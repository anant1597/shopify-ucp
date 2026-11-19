/**
 * Delivery addresses for a customer: the ones they entered with us plus the ones saved in their Shop account,
 * all stored against the customer so the assistant can offer a pick list instead of asking them to type.
 */
import { db } from "../db.ts";
import { getCustomer, normalizePhone, upsertCustomer, addAddress } from "./customers.ts";
import { getShopAccount, isShopOrdersConnected } from "./shopMcp.ts";
import { isShopLinked } from "../auth/shopIdentity.ts";

const SYNC_EVERY_MS = 10 * 60 * 1000;
const lastSync = new Map<string, number>();

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Insert or refresh one Shop-sourced address; returns its id. Matches on Shop's id, else on street + pincode. */
export function saveShopAddress(customerId: string, a: any, makeDefault = false): string | null {
  const line1 = a.street_address ?? a.address1;
  const city = a.address_locality ?? a.city;
  const pincode = String(a.postal_code ?? a.zip ?? "").replace(/\s/g, "");
  if (!line1 || !city || !/^\d{6}$/.test(pincode)) return null;
  const rows = db.prepare("SELECT id, line1, pincode, shop_address_id FROM addresses WHERE customer_id = ?").all(customerId) as any[];
  const existing = rows.find((r) => (a.id && r.shop_address_id === a.id) || (norm(r.line1) === norm(line1) && r.pincode === pincode));
  const fields = {
    first_name: a.first_name ?? null, last_name: a.last_name ?? null, phone: normalizePhone(a.phone_number ?? a.phone),
    line1, line2: a.extended_address ?? a.address2 ?? null, city, state: a.address_region ?? a.province ?? "", pincode,
  };
  if (existing) {
    db.prepare(
      `UPDATE addresses SET first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name), phone = COALESCE(?, phone),
         line1 = ?, line2 = ?, city = ?, state = ?, pincode = ?, shop_address_id = COALESCE(?, shop_address_id),
         source = COALESCE(source, 'shop') WHERE id = ?`,
    ).run(fields.first_name, fields.last_name, fields.phone, fields.line1, fields.line2, fields.city, fields.state, fields.pincode, a.id ?? null, existing.id);
    if (makeDefault && !db.prepare("SELECT 1 FROM addresses WHERE customer_id = ? AND is_default = 1").get(customerId)) {
      db.prepare("UPDATE addresses SET is_default = 1 WHERE id = ?").run(existing.id);
    }
    return existing.id;
  }
  const hasDefault = !!db.prepare("SELECT 1 FROM addresses WHERE customer_id = ? AND is_default = 1").get(customerId);
  const saved = addAddress({ customer_id: customerId, ...fields, is_default: makeDefault && !hasDefault });
  db.prepare("UPDATE addresses SET source = 'shop', shop_address_id = ? WHERE id = ?").run(a.id ?? null, saved.id);
  return saved.id;
}

/** Pull the addresses saved in the customer's Shop account (best effort, at most every 10 minutes). */
export async function syncShopAddresses(customerId: string, force = false): Promise<boolean> {
  if (!isShopOrdersConnected(customerId)) return false;
  if (!force && Date.now() - (lastSync.get(customerId) ?? 0) < SYNC_EVERY_MS) return true;
  try {
    const acct = await getShopAccount(customerId);
    for (const a of acct.addresses) saveShopAddress(customerId, a, a.id === acct.preferred_address_id);
    // Fill a missing name/email from Shop so stores get them prefilled.
    const c = getCustomer(customerId)!;
    const pref = acct.addresses.find((a) => a.id === acct.preferred_address_id) ?? acct.addresses[0];
    if ((!c.first_name && pref?.first_name) || (!c.email && acct.email)) {
      upsertCustomer({
        id: customerId,
        ...(!c.first_name && pref?.first_name ? { first_name: pref.first_name, last_name: pref.last_name ?? undefined } : {}),
        ...(!c.email && acct.email ? { email: acct.email } : {}),
      });
    }
    lastSync.set(customerId, Date.now());
    return true;
  } catch (e) {
    console.warn("[addresses] Shop sync failed:", (e as Error).message);
    return false;
  }
}

export const formatAddress = (r: any) => [r.line1, r.line2, r.city, r.state, r.pincode].filter(Boolean).join(", ");

/** Everything the customer can pick from, default first. */
export async function listDeliveryAddresses(customerId: string) {
  const synced = await syncShopAddresses(customerId);
  const rows = db.prepare(
    "SELECT * FROM addresses WHERE customer_id = ? ORDER BY is_default DESC, rowid DESC",
  ).all(customerId) as any[];
  const c = getCustomer(customerId)!;
  const hasShop = rows.some((r) => r.source === "shop");
  return {
    addresses: rows.map((r) => ({
      address_id: r.id as string,
      name: [r.first_name ?? c.first_name, r.last_name ?? c.last_name].filter(Boolean).join(" ") || null,
      address: formatAddress(r),
      pincode: r.pincode as string,
      from_shop: r.source === "shop",
      is_default: !!r.is_default,
    })),
    // Signed in with Shop but we couldn't read its addresses: the store can still prefill the Shop address.
    shop_checkout_address_available: isShopLinked(customerId) && !hasShop,
    shop_addresses_synced: synced,
  };
}
