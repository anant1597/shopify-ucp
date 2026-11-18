/**
 * After payment: order status, tracking, refunds/cancellations, and what a customer can do next.
 *
 * Sources of order data (Shopify, UCP order capability):
 *  - get_order (Order MCP): needs our agent token to carry `read_global_api_orders`, which Shopify
 *    grants per agent (ask your Shopify partner manager). Only orders placed through our agent.
 *  - Order webhooks: Shopify POSTs the full current order to our URL (registered by Shopify),
 *    signed with HMAC-SHA256 using our client secret.
 *  - Fallback: the completed checkout already carries order id, label and the order page link.
 *
 * UCP has no "cancel order" or "start return" operation. The store's order page (permalink_url)
 * is the canonical place for that; get_cancellation_options points the customer there.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import { db, now } from "../db.ts";
import { decrypt, encrypt } from "../crypto.ts";
import { callUcpTool, UcpError } from "../ucp/mcpClient.ts";
import { discoverStore } from "../ucp/discovery.ts";
import { getAgentToken } from "../auth/agentToken.ts";
import { getStoreBuyerToken } from "../auth/shopIdentity.ts";
import { CheckoutRejected, getCheckoutStatus } from "./checkout.ts";
import { findShopOrderFor, SHOP_LAG_NOTE } from "./shopMcp.ts";

const inr = (minor: number | undefined | null) => (typeof minor === "number" ? minor / 100 : undefined);
const totalOf = (totals: any[] | undefined, type = "total") => (totals ?? []).find((t) => t.type === type)?.amount;

function checkoutRowFor(customerId: string, ref: string) {
  const row = db
    .prepare("SELECT * FROM checkouts WHERE customer_id = ? AND (id = ? OR order_id = ?)")
    .get(customerId, ref, ref) as any;
  if (!row) throw new CheckoutRejected("Order not found for this customer");
  return row;
}

function saveOrder(row: any, o: { id: string; label?: string; permalink_url?: string }, snapshot?: any, source?: string) {
  db.prepare(
    `INSERT INTO orders (order_id, checkout_id, customer_id, store_domain, label, permalink_enc, snapshot_enc, snapshot_source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(order_id) DO UPDATE SET label = COALESCE(excluded.label, label),
       permalink_enc = COALESCE(excluded.permalink_enc, permalink_enc),
       snapshot_enc = COALESCE(excluded.snapshot_enc, snapshot_enc),
       snapshot_source = COALESCE(excluded.snapshot_source, snapshot_source), updated_at = excluded.updated_at`,
  ).run(
    o.id, row.id, row.customer_id, row.store_domain, o.label ?? null,
    o.permalink_url ? encrypt(o.permalink_url) : null,
    snapshot ? encrypt(JSON.stringify(snapshot)) : null, source ?? null, now(),
  );
}

/** Customer-friendly view of a UCP order snapshot. */
export function summarizeOrder(o: any) {
  const lines: any[] = o.line_items ?? [];
  const events: any[] = o.fulfillment?.events ?? [];
  const adjustments: any[] = o.adjustments ?? [];
  const titleOf = new Map(lines.map((l) => [l.id, l.item?.title]));

  const canceled =
    adjustments.some((a) => /cancel/i.test(a.type ?? "")) ||
    (lines.length > 0 && lines.every((l) => (l.quantity?.total ?? 1) === 0));
  const latest = [...events].sort((a, b) => Date.parse(b.occurred_at ?? 0) - Date.parse(a.occurred_at ?? 0))[0];
  const allFulfilled = lines.length > 0 && lines.every((l) => (l.quantity?.fulfilled ?? 0) >= (l.quantity?.total ?? 0));
  const status = canceled
    ? "canceled"
    : latest?.type ?? (allFulfilled ? "fulfilled" : lines.some((l) => l.quantity?.fulfilled) ? "partially_fulfilled" : "processing");

  const refunded = adjustments
    .filter((a) => a.status !== "pending")
    .reduce((sum, a) => sum + Math.min(0, totalOf(a.totals) ?? 0), 0);

  return {
    order_id: o.id,
    order_number: o.label,
    status,
    total: { inr: inr(totalOf(o.totals)), currency: o.currency ?? "INR" },
    refunded_inr: refunded ? -refunded / 100 : 0,
    items: lines.map((l) => ({
      title: l.item?.title,
      ordered: l.quantity?.original,
      current: l.quantity?.total,
      fulfilled: l.quantity?.fulfilled,
      status: l.status,
    })),
    shipping_to: (() => {
      const d = o.fulfillment?.expectations?.[0]?.destination;
      return d ? [d.address_locality, d.address_region, d.postal_code].filter(Boolean).join(", ") : undefined;
    })(),
    tracking: events
      .filter((e) => e.tracking_number || e.tracking_url)
      .map((e) => ({ carrier: e.carrier, number: e.tracking_number, url: e.tracking_url, status: e.type, at: e.occurred_at })),
    timeline: events.map((e) => ({
      at: e.occurred_at,
      event: e.type,
      note: e.description ?? undefined,
      items: (e.line_items ?? []).map((li: any) => titleOf.get(li.id)).filter(Boolean),
    })),
    adjustments: adjustments.map((a) => ({ type: a.type, status: a.status, at: a.occurred_at, inr: inr(totalOf(a.totals)) })),
  };
}

/**
 * Order details for one of the customer's orders (pass our checkout_id or the store's order id).
 * Prefers a live get_order; falls back to the latest webhook snapshot, then to the checkout's basics.
 */
export async function getOrder(customerId: string, ref: string) {
  let row = checkoutRowFor(customerId, ref);
  const known = db.prepare("SELECT label FROM orders WHERE checkout_id = ?").get(row.id) as any;
  if (row.status !== "completed" || !known?.label) {
    await getCheckoutStatus(row.id, customerId); // picks up order id/link once paid
    row = checkoutRowFor(customerId, row.id);
  }
  if (row.status !== "completed" || !row.order_id) {
    return { checkout_id: row.id, status: "not_paid", note: "No order yet: the customer hasn't paid this checkout." };
  }

  const stored = db.prepare("SELECT * FROM orders WHERE order_id = ?").get(row.order_id) as any;
  const orderPage = stored?.permalink_enc ? decrypt(stored.permalink_enc) : row.order_url;
  const base = { checkout_id: row.id, store: row.store_domain, order_page_url: orderPage ?? undefined };

  // 1) Live read (needs read_global_api_orders on the agent identity).
  let liveError: string | undefined;
  try {
    const store = await discoverStore(row.store_domain);
    const token = await getAgentToken();
    const res: any = await callUcpTool(store.mcpEndpoint!, "get_order", { id: row.order_id }, { token, buyerIp: row.buyer_ip });
    const o = res.order ?? res;
    saveOrder(row, o, o, "get_order");
    return { ...base, source: "live", order_page_url: o.permalink_url ?? orderPage, ...summarizeOrder(o) };
  } catch (e) {
    liveError = e instanceof UcpError ? e.message : (e as Error).message;
  }

  // 2) Shop MCP, if the customer connected Shop for order tracking (live, any store).
  try {
    const s = await findShopOrderFor(row.customer_id, row.store_domain, row.order_id);
    if (s) {
      return {
        ...base,
        source: "shop",
        order_id: row.order_id,
        order_number: stored?.label ?? undefined,
        status: s.delivery_status && s.delivery_status !== "pending" ? s.delivery_status : s.status,
        payment_status: s.payment_status,
        delivery_status: s.delivery_status,
        latest_update: s.latest_update,
        total: s.total,
        items: s.items,
        shipping_to: s.shipping_to,
        tracking: s.tracking,
        order_page_url: s.order_page_url ?? orderPage,
        return_url: s.return_url,
        note: SHOP_LAG_NOTE,
      };
    }
  } catch (e) {
    liveError = `${liveError}; Shop: ${(e as Error).message}`;
  }

  // 3) Latest webhook snapshot.
  if (stored?.snapshot_enc) {
    const o = JSON.parse(decrypt(stored.snapshot_enc));
    return { ...base, source: `${stored.snapshot_source} (as of ${new Date(stored.updated_at).toISOString()})`, ...summarizeOrder(o) };
  }

  // 4) What the completed checkout told us.
  return {
    ...base,
    source: "checkout",
    order_id: row.order_id,
    order_number: stored?.label ?? undefined,
    status: "placed",
    total: row.total_minor != null ? { inr: row.total_minor / 100, currency: row.currency } : undefined,
    note:
      /read_global_api_orders/.test(liveError ?? "")
        ? "For live status and tracking, connect the customer's Shop account (connect_shop_orders), or get read_global_api_orders / order webhooks from Shopify. The order page link shows full status."
        : `Live order details unavailable (${liveError}). The order page link shows full status.`,
  };
}

/** Questions to the store (policies, delivery times, product questions) via UCP ask_business. */
export async function askStore(storeDomain: string, question: string, buyerIp?: string) {
  const store = await discoverStore(storeDomain);
  if (!store.mcpEndpoint) throw new CheckoutRejected(`${store.domain} has no UCP endpoint`);
  const token = buyerIp ? await getAgentToken().catch(() => undefined) : undefined;
  const res: any = await callUcpTool(store.mcpEndpoint, "ask_business", { ask: { query: question } }, { token, buyerIp });
  const pick = (v: any): string | undefined =>
    typeof v === "string" ? v : v && typeof v === "object" ? (v.plain ?? v.text ?? v.markdown ?? pick(v.content)) : undefined;
  const answer =
    pick(res.answer) ?? pick(res.response) ?? pick(res.text) ??
    (res.messages ?? []).map((m: any) => pick(m.content) ?? m.content).filter(Boolean).join("\n");
  return { store: store.domain, question, answer: answer || "The store didn't return an answer." };
}

/** Cancel a checkout the customer has NOT paid. Disables our pay link too. */
export async function cancelUnpaidCheckout(customerId: string, checkoutId: string) {
  const row = checkoutRowFor(customerId, checkoutId);
  const fresh = await getCheckoutStatus(row.id, customerId);
  if (fresh.status === "completed") {
    throw new CheckoutRejected("Already paid: use get_cancellation_options to cancel the order with the store.");
  }
  if (row.method === "ucp" && row.ucp_checkout_id && fresh.status !== "canceled") {
    const store = await discoverStore(row.store_domain);
    const buyerToken = row.buyer_signed_in ? await getStoreBuyerToken(customerId, row.store_domain).catch(() => null) : null;
    const token = buyerToken ?? (await getAgentToken().catch(() => undefined));
    await callUcpTool(store.mcpEndpoint!, "cancel_checkout", { id: row.ucp_checkout_id }, {
      token, buyerIp: row.buyer_ip, idempotencyKey: randomUUID(),
    });
  }
  db.prepare("UPDATE checkouts SET status = 'canceled', updated_at = ? WHERE id = ?").run(now(), row.id);
  return { checkout_id: row.id, status: "canceled", note: "The pay link no longer works." };
}

/**
 * Paid orders can't be cancelled through UCP. Give the agent what the customer needs:
 * current order state, the store's own policy, and the order page where cancel/return is requested.
 */
export async function getCancellationOptions(customerId: string, ref: string, buyerIp?: string) {
  const order: any = await getOrder(customerId, ref);
  if (order.status === "not_paid") {
    return { ...order, how_to_cancel: "Not paid yet: call cancel_checkout to cancel it right away." };
  }
  const policy = await askStore(
    order.store,
    "Can a customer cancel an order after paying, and until when? How are refunds made and how long do they take? What is the return policy?",
    buyerIp,
  ).catch((e) => ({ answer: `Couldn't fetch the store policy (${(e as Error).message}).` }));
  const shippedStates = ["shipped", "in_transit", "out_for_delivery", "delivered", "delivered_partially", "fulfilled", "partially_fulfilled"];
  const shipped = shippedStates.includes(order.status) || shippedStates.includes(order.delivery_status);
  return {
    order_number: order.order_number,
    status: order.status,
    can_cancel_via_api: false,
    likely_option: order.status === "canceled" ? "already_canceled" : shipped ? "return_after_delivery" : "ask_store_to_cancel",
    store_policy: policy.answer,
    order_page_url: order.order_page_url,
    ...(order.return_url ? { return_url: order.return_url } : {}),
    how_to_cancel:
      "Send the customer the order page link: they can see status there and request cancellation or a return, " +
      "or contact the store from it. The store decides and processes any refund to the original payment method.",
  };
}

// ---------------------------------------------------------------- webhooks

/** Verify Shopify's order webhook HMAC (base64 HMAC-SHA256 of the raw body, keyed by our client secret). */
export function verifyOrderWebhook(rawBody: Buffer, hmacHeader: string | undefined): boolean {
  if (!hmacHeader) return false;
  const computed = createHmac("sha256", config.clientSecret).update(rawBody).digest("base64");
  const a = Buffer.from(hmacHeader, "utf8");
  const b = Buffer.from(computed, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const checkoutKey = (gid: string | undefined) => (gid ?? "").split("?")[0];

/**
 * Store the latest order snapshot. Returns what happened so the HTTP layer can respond 200 quickly.
 * Caller has already verified the signature.
 */
export function ingestOrderWebhook(deliveryId: string | undefined, payload: any): { result: string; order_id?: string } {
  if (deliveryId) {
    const fresh = db.prepare("INSERT OR IGNORE INTO webhook_deliveries (delivery_id, received_at) VALUES (?, ?)").run(deliveryId, now());
    if (fresh.changes === 0) return { result: "duplicate" };
  }
  const o = payload?.order ?? payload;
  if (!o?.id) return { result: "ignored: no order id" };

  let row = db.prepare("SELECT * FROM checkouts WHERE order_id = ?").get(o.id) as any;
  if (!row && o.checkout_id) {
    const key = checkoutKey(o.checkout_id);
    row = (db.prepare("SELECT * FROM checkouts WHERE ucp_checkout_id IS NOT NULL").all() as any[]).find(
      (r) => checkoutKey(r.ucp_checkout_id) === key,
    );
  }
  if (!row) return { result: "ignored: unknown order", order_id: o.id };

  if (row.status !== "completed" || !row.order_id) {
    db.prepare("UPDATE checkouts SET status = 'completed', order_id = ?, order_url = COALESCE(?, order_url), updated_at = ? WHERE id = ?")
      .run(o.id, o.permalink_url ?? null, now(), row.id);
  }
  saveOrder(row, o, o, "webhook");
  return { result: "stored", order_id: o.id };
}
