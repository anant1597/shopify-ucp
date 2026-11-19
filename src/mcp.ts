/**
 * MCP server exposed to our own agents and partner agents at POST /mcp.
 * Each partner authenticates with an API key; customer ids are scoped per partner.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getProductDetails, searchProducts } from "./services/catalog.ts";
import {
  CheckoutRejected,
  getCheckoutOptions,
  getCheckoutStatus,
  prepareCheckout,
  updateCheckout,
} from "./services/checkout.ts";
import { askStore, cancelUnpaidCheckout, getCancellationOptions, getOrder } from "./services/orders.ts";
import { getShopOrder, isShopOrdersConnected, listShopOrders, startShopOrdersSignIn } from "./services/shopMcp.ts";
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
        "Products with customer_must_choose (Size, Color…) show only an example variant: ask the customer, then use " +
        "get_product_details for the exact variant_id. Otherwise use the returned variant_id and store with prepare_checkout.",
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
    "get_product_details",
    {
      description:
        "All options of a product (sizes, colours, packs) with stock, and, once every option is chosen, the exact " +
        "variant_id and price for prepare_checkout. selected maps option name to the customer's choice, e.g. " +
        "{\"Size\": \"9\", \"Color\": \"Raw Titanium\"}.",
      inputSchema: {
        product_id: z.string(),
        store: z.string().optional(),
        selected: z.record(z.string(), z.string()).optional(),
        pincode: z.string().optional(),
        buyer_ip: z.string().optional(),
      },
    },
    guard((a) => getProductDetails(a)),
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
    "get_checkout_options",
    {
      description:
        "Show what's on a prepared checkout before sending the pay link: items, delivery address, total, and the " +
        "store's shipping options (with cost and a cash_on_delivery flag) per shipping group. Use the option_id " +
        "values with update_checkout.",
      inputSchema: { customer_id: z.string(), checkout_id: z.string() },
    },
    guard((a) => getCheckoutOptions(a.checkout_id, scoped(a.customer_id))),
  );

  server.registerTool(
    "update_checkout",
    {
      description:
        "Change a prepared checkout: choose a shipping option, switch to another saved address, change quantities " +
        "(0 removes; new variants are added), or set discount codes. Returns the updated checkout with the same " +
        "pay_url. Confirm changes with the customer first. Never pays or places the order.",
      inputSchema: {
        customer_id: z.string(),
        checkout_id: z.string(),
        shipping: z
          .array(z.object({ group_id: z.string().optional(), option_id: z.string() }))
          .optional()
          .describe("group_id can be omitted when the checkout has one shipping group"),
        address_id: z.string().optional(),
        items: z.array(z.object({ variant_id: z.string(), quantity: z.number().int().min(0).max(20) })).optional(),
        discount_codes: z.array(z.string()).optional().describe("Replaces current codes; [] removes all"),
      },
    },
    guard((a) => updateCheckout({ ...a, customer_id: scoped(a.customer_id) })),
  );

  server.registerTool(
    "get_checkout_status",
    {
      description: "Check whether the customer has paid (status 'completed' with order_id) or the checkout is still open.",
      inputSchema: { customer_id: z.string(), checkout_id: z.string() },
    },
    guard((a) => getCheckoutStatus(a.checkout_id, scoped(a.customer_id))),
  );

  server.registerTool(
    "connect_shop_orders",
    {
      description:
        "One-time: let the customer connect their Shop account for order tracking. Returns a link with a code " +
        "prefilled; the customer opens it and approves (Shop handles any OTP). After that, list_my_orders and " +
        "get_my_order show their orders from every Shopify store, and get_order shows live status.",
      inputSchema: { customer_id: z.string() },
    },
    guard(async (a) => {
      const id = scoped(a.customer_id);
      if (isShopOrdersConnected(id)) return { already_connected: true };
      return startShopOrdersSignIn(id);
    }),
  );

  server.registerTool(
    "list_my_orders",
    {
      description:
        "The customer's orders from ANY Shopify store, as tracked by Shop (needs connect_shop_orders). " +
        "status 'in_progress' (default 'all'), optional search text. Use get_my_order for details.",
      inputSchema: {
        customer_id: z.string(),
        query: z.string().optional(),
        status: z.enum(["in_progress", "all"]).optional(),
        limit: z.number().int().min(1).max(10).optional(),
        cursor: z.string().optional(),
      },
    },
    guard((a) => listShopOrders(scoped(a.customer_id), a)),
  );

  server.registerTool(
    "get_my_order",
    {
      description:
        "Live details of one Shop-tracked order: payment and delivery status, latest update, items, tracking, " +
        "and the store's order page (where the customer can cancel or return, if the store allows).",
      inputSchema: { customer_id: z.string(), shop_order_id: z.string().describe("id from list_my_orders") },
    },
    guard((a) => getShopOrder(scoped(a.customer_id), a.shop_order_id)),
  );

  server.registerTool(
    "get_order",
    {
      description:
        "After the customer has paid: order number, status (processing / shipped / in_transit / delivered / " +
        "canceled), items, tracking links, refunds, and the store's order page link. Pass the checkout_id from " +
        "prepare_checkout (or the store's order id).",
      inputSchema: { customer_id: z.string(), order_ref: z.string().describe("checkout_id or store order id") },
    },
    guard((a) => getOrder(scoped(a.customer_id), a.order_ref)),
  );

  server.registerTool(
    "cancel_checkout",
    {
      description:
        "Cancel a checkout the customer has NOT paid yet (for example they changed their mind). The pay link stops " +
        "working. For paid orders use get_cancellation_options instead.",
      inputSchema: { customer_id: z.string(), checkout_id: z.string() },
    },
    guard((a) => cancelUnpaidCheckout(scoped(a.customer_id), a.checkout_id)),
  );

  server.registerTool(
    "get_cancellation_options",
    {
      description:
        "Customer wants to cancel or return a PAID order. Stores don't allow cancelling through the API, so this " +
        "returns the order's status, the store's own cancellation/refund/return policy, and the order page link " +
        "where the customer requests it. Relay these to the customer; don't promise a cancellation.",
      inputSchema: { customer_id: z.string(), order_ref: z.string(), buyer_ip: z.string().optional() },
    },
    guard((a) => getCancellationOptions(scoped(a.customer_id), a.order_ref, a.buyer_ip)),
  );

  server.registerTool(
    "ask_store",
    {
      description:
        "Ask a store a question in plain language: delivery times, shipping to a pincode, return policy, product " +
        "details. Answers come from the store.",
      inputSchema: { store: z.string(), question: z.string().max(2000), buyer_ip: z.string().optional() },
    },
    guard((a) => askStore(a.store, a.question, a.buyer_ip)),
  );

  return server;
}
