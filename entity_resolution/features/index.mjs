// entity_resolution/features — deterministic pair features for matcher v0.

import { agencyCanonicalId } from "../normalizers/agency.mjs";
import { vendorStem } from "../normalizers/vendor_stem.mjs";

export const FEATURES_VERSION = "pair_features_v0";

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

/** Treat PIN and EPIN as the same identifier family. */
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
  const sharedIds = leftIds.filter((id) => rightIds.includes(id));
  const leftContractIds = contractIdValues(left);
  const rightContractIds = contractIdValues(right);
  const sharedContractIds = leftContractIds.filter((id) => rightContractIds.includes(id));
  const pinEpinConflict = leftIds.length > 0 && rightIds.length > 0 && sharedIds.length === 0;
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
  };
}
