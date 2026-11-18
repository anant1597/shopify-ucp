/**
 * "Sign in with Shop" (UCP identity linking, delegated IdP = accounts.shop.app).
 *
 *  1. Customer signs in ONCE on Shop's own page (Shop does the OTP, we never see it).
 *     Two ways to start it:
 *       - Redirect flow (authorization code + PKCE): send them a link to /auth/shop/start
 *       - Device flow: show/send a short code + URL; good for WhatsApp / voice agents
 *  2. We store Shop's refresh token (encrypted) and silently refresh access tokens.
 *  3. Per store, we exchange the Shop token for a store-scoped buyer token:
 *       Shop token-exchange (audience = store)  ->  store auth server jwt-bearer grant
 *     Checkouts created with that token are tied to the signed-in buyer, so the store
 *     recognises them and the customer does not need a fresh OTP.
 */
import { config } from "../config.ts";
import { db, now } from "../db.ts";
import { decrypt, encrypt, pkcePair, randomToken } from "../crypto.ts";
import { discoverStore } from "../ucp/discovery.ts";
import { ensureCustomer, updateCustomerFromIdentity } from "../services/customers.ts";

const SHOP = config.shopIdentityIssuer;
const STATE_TTL_MS = 15 * 60 * 1000;

async function tokenRequest(url: string, params: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params }),
  });
  const json: any = await res.json().catch(() => ({}));
  return { ok: res.ok && !json.error, status: res.status, json };
}

// ---------------------------------------------------------------- redirect flow

export function buildShopSignInUrl(customerId: string, returnTo?: string): string {
  ensureCustomer(customerId);
  const state = randomToken();
  const { verifier, challenge } = pkcePair();
  db.prepare(
    "INSERT INTO oauth_states (state, customer_id, code_verifier, return_to, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(state, customerId, verifier, returnTo ?? null, now());

  const u = new URL(`${SHOP}/oauth/authorize`);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.shopRedirectUri,
    scope: config.shopScopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

export async function handleShopCallback(code: string, state: string) {
  const row = db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(state) as any;
  db.prepare("DELETE FROM oauth_states WHERE state = ? OR created_at < ?").run(state, now() - STATE_TTL_MS);
  if (!row || now() - row.created_at > STATE_TTL_MS) throw new Error("Sign-in link expired. Please start again.");

  const r = await tokenRequest(`${SHOP}/oauth/token`, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.shopRedirectUri,
    code_verifier: row.code_verifier,
  });
  if (!r.ok) throw new Error(`Shop token exchange failed (${r.status}): ${JSON.stringify(r.json).slice(0, 300)}`);
  await saveShopTokens(row.customer_id, r.json);
  return { customerId: row.customer_id as string, returnTo: row.return_to as string | null };
}

// ---------------------------------------------------------------- device flow

export async function startDeviceSignIn(customerId: string) {
  ensureCustomer(customerId);
  const res = await fetch(`${SHOP}/oauth/device`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, scope: config.shopScopes }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.device_code) {
    throw new Error(`Device sign-in failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  void pollDeviceCode(customerId, json.device_code, json.interval ?? 5, json.expires_in ?? 600);
  return {
    verification_uri: json.verification_uri as string,
    verification_uri_complete: (json.verification_uri_complete ?? json.verification_uri) as string,
    user_code: json.user_code as string,
    expires_in: json.expires_in as number,
  };
}

async function pollDeviceCode(customerId: string, deviceCode: string, intervalS: number, expiresInS: number) {
  const deadline = Date.now() + expiresInS * 1000;
  let interval = intervalS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const r = await tokenRequest(`${SHOP}/oauth/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
    });
    if (r.ok) return saveShopTokens(customerId, r.json);
    if (r.json.error === "slow_down") interval += 5;
    else if (r.json.error !== "authorization_pending") return; // denied / expired
  }
}

// ---------------------------------------------------------------- token storage & refresh

async function saveShopTokens(customerId: string, t: any) {
  const prev = db.prepare("SELECT refresh_token_enc FROM shop_links WHERE customer_id = ?").get(customerId) as any;
  const refreshEnc = t.refresh_token ? encrypt(t.refresh_token) : (prev?.refresh_token_enc ?? null);
  const expiresAt = now() + (t.expires_in ?? 3600) * 1000;

  let sub: string | null = null;
  try {
    const info: any = await fetch(`${SHOP}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${t.access_token}` },
    }).then((r) => r.json());
    sub = info.sub ?? null;
    updateCustomerFromIdentity(customerId, info);
  } catch {
    /* userinfo is best-effort */
  }

  db.prepare(
    `INSERT INTO shop_links (customer_id, shop_sub, access_token_enc, access_expires_at, refresh_token_enc, scope, linked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(customer_id) DO UPDATE SET shop_sub=COALESCE(excluded.shop_sub, shop_sub),
       access_token_enc=excluded.access_token_enc, access_expires_at=excluded.access_expires_at,
       refresh_token_enc=excluded.refresh_token_enc, scope=excluded.scope, updated_at=excluded.updated_at`,
  ).run(customerId, sub, encrypt(t.access_token), expiresAt, refreshEnc, t.scope ?? config.shopScopes, now(), now());
  storeTokenCache.forEach((_, k) => k.startsWith(`${customerId}|`) && storeTokenCache.delete(k));
}

export function isShopLinked(customerId: string): boolean {
  return !!db.prepare("SELECT 1 FROM shop_links WHERE customer_id = ?").get(customerId);
}

/** Valid Shop access token for this customer, refreshing silently. Null if not linked or refresh revoked. */
export async function getShopAccessToken(customerId: string): Promise<string | null> {
  const row = db.prepare("SELECT * FROM shop_links WHERE customer_id = ?").get(customerId) as any;
  if (!row) return null;
  if (row.access_expires_at - 120_000 > now()) return decrypt(row.access_token_enc);
  if (!row.refresh_token_enc) return null;

  const r = await tokenRequest(`${SHOP}/oauth/token`, {
    grant_type: "refresh_token",
    refresh_token: decrypt(row.refresh_token_enc),
  });
  if (!r.ok) {
    if (r.json.error === "invalid_grant") unlinkShop(customerId, false); // revoked: customer must sign in again
    return null;
  }
  await saveShopTokens(customerId, r.json);
  return r.json.access_token;
}

// ---------------------------------------------------------------- per-store buyer token

const storeTokenCache = new Map<string, { token: string; expiresAt: number }>();
const authServerTokenEndpoint = new Map<string, string>();

async function tokenEndpointFor(authServer: string): Promise<string> {
  let ep = authServerTokenEndpoint.get(authServer);
  if (!ep) {
    try {
      const meta: any = await fetch(`${authServer}/.well-known/oauth-authorization-server`).then((r) => r.json());
      ep = meta.token_endpoint;
    } catch {
      /* fall through */
    }
    ep ??= `${authServer}/oauth/token`;
    authServerTokenEndpoint.set(authServer, ep);
  }
  return ep;
}

/**
 * Buyer-linked token for one store. Returns null when the customer hasn't linked Shop,
 * or the store doesn't support identity linking — callers then fall back to the agent token.
 */
export async function getStoreBuyerToken(customerId: string, storeDomain: string): Promise<string | null> {
  const store = await discoverStore(storeDomain);
  if (!store.mcpEndpoint || !store.authServer) return null;
  const audience = new URL(store.mcpEndpoint).host; // e.g. boatlifestylein.myshopify.com

  const key = `${customerId}|${audience}`;
  const hit = storeTokenCache.get(key);
  if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;

  const shopToken = await getShopAccessToken(customerId);
  if (!shopToken) return null;

  // 1) Shop: exchange the customer's Shop token for a short-lived JWT grant aimed at this store
  const ex = await tokenRequest(`${SHOP}/oauth/token`, {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: shopToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    requested_token_type: "urn:ietf:params:oauth:token-type:jwt",
    audience,
  });
  if (!ex.ok) {
    console.warn(`[identity] token-exchange failed for ${audience}:`, ex.status, ex.json?.error ?? ex.json);
    return null;
  }

  // 2) Store auth server: redeem the grant for a buyer-linked access token
  const redeem = await tokenRequest(await tokenEndpointFor(store.authServer), {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: ex.json.access_token,
    scope: "openid dev.ucp.shopping.checkout:manage",
  });
  if (!redeem.ok) {
    console.warn(`[identity] jwt-bearer redeem failed for ${audience}:`, redeem.status, redeem.json?.error ?? redeem.json);
    return null;
  }
  const entry = { token: redeem.json.access_token as string, expiresAt: Date.now() + (redeem.json.expires_in ?? 3600) * 1000 };
  storeTokenCache.set(key, entry);
  return entry.token;
}

export function unlinkShop(customerId: string, revoke = true) {
  const row = db.prepare("SELECT refresh_token_enc FROM shop_links WHERE customer_id = ?").get(customerId) as any;
  db.prepare("DELETE FROM shop_links WHERE customer_id = ?").run(customerId);
  storeTokenCache.forEach((_, k) => k.startsWith(`${customerId}|`) && storeTokenCache.delete(k));
  if (revoke && row?.refresh_token_enc) {
    void tokenRequest(`${SHOP}/oauth/revoke`, { token: decrypt(row.refresh_token_enc), token_type_hint: "refresh_token" });
  }
}
