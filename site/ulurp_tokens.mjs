/**
 * Strict ULURP application-number tokens for join keys.
 *
 * Real forms look like `C 240046 HAM`, `240139ZMX`, `N240140ZRX` — optional
 * type letter, 6-digit body, 2–4 letter DCP action code. Free-text extractors
 * must not swallow Zoom meeting ids (`…302621 Meeting` → false `302621MEET`)
 * or phone fragments (`…PHON` / `…INTE`).
 *
 * Single source for site notice-land join + worker ULURP joins.
 */

/** Optional type letter + isolated 6-digit body + whole-word 2–4 letter suffix. */
const ULURP_TOKEN_RE =
  /(?:(?<type>[A-Z])\s*)?(?<![0-9])(?<num>\d{6})(?![0-9])\s*(?<suf>[A-Z]{2,4})\b/gi;

/**
 * English / UI stems that 6-digit runs collide with in hearing notices
 * (Zoom "Meeting", "To join", phone labels). Belt-and-suspenders on top of
 * digit isolation + word boundaries.
 */
const ULURP_SUFFIX_DENY = new Set([
  "MEET",
  "TING",
  "JOIN",
  "ONLY",
  "FROM",
  "THIS",
  "THAT",
  "WILL",
  "HOLD",
  "PHON",
  "INTE",
  "ZOOM",
  "HTTP",
  "HTML",
  "WITH",
  "HAVE",
  "BEEN",
  "WERE",
  "YOUR",
  "HERE",
  "WHEN",
  "DATE",
  "TIME",
  "ROOM",
  "CALL",
  "LINK",
  "INTO",
  "THAN",
  "THEN",
  "ALSO",
  "NEXT",
  "OVER",
  "ID",
  "TO",
  "BY",
  "OR",
  "AM",
  "PM",
  "NY",
  "US",
  "URL",
  "WWW",
  "COM",
  "ORG",
  "GOV",
  "THE",
  "AND",
  "FOR",
  "ARE",
  "WAS",
  "NOT",
  "BUT",
  "ALL",
  "CAN",
  "HER",
  "HIS",
  "OUR",
  "OUT",
  "WHO",
  "HOW",
  "ITS",
  "MAY",
  "NEW",
  "NOW",
  "OLD",
  "SEE",
  "WAY",
  "DAY",
  "GET",
  "HAS",
  "HIM",
  "LET",
  "PUT",
  "SAY",
  "SHE",
  "TOO",
  "USE",
  "VIA",
  "PER",
  "EACH",
  "LIKE",
  "JUST",
  "VERY",
  "BACK",
  "THEY",
  "THEM",
  "WHAT",
  "WHERE",
  "BB",
  "BDA",
]);

/**
 * DCP-like action-code shape (ZMK, HAM, PQM, GZSM, ELDQ, PXQ, …).
 * Reject pure English after digit isolation fails open.
 * @param {string|null|undefined} suf
 */
export function isPlausibleUlurpSuffix(suf) {
  const s = String(suf || "").toUpperCase();
  if (s.length < 2 || s.length > 4) return false;
  if (ULURP_SUFFIX_DENY.has(s)) return false;
  // Classifier letter family seen on Open Data / ZAP ulurp_numbers.
  if (!/[ZLHMPCRDGESAXKQY]/.test(s)) return false;
  if (
    /^(MEET|PHON|INTE|JOIN|HOLD|CALL|LINK|TIME|DATE|ROOM|STRE|AVEN|BLOC|CITY|YORK|DEPT|PUBL|HEAR)/.test(
      s,
    )
  ) {
    return false;
  }
  return true;
}

/**
 * True when a normalized key (`240046HAM` or `C240046HAM`) is a plausible ULURP token.
 * @param {string|null|undefined} key
 */
export function isPlausibleUlurpKey(key) {
  const raw = String(key || "").toUpperCase().replace(/\s+/g, "");
  if (!raw) return false;
  const m = raw.match(/^([A-Z])?(\d{6})([A-Z]{2,4})$/);
  if (!m) return false;
  return isPlausibleUlurpSuffix(m[3]);
}

/**
 * Extract strict ULURP join keys from free text.
 * @param {string|null|undefined} value
 * @returns {Set<string>} uppercased tokens: `${num}${suf}` and optional `${type}${num}${suf}`
 */
export function extractUlurpKeys(value) {
  const keys = new Set();
  if (value == null) return keys;
  const text = String(value).toUpperCase();
  for (const m of text.matchAll(ULURP_TOKEN_RE)) {
    const typ = (m.groups?.type || "").toUpperCase();
    const num = m.groups?.num;
    const suf = (m.groups?.suf || "").toUpperCase();
    if (!num || !suf || !isPlausibleUlurpSuffix(suf)) continue;
    const core = `${num}${suf}`;
    keys.add(core);
    if (typ) keys.add(`${typ}${core}`);
  }
  return keys;
}

/**
 * Drop stamped keys that fail the current token rules (snapshot hygiene).
 * @param {Iterable<string>|null|undefined} keys
 * @returns {string[]}
 */
export function filterPlausibleUlurpKeys(keys) {
  const out = [];
  for (const k of keys || []) {
    const clean = String(k || "").trim().toUpperCase();
    if (clean && isPlausibleUlurpKey(clean) && !out.includes(clean)) out.push(clean);
  }
  return out.sort();
}
