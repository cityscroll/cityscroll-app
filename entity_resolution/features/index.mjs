// entity_resolution/features — deterministic pair features for matcher v0.
//
// VI-03 extension: typo/truncation/abbreviation/DBA proximity features that
// surface variant pairs the v0 normalizer misses without lowering thresholds.

import { agencyCanonicalId } from "../normalizers/agency.mjs";
import { vendorStem } from "../normalizers/vendor_stem.mjs";
import {
  authorityKeyId,
  authorityKeysForSide,
} from "../authority_keys/index.mjs";

export const FEATURES_VERSION = "pair_features_v2";

const LEGAL_FORMS = new Map([
  ["INC", "INC"],
  ["INCORPORATED", "INC"],
  ["CORP", "CORP"],
  ["CORPORATION", "CORP"],
  ["COMPANY", "COMPANY"],
  ["CO", "COMPANY"],
  ["LLC", "LLC"],
  ["L L C", "LLC"],
  ["LP", "LP"],
  ["L P", "LP"],
  ["LLP", "LLP"],
  ["L L P", "LLP"],
  ["PLLC", "PLLC"],
  ["P L L C", "PLLC"],
  ["PC", "PC"],
  ["P C", "PC"],
  ["LTD", "LTD"],
  ["LIMITED", "LTD"],
]);

const AGENCY_EXPANSIONS = new Map([
  ["COMM", "COMMUNITY"],
  ["DEV", "DEVELOPMENT"],
  ["DEPT", "DEPARTMENT"],
  ["INFO", "INFORMATION"],
  ["SRVS", "SERVICES"],
  ["SVCS", "SERVICES"],
  ["TECH", "TECHNOLOGY"],
  ["TELECOMM", "TELECOMMUNICATIONS"],
]);

const COMMON_STOPWORDS = new Set(["AND", "OF", "THE"]);
const AGENCY_STOPWORDS = new Set(["DEPARTMENT", "OFFICE", "SERVICES"]);
const AGENCY_PLACES = new Map([
  ["BRONX", "bronx"],
  ["BROOKLYN", "brooklyn"],
  ["KINGS", "brooklyn"],
  ["MANHATTAN", "manhattan"],
  ["QUEENS", "queens"],
  ["RICHMOND", "staten_island"],
  ["STATEN", "staten_island"],
]);

function displayName(side) {
  return String(
    side?.display_name ?? side?.vendor_name ?? side?.name ?? side?.title ?? "",
  );
}

/** Stable comparison surface: HTML-free, accent-free, uppercase words. */
export function comparisonSurface(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " AND ")
    .replace(/[’']/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Trailing legal form, retained separately from the identity tokens. */
export function legalForm(value) {
  const surface = comparisonSurface(value);
  for (const [suffix, form] of [...LEGAL_FORMS].sort((a, b) => b[0].length - a[0].length)) {
    if (surface === suffix || surface.endsWith(` ${suffix}`)) return form;
  }
  return null;
}

function stripLegalForm(pieces) {
  const joined = pieces.join(" ");
  for (const suffix of [...LEGAL_FORMS.keys()].sort((a, b) => b.length - a.length)) {
    if (joined === suffix) return [];
    if (joined.endsWith(` ${suffix}`)) {
      return joined.slice(0, -(suffix.length + 1)).split(" ").filter(Boolean);
    }
  }
  return pieces;
}

/** Family-aware identity tokens used for overlap features. */
export function identityTokens(side, entityType = "vendor") {
  let pieces = comparisonSurface(displayName(side)).split(" ").filter(Boolean);
  if (entityType === "vendor") pieces = stripLegalForm(pieces);
  if (entityType === "agency") {
    pieces = pieces.map((piece) => AGENCY_EXPANSIONS.get(piece) || piece);
  }
  return [...new Set(pieces.filter((piece) => {
    if (COMMON_STOPWORDS.has(piece)) return false;
    return entityType !== "agency" || !AGENCY_STOPWORDS.has(piece);
  }))];
}

function familyStem(side, entityType) {
  const name = displayName(side);
  if (entityType === "agency") return agencyCanonicalId(name);
  if (entityType === "vendor") return vendorStem(name);
  return comparisonSurface(name);
}

const NULLISH_IDENTIFIERS = new Set([
  "0",
  "NA",
  "NONE",
  "NULL",
  "TBD",
  "UNKNOWN",
  "UNAVAILABLE",
  "NOTAPPLICABLE",
  "NOTPROVIDED",
]);

/** Normalize a hard identifier while rejecting publisher null sentinels. */
export function normalizeHardIdentifier(value) {
  const normalized = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return NULLISH_IDENTIFIERS.has(normalized) ? "" : normalized;
}

function identifierValues(side, keys) {
  const values = [];
  for (const key of keys) {
    for (const container of [side, side?.attrs]) {
      const raw = container?.[key];
      const list = Array.isArray(raw) ? raw : [raw];
      for (const value of list) {
        const normalized = normalizeHardIdentifier(value);
        if (normalized) values.push(normalized);
      }
    }
  }
  return [...new Set(values)].sort();
}

/** Raw PIN/EPIN values for display and backwards-compatible diagnostics only. */
export function pinEpinValues(side) {
  return identifierValues(side, ["pin", "epin"]);
}

/** Contract identifiers form a separate NYC authority family. */
export function contractIdValues(side) {
  return identifierValues(side, [
    "contract_id",
    "contract_ids",
    "contractId",
    "ctr_id",
    "prime_contract_id",
    "contract_number",
  ]);
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / union.size;
}

function ratio(a, b) {
  const longer = Math.max(a.length, b.length);
  return longer === 0 ? 0 : Math.min(a.length, b.length) / longer;
}

function agencyPlaces(pieces) {
  const places = new Set();
  for (const piece of pieces) {
    const place = AGENCY_PLACES.get(piece);
    if (place) places.add(place);
  }
  return [...places].sort();
}

// --- VI-03 proximity features ---

/**
 * Bounded Levenshtein distance — returns a sentinel when the distance exceeds
 * the cap, so callers never pay O(n*m) on unrelated strings.
 */
function boundedLevenshtein(a, b, maxDist = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      );
      rowMin = Math.min(rowMin, curr[j]);
    }
    if (rowMin > maxDist) return maxDist + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Vendor abbreviation expansion map. Only abbreviations where the expansion is
 * unambiguous — expanding to the wrong word would be a false merge — are here.
 */
const VENDOR_ABBREVIATIONS = new Map([
  ["CNTR", "CENTER"],
  ["CTR", "CENTER"],
  ["ASSOC", "ASSOCIATES"],
  ["ASSN", "ASSOCIATION"],
  ["BROS", "BROTHERS"],
  ["CO", "COMPANY"],
  ["CORP", "CORPORATION"],
  ["DEPT", "DEPARTMENT"],
  ["DIV", "DIVISION"],
  ["ENG", "ENGINEERING"],
  ["ENT", "ENTERPRISES"],
  ["GOVT", "GOVERNMENT"],
  ["INTL", "INTERNATIONAL"],
  ["MGMT", "MANAGEMENT"],
  ["MFG", "MANUFACTURING"],
  ["SYS", "SYSTEMS"],
  ["TECH", "TECHNOLOGY"],
  ["SVCS", "SERVICES"],
  ["SRVC", "SERVICE"],
  ["TRANS", "TRANSPORTATION"],
]);

/** True when one token is a known abbreviation of the other. */
function abbreviationPair(leftToken, rightToken) {
  if (leftToken === rightToken) return false;
  const abbr = VENDOR_ABBREVIATIONS.get(leftToken);
  if (abbr && abbr === rightToken) return true;
  const abbr2 = VENDOR_ABBREVIATIONS.get(rightToken);
  if (abbr2 && abbr2 === leftToken) return true;
  return false;
}

/**
 * Count abbreviation-matched token pairs between two identity-token sets.
 * Returns the number of tokens that match through abbreviation expansion
 * (beyond exact matches already counted in shared_tokens).
 */
function abbreviationMatches(leftTokens, rightTokens) {
  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  let count = 0;
  for (const lt of leftTokens) {
    if (rightSet.has(lt)) continue;
    for (const rt of rightTokens) {
      if (leftSet.has(rt)) continue;
      if (abbreviationPair(lt, rt)) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

const DBA_PATTERN = /\b(DBA|D\/B\/A|D\.B\.A\.|AKA|A\/K\/A|A\.K\.A\.|FKA|F\/K\/A|F\.K\.A\.|T\/A)\b/i;

/**
 * Extract the DBA/FKA/AKA alias from a display name.
 * Returns { alias, primary, separator } or null when no DBA notation is present.
 */
export function extractDba(name) {
  const raw = String(name || "").trim();
  const match = raw.match(DBA_PATTERN);
  if (!match) return null;
  const idx = match.index;
  const primary = raw.slice(0, idx).trim();
  const alias = raw.slice(idx + match[0].length).trim();
  if (!primary || !alias) return null;
  return { primary, alias, separator: match[0].toUpperCase() };
}

/**
 * Detect typo proximity between two vendor stems.
 * Returns { close: boolean, distance: number } — true when the stems differ
 * by at most 2 characters and have at least 4 characters (avoiding noise on
 * very short names).
 */
function typoProximity(leftStem, rightStem) {
  if (!leftStem || !rightStem || leftStem === rightStem) {
    return { close: false, distance: -1 };
  }
  if (leftStem.length < 4 || rightStem.length < 4) {
    return { close: false, distance: -1 };
  }
  const dist = boundedLevenshtein(leftStem, rightStem, 2);
  return { close: dist <= 2, distance: dist };
}

/**
 * Detect truncation: one stem is a prefix of the other within a small tail.
 * This catches 50-char Checkbook/City Record truncations where the suffix
 * strip left the same identity words but one surface was cut mid-word.
 */
function stemTruncation(leftStem, rightStem) {
  if (!leftStem || !rightStem || leftStem === rightStem) return false;
  const shorter = leftStem.length < rightStem.length ? leftStem : rightStem;
  const longer = leftStem.length < rightStem.length ? rightStem : leftStem;
  if (shorter.length < 5) return false;
  if (!longer.startsWith(shorter)) return false;
  const tail = longer.length - shorter.length;
  // Truncation: the tail is a partial word (≤4 chars) or empty after trimming.
  return tail <= 4;
}

/**
 * Extract deterministic, JSON-safe features for one candidate pair.
 *
 * @param {object} left
 * @param {object} right
 * @param {{ entityType?: string }} [opts]
 */
export function extractFeatures(left = {}, right = {}, opts = {}) {
  const family = opts.entityType || left?.entity_type || right?.entity_type || "vendor";
  const leftName = displayName(left);
  const rightName = displayName(right);
  const leftSurface = comparisonSurface(leftName);
  const rightSurface = comparisonSurface(rightName);
  const leftStem = familyStem(left, family);
  const rightStem = familyStem(right, family);
  const leftPieces = identityTokens(left, family);
  const rightPieces = identityTokens(right, family);
  const sharedPieces = leftPieces.filter((piece) => rightPieces.includes(piece)).sort();
  const leftIds = pinEpinValues(left);
  const rightIds = pinEpinValues(right);
  const leftAuthorityKeys = authorityKeysForSide(left);
  const rightAuthorityKeys = authorityKeysForSide(right);
  const rightAuthorityIds = new Set(rightAuthorityKeys.map(authorityKeyId));
  const sharedAuthorityKeys = leftAuthorityKeys.filter((key) =>
    rightAuthorityIds.has(authorityKeyId(key))
  );
  const sharedIds = [...new Set(sharedAuthorityKeys.map((key) => key.value))].sort();
  const leftContractIds = contractIdValues(left);
  const rightContractIds = contractIdValues(right);
  const sharedContractIds = leftContractIds.filter((id) => rightContractIds.includes(id));
  const comparableAuthority = (leftKey, rightKey) =>
    leftKey.scheme === rightKey.scheme &&
    leftKey.scope === rightKey.scope;
  const pinEpinConflict = sharedAuthorityKeys.length === 0 && leftAuthorityKeys.some((leftKey) =>
    rightAuthorityKeys.some((rightKey) => comparableAuthority(leftKey, rightKey))
  );
  const contractIdConflict = leftContractIds.length > 0 && rightContractIds.length > 0 && sharedContractIds.length === 0;
  const hardIdEqual = sharedIds.length > 0 || sharedContractIds.length > 0;
  const leftForm = family === "vendor" ? legalForm(leftName) : null;
  const rightForm = family === "vendor" ? legalForm(rightName) : null;
  const leftPlaces = family === "agency" ? agencyPlaces(leftPieces) : [];
  const rightPlaces = family === "agency" ? agencyPlaces(rightPieces) : [];

  return {
    features_version: FEATURES_VERSION,
    family,
    left_stem: leftStem,
    right_stem: rightStem,
    stem_equal: Boolean(leftStem && leftStem === rightStem),
    token_jaccard: jaccard(leftPieces, rightPieces),
    shared_tokens: sharedPieces,
    left_token_count: leftPieces.length,
    right_token_count: rightPieces.length,
    length_ratio: ratio(leftSurface, rightSurface),
    name_containment: Boolean(
      leftSurface && rightSurface &&
      (leftSurface.includes(rightSurface) || rightSurface.includes(leftSurface)),
    ),
    pin_epin_equal: sharedIds.length > 0,
    pin_epin_conflict: pinEpinConflict,
    shared_pin_epin: sharedIds,
    authority_key_equal: sharedAuthorityKeys.length > 0,
    authority_key_conflict: pinEpinConflict,
    shared_authority_keys: sharedAuthorityKeys,
    left_authority_keys: leftAuthorityKeys,
    right_authority_keys: rightAuthorityKeys,
    contract_id_equal: sharedContractIds.length > 0,
    contract_id_conflict: contractIdConflict,
    shared_contract_ids: sharedContractIds,
    hard_id_equal: hardIdEqual,
    hard_id_conflict: !hardIdEqual && (pinEpinConflict || contractIdConflict),
    left_legal_form: leftForm,
    right_legal_form: rightForm,
    legal_form_conflict: Boolean(leftForm && rightForm && leftForm !== rightForm),
    agency_place_conflict: Boolean(
      leftPlaces.length > 0 && rightPlaces.length > 0 &&
      !leftPlaces.some((place) => rightPlaces.includes(place)),
    ),
    // VI-03 proximity features (vendor family only).
    typo_proximity: family === "vendor"
      ? typoProximity(leftStem, rightStem)
      : { close: false, distance: -1 },
    stem_truncation: family === "vendor" && stemTruncation(leftStem, rightStem),
    abbreviation_matches: family === "vendor"
      ? abbreviationMatches(leftPieces, rightPieces)
      : 0,
    left_dba: family === "vendor" ? extractDba(leftName) : null,
    right_dba: family === "vendor" ? extractDba(rightName) : null,
  };
}
