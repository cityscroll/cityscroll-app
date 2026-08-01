/**
 * Token / stem blocking v0 (pure candidate generation).
 *
 * The evaluation harness uses this for gold-pair candidate_recall. The package
 * candidate-generation surface also reuses these keys; this module itself
 * never writes links or touches D1/KV.
 *
 * Block keys per side:
 *   - stem:<normalized identity key>   (vendor stem or agency canonical id)
 *   - tok:<token>                      (non-stop tokens from the stem surface)
 *   - pin:<PIN>                        (when attrs.pin is present)
 *
 * A gold pair is blocked-in when left and right share at least one block key.
 */

import {
  vendorStem,
  agencyCanonicalId,
} from "../../../worker/src/lib/normalize.mjs";

export const BLOCKER_ID = "token_v0";
export const BLOCKER_VERSION = "0";

/** Light English / civic stop list — never drop identity-bearing stems like HNTB. */
const STOPWORDS = new Set([
  "A",
  "AN",
  "AND",
  "AT",
  "BY",
  "FOR",
  "IN",
  "OF",
  "ON",
  "OR",
  "THE",
  "TO",
  "DEPT",
  "DEPARTMENT",
  "OFFICE",
  "SERVICES",
  "SERVICE",
  "INC",
  "LLC",
  "CORP",
  "COMPANY",
  "CO",
  "LTD",
  "LIMITED",
  "LP",
  "LLP",
  "PLLC",
  "PC",
  "USA",
]);

/**
 * Clean display text into an uppercase token surface (no legal-suffix strip).
 * Used for procurement titles and as a fallback when stem is empty.
 */
export function cleanSurface(name) {
  return String(name || "")
    .replace(/<[^>]*>/g, " ")
    .toUpperCase()
    .replace(/[.,'’"&/()#:;+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Identity stem surface for token extraction.
 * vendor → vendorStem; agency → canonical id (hyphen form) + cleaned display;
 * procurement → cleaned display only.
 */
export function identitySurface(side, entityType) {
  const name = side?.display_name ?? "";
  if (entityType === "agency") {
    const id = agencyCanonicalId(name);
    // Prefer canonical id as stem key; still expose cleaned name for tokens.
    return { stemKey: id || "", tokenSurface: cleanSurface(name) };
  }
  if (entityType === "procurement") {
    const surface = cleanSurface(name);
    return { stemKey: "", tokenSurface: surface };
  }
  // vendor (default) and unknown entity types
  const stem = vendorStem(name);
  return { stemKey: stem, tokenSurface: stem || cleanSurface(name) };
}

/**
 * Significant tokens from a surface string.
 * @param {string} surface
 * @returns {string[]}
 */
export function significantTokens(surface) {
  if (!surface) return [];
  const out = [];
  for (const t of String(surface).split(/\s+/)) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    // Skip pure numeric noise (BIN codes keep alphanumeric; pure years stay).
    out.push(t);
  }
  return out;
}

/**
 * Normalize a PIN for equality (uppercase, strip spaces/dashes).
 * @param {string} pin
 */
export function normalizePin(pin) {
  return String(pin || "")
    .toUpperCase()
    .replace(/[\s\-]/g, "")
    .trim();
}

/**
 * Block keys for one gold side.
 * @param {{ display_name?: string, native_key?: string, attrs?: object }} side
 * @param {string} entityType
 * @returns {Set<string>}
 */
export function blockKeysForSide(side, entityType) {
  const keys = new Set();
  if (!side || typeof side !== "object") return keys;

  const { stemKey, tokenSurface } = identitySurface(side, entityType);
  if (stemKey) keys.add(`stem:${stemKey}`);

  for (const t of significantTokens(tokenSurface)) {
    keys.add(`tok:${t}`);
  }

  const pin = side.attrs?.pin;
  if (pin) {
    const p = normalizePin(pin);
    if (p) keys.add(`pin:${p}`);
  }

  return keys;
}

/**
 * Shared block keys between two sides (empty → no candidate).
 * @returns {string[]}
 */
export function sharedBlockKeys(left, right, entityType) {
  const a = blockKeysForSide(left, entityType);
  const b = blockKeysForSide(right, entityType);
  const shared = [];
  for (const k of a) {
    if (b.has(k)) shared.push(k);
  }
  return shared.sort();
}

/**
 * True when the pair would enter the candidate set under token_v0.
 */
export function isCandidatePair(left, right, entityType) {
  return sharedBlockKeys(left, right, entityType).length > 0;
}

/**
 * Apply token_v0 to a gold case list.
 * @param {object[]} cases
 * @returns {{
 *   candidateIds: Set<string>,
 *   details: Array<{
 *     id: string,
 *     label: string,
 *     entity_type: string,
 *     blocked_in: boolean,
 *     shared_keys: string[],
 *     left_name: string,
 *     right_name: string,
 *   }>
 * }}
 */
export function applyTokenV0(cases) {
  const candidateIds = new Set();
  const details = [];
  for (const c of cases) {
    const shared = sharedBlockKeys(c.left, c.right, c.entity_type);
    const blockedIn = shared.length > 0;
    if (blockedIn) candidateIds.add(c.id);
    details.push({
      id: c.id,
      label: c.label,
      entity_type: c.entity_type,
      blocked_in: blockedIn,
      shared_keys: shared,
      left_name: c.left?.display_name ?? "",
      right_name: c.right?.display_name ?? "",
    });
  }
  return { candidateIds, details };
}
