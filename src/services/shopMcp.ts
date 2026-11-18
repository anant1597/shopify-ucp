/**
 * Shop MCP (https://mcp.shop.com): the customer's Shop-tracked orders across ALL Shopify stores,
 * with live status, delivery progress and the store's order page link.
 *
 * - Customer connects once with a device code (personal_agent scope); we keep the refresh token encrypted.
 * - No cancel/return tool exists. Shop's guidance: give the shopper the order's permalink_url / return_url.
 * - Client: SHOP_MCP_CLIENT_ID. Defaults to Shop's public CLI client, which is for prototyping only;
 *   production needs your own Shop app that Shopify has enabled for personal_agent.
 */
import { config } from "../config.ts";
import { db, now } from "../db.ts";
import { decrypt, encrypt } from "../crypto.ts";
import { ensureCustomer } from "./customers.ts";
import { CheckoutRejected } from "./checkout.ts";

const SHOP = config.shopIdentityIssuer;
const SCOPE = "openid email personal_agent";
const MAX_PAGE = 10; // search_orders rejects larger pages

/** Shop's order feed can lag the store (seen: a store cancellation + refund still shown as paid/processing hours later). */
export const SHOP_LAG_NOTE =
  "Status as tracked by Shop, which can lag the store (cancellations and refunds may not show yet). " +
  "The store's order page is the source of truth.";

function clientParams(): Record<string, string> {
  return {
    client_id: config.shopMcpClientId,
    ...(config.shopMcpClientSecret ? { client_secret: config.shopMcpClientSecret } : {}),
  };
}

async function postForm(url: string, params: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...clientParams(), ...params }),
  });
  const json: any = await res.json().catch(() => ({}));
  return { ok: res.ok && !json.error, status: res.status, json };
}

// ---------------------------------------------------------------- sign-in (device flow)

export function isShopOrdersConnected(customerId: string): boolean {
  return !!db.prepare("SELECT 1 FROM shop_agent_links WHERE customer_id = ?").get(customerId);
}

export async function startShopOrdersSignIn(customerId: string) {
  ensureCustomer(customerId);
  const r = await postForm(`${SHOP}/oauth/device`, { scope: SCOPE, resource: config.shopMcpResource });
  if (!r.ok || !r.json.device_code) throw new Error(`Shop sign-in failed (${r.status}): ${JSON.stringify(r.json).slice(0, 200)}`);
  void pollDevice(customerId, r.json.device_code, r.json.interval ?? 5, r.json.expires_in ?? 900);
  return {
    sign_in_url: r.json.verification_uri_complete as string,
    code: r.json.user_code as string,
    expires_in_minutes: Math.round((r.json.expires_in ?? 900) / 60),
    note: "Customer opens the link (code is prefilled), taps Continue and approves. Shop handles any OTP.",
  };
}

async function pollDevice(customerId: string, deviceCode: string, intervalS: number, expiresS: number) {
  const deadline = Date.now() + expiresS * 1000;
  let interval = intervalS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const r = await postForm(`${SHOP}/oauth/token`, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode });
    if (r.ok) return saveTokens(customerId, r.json);
    if (r.json.error === "slow_down") interval += 5;
    else if (r.json.error !== "authorization_pending") return;
  }
}

export function saveTokens(customerId: string, t: any) {
  const prev = db.prepare("SELECT refresh_token_enc FROM shop_agent_links WHERE customer_id = ?").get(customerId) as any;
  db.prepare(
    `INSERT INTO shop_agent_links (customer_id, access_token_enc, access_expires_at, refresh_token_enc, scope, linked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(customer_id) DO UPDATE SET access_token_enc = excluded.access_token_enc,
       access_expires_at = excluded.access_expires_at, refresh_token_enc = excluded.refresh_token_enc,
       scope = excluded.scope, updated_at = excluded.updated_at`,
  ).run(
    customerId, encrypt(t.access_token), now() + (t.expires_in ?? 3600) * 1000,
    t.refresh_token ? encrypt(t.refresh_token) : (prev?.refresh_token_enc ?? null), t.scope ?? SCOPE, now(), now(),
  );
}

async function accessToken(customerId: string, forceRefresh = false): Promise<string | null> {
  const row = db.prepare("SELECT * FROM shop_agent_links WHERE customer_id = ?").get(customerId) as any;
  if (!row) return null;
  if (!forceRefresh && row.access_expires_at - 120_000 > now()) return decrypt(row.access_token_enc);
  if (!row.refresh_token_enc) return null;
  const r = await postForm(`${SHOP}/oauth/token`, {
    grant_type: "refresh_token", refresh_token: decrypt(row.refresh_token_enc), resource: config.shopMcpResource,
  });
  if (!r.ok) {
    if (r.json.error === "invalid_grant") db.prepare("DELETE FROM shop_agent_links WHERE customer_id = ?").run(customerId);
    return null;
  }
  saveTokens(customerId, r.json);
  return r.json.access_token;
}

// ---------------------------------------------------------------- MCP calls

async function callShop(customerId: string, name: string, args: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(customerId, attempt > 0);
    if (!token) throw new CheckoutRejected("Customer hasn't connected Shop for order tracking: call connect_shop_orders first.");
    const res = await fetch(config.shopMcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "MCP-Protocol-Version": config.shopMcpProtocol,
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: {
          name, arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": config.shopMcpProtocol,
            "io.modelcontextprotocol/clientInfo": { name: "ucp-india-checkout", version: "0.1.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    if (res.status === 401 && attempt === 0) continue; // expired/revoked: refresh once
    const text = await res.text();
    const line = text.trim().startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5);
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      throw new Error(`Shop MCP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (j.error) throw new Error(`Shop MCP: ${j.error.message}`);
    const r = j.result ?? {};
    const data = r.structuredContent ?? (() => {
      try { return JSON.parse(r.content?.[0]?.text ?? "null"); } catch { return null; }
    })();
    if (r.isError) {
      throw new Error(`Shop MCP: ${(data?.messages ?? []).map((m: any) => m.content ?? m.code).join("; ") || "tool error"}`);
    }
    return data;
  }
  throw new CheckoutRejected("Shop sign-in expired: call connect_shop_orders again.");
}

// ---------------------------------------------------------------- orders

const minor = (totals: any[] | undefined) => (totals ?? []).find((t) => t.type === "total")?.amount;
const numericId = (gidOrNum: string | undefined | null) => String(gidOrNum ?? "").split("/").pop()!.split("?")[0];

function summarizeShopOrder(o: any) {
  const events: any[] = o.fulfillment?.events ?? [];
  const latest = [...events].sort((a, b) => Date.parse(b.occurred_at ?? 0) - Date.parse(a.occurred_at ?? 0))[0];
  const dest = o.fulfillment?.expectations?.[0]?.destination;
  return {
    shop_order_id: o.id,
    store: o.seller?.domain,
    store_name: o.seller?.name,
    title: o.label,
    placed_at: o.placed_at,
    status: o.status,
    payment_status: o.payment_status,
    delivery_status: o.delivery_status,
    latest_update: latest ? { at: latest.occurred_at, event: latest.type, detail: latest.status ?? latest.description } : undefined,
    total: minor(o.totals) != null ? { inr: minor(o.totals) / 100, currency: o.currency } : undefined,
    items: (o.line_items ?? []).map((l: any) => ({
      title: l.item?.title, quantity: l.quantity?.total, shipped: l.quantity?.fulfilled, status: l.status,
    })),
    shipping_to: dest ? [dest.address_locality, dest.address_region, dest.postal_code].filter(Boolean).join(", ") : undefined,
    tracking: events
      .filter((e) => e.tracking_number || e.tracking_url)
      .map((e) => ({ carrier: e.carrier, number: e.tracking_number, url: e.tracking_url, event: e.type, at: e.occurred_at })),
    order_page_url: o.permalink_url,
    return_url: o.return_url ?? undefined,
    shopify_order_id: o.shopify_order_id ? numericId(o.shopify_order_id) : undefined,
    note: SHOP_LAG_NOTE,
  };
}

/** All of the customer's Shop-tracked orders (any Shopify store, not only ours). */
export async function listShopOrders(customerId: string, opts: { query?: string; status?: "in_progress" | "all"; cursor?: string; limit?: number } = {}) {
  const data = await callShop(customerId, "search_orders", {
    orders: {
      ...(opts.query ? { query: opts.query } : {}),
      filters: { status: opts.status ?? "all" },
      pagination: { limit: Math.min(opts.limit ?? 10, MAX_PAGE), ...(opts.cursor ? { cursor: opts.cursor } : {}) },
    },
  });
  return {
    orders: (data?.orders ?? []).map((o: any) => {
      const s = summarizeShopOrder(o);
      return {
        shop_order_id: s.shop_order_id, store: s.store, store_name: s.store_name, title: s.title,
        placed_at: s.placed_at, status: s.status, delivery_status: s.delivery_status, total: s.total,
      };
    }),
    next_cursor: data?.pagination?.cursor ?? data?.pagination?.next_cursor ?? null,
  };
}

export async function getShopOrder(customerId: string, shopOrderId: string) {
  const data = await callShop(customerId, "get_order", { id: shopOrderId });
  return summarizeShopOrder(data?.order ?? data);
}

/**
 * Find the Shop view of an order we placed (matched on Shopify's numeric order id).
 * Returns null when the customer hasn't connected Shop or Shop doesn't track it.
 */
export async function findShopOrderFor(customerId: string, storeDomain: string, shopifyOrderGid: string) {
  if (!isShopOrdersConnected(customerId)) return null;
  const want = numericId(shopifyOrderGid);
  const bare = storeDomain.replace(/^www\./, "");
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) { // newest 30 orders is plenty for orders we just placed
    const list = await callShop(customerId, "search_orders", {
      orders: { filters: { status: "all" }, pagination: { limit: MAX_PAGE, ...(cursor ? { cursor } : {}) } },
    });
    const candidates = (list?.orders ?? []).filter((o: any) =>
      [o.seller?.domain, o.seller?.myshopify_domain].some((d: string) => d && d.replace(/^www\./, "") === bare),
    );
    for (const c of candidates) {
      const full = await getShopOrder(customerId, c.id);
      if (full.shopify_order_id === want) return full;
    }
    cursor = list?.pagination?.cursor ?? list?.pagination?.next_cursor;
    if (!cursor || !(list?.pagination?.has_next_page ?? true)) break;
  }
  return null;
}
