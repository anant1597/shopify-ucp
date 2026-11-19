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

const money = (m: any) => (m && typeof m.amount === "number" ? { inr: m.amount / 100, currency: m.currency } : undefined);

/** A variant's option values as { Size: "9", Color: "Raw Titanium" }. */
const variantOptions = (v: any): Record<string, string> | undefined => {
  const o = v?.options;
  if (!Array.isArray(o) || !o.length) return undefined;
  return Object.fromEntries(o.filter((x: any) => x?.name && x?.label).map((x: any) => [x.name, x.label]));
};

/** Product options, e.g. [{ name: "Size", values: ["5", "6", …] }]. Values carry availability when the store sends it. */
function productOptions(p: any) {
  return (p.options ?? [])
    .filter((o: any) => o?.name && Array.isArray(o.values) && o.values.length)
    .map((o: any) => ({
      name: o.name as string,
      values: o.values.slice(0, 40).map((v: any) => (v.available === false ? `${v.label} (sold out)` : v.label) as string),
    }))
    // Shopify's placeholder option for single-variant products.
    .filter((o: any) => !(o.values.length === 1 && /^default title$/i.test(o.values[0])));
}

/** Options the customer must pick (more than one value). */
const choicesOf = (options: { name: string; values: string[] }[]) => options.filter((o) => o.values.length > 1).map((o) => o.name);

function simplifyVariant(v: any, p?: any) {
  return {
    variant_id: v.id,
    title: v.title,
    options: variantOptions(v),
    price: money(v.price),
    available: v.availability?.available ?? v.available ?? undefined,
    store: shopDomainOf(v) ?? (p ? shopDomainOf(p) : undefined),
    url: cleanUrl(v.url),
  };
}

function simplifyProduct(p: any) {
  const variants = (p.variants ?? []).slice(0, 10).map((v: any) => simplifyVariant(v, p));
  const options = productOptions(p);
  const choose = choicesOf(options);
  return {
    product_id: p.id,
    title: p.title,
    store: shopDomainOf(p) ?? variants[0]?.store,
    price_range: p.price_range ? { min: money(p.price_range.min), max: money(p.price_range.max) } : undefined,
    url: cleanUrl(p.url) ?? variants[0]?.url,
    image: cleanUrl(p.media?.[0]?.url ?? p.images?.[0]?.url),
    options,
    ...(choose.length
      ? {
          customer_must_choose: choose,
          note: `Comes in several ${choose.join(" / ")} options. The variant below is only an example: ask the customer, then call get_product_details with their choices to get the variant_id.`,
        }
      : {}),
    variants,
  };
}

export interface ProductDetailsInput {
  product_id: string;
  /** Store domain, needed for store-level ids (gid://shopify/Product/…); catalog ids (gid://shopify/p/…) work without it. */
  store?: string;
  /** Customer's choices, e.g. { Size: "9", Color: "Raw Titanium" }. */
  selected?: Record<string, string>;
  pincode?: string;
  buyer_ip?: string;
}

/**
 * Full options of one product and, once every option is chosen, the exact variant (id, price, stock).
 * Catalog search only returns one example variant per product, so this is how a size/colour becomes a variant_id.
 */
export async function getProductDetails(input: ProductDetailsInput) {
  let endpoint = config.globalCatalogMcp;
  if (input.store && !input.product_id.startsWith("gid://shopify/p/")) {
    const s = await discoverStore(input.store);
    if (s.mcpEndpoint) endpoint = s.mcpEndpoint;
  }
  const context = { address_country: "IN", currency: "INR", language: "en-IN", ...(input.pincode ? { postal_code: input.pincode } : {}) };
  const call = (selected?: { name: string; label: string }[]) => {
    const catalog: Record<string, unknown> = { id: input.product_id, context, ...(selected?.length ? { selected } : {}) };
    if (input.buyer_ip) catalog.signals = { "dev.ucp.buyer_ip": input.buyer_ip };
    return callUcpTool<any>(endpoint, "get_product", { catalog }, {});
  };

  // First read the options so the customer's words ("9", "titanium") map to the store's exact labels.
  let res = await call();
  let p = res.product ?? res;
  if (!p?.id) throw new Error("Product not found");
  const rawOptions: any[] = (p.options ?? []).filter((o: any) => o?.name && Array.isArray(o.values));
  const options = productOptions(p);
  const choose = choicesOf(options);

  const chosen: { name: string; label: string }[] = [];
  const problems: string[] = [];
  for (const [key, want] of Object.entries(input.selected ?? {})) {
    const opt = rawOptions.find((o) => o.name.toLowerCase() === key.trim().toLowerCase());
    if (!opt) { problems.push(`"${key}" isn't an option of this product (options: ${options.map((o: any) => o.name).join(", ") || "none"})`); continue; }
    const w = String(want).trim().toLowerCase();
    const labels: string[] = opt.values.map((v: any) => v.label);
    const match = labels.find((l) => l.toLowerCase() === w) ?? labels.filter((l) => l.toLowerCase().includes(w)).sort((a, b) => a.length - b.length)[0];
    if (!match) problems.push(`${opt.name} "${want}" isn't available; choose from: ${labels.join(", ")}`);
    else chosen.push({ name: opt.name, label: match });
  }

  const stillToChoose = choose.filter((n) => !chosen.some((c) => c.name === n));
  let variant: ReturnType<typeof simplifyVariant> | null = null;
  let otherStores: { store: string | undefined; variant_id: string; price: any }[] = [];
  if (chosen.length) {
    res = await call(chosen);
    p = res.product ?? res;
  }
  if (!problems.length && !stillToChoose.length) {
    const want = Object.fromEntries(chosen.map((c) => [c.name, c.label]));
    const matching = (p.variants ?? []).filter((x: any) => {
      const o = variantOptions(x) ?? {};
      return Object.entries(want).every(([k, val]) => o[k] === val);
    });
    // A catalog product (gid://shopify/p/…) groups the same item from many stores, so the variants list mixes
    // sellers. Only the requested store's variant counts; the others are offered as alternatives.
    const isAvailable = (x: any) => (x.availability?.available ?? x.available) !== false;
    const store = bare(input.store);
    const mine = store ? matching.filter((x: any) => bare(shopDomainOf(x) ?? shopDomainOf(p)) === store) : matching;
    const v = mine.find(isAvailable) ?? mine[0];
    if (v) variant = simplifyVariant(v, p);
    else if (store && matching.length) problems.push(`${input.store} doesn't sell ${chosen.map((c) => `${c.name} ${c.label}`).join(", ") || "this item"}`);
    else problems.push(`The store has no variant for ${chosen.map((c) => `${c.name} ${c.label}`).join(", ")}`);
    if (!v || !isAvailable(v)) {
      otherStores = matching
        .filter((x: any) => x !== v && isAvailable(x) && bare(shopDomainOf(x)) !== store)
        .slice(0, 5)
        .map((x: any) => ({ store: shopDomainOf(x), variant_id: x.id, price: money(x.price) }));
    }
  }

  return {
    product_id: p.id,
    title: variant?.title ?? p.title,
    store: input.store ?? shopDomainOf(p) ?? (p.variants?.[0] ? shopDomainOf(p.variants[0]) : undefined),
    image: cleanUrl(p.variants?.[0]?.media?.[0]?.url ?? p.media?.[0]?.url),
    price_range: variant?.price
      ? { min: variant.price, max: variant.price }
      : p.price_range ? { min: money(p.price_range.min), max: money(p.price_range.max) } : undefined,
    // For catalog products the options cover every store that sells it; the variant below is the one store's.
    options,
    selected: Object.fromEntries(chosen.map((c) => [c.name, c.label])),
    ...(stillToChoose.length ? { still_to_choose: stillToChoose } : {}),
    ...(problems.length ? { problems } : {}),
    variant,
    ...(variant && variant.available === false ? { warning: `This combination is sold out at ${variant.store ?? "this store"}.` } : {}),
    ...(otherStores.length
      ? { other_stores_in_stock: otherStores, note: "Same item and options in stock at these stores (use one's variant_id with its store)." }
      : {}),
  };
}

const bare = (d?: string) => d?.toLowerCase().replace(/^www\./, "") || undefined;

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
