/** Pure date arithmetic shared by rule participation and action bands. */

export function isoDate(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Calendar days remaining until ISO date (UTC noon). Negative = past.
 * @param {string|null|undefined} iso
 * @param {string|Date|null} [now]
 */
export function daysUntil(iso, now = null) {
  const day = isoDate(iso);
  if (!day) return null;
  const end = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(end)) return null;
  let start;
  if (now instanceof Date) {
    start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 12 * 3600 * 1000;
  } else if (now) {
    const n = isoDate(now) || String(now).slice(0, 10);
    start = Date.parse(`${n}T12:00:00Z`);
  } else {
    // determinism-lint: allow clock the caller-supplied now wins in both branches above; this is the arm taken when nothing was supplied.
    const n = new Date();
    start = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) + 12 * 3600 * 1000;
  }
  if (!Number.isFinite(start)) return null;
  return Math.round((end - start) / 86400000);
}
