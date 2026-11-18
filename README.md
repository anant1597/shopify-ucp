# India Shopify checkout service (UCP)

Lets our agents, and partner agents we connect with, prepare orders on Shopify stores in India
and hand the customer a **card payment link**. It **never completes the purchase**: the customer
pays on the store's own checkout page.

## How it works

```
partner / our agent ──MCP (x-api-key)──▶  /mcp
   search_products ─────────────▶ Global Catalog  (ships_to IN, ships_from IN)
   upsert_customer / add_address  (our DB)
   get_shop_sign_in ────────────▶ "Sign in with Shop" link or device code (one time)
   prepare_checkout ────────────▶ store /.well-known/ucp → store /api/ucp/mcp create_checkout
                                    ├─ customer signed in?  buyer-linked token (store recognises them)
                                    ├─ else                 agent token (client credentials)
                                    ├─ auto-pick cheapest shipping, enforce max_total_inr
                                    └─ continue_url → stored encrypted → returns  /pay/<token>
                                 (no UCP on store → cart permalink fallback, totals estimated)
   get_checkout_options ────────▶ get_checkout  → items, address, total, shipping options (COD flagged)
   update_checkout ─────────────▶ update_checkout (full PUT) → shipping choice, address, qty, discount codes;
                                    re-reads after re-planning, keeps the customer's shipping pick,
                                    re-checks the price cap (pay link disabled while over it)
   get_checkout_status ─────────▶ get_checkout  → completed + order_id once the customer pays

customer ── /pay/<token> ──302──▶ store checkout page (pays by card; OTP/3DS happens there)
```

`complete_checkout` is never called. On Shopify, that tool submits a payment instrument and places
the order, and only trusted agents with a payment handler can use it. Indian stores don't publish
payment handlers, so the pay link is the only route anyway (and it keeps us out of PCI scope).

## After payment: orders, cancellation, store questions

| Tool | What it does |
|---|---|
| `get_order` | Order number, status (processing / shipped / in_transit / delivered / canceled), items, tracking, refunds, order page link |
| `cancel_checkout` | Cancels an **unpaid** checkout; our pay link stops working (410) |
| `get_cancellation_options` | Paid order: status + the store's own cancel/refund/return policy (via `ask_business`) + order page link |
| `ask_store` | Plain-language questions to the store (`ask_business`) |

Where order data comes from, best first:
1. **`get_order` (Order MCP)**: needs our agent token to carry the `read_global_api_orders` scope.
   Shopify grants it per agent; requesting it on the token does nothing. Ask your Shopify partner manager.
2. **Order webhooks** at `POST /webhooks/ucp/orders`: HMAC-SHA256 of the raw body with our client secret
   (`X-Shopify-Hmac-SHA256`), de-duplicated on `X-Shopify-Webhook-Id`, latest snapshot stored encrypted.
   Delivery URL is registered by Shopify (partner manager); there's no self-serve subscription yet.
3. **The completed checkout**: order id, order number and order page link, always available.

UCP has no "cancel order" or "start return" call. The store's order page (`permalink_url`) is the
canonical place for those, so agents send the customer there with the store's policy.

## Shipping choice decides the payment method

On many Indian stores a "Cash on Delivery" shipping option turns the pay page's payment section into
COD only (seen on Blue Tokai: no card, button says "Complete order"). So:

- new checkouts get the cheapest **prepaid** option (never COD when a prepaid option exists)
- `update_checkout` warns when the agent selects a COD option
- after an item or address change the store re-plans shipping; we restore the customer's earlier pick

## Customer sign-in (no repeated OTP)

1. `get_shop_sign_in` returns a link, or a short code for chat/voice. The customer signs in **once** on
   `accounts.shop.app`, and Shop handles the OTP. We never see or relay OTPs.
2. We store Shop's refresh token (AES-256-GCM encrypted) and renew access tokens silently.
3. For each store: Shop token-exchange (audience = store) → store auth server `jwt-bearer` →
   buyer-linked token. Checkouts created with it are tied to the customer's identity.
4. The customer only signs in again if they revoke access or Shop invalidates the refresh token.

Customers who never sign in still work: the checkout is created with the agent token, prefilled with
email, phone and address, and the store may ask for its own OTP on the pay page.

## Do we need an address?

Not to identify the customer: identity is our `customer_id` plus phone/email, or their Shop sign-in.
An address (or at least the pincode) gives an exact total with shipping and tax, checks the store
delivers there, and lets the pay page open prefilled. Without one, the customer enters it on the pay page.

## Setup

```bash
npm install
cp .env.example .env    # fill in values, see below
npm start
```

| Variable | Where it comes from |
|---|---|
| `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | Dev Dashboard → Agents → Agent identities → your identity → API credentials |
| `PUBLIC_BASE_URL` | A public HTTPS URL for this service. Stores fetch `${PUBLIC_BASE_URL}/.well-known/ucp`. In development use a tunnel (`cloudflared tunnel --url http://localhost:3000`) |
| Redirect URL | Add `${PUBLIC_BASE_URL}/auth/shop/callback` under **Redirect URLs** on the same agent identity |
| `ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `PARTNER_API_KEYS` | `name:key` pairs, e.g. `internal:…,acme:…`. Customer IDs are namespaced per partner |

Probe stores: `npm run probe -- www.boat-lifestyle.com snitch.co.in`

## Things Shopify requires

- `Shopify-Buyer-IP` must be the **real customer IP** on every authenticated call. Agents pass `buyer_ip`.
- `continue_url` grants access to the buyer's checkout. We store it encrypted, never log it, and only
  give out our `/pay/…` redirect.
- When a call fails, the store's error response also includes a `continue_url`, pointing to the store **homepage**.
  The client treats these as errors, never as pay links.
- Ask Shopify for higher rate limits before scaling (Checkout MCP is rate limited per buyer IP).

## Layout

```
src/server.ts              HTTP: /.well-known/ucp, /auth/shop/*, /pay/:token, /mcp
src/mcp.ts                 MCP tools for agents
src/services/checkout.ts   prepare → pay link, status, permalink fallback
src/services/catalog.ts    Global Catalog / per-store search
src/services/customers.ts  customers, addresses, phone normalisation
src/auth/agentToken.ts     client-credentials agent token
src/auth/shopIdentity.ts   Sign in with Shop, refresh, per-store buyer tokens
src/ucp/mcpClient.ts       JSON-RPC client (meta, buyer IP, 429 backoff, error unwrapping)
src/ucp/discovery.ts       store /.well-known/ucp + OAuth metadata (cached)
public/agent-profile.json  our UCP agent profile
scripts/probe.ts           store capability probe
```
