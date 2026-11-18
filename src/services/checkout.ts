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

  // If the store asks us to pick a shipping option, pick the cheapest one (one round only).
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
function autoSelectShipping(co: any, body: Record<string, unknown>): Record<string, unknown> | null {
  const methods: any[] = co.fulfillment?.methods ?? [];
  let changed = false;
  const newMethods = methods.map((m) => {
    const groups = (m.groups ?? []).map((g: any) => {
      if (g.selected_option_id || !g.options?.length) return { id: g.id, selected_option_id: g.selected_option_id };
      const cheapest = [...g.options].sort((a, b) => optionCost(a) - optionCost(b))[0];
      changed = true;
      return { id: g.id, selected_option_id: cheapest.id };
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
       continue_url_enc, pay_token, buyer_signed_in, buyer_ip, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, p.input.customer_id, p.input.partner ?? null, p.domain, p.method, p.ucpId, status, p.totalMinor ?? null,
    p.currency, encrypt(p.continueUrl), payToken, p.buyerSignedIn ? 1 : 0, p.input.buyer_ip, now(), now(), expiresAtMs,
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
  if (row.status === "awaiting_payment" || row.status === "needs_customer_input") {
    db.prepare("UPDATE checkouts SET status = 'link_opened', updated_at = ? WHERE id = ?").run(now(), row.id);
  }
  return decrypt(row.continue_url_enc);
}

export async function getCheckoutStatus(checkoutId: string, customerId?: string) {
  const row = db.prepare("SELECT * FROM checkouts WHERE id = ?").get(checkoutId) as any;
  if (!row || (customerId && row.customer_id !== customerId)) throw new CheckoutRejected("Checkout not found");

  if (row.method === "ucp" && row.ucp_checkout_id && !["completed", "canceled"].includes(row.status)) {
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
