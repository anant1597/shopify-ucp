/**
 * Website routes: Sign in with Shop → session cookie → chat.
 *   GET  /                 the chat page
 *   GET  /login            start Sign in with Shop
 *   GET  /web/signed-in    back from Shop: session cookie, then /
 *   POST /logout
 *   GET  /api/me           profile (401 when signed out)
 *   GET  /api/conversation?id=…
 *   POST /api/chat         {conversation_id?, message} → server-sent events
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { config } from "../config.ts";
import { db, now } from "../db.ts";
import { randomToken } from "../crypto.ts";
import { buildShopSignInUrl, isShopLinked } from "../auth/shopIdentity.ts";
import { getCustomer } from "../services/customers.ts";
import { isShopOrdersConnected } from "../services/shopMcp.ts";
import { rememberCustomerIp, settleCustomer } from "../connector/oauth.ts";
import { getConversation, runChat, type ChatEvent } from "./chat.ts";

const SESSION_DAYS = 30;
const LOGIN_TTL_MS = 15 * 60 * 1000;
const sha = (s: string) => createHash("sha256").update(s).digest("base64url");
const secure = config.publicBaseUrl.startsWith("https://");
const pagePath = new URL("../../public/web/index.html", import.meta.url);

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]),
  );
}

const cookie = (name: string, value: string, maxAgeS: number) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;

function sessionCustomer(req: IncomingMessage): string | null {
  const sid = cookies(req).sid;
  if (!sid) return null;
  const row = db.prepare("SELECT customer_id, expires_at FROM web_sessions WHERE token_hash = ?").get(sha(sid)) as any;
  if (!row || row.expires_at < now() || !isShopLinked(row.customer_id)) return null;
  return row.customer_id;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage, limit = 32_000): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("Message too long");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export async function handleWeb(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;

  if (req.method === "GET" && (p === "/" || p === "/index.html")) {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
      "content-security-policy": "default-src 'self'; img-src * data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    });
    res.end(readFileSync(pagePath));
    return true;
  }

  if (req.method === "GET" && p === "/login") {
    const loginId = randomToken(18);
    const customerId = `shopper:${randomUUID()}`;
    db.prepare("INSERT INTO web_logins (id, customer_id, created_at) VALUES (?, ?, ?)").run(loginId, customerId, now());
    db.prepare("DELETE FROM web_logins WHERE created_at < ?").run(now() - LOGIN_TTL_MS);
    const shopUrl = buildShopSignInUrl(customerId, `${config.publicBaseUrl}/web/signed-in?l=${loginId}`);
    rememberCustomerIp(customerId, req);
    // Bind the sign-in to this browser so a sign-in link can't be finished in someone else's.
    res.writeHead(302, { location: shopUrl, "set-cookie": cookie("lid", loginId, 900), "cache-control": "no-store" });
    res.end();
    return true;
  }

  if (req.method === "GET" && p === "/web/signed-in") {
    const loginId = url.searchParams.get("l") ?? "";
    const row = db.prepare("SELECT * FROM web_logins WHERE id = ?").get(loginId) as any;
    db.prepare("DELETE FROM web_logins WHERE id = ?").run(loginId);
    if (!row || now() - row.created_at > LOGIN_TTL_MS || cookies(req).lid !== loginId || !isShopLinked(row.customer_id)) {
      res.writeHead(302, { location: "/?signin=failed" });
      res.end();
      return true;
    }
    const customerId = settleCustomer(row.customer_id);
    rememberCustomerIp(customerId, req);
    const sid = randomToken(32);
    db.prepare("INSERT INTO web_sessions (token_hash, customer_id, expires_at) VALUES (?, ?, ?)")
      .run(sha(sid), customerId, now() + SESSION_DAYS * 86400_000);
    db.prepare("DELETE FROM web_sessions WHERE expires_at < ?").run(now());
    res.writeHead(302, { location: "/", "set-cookie": [cookie("sid", sid, SESSION_DAYS * 86400), cookie("lid", "", 0)] });
    res.end();
    return true;
  }

  if (req.method === "POST" && p === "/logout") {
    const sid = cookies(req).sid;
    if (sid) db.prepare("DELETE FROM web_sessions WHERE token_hash = ?").run(sha(sid));
    res.writeHead(204, { "set-cookie": cookie("sid", "", 0) });
    res.end();
    return true;
  }

  if (!p.startsWith("/api/")) return false;
  const customerId = sessionCustomer(req);
  if (!customerId) {
    json(res, 401, { error: "signed_out" });
    return true;
  }

  if (req.method === "GET" && p === "/api/me") {
    const c = getCustomer(customerId)!;
    json(res, 200, {
      name: [c.first_name, c.last_name].filter(Boolean).join(" ") || null,
      email: c.email,
      order_tracking: isShopOrdersConnected(customerId),
    });
    return true;
  }

  if (req.method === "GET" && p === "/api/conversation") {
    const conv = getConversation(customerId, url.searchParams.get("id") ?? "");
    json(res, conv ? 200 : 404, conv ?? { error: "not_found" });
    return true;
  }

  if (req.method === "POST" && p === "/api/chat") {
    // JSON-only (cross-site forms can't send it) on top of the SameSite cookie.
    if (!(req.headers["content-type"] ?? "").includes("application/json")) {
      json(res, 415, { error: "json_required" });
      return true;
    }
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      json(res, 400, { error: (e as Error).message });
      return true;
    }
    const message = String(body.message ?? "").trim().slice(0, 4000);
    if (!message) {
      json(res, 400, { error: "empty_message" });
      return true;
    }
    rememberCustomerIp(customerId, req); // the real buyer IP Shopify asks for
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const emit = (e: ChatEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    await runChat(customerId, typeof body.conversation_id === "string" ? body.conversation_id : null, message, emit);
    res.end();
    return true;
  }

  json(res, 404, { error: "not_found" });
  return true;
}
