import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.ts";
import { buildMcpServer } from "./mcp.ts";
import { handleShopCallback } from "./auth/shopIdentity.ts";
import { resolvePayLink } from "./services/checkout.ts";

const agentProfile = readFileSync(new URL("../public/agent-profile.json", import.meta.url), "utf8");

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end(body);
}

const page = (title: string, msg: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 16px">
<h2>${title}</h2><p>${msg}</p></body>`;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function partnerFor(req: IncomingMessage): string | null {
  const key = (req.headers["x-api-key"] as string) ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return key ? (config.partnerApiKeys.get(key) ?? null) : null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", config.publicBaseUrl);
  try {
    // Our UCP agent profile — stores fetch this on every call.
    // Stores reject profiles that aren't cacheable ("Invalid cache control"), so no `no-store` here.
    if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/.well-known/ucp") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" });
      return res.end(agentProfile);
    }

    // Shop sign-in: bounce to accounts.shop.app (only to that host).
    if (req.method === "GET" && url.pathname === "/auth/shop/start") {
      const target = url.searchParams.get("u") ?? "";
      if (!target.startsWith(`${config.shopIdentityIssuer}/oauth/authorize?`)) return send(res, 400, "Bad sign-in link");
      res.writeHead(302, { location: target, "cache-control": "no-store" });
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/auth/shop/callback") {
      const err = url.searchParams.get("error");
      if (err) return send(res, 400, page("Sign-in cancelled", "You can close this window."), "text/html");
      const { returnTo } = await handleShopCallback(url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "");
      if (returnTo?.startsWith("https://")) {
        res.writeHead(302, { location: returnTo });
        return res.end();
      }
      return send(res, 200, page("You're signed in", "You can close this window and go back to the chat."), "text/html");
    }

    // Pay link → store's own checkout page (customer pays by card there).
    if (req.method === "GET" && url.pathname.startsWith("/pay/")) {
      const target = resolvePayLink(url.pathname.slice(5));
      if (!target) return send(res, 410, page("Link expired", "Ask the assistant for a fresh payment link."), "text/html");
      res.writeHead(302, { location: target, "cache-control": "no-store", "referrer-policy": "no-referrer" });
      return res.end();
    }

    // MCP for agents (stateless streamable HTTP).
    if (url.pathname === "/mcp") {
      const partner = partnerFor(req);
      if (!partner) return send(res, 401, JSON.stringify({ error: "invalid api key" }), "application/json");
      if (req.method !== "POST") return send(res, 405, "Method not allowed");
      const mcp = buildMcpServer(partner);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      return transport.handleRequest(req, res, await readJson(req));
    }

    if (url.pathname === "/health") return send(res, 200, "ok");
    send(res, 404, "Not found");
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, page("Something went wrong", (e as Error).message), "text/html");
  }
});

server.listen(config.port, () => {
  console.log(`UCP checkout service on :${config.port}`);
  console.log(`  agent profile : ${config.agentProfileUrl}`);
  console.log(`  shop redirect : ${config.shopRedirectUri}`);
  console.log(`  partners      : ${[...config.partnerApiKeys.values()].join(", ") || "(none — set PARTNER_API_KEYS)"}`);
});
