/**
 * Prepare a checkout and return a pay link. NEVER completes the purchase:
 * the customer pays by card on the store's own checkout page (continue_url).
 */
import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { db, now } from "../db.ts";
import { decrypt, encrypt, randomToken } from "../crypto.ts";
import { callUcpTool, UcpError } from "../ucp/mcpClient.ts";
import { discoverStore } from "../ucp/discovery.ts";
import { getAgentToken } from "../auth/agentToken.ts";
import { getStoreBuyerToken } from "../auth/shopIdentity.ts";
import { getAddress, getCustomer, getDefaultAddress, type Address, type Customer } from "./customers.ts";

export interface PrepareCheckoutInput {
  customer_id: string;
  /** Real IP of the end customer. Required by Shopify on every authenticated call. */
  buyer_ip: string;
  store: string;
  items: { variant_id: string; quantity: number }[];
  /** Saved address id; defaults to the customer's default address. Optional: the customer can enter it on the pay page. */
  address_id?: string;
  /** Hard cap; the checkout is cancelled if the store's total is higher. */
  max_total_inr?: number;
  discount_codes?: string[];
  partner?: string;
}

export interface PrepareCheckoutResult {
  checkout_id: string;
  status: "awaiting_payment" | "needs_customer_input";
  pay_url: string;
  method: "ucp" | "permalink";
  buyer_signed_in: boolean;
  total?: { inr: number; currency: string; estimated: boolean };
  breakdown?: { type: string; inr: number }[];
  messages: { severity?: string; code?: string; text: string }[];
  expires_at?: string;
}

export class CheckoutRejected extends Error {}

const toGid = (id: string) => (id.startsWith("gid://") ? id : `gid://shopify/ProductVariant/${id}`);
const toNumericId = (id: string) => id.split("/").pop()!;

export async function prepareCheckout(input: PrepareCheckoutInput): Promise<PrepareCheckoutResult> {
  const customer = getCustomer(input.customer_id);
  if (!customer) throw new CheckoutRejected(`Unknown customer ${input.customer_id}`);
  if (!input.items.length) throw new CheckoutRejected("No items");
  if (!input.buyer_ip) throw new CheckoutRejected("buyer_ip is required (Shopify needs the real customer IP)");

  const address = input.address_id ? getAddress(input.address_id) : getDefaultAddress(customer.id);
  if (input.address_id && (!address || address.customer_id !== customer.id)) throw new CheckoutRejected("Address not found");

  const store = await discoverStore(input.store);
  if (store.checkoutOk && store.mcpEndpoint) {
    try {
      return await prepareViaUcp(input, customer, address, store.domain, store.mcpEndpoint);
    } catch (e) {
      if (e instanceof CheckoutRejected) throw e;
      console.warn(`[checkout] UCP failed for ${store.domain}, falling back to permalink:`, (e as Error).message);
    }
  }
  return prepareViaPermalink(input, customer, address, store.domain);
}

// ------------------------------------------------------------------ UCP path

async function prepareViaUcp(
  input: PrepareCheckoutInput,
  customer: Customer,
  address: Address | undefined,
  domain: string,
  endpoint: string,
): Promise<PrepareCheckoutResult> {
  // Signed-in customers get a buyer-linked token (store recognises them: no OTP, saved details, auto discounts)
  const buyerToken = await getStoreBuyerToken(customer.id, domain).catch(() => null);
  // Stores accept anonymous create_checkout today (lower rate limits); use the agent token when we have one.
  const token = buyerToken ?? (await getAgentToken().catch((e) => {
    console.warn("[checkout] no agent token, calling store anonymously:", (e as Error).message);
    return undefined;
  }));
  const call = (tool: string, args: Record<string, unknown>, extra: { idempotencyKey?: string } = {}) =>
    callUcpTool<any>(endpoint, tool, args, { token, buyerIp: input.buyer_ip, ...extra });

  const lineItems = input.items.map((i) => ({ item: { id: toGid(i.variant_id) }, quantity: i.quantity }));
  const buyer = buyerPayload(customer);
  const destination = address ? destinationPayload(address, customer) : undefined;

  const checkoutBody: Record<string, unknown> = {
    line_items: lineItems,
    ...(buyer ? { buyer } : {}),
    context: { address_country: "IN", currency: "INR", language: "en-IN", ...(address ? { postal_code: address.pincode, address_region: address.state } : {}) },
    attribution: { utm_source: "agent", utm_medium: input.partner ?? "direct" },
    ...(destination ? { fulfillment: { methods: [{ type: "shipping", destinations: [destination] }] } } : {}),
    ...(input.discount_codes?.length ? { discounts: { codes: input.discount_codes } } : {}),
  };

  let co = unwrap(await call("create_checkout", { checkout: checkoutBody }));

  // Signed-in buyers get the store's saved address prefilled, sometimes without a phone number
  // (store message: delivery_phone_number_required). Fill it from the customer's profile.
  const fill = fillMissingDeliveryPhone(co, customer);
  if (fill) co = unwrap(await call("update_checkout", { id: co.id, checkout: fill }));

  // Pick the cheapest prepaid shipping if the store left a group unselected or defaulted to COD.
  const update = autoSelectShipping(co, checkoutBody);
  if (update) co = unwrap(await call("update_checkout", { id: co.id, checkout: update }));

  const totals = readTotals(co);
  if (input.max_total_inr != null && totals.total != null && totals.total / 100 > input.max_total_inr) {
    await call("cancel_checkout", { id: co.id }, { idempotencyKey: randomUUID() }).catch(() => {});
    throw new CheckoutRejected(
      `Store total ₹${(totals.total / 100).toFixed(2)} is above the cap of ₹${input.max_total_inr}`,
    );
  }

  const continueUrl = safeHttpsUrl(co.continue_url);
  if (!continueUrl) {
    const msgs = (co.messages ?? []).map((m: any) => m.content ?? m.code).join("; ");
    throw new Error(`Store returned no continue_url (status ${co.status}). ${msgs}`);
  }

  // We deliberately never call complete_checkout.
  return persist({
    input,
    domain,
    method: "ucp",
    ucpId: co.id,
    continueUrl,
    totalMinor: totals.total,
    currency: totals.currency,
    estimated: false,
    breakdown: totals.lines,
    buyerSignedIn: !!buyerToken,
    messages: (co.messages ?? []).map((m: any) => ({ severity: m.severity ?? m.type, code: m.code, text: m.content ?? m.code })),
    expiresAt: co.expires_at,
    needsInput: co.status === "incomplete",
  });
}

function unwrap(r: any) {
  return r?.checkout ?? r;
}

function buyerPayload(c: Customer) {
  const b: Record<string, unknown> = {};
  if (c.email) b.email = c.email;
  if (c.phone) b.phone_number = c.phone;
  if (c.first_name) b.first_name = c.first_name;
  if (c.last_name) b.last_name = c.last_name;
  return Object.keys(b).length ? b : undefined;
}

function destinationPayload(a: Address, c: Customer) {
  return {
    id: `addr_${a.id.slice(0, 8)}`,
    first_name: a.first_name ?? c.first_name ?? undefined,
    last_name: a.last_name ?? c.last_name ?? undefined,
    phone_number: a.phone ?? c.phone ?? undefined,
    street_address: a.line1,
    extended_address: a.line2 ?? undefined,
    address_locality: a.city,
    address_region: a.state,
    postal_code: a.pincode,
    address_country: a.country || "IN",
  };
}

/** update_checkout is PUT: resend everything, with line item ids and an explicit option per group. */
/**
 * Pick the cheapest prepaid option for any group without a choice, and move groups off a
 * cash-on-delivery option (on many Indian stores COD shipping removes card payment from the page).
 * In "fill_only" mode (updates) existing choices are kept, so a customer's COD pick survives later edits.
 */
function autoSelectShipping(
  co: any,
  body: Record<string, unknown>,
  mode: "prefer_prepaid" | "fill_only" = "prefer_prepaid",
): Record<string, unknown> | null {
  const methods: any[] = co.fulfillment?.methods ?? [];
  let changed = false;
  const newMethods = methods.map((m) => {
    const groups = (m.groups ?? []).map((g: any) => {
      const keep = { id: g.id, selected_option_id: g.selected_option_id };
      if (!g.options?.length) return keep;
      const selected = g.options.find((o: any) => o.id === g.selected_option_id);
      if (selected && (mode === "fill_only" || !isCod(selected))) return keep;
      const prepaid = g.options.filter((o: any) => !isCod(o));
      const pool = prepaid.length ? prepaid : g.options;
      const best = [...pool].sort((a, b) => optionCost(a) - optionCost(b))[0];
      if (best.id === g.selected_option_id) return keep;
      changed = true;
      return { id: g.id, selected_option_id: best.id };
    });
    return {
      id: m.id,
      type: m.type ?? "shipping",
      line_item_ids: m.line_item_ids ?? (co.line_items ?? []).map((li: any) => li.id),
      destinations: m.destinations,
      selected_destination_id: m.selected_destination_id ?? m.destinations?.[0]?.id,
      groups,
    };
  });
  if (!changed) return null;
  return {
    ...body,
    line_items: (co.line_items ?? []).map((li: any) => ({ id: li.id, item: { id: li.item?.id }, quantity: li.quantity })),
    fulfillment: { methods: newMethods },
  };
}

function optionCost(o: any): number {
  const t = (o.totals ?? []).find((x: any) => x.type === "total") ?? o.totals?.[0];
  return amountOf(t) ?? Number.MAX_SAFE_INTEGER;
}

function amountOf(x: any): number | undefined {
  if (x == null) return undefined;
  if (typeof x.amount === "number") return x.amount;
  if (typeof x.amount?.amount === "number") return x.amount.amount;
  return undefined;
}

function readTotals(co: any) {
  const lines = (co.totals ?? [])
    .map((t: any) => ({ type: t.type as string, minor: amountOf(t) }))
    .filter((t: any) => t.minor != null);
  const total = lines.find((t: any) => t.type === "total")?.minor as number | undefined;
  const currency = co.currency ?? co.totals?.find((t: any) => t.amount?.currency)?.amount?.currency ?? "INR";
  return { total, currency, lines: lines.map((l: any) => ({ type: l.type, inr: l.minor / 100 })) };
}

function safeHttpsUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ permalink fallback

async function prepareViaPermalink(
  input: PrepareCheckoutInput,
  customer: Customer,
  address: Address | undefined,
  domain: string,
): Promise<PrepareCheckoutResult> {
  const path = input.items.map((i) => `${toNumericId(i.variant_id)}:${i.quantity}`).join(",");
  const u = new URL(`https://${domain}/cart/${path}`);
  const q = u.searchParams;
  if (customer.email) q.set("checkout[email]", customer.email);
  if (address) {
    const fn = address.first_name ?? customer.first_name;
    const ln = address.last_name ?? customer.last_name;
    if (fn) q.set("checkout[shipping_address][first_name]", fn);
    if (ln) q.set("checkout[shipping_address][last_name]", ln);
    q.set("checkout[shipping_address][address1]", address.line1);
    if (address.line2) q.set("checkout[shipping_address][address2]", address.line2);
    q.set("checkout[shipping_address][city]", address.city);
    q.set("checkout[shipping_address][province]", address.state);
    q.set("checkout[shipping_address][zip]", address.pincode);
    q.set("checkout[shipping_address][country]", "India");
    const ph = address.phone ?? customer.phone;
    if (ph) q.set("checkout[shipping_address][phone]", ph);
  }
  if (input.discount_codes?.[0]) q.set("discount", input.discount_codes[0]);
  q.set("utm_source", "agent");

  return persist({
    input,
    domain,
    method: "permalink",
    ucpId: null,
    continueUrl: u.toString(),
    totalMinor: undefined,
    currency: "INR",
    estimated: true,
    breakdown: [],
    buyerSignedIn: false,
    messages: [{ severity: "info", text: "Store has no UCP checkout; totals are calculated on the store's checkout page." }],
    needsInput: false,
  });
}

// ------------------------------------------------------------------ persistence & status

function persist(p: {
  input: PrepareCheckoutInput;
  domain: string;
  method: "ucp" | "permalink";
  ucpId: string | null;
  continueUrl: string;
  totalMinor: number | undefined;
  currency: string;
  estimated: boolean;
  breakdown: { type: string; inr: number }[];
  buyerSignedIn: boolean;
  messages: { severity?: string; code?: string; text: string }[];
  expiresAt?: string;
  needsInput: boolean;
}): PrepareCheckoutResult {
  const id = `chk_${randomToken(12)}`;
  const payToken = randomToken(16);
  const status = p.needsInput ? "needs_customer_input" : "awaiting_payment";
  const expiresAtMs = p.expiresAt ? Date.parse(p.expiresAt) : now() + 24 * 60 * 60 * 1000;
  db.prepare(
    `INSERT INTO checkouts (id, customer_id, partner, store_domain, method, ucp_checkout_id, status, total_minor, currency,
       continue_url_enc, pay_token, buyer_signed_in, buyer_ip, created_at, updated_at, expires_at, max_total_minor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, p.input.customer_id, p.input.partner ?? null, p.domain, p.method, p.ucpId, status, p.totalMinor ?? null,
    p.currency, encrypt(p.continueUrl), payToken, p.buyerSignedIn ? 1 : 0, p.input.buyer_ip, now(), now(), expiresAtMs,
    p.input.max_total_inr != null ? Math.round(p.input.max_total_inr * 100) : null,
  );
  return {
    checkout_id: id,
    status,
    pay_url: `${config.publicBaseUrl}/pay/${payToken}`,
    method: p.method,
    buyer_signed_in: p.buyerSignedIn,
    ...(p.totalMinor != null ? { total: { inr: p.totalMinor / 100, currency: p.currency, estimated: p.estimated } } : {}),
    breakdown: p.breakdown,
    messages: p.messages,
    expires_at: new Date(expiresAtMs).toISOString(),
  };
}

/** Resolve our pay link to the store's checkout URL (used by GET /pay/:token). */
export function resolvePayLink(payToken: string): string | null {
  const row = db.prepare("SELECT id, continue_url_enc, expires_at, status FROM checkouts WHERE pay_token = ?").get(payToken) as any;
  if (!row || (row.expires_at && row.expires_at < now())) return null;
  if (row.status === "over_cap" || row.status === "canceled" || row.status === "completed") return null;
  if (row.status === "awaiting_payment" || row.status === "needs_customer_input") {
    db.prepare("UPDATE checkouts SET status = 'link_opened', updated_at = ? WHERE id = ?").run(now(), row.id);
  }
  return decrypt(row.continue_url_enc);
}

export async function getCheckoutStatus(checkoutId: string, customerId?: string) {
  const row = db.prepare("SELECT * FROM checkouts WHERE id = ?").get(checkoutId) as any;
  if (!row || (customerId && row.customer_id !== customerId)) throw new CheckoutRejected("Checkout not found");

  // Re-read open checkouts, and paid ones whose order number we haven't recorded yet.
  const missingOrderLabel =
    row.status === "completed" &&
    !(db.prepare("SELECT label FROM orders WHERE checkout_id = ?").get(row.id) as any)?.label;
  if (row.method === "ucp" && row.ucp_checkout_id && (!["completed", "canceled"].includes(row.status) || missingOrderLabel)) {
    try {
      const store = await discoverStore(row.store_domain);
      const buyerToken = row.buyer_signed_in ? await getStoreBuyerToken(row.customer_id, row.store_domain) : null;
      const token = buyerToken ?? (await getAgentToken().catch(() => undefined));
      const co = unwrap(await callUcpTool(store.mcpEndpoint!, "get_checkout", { id: row.ucp_checkout_id }, { token, buyerIp: row.buyer_ip }));
      const status = co.status === "completed" ? "completed" : co.status === "canceled" ? "canceled" : row.status;
      const total = readTotals(co).total ?? row.total_minor;
      db.prepare(
        "UPDATE checkouts SET status = ?, total_minor = ?, order_id = ?, order_url = ?, updated_at = ? WHERE id = ?",
      ).run(status, total, co.order?.id ?? row.order_id, co.order?.permalink_url ?? row.order_url, now(), row.id);
      Object.assign(row, { status, total_minor: total, order_id: co.order?.id ?? row.order_id, order_url: co.order?.permalink_url ?? row.order_url });
      if (co.order?.id) recordOrder(row, co.order);
    } catch (e) {
      if (!(e instanceof UcpError)) throw e;
      // Expired/unknown checkouts surface as UCP errors; keep last known state.
    }
  }
  return {
    checkout_id: row.id,
    store: row.store_domain,
    method: row.method,
    status: row.status as string,
    total: row.total_minor != null ? { inr: row.total_minor / 100, currency: row.currency } : undefined,
    order_id: row.order_id ?? undefined,
    order_url: row.order_url ?? undefined,
    pay_url: `${config.publicBaseUrl}/pay/${row.pay_token}`,
    note: row.method === "permalink" ? "Permalink checkouts can't be tracked through UCP; confirm with the customer." : undefined,
  };
}

// ------------------------------------------------------------------ options & updates

export interface UpdateCheckoutInput {
  customer_id: string;
  checkout_id: string;
  /** Pick a shipping option per group (group_id may be omitted when there is only one group). */
  shipping?: { group_id?: string; option_id: string }[];
  /** Switch to another saved address of this customer. */
  address_id?: string;
  /** Change quantities (0 removes) or add variants. Items not listed stay as they are. */
  items?: { variant_id: string; quantity: number }[];
  /** Replaces the codes currently on the checkout. [] removes all. */
  discount_codes?: string[];
}

const DEST_FIELDS = [
  "id", "first_name", "last_name", "phone_number", "street_address", "extended_address",
  "address_locality", "address_region", "postal_code", "address_country",
] as const;
const pickDest = (d: any) => Object.fromEntries(DEST_FIELDS.filter((k) => d?.[k] != null).map((k) => [k, d[k]]));
const isCod = (o: any) => /cash\s*on\s*delivery|\bcod\b/i.test(`${o.title ?? ""} ${o.description?.plain ?? ""}`);

async function openUcpCheckout(checkoutId: string, customerId: string) {
  const row = db.prepare("SELECT * FROM checkouts WHERE id = ?").get(checkoutId) as any;
  if (!row || row.customer_id !== customerId) throw new CheckoutRejected("Checkout not found");
  if (row.method !== "ucp" || !row.ucp_checkout_id) {
    throw new CheckoutRejected("This store's checkout can't be changed through the API (permalink). Prepare a new checkout instead.");
  }
  const store = await discoverStore(row.store_domain);
  const buyerToken = row.buyer_signed_in ? await getStoreBuyerToken(row.customer_id, row.store_domain).catch(() => null) : null;
  const token = buyerToken ?? (await getAgentToken().catch(() => undefined));
  const call = (tool: string, args: Record<string, unknown>) =>
    callUcpTool<any>(store.mcpEndpoint!, tool, args, { token, buyerIp: row.buyer_ip });
  const co = unwrap(await call("get_checkout", { id: row.ucp_checkout_id }));
  return { row, call, co };
}

/** What the agent can show the customer: items, address, shipping choices (COD flagged), totals. */
function describeCheckout(row: any, co: any) {
  const totals = readTotals(co);
  const titleOf = new Map<string, string>((co.line_items ?? []).map((li: any) => [li.id, li.item?.title]));
  const method = co.fulfillment?.methods?.[0];
  const dest = method?.destinations?.find((d: any) => d.id === method.selected_destination_id) ?? method?.destinations?.[0];
  return {
    checkout_id: row.id,
    store: row.store_domain,
    status: row.status as string,
    total: totals.total != null ? { inr: totals.total / 100, currency: totals.currency } : undefined,
    breakdown: totals.lines,
    items: (co.line_items ?? []).map((li: any) => ({
      variant_id: li.item?.id,
      title: li.item?.title,
      quantity: li.quantity,
      unit_price_inr: amountOf(li.item?.price) != null ? amountOf(li.item.price)! / 100 : undefined,
    })),
    delivery_address: dest
      ? [dest.street_address, dest.extended_address, dest.address_locality, dest.address_region, dest.postal_code].filter(Boolean).join(", ")
      : null,
    shipping: (co.fulfillment?.methods ?? []).flatMap((m: any) =>
      (m.groups ?? []).map((g: any) => ({
        group_id: g.id,
        items: (g.line_item_ids ?? []).map((id: string) => titleOf.get(id)).filter(Boolean),
        selected_option_id: g.selected_option_id ?? null,
        options: (g.options ?? []).map((o: any) => ({
          option_id: o.id,
          title: o.title,
          description: o.description?.plain ?? undefined,
          cost_inr: (optionCost(o) === Number.MAX_SAFE_INTEGER ? undefined : optionCost(o) / 100),
          cash_on_delivery: isCod(o),
          selected: o.id === g.selected_option_id,
        })),
      })),
    ),
    discount_codes: co.discounts?.codes ?? [],
    applied_discounts: (co.discounts?.applied ?? []).map((d: any) => ({ title: d.title ?? d.code, inr: (amountOf(d) ?? 0) / 100 })),
    messages: (co.messages ?? []).map((m: any) => ({ severity: m.severity ?? m.type, code: m.code, text: m.content ?? m.code })),
    pay_url: `${config.publicBaseUrl}/pay/${row.pay_token}`,
  };
}

export async function getCheckoutOptions(checkoutId: string, customerId: string) {
  const { row, co } = await openUcpCheckout(checkoutId, customerId);
  syncRow(row, co);
  return describeCheckout(row, co);
}

/** Full PUT body rebuilt from the store's current checkout, with our overrides applied. */
function bodyFrom(
  co: any,
  customer: Customer,
  o: {
    lineItems?: { id?: string; item: { id: string }; quantity: number }[];
    destination?: Record<string, unknown>;
    postalContext?: Address;
    dropGroups?: boolean;
    selections?: Map<string, string>;
    discountCodes?: string[];
  } = {},
) {
  const lineItems =
    o.lineItems ?? (co.line_items ?? []).map((li: any) => ({ id: li.id, item: { id: li.item?.id }, quantity: li.quantity }));
  const lineIds = lineItems.map((l: { id?: string }) => l.id).filter(Boolean) as string[];
  const methods = (co.fulfillment?.methods ?? []).map((m: any) => {
    const ids = (m.line_item_ids ?? []).filter((id: string) => lineIds.includes(id));
    return {
      id: m.id,
      type: m.type ?? "shipping",
      line_item_ids: ids.length ? ids : lineIds,
      destinations: o.destination ? [o.destination] : (m.destinations ?? []).map(pickDest),
      selected_destination_id: o.destination ? o.destination.id : m.selected_destination_id,
      ...(o.dropGroups
        ? {}
        : { groups: (m.groups ?? []).map((g: any) => ({ id: g.id, selected_option_id: o.selections?.get(g.id) ?? g.selected_option_id })) }),
    };
  });
  if (!methods.length && o.destination) {
    methods.push({ type: "shipping", line_item_ids: lineIds, destinations: [o.destination], selected_destination_id: o.destination.id });
  }
  const buyer = buyerPayload(customer);
  return {
    line_items: lineItems,
    ...(buyer ? { buyer } : {}),
    context: {
      address_country: "IN", currency: "INR", language: "en-IN",
      ...(o.postalContext ? { postal_code: o.postalContext.pincode, address_region: o.postalContext.state } : {}),
    },
    ...(methods.length ? { fulfillment: { methods } } : {}),
    discounts: { codes: o.discountCodes ?? co.discounts?.codes ?? [] },
  };
}

export async function updateCheckout(input: UpdateCheckoutInput) {
  const { row, call, co: initial } = await openUcpCheckout(input.checkout_id, input.customer_id);
  if (["completed", "canceled"].includes(row.status) || ["completed", "canceled"].includes(initial.status)) {
    throw new CheckoutRejected(`Checkout is already ${initial.status ?? row.status}; prepare a new one.`);
  }
  const customer = getCustomer(row.customer_id)!;
  let co = initial;
  const warnings: string[] = [];

  // 1) Items / address / discounts. Changing items or address makes the store re-plan shipping.
  const address = input.address_id ? getAddress(input.address_id) : undefined;
  if (input.address_id && (!address || address.customer_id !== customer.id)) throw new CheckoutRejected("Address not found");

  if (input.items?.length || address || input.discount_codes) {
    let lineItems: { id?: string; item: { id: string }; quantity: number }[] | undefined;
    if (input.items?.length) {
      lineItems = (co.line_items ?? []).map((li: any) => ({ id: li.id, item: { id: li.item?.id }, quantity: li.quantity }));
      for (const change of input.items) {
        const gid = toGid(change.variant_id);
        const existing = lineItems!.find((l) => l.item.id === gid);
        if (existing) existing.quantity = change.quantity;
        else if (change.quantity > 0) lineItems!.push({ item: { id: gid }, quantity: change.quantity });
      }
      lineItems = lineItems!.filter((l) => l.quantity > 0);
      if (!lineItems.length) throw new CheckoutRejected("A checkout needs at least one item");
    }
    co = unwrap(
      await call("update_checkout", {
        id: row.ucp_checkout_id,
        checkout: bodyFrom(co, customer, {
          lineItems,
          destination: address ? destinationPayload(address, customer) : undefined,
          postalContext: address,
          dropGroups: !!(lineItems || address),
          discountCodes: input.discount_codes,
        }),
      }),
    );
    // The update response comes back before the store re-plans shipping (no fulfillment details),
    // so re-read until the shipping groups are there again.
    if (lineItems || address) {
      co = await refetchUntilShippingPlanned(call, row.ucp_checkout_id, co);
      // Re-planning resets shipping to the store default; restore the customer's earlier choice if still offered.
      if (!input.shipping?.length) {
        const restore = new Map<string, string>();
        const before = new Map<string, string>(
          (initial.fulfillment?.methods ?? []).flatMap((m: any) => (m.groups ?? []).map((g: any) => [g.id, g.selected_option_id])),
        );
        for (const g of (co.fulfillment?.methods ?? []).flatMap((m: any) => m.groups ?? [])) {
          const prev = before.get(g.id);
          if (prev && prev !== g.selected_option_id && g.options?.some((o: any) => o.id === prev)) restore.set(g.id, prev);
        }
        if (restore.size) {
          co = unwrap(await call("update_checkout", { id: row.ucp_checkout_id, checkout: bodyFrom(co, customer, { selections: restore }) }));
        }
      }
    }
    if (input.discount_codes?.length) {
      const applied = new Set((co.discounts?.applied ?? []).map((d: any) => String(d.code ?? d.title ?? "").toLowerCase()));
      for (const code of input.discount_codes) {
        if (!applied.has(code.toLowerCase())) warnings.push(`Discount code "${code}" was not applied by the store`);
      }
    }
  }

  // 2) Shipping choice
  if (input.shipping?.length) {
    const groups: any[] = (co.fulfillment?.methods ?? []).flatMap((m: any) => m.groups ?? []);
    if (!groups.length) throw new CheckoutRejected("No shipping options yet: the checkout needs a delivery address first");
    const selections = new Map<string, string>();
    for (const s of input.shipping) {
      const group = s.group_id ? groups.find((g) => g.id === s.group_id) : groups.length === 1 ? groups[0] : groups.find((g) => g.options?.some((o: any) => o.id === s.option_id));
      if (!group) throw new CheckoutRejected(`Unknown shipping group ${s.group_id ?? ""}`.trim());
      if (!group.options?.some((o: any) => o.id === s.option_id)) {
        const valid = group.options.map((o: any) => `${o.id} (${o.title})`).join(", ");
        throw new CheckoutRejected(`Option ${s.option_id} is not available for this group. Valid: ${valid}`);
      }
      selections.set(group.id, s.option_id);
      const chosen = group.options.find((o: any) => o.id === s.option_id);
      if (isCod(chosen)) {
        warnings.push(
          `"${chosen.title}" is cash on delivery: on this store the pay page will offer COD only (no card). ` +
            "Pick a prepaid option if the customer should pay by card.",
        );
      }
    }
    co = unwrap(await call("update_checkout", { id: row.ucp_checkout_id, checkout: bodyFrom(co, customer, { selections }) }));
  }

  // 3) Any group left without a choice gets the cheapest option.
  const auto = autoSelectShipping(co, bodyFrom(co, customer), "fill_only");
  if (auto) co = unwrap(await call("update_checkout", { id: row.ucp_checkout_id, checkout: auto }));

  syncRow(row, co);
  if (row.status === "over_cap") {
    warnings.push(`Total is above the cap of ₹${row.max_total_minor / 100}; the pay link is disabled until it is back under.`);
  }
  return { ...describeCheckout(row, co), warnings };
}

/** Persist latest totals/status/continue_url and enforce the stored price cap. */
function syncRow(row: any, co: any) {
  const total = readTotals(co).total ?? row.total_minor;
  let status = row.status;
  if (co.status === "completed") status = "completed";
  else if (co.status === "canceled") status = "canceled";
  else if (row.max_total_minor != null && total != null && total > row.max_total_minor) status = "over_cap";
  else if (status === "over_cap") status = "awaiting_payment";
  const url = safeHttpsUrl(co.continue_url);
  db.prepare(
    `UPDATE checkouts SET status = ?, total_minor = ?, continue_url_enc = COALESCE(?, continue_url_enc),
       order_id = COALESCE(?, order_id), order_url = COALESCE(?, order_url), updated_at = ? WHERE id = ?`,
  ).run(status, total, url ? encrypt(url) : null, co.order?.id ?? null, co.order?.permalink_url ?? null, now(), row.id);
  if (co.order?.id) recordOrder(row, co.order);
  Object.assign(row, { status, total_minor: total });
}

const hasShippingGroups = (co: any) =>
  (co.fulfillment?.methods ?? []).some((m: any) => (m.groups ?? []).some((g: any) => g.options?.length));

async function refetchUntilShippingPlanned(
  call: (tool: string, args: Record<string, unknown>) => Promise<any>,
  ucpId: string,
  co: any,
): Promise<any> {
  for (let i = 0; i < 4 && !hasShippingGroups(co); i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 750 * i));
    co = unwrap(await call("get_checkout", { id: ucpId }));
  }
  return co;
}

function fillMissingDeliveryPhone(co: any, customer: Customer): Record<string, unknown> | null {
  if (!customer.phone) return null;
  const method = co.fulfillment?.methods?.[0];
  const dest = method?.destinations?.find((d: any) => d.id === method.selected_destination_id) ?? method?.destinations?.[0];
  if (!dest || dest.phone_number) return null;
  return bodyFrom(co, customer, { destination: { ...pickDest(dest), phone_number: customer.phone } });
}

/** Remember the order the store attached to a completed checkout (id, label like "#1042", order page). */
function recordOrder(row: any, order: { id: string; label?: string; permalink_url?: string }) {
  db.prepare(
    `INSERT INTO orders (order_id, checkout_id, customer_id, store_domain, label, permalink_enc, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(order_id) DO UPDATE SET label = COALESCE(excluded.label, label),
       permalink_enc = COALESCE(excluded.permalink_enc, permalink_enc), updated_at = excluded.updated_at`,
  ).run(
    order.id, row.id, row.customer_id, row.store_domain, order.label ?? null,
    order.permalink_url ? encrypt(order.permalink_url) : null, now(),
  );
}
