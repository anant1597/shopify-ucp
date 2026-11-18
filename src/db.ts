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

// Additive migrations for databases created before a column existed.
for (const sql of ["ALTER TABLE checkouts ADD COLUMN max_total_minor INTEGER"]) {
  try {
    db.exec(sql);
  } catch {
    /* column already exists */
  }
}

export const now = () => Date.now();
