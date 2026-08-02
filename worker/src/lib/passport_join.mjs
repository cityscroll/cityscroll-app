// Pure EPIN ↔ City Record PIN join for PASSPort Public contracts and RFx.
//
// Measured join strategies (2026-07-30 against 7,254 City Record Procurement notices
// with PIN since 2025-01-01; see site/data/source_contracts.json join_measurement):
//   exact                  — alnum-normalized PIN equals EPIN
//   pin_strip_suffix       — strip one trailing letter+3–4 digits (A001, R001) from PIN
//   pin_prefix_of_epin     — PIN is a proper prefix of EPIN; remainder is digits or letter+digits
//   epin_prefix_of_pin     — EPIN (len ≥ 8) is a proper prefix of PIN; remainder is digits or letter+digits
//
// Weak shared-prefix joins (same first N chars, different body) are intentionally rejected —
// they produced false matches such as 26026N0011014 → 26026N0011098.
//
// Min EPIN prefix length was lowered from 10 → 8 so award PINs that carry a short
// solicitation EPIN stem (common task-order / line suffixes) still recover RFx.

const SUFFIX_RE = /^(.+?)([A-Z]\d{3,4})$/;
/** Remainder after a proper prefix: digits, letter+digits, or multi-segment task tails. */
const REST_OK_RE = /^(?:\d+|[A-Z]\d{2,6}|[A-Z]{1,2}\d{2,6})+$/;
/** Minimum EPIN length for prefix strategies (was 10; 8 recovers short stems). */
export const EPIN_PREFIX_MIN_LEN = 8;

/** Alphanumeric uppercase form used as the join key. */
export function normId(value) {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** Strip one trailing amendment/renewal-style suffix (A001, R001, …). */
export function stripOneSuffix(id) {
  const n = normId(id);
  const match = n.match(SUFFIX_RE);
  return match ? match[1] : null;
}

/**
 * Build a join index from a list of EPIN strings.
 * @returns {{ exact: Set<string>, byPrefix: Map<string, string[]> }}
 */
export function buildEpinIndex(epins) {
  const exact = new Set();
  const byPrefix = new Map();
  for (const raw of epins || []) {
    const e = normId(raw);
    if (!e) continue;
    exact.add(e);
    // Index longer EPINs under shorter prefix keys for reverse prefix lookup.
    for (let L = Math.min(e.length - 1, 20); L >= EPIN_PREFIX_MIN_LEN; L--) {
      const pref = e.slice(0, L);
      if (!byPrefix.has(pref)) byPrefix.set(pref, []);
      byPrefix.get(pref).push(e);
    }
  }
  return { exact, byPrefix };
}

/**
 * Whether a remainder after a proper EPIN/PIN prefix is an honest task/line tail.
 * Rejects body collisions (different mid-serial with shared first N chars).
 */
export function restOkForPrefixJoin(rest) {
  if (rest == null || rest === "") return true;
  return REST_OK_RE.test(String(rest));
}

/**
 * Join a City Record PIN to an EPIN index.
 * @returns {{ method: string, epin: string } | null}
 */
export function joinPinToEpin(pin, index) {
  if (!index?.exact) return null;
  const p = normId(pin);
  if (!p) return null;

  if (index.exact.has(p)) return { method: "exact", epin: p };

  const stripped = stripOneSuffix(p);
  if (stripped && index.exact.has(stripped)) {
    return { method: "pin_strip_suffix", epin: stripped };
  }
  if (stripped) {
    const stripped2 = stripOneSuffix(stripped);
    if (stripped2 && index.exact.has(stripped2)) {
      return { method: "pin_strip_suffix", epin: stripped2 };
    }
  }

  // EPIN is a proper prefix of PIN (solicitation EPIN + task/line suffix on the notice).
  for (let L = Math.min(p.length - 1, 20); L >= EPIN_PREFIX_MIN_LEN; L--) {
    const cand = p.slice(0, L);
    if (!index.exact.has(cand)) continue;
    const rest = p.slice(L);
    if (restOkForPrefixJoin(rest)) return { method: "epin_prefix_of_pin", epin: cand };
  }

  // PIN is a proper prefix of some EPIN (short notice PIN, longer PASSPort EPIN).
  if (p.length >= EPIN_PREFIX_MIN_LEN && index.byPrefix?.has(p)) {
    for (const e of index.byPrefix.get(p)) {
      const rest = e.slice(p.length);
      if (restOkForPrefixJoin(rest)) return { method: "pin_prefix_of_epin", epin: e };
    }
  }
  // Also try stripped PIN as prefix of EPIN.
  if (stripped && stripped.length >= EPIN_PREFIX_MIN_LEN && index.byPrefix?.has(stripped)) {
    for (const e of index.byPrefix.get(stripped)) {
      const rest = e.slice(stripped.length);
      if (restOkForPrefixJoin(rest)) return { method: "pin_prefix_of_epin", epin: e };
    }
  }

  return null;
}

/** PASSPort contract statuses that fill the lifecycle "pending" stage. */
export const PASSPORT_PENDING_STATUSES = new Set([
  "In Progress",
  "Pending  Comptroller Approval",
  "Pending Registration Package Compilation",
  "Pending Oversight Approval",
  "Pending ACCO Approval",
  "Pending MOCS Approval",
  "Pending OMB Approval",
  "Draft",
]);

export function isPassportPendingStatus(status) {
  return PASSPORT_PENDING_STATUSES.has(String(status || "").trim());
}

export function isPassportRegisteredStatus(status) {
  return String(status || "").trim() === "Registered";
}
