import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";

mkdirSync(dirname(config.dbPath), { recursive: true });
export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,           -- your own customer id
  email       TEXT,
  phone       TEXT,                       -- E.164, e.g. +919812345678
  first_name  TEXT,
  last_name   TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS addresses (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  first_name  TEXT, last_name TEXT, phone TEXT,
  line1       TEXT NOT NULL, line2 TEXT,
  city        TEXT NOT NULL, state TEXT NOT NULL,
  pincode     TEXT NOT NULL, country TEXT NOT NULL DEFAULT 'IN',
  is_default  INTEGER NOT NULL DEFAULT 0
);

-- One Shop identity per customer. Tokens are encrypted at rest.
CREATE TABLE IF NOT EXISTS shop_links (
  customer_id        TEXT PRIMARY KEY REFERENCES customers(id),
  shop_sub           TEXT,
  access_token_enc   TEXT NOT NULL,
  access_expires_at  INTEGER NOT NULL,
  refresh_token_enc  TEXT,
  scope              TEXT,
  linked_at          INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- Pending OAuth sign-ins (state + PKCE verifier). Short lived.
CREATE TABLE IF NOT EXISTS oauth_states (
  state         TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_to     TEXT,
  created_at    INTEGER NOT NULL
);

-- Cached per-store UCP discovery.
CREATE TABLE IF NOT EXISTS stores (
  domain       TEXT PRIMARY KEY,           -- storefront domain, e.g. www.boat-lifestyle.com
  mcp_endpoint TEXT,
  auth_server  TEXT,
  capabilities TEXT,                       -- JSON array of capability names
  checkout_ok  INTEGER NOT NULL DEFAULT 0,
  fetched_at   INTEGER NOT NULL
);

-- Every checkout we prepared. continue_url is encrypted; we hand out our own pay link.
CREATE TABLE IF NOT EXISTS checkouts (
  id                 TEXT PRIMARY KEY,
  customer_id        TEXT NOT NULL,
  partner            TEXT,
  store_domain       TEXT NOT NULL,
  method             TEXT NOT NULL,        -- 'ucp' | 'permalink'
  ucp_checkout_id    TEXT,
  status             TEXT NOT NULL,
  total_minor        INTEGER,
  currency           TEXT,
  continue_url_enc   TEXT NOT NULL,
  pay_token          TEXT NOT NULL UNIQUE,
  order_id           TEXT,
  order_url          TEXT,
  buyer_signed_in    INTEGER NOT NULL DEFAULT 0,
  buyer_ip           TEXT,                 -- needed for follow-up status reads (Shopify-Buyer-IP)
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  expires_at         INTEGER
);
`);

db.exec(`
-- Orders placed through our pay links. Latest snapshot only (UCP: each payload is the full current state).
CREATE TABLE IF NOT EXISTS orders (
  order_id          TEXT PRIMARY KEY,          -- gid://shopify/Order/...
  checkout_id       TEXT NOT NULL,             -- our chk_...
  customer_id       TEXT NOT NULL,
  store_domain      TEXT NOT NULL,
  label             TEXT,                      -- e.g. #1042
  permalink_enc     TEXT,                      -- store's order status page (grants access: encrypted)
  snapshot_enc      TEXT,                      -- latest full UCP order JSON (encrypted)
  snapshot_source   TEXT,                      -- 'get_order' | 'webhook'
  updated_at        INTEGER NOT NULL
);

-- Customer's Shop MCP connection (scope personal_agent, resource https://mcp.shop.com): order history
-- across all Shopify stores. Separate from shop_links because it's a different client/scope.
CREATE TABLE IF NOT EXISTS shop_agent_links (
  customer_id        TEXT PRIMARY KEY,
  access_token_enc   TEXT NOT NULL,
  access_expires_at  INTEGER NOT NULL,
  refresh_token_enc  TEXT,
  scope              TEXT,
  linked_at          INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- Claude custom connector (we are the OAuth server; signing in = Sign in with Shop).
CREATE TABLE IF NOT EXISTS connector_clients (
  client_id      TEXT PRIMARY KEY,
  client_name    TEXT,
  redirect_uris  TEXT NOT NULL,            -- JSON array
  created_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_auth_requests (
  id              TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  state           TEXT,
  code_challenge  TEXT NOT NULL,
  scope           TEXT,
  customer_id     TEXT,                    -- set once Shop sign-in completes
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_codes (
  code_hash       TEXT PRIMARY KEY,
  client_id       TEXT NOT NULL,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  customer_id     TEXT NOT NULL,
  expires_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_tokens (
  token_hash   TEXT PRIMARY KEY,           -- sha256 of the token; tokens themselves are never stored
  kind         TEXT NOT NULL,              -- access | refresh
  client_id    TEXT NOT NULL,
  customer_id  TEXT NOT NULL,
  expires_at   INTEGER NOT NULL
);

-- Website: sign-in attempts, sessions (cookie token hashed) and chat conversations.
CREATE TABLE IF NOT EXISTS web_logins (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash   TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS web_conversations (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL,
  messages_json  TEXT NOT NULL,           -- Claude API messages, append-only
  display_json   TEXT NOT NULL,           -- what the UI shows (text + product/checkout cards)
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

-- Website chat spend per day (UTC), estimated from each response's token usage.
CREATE TABLE IF NOT EXISTS chat_usage (
  day       TEXT PRIMARY KEY,
  usd       REAL NOT NULL,
  requests  INTEGER NOT NULL
);

-- Webhook delivery ids we've processed (X-Shopify-Webhook-Id), for de-duplication.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id  TEXT PRIMARY KEY,
  received_at  INTEGER NOT NULL
);
`);

// Additive migrations for databases created before a column existed.
for (const sql of [
  "ALTER TABLE checkouts ADD COLUMN max_total_minor INTEGER",
  "ALTER TABLE customers ADD COLUMN last_ip TEXT", // last IP seen from the customer's own browser
]) {
  try {
    db.exec(sql);
  } catch {
    /* column already exists */
  }
}

export const now = () => Date.now();
