import { config } from "../config.ts";

let cached: { token: string; expiresAt: number } | undefined;
let inflight: Promise<string> | undefined;

/** Expiry from the JWT's `exp` claim (the token response has no expires_in). */
function jwtExpiry(token: string): number | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Agent ("Token tier") access token via client credentials from the Dev Dashboard agent identity.
 * JWT, ~60 min TTL. Cached and refreshed 2 minutes before expiry.
 */
export async function getAgentToken(): Promise<string> {
  if (cached && cached.expiresAt - 120_000 > Date.now()) return cached.token;
  inflight ??= (async () => {
    try {
      const res = await fetch(config.shopifyTokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "client_credentials",
        }),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok || !json.access_token) {
        throw new Error(`Agent token request failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`);
      }
      const expiresAt =
        jwtExpiry(json.access_token) ?? Date.now() + (json.expires_in ?? 3600) * 1000;
      cached = { token: json.access_token, expiresAt };
      return cached.token;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** True if `token` is the agent token we handed out (used to decide whether a retry can help). */
export function isCachedAgentToken(token: string | undefined): boolean {
  return !!token && cached?.token === token;
}

export function invalidateAgentToken() {
  cached = undefined;
}
