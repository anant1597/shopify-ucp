import { randomUUID } from "node:crypto";
import { db, now } from "../db.ts";

export interface Customer {
  id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
}

export interface Address {
  id: string;
  customer_id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
  country: string;
}

export function ensureCustomer(id: string): Customer {
  db.prepare("INSERT OR IGNORE INTO customers (id, created_at) VALUES (?, ?)").run(id, now());
  return getCustomer(id)!;
}

export function getCustomer(id: string): Customer | undefined {
  return db.prepare("SELECT id, email, phone, first_name, last_name FROM customers WHERE id = ?").get(id) as any;
}

export function upsertCustomer(c: Partial<Customer> & { id: string }): Customer {
  ensureCustomer(c.id);
  db.prepare(
    `UPDATE customers SET email = COALESCE(?, email), phone = COALESCE(?, phone),
       first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name) WHERE id = ?`,
  ).run(c.email ?? null, normalizePhone(c.phone), c.first_name ?? null, c.last_name ?? null, c.id);
  return getCustomer(c.id)!;
}

/** Fill blanks from the Shop identity (userinfo). Never overwrite what we already have. */
export function updateCustomerFromIdentity(id: string, info: any) {
  db.prepare(
    `UPDATE customers SET email = COALESCE(email, ?), phone = COALESCE(phone, ?),
       first_name = COALESCE(first_name, ?), last_name = COALESCE(last_name, ?) WHERE id = ?`,
  ).run(info.email ?? null, normalizePhone(info.phone ?? info.phone_number), info.given_name ?? null, info.family_name ?? null, id);
}

export function addAddress(a: Omit<Address, "id" | "country"> & { country?: string; is_default?: boolean }): Address {
  ensureCustomer(a.customer_id);
  const id = randomUUID();
  if (a.is_default) db.prepare("UPDATE addresses SET is_default = 0 WHERE customer_id = ?").run(a.customer_id);
  const hasAny = db.prepare("SELECT 1 FROM addresses WHERE customer_id = ?").get(a.customer_id);
  db.prepare(
    `INSERT INTO addresses (id, customer_id, first_name, last_name, phone, line1, line2, city, state, pincode, country, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, a.customer_id, a.first_name, a.last_name, normalizePhone(a.phone), a.line1, a.line2 ?? null,
    a.city, a.state, a.pincode, a.country ?? "IN", a.is_default || !hasAny ? 1 : 0,
  );
  return getAddress(id)!;
}

export function getAddress(id: string): Address | undefined {
  return db.prepare("SELECT * FROM addresses WHERE id = ?").get(id) as any;
}

export function getDefaultAddress(customerId: string): Address | undefined {
  return db
    .prepare("SELECT * FROM addresses WHERE customer_id = ? ORDER BY is_default DESC, rowid DESC LIMIT 1")
    .get(customerId) as any;
}

/** Indian numbers → E.164 (+91XXXXXXXXXX). Leaves other formats alone. */
export function normalizePhone(p?: string | null): string | null {
  if (!p) return null;
  const digits = p.replace(/[^\d+]/g, "");
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  const d = digits.replace(/^\+/, "");
  if (/^[6-9]\d{9}$/.test(d)) return `+91${d}`;
  if (/^91[6-9]\d{9}$/.test(d)) return `+${d}`;
  if (/^0[6-9]\d{9}$/.test(d)) return `+91${d.slice(1)}`;
  return digits;
}
