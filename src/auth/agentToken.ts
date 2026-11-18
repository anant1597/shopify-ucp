import { config } from "../config.ts";

let cached: { token: string; expiresAt: number } | undefined;
let inflight: Promise<string> | undefined;

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
      cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
      return cached.token;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}
