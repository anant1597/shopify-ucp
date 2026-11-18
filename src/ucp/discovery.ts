import { db, now } from "../db.ts";

export interface StoreInfo {
  domain: string;
  mcpEndpoint: string | null;
  authServer: string | null;
  capabilities: string[];
  checkoutOk: boolean;
}

const TTL_MS = 6 * 60 * 60 * 1000; // re-discover every 6h

export function normalizeDomain(input: string): string {
  const s = input.trim().toLowerCase();
  const url = new URL(s.startsWith("http") ? s : `https://${s}`);
  return url.host;
}

/**
 * Reads the store's `/.well-known/ucp` profile to find its MCP endpoint and capabilities,
 * and its OAuth protected-resource metadata to find the store's authorization server
 * (needed to turn a Shop sign-in into a store-scoped buyer token).
 */
export async function discoverStore(domainInput: string, force = false): Promise<StoreInfo> {
  const domain = normalizeDomain(domainInput);
  const cached = db.prepare("SELECT * FROM stores WHERE domain = ?").get(domain) as any;
  if (cached && !force && now() - cached.fetched_at < TTL_MS) return rowToInfo(cached);

  let mcpEndpoint: string | null = null;
  let capabilities: string[] = [];
  try {
    const res = await fetch(`https://${domain}/.well-known/ucp`, { redirect: "follow" });
    if (res.ok) {
      const profile: any = await res.json();
      const ucp = profile.ucp ?? {};
      capabilities = Object.keys(ucp.capabilities ?? {});
      const services = Object.values(ucp.services ?? {}).flat() as any[];
      mcpEndpoint = services.find((s) => s.transport === "mcp" && s.endpoint)?.endpoint ?? null;
    }
  } catch {
    /* not a UCP store (or not Shopify) */
  }

  let authServer: string | null = null;
  if (mcpEndpoint) {
    try {
      const origin = new URL(mcpEndpoint).origin;
      const res = await fetch(`${origin}/.well-known/oauth-protected-resource`);
      if (res.ok) authServer = ((await res.json()) as any).authorization_servers?.[0] ?? null;
    } catch {
      /* identity linking unavailable */
    }
  }

  const checkoutOk = !!mcpEndpoint && capabilities.includes("dev.ucp.shopping.checkout");
  db.prepare(
    `INSERT INTO stores (domain, mcp_endpoint, auth_server, capabilities, checkout_ok, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET mcp_endpoint=excluded.mcp_endpoint, auth_server=excluded.auth_server,
       capabilities=excluded.capabilities, checkout_ok=excluded.checkout_ok, fetched_at=excluded.fetched_at`,
  ).run(domain, mcpEndpoint, authServer, JSON.stringify(capabilities), checkoutOk ? 1 : 0, now());

  return { domain, mcpEndpoint, authServer, capabilities, checkoutOk };
}

function rowToInfo(r: any): StoreInfo {
  return {
    domain: r.domain,
    mcpEndpoint: r.mcp_endpoint,
    authServer: r.auth_server,
    capabilities: JSON.parse(r.capabilities ?? "[]"),
    checkoutOk: !!r.checkout_ok,
  };
}
