/**
 * MCP tools for the Claude custom connector. The customer is whoever signed in with Shop when the
 * connector was added, so no tool takes a customer id, and the buyer IP comes from their own browser.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../db.ts";
import { searchProducts } from "../services/catalog.ts";
import { CheckoutRejected, getCheckoutOptions, getCheckoutStatus, prepareCheckout, updateCheckout } from "../services/checkout.ts";
import { askStore, cancelUnpaidCheckout, getCancellationOptions, getOrder } from "../services/orders.ts";
import { getShopOrder, isShopOrdersConnected, listShopOrders, startShopOrdersSignIn } from "../services/shopMcp.ts";
import { addAddress, getCustomer, upsertCustomer } from "../services/customers.ts";
import { isShopLinked } from "../auth/shopIdentity.ts";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

const READ = { readOnlyHint: true, openWorldHint: true } as const;

export function buildConnectorServer(customerId: string) {
  const server = new McpServer(
    { name: "india-shopify-shopping", version: "0.1.0" },
    {
      instructions:
        "Shop on Shopify stores that deliver in India for the signed-in customer. Flow: search_products → confirm the " +
        "item, size/variant, quantity and delivery address with the customer → prepare_checkout → give them the pay link. " +
        "Nothing is ever bought or paid by these tools: the customer pays on the store's own checkout page. " +
        "Prefer stores whose prices are in INR. Show prices in ₹.",
    },
  );

  const buyerIp = () => {
    const row = db.prepare("SELECT last_ip FROM customers WHERE id = ?").get(customerId) as any;
    if (!row?.last_ip) throw new CheckoutRejected("Reconnect the connector in Claude settings so we can verify your location.");
    return row.last_ip as string;
  };

  const guard =
    <A,>(fn: (a: A) => Promise<unknown> | unknown) =>
    async (a: A) => {
      try {
        return ok(await fn(a));
      } catch (e) {
        return fail(e instanceof CheckoutRejected ? e.message : `Error: ${(e as Error).message}`);
      }
    };

  const addresses = () =>
    (db.prepare("SELECT id, line1, line2, city, state, pincode, is_default FROM addresses WHERE customer_id = ? ORDER BY is_default DESC, rowid DESC")
      .all(customerId) as any[]).map((a) => ({ ...a, is_default: !!a.is_default }));

  server.registerTool(
    "get_my_profile",
    {
      title: "My shopping profile",
      description: "The signed-in customer's name, email, phone, saved delivery addresses, and whether order tracking is on.",
      inputSchema: {},
      annotations: READ,
    },
    guard(() => {
      const c = getCustomer(customerId)!;
      return {
        name: [c.first_name, c.last_name].filter(Boolean).join(" ") || null,
        email: c.email, phone: c.phone,
        signed_in_with_shop: isShopLinked(customerId),
        order_tracking: isShopOrdersConnected(customerId),
        addresses: addresses(),
      };
    }),
  );

  server.registerTool(
    "update_my_details",
    {
      title: "Update my details",
      description: "Set the customer's name or Indian mobile number (stores need a phone for delivery).",
      inputSchema: { first_name: z.string().optional(), last_name: z.string().optional(), phone: z.string().optional() },
      annotations: { idempotentHint: true },
    },
    guard((a) => {
      const c = upsertCustomer({ id: customerId, ...a });
      return { name: [c.first_name, c.last_name].filter(Boolean).join(" "), phone: c.phone };
    }),
  );

  server.registerTool(
    "add_address",
    {
      title: "Save delivery address",
      description: "Save a delivery address in India. Spell the state in full (e.g. Karnataka). Confirm it with the customer first.",
      inputSchema: {
        line1: z.string(), line2: z.string().optional(), city: z.string(),
        state: z.string().describe("Full state name, e.g. Karnataka"),
        pincode: z.string().regex(/^\d{6}$/), recipient_name: z.string().optional(), phone: z.string().optional(),
        is_default: z.boolean().optional(),
      },
    },
    guard((a) => {
      const c = getCustomer(customerId)!;
      const [first, ...rest] = (a.recipient_name ?? "").trim().split(/\s+/).filter(Boolean);
      const addr = addAddress({
        customer_id: customerId, line1: a.line1, line2: a.line2 ?? null, city: a.city, state: a.state, pincode: a.pincode,
        first_name: first ?? c.first_name, last_name: rest.join(" ") || c.last_name, phone: a.phone ?? c.phone,
        is_default: a.is_default,
      });
      return { address_id: addr.id, saved: `${addr.line1}, ${addr.city} ${addr.pincode}` };
    }),
  );

  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description:
        "Search products on Shopify stores that ship within India (or inside one store). Prices in INR. " +
        "Use the variant_id and store from results with prepare_checkout.",
      inputSchema: {
        query: z.string(),
        store: z.string().optional().describe("Store domain to search within, e.g. bluetokaicoffee.com"),
        pincode: z.string().optional(),
        max_price_inr: z.number().optional(),
        limit: z.number().int().min(1).max(20).optional(),
        cursor: z.string().optional(),
      },
      annotations: READ,
    },
    guard((a) => searchProducts({ ...a, limit: a.limit ?? 8 })),
  );

  server.registerTool(
    "prepare_checkout",
    {
      title: "Prepare checkout and pay link",
      description:
        "Build a checkout on the store and return pay_url: the customer opens it and pays on the store's own page " +
        "(card, UPI, etc.). This never pays or places the order. Confirm item, quantity, store and address first. " +
        "Show the total and the pay_url as a link.",
      inputSchema: {
        store: z.string(),
        items: z.array(z.object({ variant_id: z.string(), quantity: z.number().int().min(1).max(20) })).min(1),
        address_id: z.string().optional().describe("Defaults to the default saved address"),
        max_total_inr: z.number().positive().optional().describe("Refuse if the store's total is higher"),
        discount_codes: z.array(z.string()).optional(),
      },
    },
    guard((a) => prepareCheckout({ ...a, customer_id: customerId, buyer_ip: buyerIp(), partner: "claude" })),
  );

  server.registerTool(
    "get_checkout_options",
    {
      title: "Checkout options",
      description: "Items, address, total and the store's shipping options (cost, cash_on_delivery flag) for a prepared checkout.",
      inputSchema: { checkout_id: z.string() },
      annotations: READ,
    },
    guard((a) => getCheckoutOptions(a.checkout_id, customerId)),
  );

  server.registerTool(
    "update_checkout",
    {
      title: "Change checkout",
      description:
        "Change shipping option, address, quantities (0 removes) or discount codes on a prepared checkout. The pay link stays the same. " +
        "Avoid cash-on-delivery shipping: on many Indian stores it removes card/UPI payment.",
      inputSchema: {
        checkout_id: z.string(),
        shipping: z.array(z.object({ group_id: z.string().optional(), option_id: z.string() })).optional(),
        address_id: z.string().optional(),
        items: z.array(z.object({ variant_id: z.string(), quantity: z.number().int().min(0).max(20) })).optional(),
        discount_codes: z.array(z.string()).optional(),
      },
    },
    guard((a) => updateCheckout({ ...a, customer_id: customerId })),
  );

  server.registerTool(
    "get_checkout_status",
    {
      title: "Has it been paid?",
      description: "Whether the customer has paid (status 'completed' with the order number) or the checkout is still open.",
      inputSchema: { checkout_id: z.string() },
      annotations: READ,
    },
    guard((a) => getCheckoutStatus(a.checkout_id, customerId)),
  );

  server.registerTool(
    "cancel_checkout",
    {
      title: "Cancel unpaid checkout",
      description: "Cancel a checkout that hasn't been paid; its pay link stops working. For paid orders use get_cancellation_options.",
      inputSchema: { checkout_id: z.string() },
      annotations: { destructiveHint: true },
    },
    guard((a) => cancelUnpaidCheckout(customerId, a.checkout_id)),
  );

  server.registerTool(
    "get_order",
    {
      title: "Order status",
      description: "Status, items, tracking and the store's order page for an order placed through prepare_checkout.",
      inputSchema: { order_ref: z.string().describe("checkout_id from prepare_checkout, or the store's order id") },
      annotations: READ,
    },
    guard((a) => getOrder(customerId, a.order_ref)),
  );

  server.registerTool(
    "connect_order_tracking",
    {
      title: "Turn on order tracking",
      description: "One-time link so the customer can approve order tracking on Shop (all Shopify stores). Show the link.",
      inputSchema: {},
    },
    guard(async () => (isShopOrdersConnected(customerId) ? { already_connected: true } : startShopOrdersSignIn(customerId))),
  );

  server.registerTool(
    "list_my_orders",
    {
      title: "My orders",
      description: "The customer's orders from any Shopify store, as tracked by Shop (needs order tracking on).",
      inputSchema: {
        query: z.string().optional(),
        status: z.enum(["in_progress", "all"]).optional(),
        limit: z.number().int().min(1).max(10).optional(),
        cursor: z.string().optional(),
      },
      annotations: READ,
    },
    guard((a) => listShopOrders(customerId, a)),
  );

  server.registerTool(
    "get_my_order",
    {
      title: "Order details",
      description: "Live details of one order from list_my_orders: payment, delivery, items, tracking, store order page.",
      inputSchema: { shop_order_id: z.string() },
      annotations: READ,
    },
    guard((a) => getShopOrder(customerId, a.shop_order_id)),
  );

  server.registerTool(
    "get_cancellation_options",
    {
      title: "Cancel or return a paid order",
      description:
        "Stores don't allow cancelling through an API. Returns the order status, the store's cancellation/return policy, " +
        "and the order page where the customer requests it. Don't promise a cancellation.",
      inputSchema: { order_ref: z.string() },
      annotations: READ,
    },
    guard((a) => getCancellationOptions(customerId, a.order_ref, buyerIp())),
  );

  server.registerTool(
    "ask_store",
    {
      title: "Ask the store",
      description: "Ask a store a plain-language question: delivery time to a pincode, return policy, product details.",
      inputSchema: { store: z.string(), question: z.string().max(2000) },
      annotations: READ,
    },
    guard((a) => askStore(a.store, a.question, buyerIp())),
  );

  return server;
}
