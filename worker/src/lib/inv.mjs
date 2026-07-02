// Pure validation for shared investigation snapshots (POST /inv). A snapshot is a
// user-curated pin list — structured fields only, every string clamped, hard byte cap,
// so the share endpoint can't be used as arbitrary file hosting.

export const MAX_INV_BYTES = 32768;
export const MAX_INV_ITEMS = 100;
export const INV_TTL = 90 * 24 * 3600; // shared links live 90 days

export function validInvPayload(obj) {
  if (!obj || typeof obj !== "object") return null;
  const name = String(obj.name || "").slice(0, 80);
  if (!Array.isArray(obj.items) || !obj.items.length || obj.items.length > MAX_INV_ITEMS) return null;
  const items = obj.items.map((i) => ({
    t: String((i && i.t) || "").slice(0, 12),
    id: String((i && i.id) || "").slice(0, 120),
    title: String((i && i.title) || "").slice(0, 300),
    meta: String((i && i.meta) || "").slice(0, 300),
    note: String((i && i.note) || "").slice(0, 1000),
    added: String((i && i.added) || "").slice(0, 10),
  })).filter((i) => i.id && i.t);
  if (!items.length) return null;
  const out = { name, items, sharedAt: new Date().toISOString().slice(0, 10) };
  if (JSON.stringify(out).length > MAX_INV_BYTES) return null;
  return out;
}
