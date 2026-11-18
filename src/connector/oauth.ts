/**
 * OAuth 2.1 authorization server for the Claude custom connector (MCP authorization spec):
 *   - protected resource + authorization server metadata, dynamic client registration
 *   - /oauth/authorize: the customer signs in with Shop (that IS the login), we never see an OTP
 *   - after Shop: optional "also track my orders" (Shop device approval), then back to Claude
 *   - /oauth/token: authorization_code (PKCE S256 required) and rotating refresh tokens
 * Tokens are random strings; only their sha256 is stored.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { db, now } from "../db.ts";
import { randomToken } from "../crypto.ts";
import { buildShopSignInUrl } from "../auth/shopIdentity.ts";
import { getCustomer } from "../services/customers.ts";
import { isShopOrdersConnected, startShopOrdersSignIn } from "../services/shopMcp.ts";

export const CONNECTOR_PATH = "/connector/mcp";
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 60 * 24 * 3600 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TTL_MS = 30 * 60 * 1000;

const sha = (s: string) => createHash("sha256").update(s).digest("base64url");
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const resourceMetadataUrl = () => `${config.publicBaseUrl}/.well-known/oauth-protected-resource`;

/** Real client IP: Cloudflare/tunnel header first, then the first X-Forwarded-For hop, then the socket. */
export function clientIp(req: IncomingMessage): string | null {
  const cf = req.headers["cf-connecting-ip"] as string | undefined;
  const xff = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  const ip = cf || xff || req.socket.remoteAddress || null;
  return ip?.replace(/^::ffff:/, "") ?? null;
}

/** Remember the IP the customer's own browser used (Shopify wants the real buyer IP on checkout calls). */
export function rememberCustomerIp(customerId: string, req: IncomingMessage) {
  const ip = clientIp(req);
  if (ip && !/^(127\.|::1$|10\.|192\.168\.)/.test(ip)) {
    db.prepare("UPDATE customers SET last_ip = ? WHERE id = ?").run(ip, customerId);
  }
}

export function customerForAccessToken(header: string | undefined): string | null {
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  const row = db.prepare("SELECT customer_id, expires_at FROM connector_tokens WHERE token_hash = ? AND kind = 'access'")
    .get(sha(token)) as any;
  return row && row.expires_at > now() ? row.customer_id : null;
}

// ---------------------------------------------------------------- helpers

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, status: number, title: string, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 16px;line-height:1.5;color:#1a1a1a;background:#fff}
  .btn{display:block;text-align:center;padding:.8rem 1rem;border-radius:10px;text-decoration:none;font-weight:600;margin:.75rem 0}
  .primary{background:#5a31f4;color:#fff}.secondary{border:1px solid #ccc;color:#1a1a1a}
  .muted{color:#666;font-size:.9rem}
  @media (prefers-color-scheme: dark){body{background:#111;color:#eee}.secondary{color:#eee;border-color:#444}.muted{color:#aaa}}
</style>
<h2>${esc(title)}</h2>${body}`);
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64_000) throw new Error("Body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if ((req.headers["content-type"] ?? "").includes("application/json")) return raw ? JSON.parse(raw) : {};
  return Object.fromEntries(new URLSearchParams(raw));
}

function isAllowedRedirect(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1"].includes(x.hostname));
  } catch {
    return false;
  }
}

function issueTokens(clientId: string, customerId: string) {
  const access = randomToken(32);
  const refresh = randomToken(32);
  const ins = db.prepare("INSERT INTO connector_tokens (token_hash, kind, client_id, customer_id, expires_at) VALUES (?, ?, ?, ?, ?)");
  ins.run(sha(access), "access", clientId, customerId, now() + ACCESS_TTL_S * 1000);
  ins.run(sha(refresh), "refresh", clientId, customerId, now() + REFRESH_TTL_MS);
  db.prepare("DELETE FROM connector_tokens WHERE expires_at < ?").run(now());
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: "shopping" };
}

/**
 * After Shop sign-in, reuse the customer we already have for this Shop identity, so the website and the
 * Claude connector share one customer (addresses, checkouts, orders).
 */
export function settleCustomer(tempId: string): string {
  const link = db.prepare("SELECT shop_sub FROM shop_links WHERE customer_id = ?").get(tempId) as any;
  if (!link?.shop_sub) return tempId;
  const existing = db.prepare(
    `SELECT customer_id FROM shop_links WHERE shop_sub = ? AND customer_id != ?
       AND (customer_id LIKE 'shopper:%' OR customer_id LIKE 'claude:%') ORDER BY linked_at LIMIT 1`,
  ).get(link.shop_sub, tempId) as any;
  if (!existing) return tempId;
  const id = existing.customer_id as string;
  const t = db.prepare("SELECT email, phone, first_name, last_name, last_ip FROM customers WHERE id = ?").get(tempId) as any;
  db.prepare("DELETE FROM shop_links WHERE customer_id = ?").run(id);
  db.prepare("UPDATE shop_links SET customer_id = ? WHERE customer_id = ?").run(id, tempId);
  db.prepare(
    `UPDATE customers SET email = COALESCE(email, ?), phone = COALESCE(phone, ?), first_name = COALESCE(first_name, ?),
       last_name = COALESCE(last_name, ?), last_ip = COALESCE(?, last_ip) WHERE id = ?`,
  ).run(t?.email ?? null, t?.phone ?? null, t?.first_name ?? null, t?.last_name ?? null, t?.last_ip ?? null, id);
  db.prepare("DELETE FROM customers WHERE id = ?").run(tempId);
  return id;
}

function pendingRequest(id: string | null) {
  if (!id) return null;
  const row = db.prepare("SELECT * FROM connector_auth_requests WHERE id = ?").get(id) as any;
  return row && now() - row.created_at < REQUEST_TTL_MS ? row : null;
}

// ---------------------------------------------------------------- routes

/** Returns true when the request was handled. */
export async function handleConnectorOAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const base = config.publicBaseUrl;
  const p = url.pathname;

  // RFC 9728 protected resource metadata (also under the resource path suffix, which some clients try first)
  if (req.method === "GET" && (p === "/.well-known/oauth-protected-resource" || p === `/.well-known/oauth-protected-resource${CONNECTOR_PATH}`)) {
    json(res, 200, {
      resource: `${base}${CONNECTOR_PATH}`,
      authorization_servers: [base],
      scopes_supported: ["shopping"],
      bearer_methods_supported: ["header"],
      resource_name: "India Shopify Shopping",
    });
    return true;
  }

  // RFC 8414 authorization server metadata
  if (req.method === "GET" && (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration")) {
    json(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["shopping"],
    });
    return true;
  }

  // RFC 7591 dynamic client registration (Claude registers itself here)
  if (req.method === "POST" && p === "/oauth/register") {
    const body: any = await readForm(req).catch(() => ({}));
    const uris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!uris.length || !uris.every(isAllowedRedirect)) {
      json(res, 400, { error: "invalid_redirect_uri", error_description: "redirect_uris must be https URLs" });
      return true;
    }
    const clientId = `cc_${randomUUID()}`;
    db.prepare("INSERT INTO connector_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
      .run(clientId, String(body.client_name ?? "").slice(0, 100) || null, JSON.stringify(uris), now());
    json(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: body.client_name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    return true;
  }

  // Start: validate the client, remember the request, send the customer to Sign in with Shop
  if (req.method === "GET" && p === "/oauth/authorize") {
    const q = url.searchParams;
    const client = db.prepare("SELECT * FROM connector_clients WHERE client_id = ?").get(q.get("client_id") ?? "") as any;
    const redirectUri = q.get("redirect_uri") ?? "";
    if (!client || !(JSON.parse(client.redirect_uris) as string[]).includes(redirectUri)) {
      html(res, 400, "Can't connect", "<p>This connection request isn't valid. Remove the connector in Claude and add it again.</p>");
      return true;
    }
    const back = (params: Record<string, string>) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (q.get("state")) u.searchParams.set("state", q.get("state")!);
      res.writeHead(302, { location: u.toString(), "cache-control": "no-store" });
      res.end();
      return true;
    };
    if (q.get("response_type") !== "code") return back({ error: "unsupported_response_type" });
    if (!q.get("code_challenge") || (q.get("code_challenge_method") ?? "S256") !== "S256") {
      return back({ error: "invalid_request", error_description: "PKCE S256 required" });
    }

    const reqId = randomToken(18);
    const customerId = `shopper:${randomUUID()}`; // replaced by the existing customer if this Shop identity connected before
    db.prepare(
      `INSERT INTO connector_auth_requests (id, client_id, redirect_uri, state, code_challenge, scope, customer_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(reqId, client.client_id, redirectUri, q.get("state"), q.get("code_challenge"), q.get("scope"), customerId, now());
    db.prepare("DELETE FROM connector_auth_requests WHERE created_at < ?").run(now() - REQUEST_TTL_MS);

    const shopUrl = buildShopSignInUrl(customerId, `${base}/oauth/signed-in?req=${reqId}`);
    rememberCustomerIp(customerId, req);
    res.writeHead(302, { location: shopUrl, "cache-control": "no-store" });
    res.end();
    return true;
  }

  // Back from Shop: settle the customer, offer order tracking, then continue to Claude
  if (req.method === "GET" && p === "/oauth/signed-in") {
    const r = pendingRequest(url.searchParams.get("req"));
    if (!r) {
      html(res, 400, "Link expired", "<p>Go back to Claude and connect again.</p>");
      return true;
    }
    const customerId = settleCustomer(r.customer_id);
    if (customerId !== r.customer_id) db.prepare("UPDATE connector_auth_requests SET customer_id = ? WHERE id = ?").run(customerId, r.id);
    rememberCustomerIp(customerId, req);
    const c = getCustomer(customerId);
    const who = [c?.first_name, c?.last_name].filter(Boolean).join(" ") || c?.email || "your Shop account";
    const ordersDone = isShopOrdersConnected(customerId);
    html(res, 200, "Signed in with Shop", `
<p>Connected as <b>${esc(who)}</b>. Claude can now prepare checkouts on Shopify stores for you.
You always pay yourself, on the store's own page.</p>
${ordersDone ? `<p>Order tracking is already on.</p>` : `
<p><b>Optional:</b> let Claude see your orders and delivery status from any Shopify store.</p>
<a class="btn secondary" href="${base}/oauth/track-orders?req=${esc(r.id)}" target="_blank" rel="noopener">Turn on order tracking (approve on Shop)</a>
<p class="muted">Opens Shop in a new tab. Approve there, then come back and continue.</p>`}
<a class="btn primary" href="${base}/oauth/finish?req=${esc(r.id)}">Continue to Claude</a>`);
    return true;
  }

  if (req.method === "GET" && p === "/oauth/track-orders") {
    const r = pendingRequest(url.searchParams.get("req"));
    if (!r) {
      html(res, 400, "Link expired", "<p>You can turn on order tracking later by asking Claude.</p>");
      return true;
    }
    const s = await startShopOrdersSignIn(r.customer_id);
    res.writeHead(302, { location: s.sign_in_url, "cache-control": "no-store" });
    res.end();
    return true;
  }

  if (req.method === "GET" && p === "/oauth/finish") {
    const r = pendingRequest(url.searchParams.get("req"));
    if (!r || !db.prepare("SELECT 1 FROM shop_links WHERE customer_id = ?").get(r.customer_id)) {
      html(res, 400, "Link expired", "<p>Go back to Claude and connect again.</p>");
      return true;
    }
    db.prepare("DELETE FROM connector_auth_requests WHERE id = ?").run(r.id);
    const code = randomToken(24);
    db.prepare(
      "INSERT INTO connector_codes (code_hash, client_id, redirect_uri, code_challenge, customer_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(sha(code), r.client_id, r.redirect_uri, r.code_challenge, r.customer_id, now() + CODE_TTL_MS);
    const u = new URL(r.redirect_uri);
    u.searchParams.set("code", code);
    if (r.state) u.searchParams.set("state", r.state);
    res.writeHead(302, { location: u.toString(), "cache-control": "no-store" });
    res.end();
    return true;
  }

  if (req.method === "POST" && p === "/oauth/token") {
    const b = await readForm(req).catch(() => ({}) as Record<string, string>);
    const bad = (error: string, d?: string) => (json(res, 400, { error, ...(d ? { error_description: d } : {}) }), true);

    if (b.grant_type === "authorization_code") {
      const row = db.prepare("SELECT * FROM connector_codes WHERE code_hash = ?").get(sha(b.code ?? "")) as any;
      db.prepare("DELETE FROM connector_codes WHERE code_hash = ? OR expires_at < ?").run(sha(b.code ?? ""), now());
      if (!row || row.expires_at < now()) return bad("invalid_grant", "code expired or already used");
      if (row.client_id !== b.client_id || row.redirect_uri !== b.redirect_uri) return bad("invalid_grant", "client or redirect_uri mismatch");
      if (!b.code_verifier || sha(b.code_verifier) !== row.code_challenge) return bad("invalid_grant", "PKCE verification failed");
      json(res, 200, issueTokens(row.client_id, row.customer_id));
      return true;
    }

    if (b.grant_type === "refresh_token") {
      const h = sha(b.refresh_token ?? "");
      const row = db.prepare("SELECT * FROM connector_tokens WHERE token_hash = ? AND kind = 'refresh'").get(h) as any;
      if (!row || row.expires_at < now() || (b.client_id && b.client_id !== row.client_id)) return bad("invalid_grant");
      db.prepare("DELETE FROM connector_tokens WHERE token_hash = ?").run(h); // rotate
      json(res, 200, issueTokens(row.client_id, row.customer_id));
      return true;
    }
    return bad("unsupported_grant_type");
  }

  return false;
}
