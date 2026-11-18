import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { getAgentToken, invalidateAgentToken, isCachedAgentToken } from "../auth/agentToken.ts";

export class UcpError extends Error {
  code: number;
  data: unknown;
  httpStatus: number;
  constructor(message: string, code: number, data: unknown, httpStatus: number) {
    super(message);
    this.code = code;
    this.data = data;
    this.httpStatus = httpStatus;
  }
}

export interface CallOptions {
  /** Bearer token: agent token, or a buyer-linked token when the customer signed in with Shop. */
  token?: string;
  /** Real IP of the buyer we act for. Shopify requires it on token-tier calls. */
  buyerIp?: string;
  buyerUserAgent?: string;
  /** Needed for complete/cancel; we only ever send it for cancel. */
  idempotencyKey?: string;
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls a UCP tool on a Shopify MCP endpoint (per-store `/api/ucp/mcp` or the Global Catalog).
 * Handles JSON-RPC framing, required `meta`, buyer IP header and 429 backoff.
 */
const isAuthFailure = (e: unknown) =>
  e instanceof UcpError && (e.httpStatus === 401 || /authenticat|unauthori[sz]ed|invalid[_ ]token/i.test(e.message));

/**
 * Calls a UCP tool. If a store rejects our cached agent token, fetch a fresh one and retry once.
 * (Buyer tokens are not retried here; the caller falls back to the agent token.)
 */
export async function callUcpTool<T = any>(
  endpoint: string,
  tool: string,
  args: Record<string, unknown>,
  opts: CallOptions = {},
): Promise<T> {
  try {
    return await callOnce<T>(endpoint, tool, args, opts);
  } catch (e) {
    if (!isAuthFailure(e) || !isCachedAgentToken(opts.token)) throw e;
    invalidateAgentToken();
    return callOnce<T>(endpoint, tool, args, { ...opts, token: await getAgentToken() });
  }
}

async function callOnce<T>(
  endpoint: string,
  tool: string,
  args: Record<string, unknown>,
  opts: CallOptions,
): Promise<T> {
  const meta: Record<string, unknown> = { "ucp-agent": { profile: config.agentProfileUrl } };
  if (opts.idempotencyKey) meta["idempotency-key"] = opts.idempotencyKey;

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "tools/call",
    params: { name: tool, arguments: { meta, ...args } },
  });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.buyerIp) headers["Shopify-Buyer-IP"] = opts.buyerIp;

  const maxRetries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(endpoint, { method: "POST", headers, body });
    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
      await sleep(retryAfter * 1000 + Math.random() * 250);
      continue;
    }
    const text = await res.text();
    let json: any;
    try {
      json = parseRpc(text);
    } catch {
      throw new UcpError(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`, -1, null, res.status);
    }
    if (json.error) {
      throw new UcpError(json.error.message ?? "UCP error", json.error.code, json.error.data, res.status);
    }
    return unwrapToolResult<T>(json.result);
  }
}

/** Accepts plain JSON or a single SSE `data:` frame. */
function parseRpc(text: string): any {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const dataLine = t.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error("no data");
  return JSON.parse(dataLine.slice(5));
}

/** MCP tool results come back as structuredContent and/or a JSON text block. */
function unwrapToolResult<T>(result: any): T {
  if (!result) return result;
  // Business errors come back as isError + ucp.status "error". They still carry a continue_url,
  // but it points at the store HOMEPAGE, so it must never be treated as a pay link.
  const sc = result.structuredContent;
  if (result.isError || sc?.ucp?.status === "error") {
    const msgs: any[] = sc?.messages ?? [];
    const text =
      msgs.map((m) => `${m.code ?? "error"}: ${m.content ?? ""}${m.path ? ` (${m.path})` : ""}`).join("; ") ||
      result.content?.find((c: any) => c.type === "text")?.text?.slice(0, 300) ||
      "UCP tool error";
    throw new UcpError(text, -1, sc ?? null, 200);
  }
  if (sc) return sc as T;
  const textBlock = result.content?.find((c: any) => c.type === "text");
  if (textBlock) {
    try {
      return JSON.parse(textBlock.text) as T;
    } catch {
      if (result.isError) throw new UcpError(textBlock.text, -1, null, 200);
      return { text: textBlock.text } as T;
    }
  }
  return result as T;
}
