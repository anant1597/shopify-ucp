/**
 * MCP server exposed to our own agents and partner agents at POST /mcp.
 * Each partner authenticates with an API key; customer ids are scoped per partner.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchProducts } from "./services/catalog.ts";
import { CheckoutRejected, getCheckoutStatus, prepareCheckout } from "./services/checkout.ts";
import { addAddress, getCustomer, getDefaultAddress, upsertCustomer } from "./services/customers.ts";
import { buildShopSignInUrl, isShopLinked, startDeviceSignIn } from "./auth/shopIdentity.ts";
import { config } from "./config.ts";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

export function buildMcpServer(partner: string) {
  const scoped = (customerId: string) => (partner === "internal" ? customerId : `${partner}:${customerId}`);
  const server = new McpServer({ name: "india-shopify-checkout", version: "0.1.0" });

  const guard =
    <A,>(fn: (a: A) => Promise<unknown> | unknown) =>
    async (a: A) => {
      try {
        return ok(await fn(a));
      } catch (e) {
        return fail(e instanceof CheckoutRejected ? e.message : `Error: ${(e as Error).message}`);
      }
    };

  server.registerTool(
    "search_products",
    {
      description:
        "Search products across Shopify stores that ship to India (or within one store). Prices are in INR. " +
        "Use the returned variant_id and store with prepare_checkout.",
      inputSchema: {
        query: z.string(),
        store: z.string().optional().describe("Storefront domain to search within, e.g. www.boat-lifestyle.com"),
        pincode: z.string().optional(),
        min_price_inr: z.number().optional(),
        max_price_inr: z.number().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().optional(),
        buyer_ip: z.string().optional(),
      },
    },
    guard((a) => searchProducts(a)),
  );

  server.registerTool(
    "upsert_customer",
    {
      description: "Create or update a customer. Phone (Indian mobile) or email is needed by most stores.",
      inputSchema: {
        customer_id: z.string(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
      },
    },
    guard((a) => {
      const c = upsertCustomer({ ...a, id: scoped(a.customer_id) });
      return { ...c, id: a.customer_id, shop_signed_in: isShopLinked(c.id), default_address: getDefaultAddress(c.id) ?? null };
    }),
  );

  server.registerTool(
    "add_address",
    {
      description: "Save a shipping address for a customer (optional; the customer can also enter it on the pay page).",
      inputSchema: {
        customer_id: z.string(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        phone: z.string().optional(),
        line1: z.string(),
        line2: z.string().optional(),
        city: z.string(),
        state: z.string().describe("Indian state, e.g. Karnataka or KA"),
        pincode: z.string().regex(/^\d{6}$/),
        is_default: z.boolean().optional(),
      },
    },
    guard((a) => {
      const addr = addAddress({
        ...a,
        customer_id: scoped(a.customer_id),
        first_name: a.first_name ?? null,
        last_name: a.last_name ?? null,
        phone: a.phone ?? null,
        line2: a.line2 ?? null,
      });
      return { address_id: addr.id };
    }),
  );

  server.registerTool(
    "get_shop_sign_in",
    {
      description:
        "Get a one-time 'Sign in with Shop' link (or device code) for the customer. After they sign in once, " +
        "future checkouts are tied to their Shop identity, so stores recognise them without a fresh OTP. " +
        "Send the link to the customer; never ask them for the OTP yourself.",
      inputSchema: {
        customer_id: z.string(),
        mode: z.enum(["link", "device_code"]).default("link"),
      },
    },
    guard(async (a) => {
      const id = scoped(a.customer_id);
      if (isShopLinked(id)) return { already_signed_in: true };
      if (a.mode === "device_code") return { ...(await startDeviceSignIn(id)), mode: "device_code" };
      const start = `${config.publicBaseUrl}/auth/shop/start?u=${encodeURIComponent(buildShopSignInUrl(id))}`;
      return { mode: "link", sign_in_url: start, note: "Link is valid for 15 minutes." };
    }),
  );

  server.registerTool(
    "prepare_checkout",
    {
      description:
        "Build a checkout on the store for the customer and return a pay_url the customer opens to pay by card. " +
        "This NEVER places or pays for the order. Always confirm item, quantity and store with the customer first.",
      inputSchema: {
        customer_id: z.string(),
        buyer_ip: z.string().describe("The end customer's real IP address (required by Shopify)"),
        store: z.string().describe("Storefront domain, e.g. www.boat-lifestyle.com"),
        items: z.array(z.object({ variant_id: z.string(), quantity: z.number().int().min(1).max(20) })).min(1),
        address_id: z.string().optional(),
        max_total_inr: z.number().positive().optional(),
        discount_codes: z.array(z.string()).optional(),
      },
    },
    guard(async (a) => {
      const id = scoped(a.customer_id);
      if (!getCustomer(id)) throw new CheckoutRejected("Unknown customer: call upsert_customer first");
      return prepareCheckout({ ...a, customer_id: id, partner });
    }),
  );

  server.registerTool(
    "get_checkout_status",
    {
      description: "Check whether the customer has paid (status 'completed' with order_id) or the checkout is still open.",
      inputSchema: { customer_id: z.string(), checkout_id: z.string() },
    },
    guard((a) => getCheckoutStatus(a.checkout_id, scoped(a.customer_id))),
  );

  return server;
}
