/**
 * Probe Indian Shopify stores: does the store serve UCP, which capabilities,
 * and does it support "Sign in with Shop" identity linking?
 *
 *   npm run probe -- www.boat-lifestyle.com snitch.co.in
 *   npm run probe -- --file stores.txt
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const domains = args[0] === "--file"
  ? readFileSync(args[1], "utf8").split(/\s+/).filter(Boolean)
  : args.length ? args : ["www.boat-lifestyle.com", "snitch.co.in", "sugarcosmetics.com", "bombayshavingcompany.com", "www.bluetokaicoffee.com"];

const rows: Record<string, unknown>[] = [];
for (const d of domains) {
  const row: Record<string, unknown> = { store: d };
  try {
    const r = await fetch(`https://${d}/.well-known/ucp`, { redirect: "follow", signal: AbortSignal.timeout(15000) });
    const p: any = r.ok ? await r.json() : null;
    const caps = Object.keys(p?.ucp?.capabilities ?? {});
    const svc = (Object.values(p?.ucp?.services ?? {}).flat() as any[]).find((s) => s.endpoint);
    row.ucp = !!p?.ucp;
    row.checkout = caps.includes("dev.ucp.shopping.checkout");
    row.identity_linking = caps.includes("dev.ucp.common.identity_linking");
    row.permalink = caps.includes("dev.ucp.shopping.permalink");
    row.payment_handlers = Object.keys(p?.ucp?.payment_handlers ?? {}).join("|") || "none";
    row.endpoint = svc?.endpoint ?? "";
  } catch (e) {
    row.error = (e as Error).message;
  }
  rows.push(row);
}
console.table(rows);
