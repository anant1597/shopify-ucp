import { config } from "../config.ts";
import { callUcpTool } from "../ucp/mcpClient.ts";
import { getAgentToken } from "../auth/agentToken.ts";
import { discoverStore } from "../ucp/discovery.ts";

export interface SearchInput {
  query: string;
  /** Limit to one store (storefront domain). Omit to search all Shopify stores shipping to India. */
  store?: string;
  pincode?: string;
  min_price_inr?: number;
  max_price_inr?: number;
  limit?: number;
  cursor?: string;
  buyer_ip?: string;
  /** Only merchants based in India (ships_from IN). Default true. */
  indian_merchants_only?: boolean;
}

export async function searchProducts(input: SearchInput) {
  const filters: Record<string, unknown> = { available: true };
  if (input.min_price_inr != null || input.max_price_inr != null) {
    filters.price = {
      ...(input.min_price_inr != null ? { min: Math.round(input.min_price_inr * 100) } : {}),
      ...(input.max_price_inr != null ? { max: Math.round(input.max_price_inr * 100) } : {}),
    };
  }

  const catalog: Record<string, unknown> = {
    query: input.query,
    context: { address_country: "IN", currency: "INR", language: "en-IN", ...(input.pincode ? { postal_code: input.pincode } : {}) },
    pagination: { limit: Math.min(input.limit ?? 10, 50), ...(input.cursor ? { cursor: input.cursor } : {}) },
    filters,
  };
  if (input.buyer_ip) catalog.signals = { "dev.ucp.buyer_ip": input.buyer_ip };

  let endpoint = config.globalCatalogMcp;
  if (input.store) {
    const s = await discoverStore(input.store);
    if (!s.mcpEndpoint) throw new Error(`${s.domain} does not expose a UCP endpoint`);
    endpoint = s.mcpEndpoint;
  } else {
    filters.ships_to = { country: "IN", ...(input.pincode ? { postal_code: input.pincode } : {}) };
    if (input.indian_merchants_only !== false) filters.ships_from = [{ country: "IN" }];
  }

  // Shopify rejects token-tier calls without Shopify-Buyer-IP ("AuthenticationFailed"), so only send the
  // agent token when we know the buyer's IP; otherwise search anonymously (lower rate limits).
  const token = input.buyer_ip ? await getAgentToken().catch(() => undefined) : undefined;
  const res: any = await callUcpTool(endpoint, "search_catalog", { catalog }, { token, buyerIp: input.buyer_ip });
  return {
    products: (res.products ?? res.catalog?.products ?? []).map(simplifyProduct),
    next_cursor: res.pagination?.cursor ?? res.pagination?.next_cursor ?? null,
  };
}

/** Flatten a UCP product into something an LLM agent can reason about cheaply. */
// The catalog returns some URLs HTML-escaped (`&amp;`), which breaks every query parameter after the first.
const cleanUrl = (u: unknown) => (typeof u === "string" ? u.replace(/&amp;/g, "&") : undefined);

function simplifyProduct(p: any) {
  const money = (m: any) => (m && typeof m.amount === "number" ? { inr: m.amount / 100, currency: m.currency } : undefined);
  const variants = (p.variants ?? []).slice(0, 10).map((v: any) => ({
    variant_id: v.id,
    title: v.title,
    price: money(v.price),
    available: v.availability?.available ?? v.available ?? undefined,
    store: shopDomainOf(v) ?? shopDomainOf(p),
    url: cleanUrl(v.url),
  }));
  return {
    product_id: p.id,
    title: p.title,
    store: shopDomainOf(p) ?? variants[0]?.store,
    price_range: p.price_range ? { min: money(p.price_range.min), max: money(p.price_range.max) } : undefined,
    url: cleanUrl(p.url) ?? variants[0]?.url,
    image: cleanUrl(p.media?.[0]?.url ?? p.images?.[0]?.url),
    variants,
  };
}

function shopDomainOf(x: any): string | undefined {
  const seller = x?.seller ?? x?.shop ?? x?.merchant;
  const url = seller?.url ?? seller?.domain ?? x?.url;
  if (!url) return undefined;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).host;
  } catch {
    return undefined;
  }
}
