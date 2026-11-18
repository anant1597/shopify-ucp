function env(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var ${name} (see .env.example)`);
}

const publicBaseUrl = env("PUBLIC_BASE_URL", "http://localhost:3000").replace(/\/$/, "");

export const config = {
  port: Number(env("PORT", "3000")),
  publicBaseUrl,
  get clientId() { return env("SHOPIFY_CLIENT_ID"); },
  get clientSecret() { return env("SHOPIFY_CLIENT_SECRET"); },
  agentProfileUrl: env("AGENT_PROFILE_URL", `${publicBaseUrl}/.well-known/ucp`),
  shopRedirectUri: env("SHOP_REDIRECT_URI", `${publicBaseUrl}/auth/shop/callback`),
  shopScopes: env(
    "SHOP_SCOPES",
    "openid email phone dev.ucp.shopping.checkout:manage dev.ucp.shopping.catalog.search:read",
  ),
  get encryptionKey() { return env("ENCRYPTION_KEY"); },
  partnerApiKeys: new Map(
    env("PARTNER_API_KEYS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const [name, key] = pair.split(":");
        return [key, name] as [string, string];
      }),
  ),
  dbPath: env("DB_PATH", "data/ucp.db"),

  // Shop MCP (order history across all Shopify stores). Needs a Shop app client enabled by Shopify for
  // the personal_agent scope. Defaults to Shop's public CLI client, which Shop allows for prototyping only.
  shopMcpClientId: env("SHOP_MCP_CLIENT_ID", "5c733ab2-1903-400a-891e-7ba20c09e2a3"),
  shopMcpClientSecret: process.env.SHOP_MCP_CLIENT_SECRET?.trim() || undefined,
  shopMcpUrl: "https://mcp.shop.com/",
  shopMcpResource: "https://mcp.shop.com",
  shopMcpProtocol: "2026-07-28",

  // Shopify endpoints
  shopifyTokenUrl: "https://api.shopify.com/auth/access_token",
  globalCatalogMcp: "https://catalog.shopify.com/api/ucp/mcp",
  shopIdentityIssuer: "https://accounts.shop.app",
  ucpVersion: "2026-08-25",
};
