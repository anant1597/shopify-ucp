/**
 * MCP tools for the Claude custom connector. The customer is whoever signed in with Shop when the
 * connector was added, so no tool takes a customer id, and the buyer IP comes from their own browser.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "../db.ts";
import { getProductDetails, searchProducts } from "../services/catalog.ts";
import { CheckoutRejected, confirmCheckout, listCustomerOrders, getCheckoutOptions, getCheckoutStatus, prepareCheckout, updateCheckout } from "../services/checkout.ts";
import { askStore, cancelUnpaidCheckout, getCancellationOptions, getOrder } from "../services/orders.ts";
import { getShopOrder, isShopOrdersConnected, listShopOrders, startShopOrdersSignIn } from "../services/shopMcp.ts";
import { addAddress, getCustomer, upsertCustomer } from "../services/customers.ts";
import { isShopLinked } from "../auth/shopIdentity.ts";
import { listDeliveryAddresses } from "../services/addresses.ts";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

const READ = { readOnlyHint: true, openWorldHint: true } as const;

/**
 * Per customer: variants seen in search whose product has size/colour/etc. choices, and the variants actually
 * resolved from the customer's choices. prepare_checkout refuses the first kind until it becomes the second, so an
 * assistant can't check out search's example variant without asking. In memory: after a restart nothing is
 * blocked (the variant is simply unknown).
 */
type Choices = { needs: Map<string, { title: string; options: string[] }>; chosen: Set<string> };
const choiceState = new Map<string, Choices>();
function choicesFor(customerId: string): Choices {
  let c = choiceState.get(customerId);
  if (!c) {
    if (choiceState.size >= 2000) choiceState.delete(choiceState.keys().next().value!);
    c = { needs: new Map(), chosen: new Set() };
    choiceState.set(customerId, c);
  }
  if (c.needs.size > 1000) c.needs.clear();
  return c;
}

export function buildConnectorServer(customerId: string) {
  const server = new McpServer(
    { name: "india-shopify-shopping", version: "0.1.0" },
    {
      instructions:
        "Shop on Shopify stores that deliver in India for the signed-in customer. Go through every check with the " +
        "customer before giving a pay link: 1) search_products; 2) if the product has options (customer_must_choose, " +
        "e.g. Size, Color), ask the customer to pick each one and the quantity in one question, listing the choices, " +
        "then get_product_details with their picks for the exact variant_id (never pick an option for them); " +
        "3) ask where to deliver: call get_delivery_addresses and let the customer pick from the list (their saved " +
        "addresses and the ones from their Shop account, numbered, one line each with pincode); only if none suits them, " +
        "take a new one (add_address: line 1, city, state, 6-digit pincode). If the list is empty but " +
        "shop_checkout_address_available, offer the address in their Shop account (use_shop_address). Never ask them " +
        "to type an address that's already in the list, and never ask for a phone the profile already has; " +
        "4) prepare_checkout builds the order on the store and returns a " +
        "review with no pay link: it checks the store delivers to that pincode and gives the delivery option and total; " +
        "if it doesn't deliver, say so and ask for another address; 5) show the review (item, options, quantity, " +
        "address, delivery, contact details, total) and ask the customer to confirm; 6) only after they say yes, confirm_checkout returns " +
        "the pay link, and the store's page opens with their name, phone, email and address filled in. " +
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
    (db.prepare("SELECT id, line1, line2, city, state, pincode, is_default, source FROM addresses WHERE customer_id = ? ORDER BY is_default DESC, rowid DESC")
      .all(customerId) as any[]).map(({ source, ...a }) => ({ ...a, is_default: !!a.is_default, from_shop: source === "shop" }));

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
    "get_delivery_addresses",
    {
      title: "Delivery addresses to choose from",
      description:
        "The customer's delivery addresses to offer as a pick list: ones saved here plus the ones in their Shop " +
        "account (from_shop). Show them numbered, one line each with the pincode, and let the customer pick; offer " +
        "'a new address' as the last choice. Use the chosen address_id with prepare_checkout.",
      inputSchema: {},
      annotations: READ,
    },
    guard(() => listDeliveryAddresses(customerId)),
  );

  server.registerTool(
    "list_orders_placed",
    {
      title: "Orders placed here",
      description:
        "Orders the customer confirmed through this service, newest first: paid (with order number), awaiting " +
        "payment (with pay link), expired or cancelled. Re-checks unpaid ones with the store.",
      inputSchema: {},
      annotations: READ,
    },
    guard(() => listCustomerOrders(customerId)),
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
    guard(async (a) => {
      const r: any = await searchProducts({ ...a, limit: a.limit ?? 8 });
      // Some stores ignore the catalog price filter, so enforce it here.
      if (a.max_price_inr != null) {
        r.products = r.products.filter((p: any) => {
          const prices = (p.variants ?? []).map((v: any) => v.price?.inr).filter((n: any) => typeof n === "number");
          const min = prices.length ? Math.min(...prices) : p.price_range?.min?.inr;
          return min == null || min <= a.max_price_inr!;
        });
      }
      const c = choicesFor(customerId);
      for (const p of r.products ?? []) {
        if (!p.customer_must_choose?.length) continue;
        for (const v of p.variants ?? []) if (!c.chosen.has(v.variant_id)) c.needs.set(v.variant_id, { title: p.title, options: p.customer_must_choose });
      }
      return r;
    }),
  );

  server.registerTool(
    "get_product_details",
    {
      title: "Product options and exact variant",
      description:
        "All options of a product (sizes, colours, packs) with what's in stock, and, once the customer has chosen every " +
        "option, the exact variant_id and price to use with prepare_checkout. Pass the customer's choices in selected, " +
        "e.g. {\"Size\": \"9\", \"Color\": \"Raw Titanium\"}. Use the product_id from search_products.",
      inputSchema: {
        product_id: z.string(),
        store: z.string().optional().describe("Store domain from search_products"),
        selected: z.record(z.string(), z.string()).optional().describe("Option name → the customer's choice"),
        pincode: z.string().optional(),
      },
      annotations: READ,
    },
    guard(async (a) => {
      const d = await getProductDetails({ ...a, buyer_ip: (db.prepare("SELECT last_ip FROM customers WHERE id = ?").get(customerId) as any)?.last_ip ?? undefined });
      const c = choicesFor(customerId);
      if (d.variant && !d.still_to_choose && !d.problems) {
        c.chosen.add(d.variant.variant_id);
        c.needs.delete(d.variant.variant_id);
      }
      return d;
    }),
  );

  server.registerTool(
    "prepare_checkout",
    {
      title: "Build order for review",
      description:
        "Build the order on the store for the address the customer chose and check it: whether the store delivers " +
        "there, the delivery option and cost, and the exact total. Returns a review and NO pay link; show it to the " +
        "customer and call confirm_checkout only after they agree. Needs address_id (a saved address the customer " +
        "picked) or use_shop_address=true (customer chose the address in their Shop account). For products with " +
        "options, the variant_id must come from get_product_details with the customer's own choices.",
      inputSchema: {
        store: z.string(),
        items: z.array(z.object({ variant_id: z.string(), quantity: z.number().int().min(1).max(20) })).min(1),
        address_id: z.string().optional().describe("Saved address the customer chose for this order"),
        use_shop_address: z.boolean().optional().describe("Customer chose the address saved in their Shop account"),
        max_total_inr: z.number().positive().optional().describe("Refuse if the store's total is higher"),
        discount_codes: z.array(z.string()).optional(),
      },
    },
    guard((a) => {
      const c = choicesFor(customerId);
      for (const it of a.items) {
        const need = c.needs.get(it.variant_id);
        if (need && !c.chosen.has(it.variant_id)) {
          throw new CheckoutRejected(
            `"${need.title}" comes in different ${need.options.join(" / ")} options and the customer hasn't chosen yet. ` +
              `Ask them which ${need.options.join(" and ")} they want (and how many), then call get_product_details with ` +
              `their choices and use the variant_id it returns.`,
          );
        }
      }
      if (!a.address_id && !a.use_shop_address) {
        const saved = addresses();
        throw new CheckoutRejected(
          "Ask the customer where to deliver first. " +
            (saved.length ? `Saved addresses: ${saved.map((x) => `${x.id} (${x.line1}, ${x.city} ${x.pincode})`).join("; ")}. ` : "No saved addresses. ") +
            (isShopLinked(customerId) ? "They can also use the address in their Shop account (use_shop_address). " : "") +
            "Or take a new address and save it with add_address. Then call prepare_checkout with their choice.",
        );
      }
      if (a.use_shop_address && !a.address_id && !isShopLinked(customerId)) {
        throw new CheckoutRejected("The customer isn't signed in with Shop, so there's no Shop address. Ask for an address and save it with add_address.");
      }
      const { use_shop_address, ...rest } = a;
      return prepareCheckout({
        ...rest, customer_id: customerId, buyer_ip: buyerIp(), partner: "claude",
        require_confirmation: true, no_default_address: !a.address_id,
      });
    }),
  );

  server.registerTool(
    "confirm_checkout",
    {
      title: "Confirm order and get pay link",
      description:
        "Call only after the customer has seen the review from prepare_checkout (item, options, quantity, address, " +
        "delivery, total) and said yes. Re-checks delivery and the total with the store, then returns pay_url: the " +
        "customer pays on the store's own page. Nothing is charged by this tool.",
      inputSchema: { checkout_id: z.string() },
    },
    guard((a) => confirmCheckout(a.checkout_id, customerId)),
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
        "Change shipping option, address, quantities (0 removes) or discount codes on a prepared checkout. If it isn't " +
        "confirmed yet, show the customer the updated summary and get their yes before confirm_checkout. " +
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
