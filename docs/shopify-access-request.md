# Request to Shopify: order access for our agent

Send to your Shopify partner manager. If you don't have one, use the Shopify Help Center
(https://help.shopify.com) and ask to be routed to the agentic commerce / UCP team.

---

**Subject:** Agentic commerce: order scope, order webhooks and Shop MCP access for our agent

Hi,

We're building an agent on Shopify's UCP that prepares checkouts on Shopify stores in India for our
customers. The agent never completes payment: each customer pays on the store's own checkout page
through a link we send them. We have this working end to end with live stores (Checkout MCP, Global
Catalog, Sign in with Shop / buyer-linked tokens).

To keep customers updated after they pay, we'd like:

1. **`read_global_api_orders` scope** on our agent identity, so we can call `get_order` (Order MCP)
   for orders placed through our agent. Today our client-credentials token only carries
   `read_global_api_catalog_search write_global_api_app_events`.
2. **Order webhook subscription** (`orders/create`, `orders/updated`, `orders/delete`) delivered to
   `https://<our-domain>/webhooks/ucp/orders`. We verify `X-Shopify-Hmac-SHA256` with our client
   secret and de-duplicate on `X-Shopify-Webhook-Id`.
3. **`personal_agent` scope** for our Shop app client (resource `https://mcp.shop.com`), so signed-in
   customers can see order status and tracking through Shop MCP. Requesting it today returns
   `access_denied`.
4. **Rate limits** suitable for <expected checkouts per day> across Indian merchants, and confirmation
   that our use (agent acting for many customers, customer always pays on the merchant checkout) fits
   your terms.

Agent identity: "default" (Dev Dashboard → Agents), API key ending …59ff
Agent profile: https://<our-domain>/.well-known/ucp

Thanks,
<name, company, contact>
