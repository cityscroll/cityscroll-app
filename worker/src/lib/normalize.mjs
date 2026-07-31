// Entity-resolution normalizers (er-03).
//
// Pure string identity helpers shared by watch replay, vendor profiles, ingest
// projections, and later matcher cards. Behavior of vendorStem matches the
// historical compile.mjs body (legal-suffix strip + punctuation fold) so
// call sites that re-export from compile.mjs see zero churn.
//
// Agency surfaces go through the existing alias map in agencies.mjs
// (canonicalAgency) — this module is the single import surface for both
// families until the entity_resolution package boundary (er-08) absorbs it.

import { canonicalAgency } from "./agencies.mjs";

/** Matcher id for durable link receipts (see entity-resolution ADR). */
export const VENDOR_STEM_METHOD = "vendor_stem_v1";
export const VENDOR_STEM_VERSION = "1";

// Trailing legal / jurisdiction suffixes stripped iteratively (same regex as site/index.html).
export const VENDOR_SUFFIX =
  /\s+(INCORPORATED|INC|LLC|L\.L\.C|CORPORATION|CORP|COMPANY|CO|LTD|LIMITED|LP|LLP|PLLC|P\.C|PC|USA|OF NY|OF NEW YORK)\.?$/;

/**
 * Vendor-name identity: normalize to a stem (case / punctuation / legal suffixes).
 * Mirrors the site's read-time resolution so a watch on "Sinergia Inc" also
 * catches "Sinergia Incorporated". Empty / null → "".
 */
export function vendorStem(name) {
  let s = String(name || "")
    .replace(/<[^>]*>/g, " ")
    .toUpperCase()
    .replace(/[.,'’&]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let prev;
  do {
    prev = s;
    s = s.replace(VENDOR_SUFFIX, "").trim();
  } while (s !== prev && s.length > 3);
  return s;
}

/** True when both names produce the same non-empty vendor stem. */
export function sameVendorStem(a, b) {
  const sa = vendorStem(a);
  const sb = vendorStem(b);
  return sa.length > 0 && sa === sb;
}

/**
 * Agency identity via the City Record alias map (agencies.mjs GROUPS + patterns).
 * Re-exported so ER code has one normalize import for vendor + agency.
 */
export { canonicalAgency };

/** Stable site id for an agency surface (empty string for blank input). */
export function agencyCanonicalId(name) {
  const raw = String(name || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  return canonicalAgency(raw).canonical_id;
}

/** True when both agency strings resolve to the same non-empty canonical id. */
export function sameAgency(a, b) {
  const idA = agencyCanonicalId(a);
  const idB = agencyCanonicalId(b);
  return idA.length > 0 && idA === idB;
}

/**
 * Family-aware normalize for candidate generation.
 * kind: "vendor" | "agency" (default vendor).
 * Returns { family, key, display } where key is the identity handle.
 */
export function normalizeEntity(name, kind = "vendor") {
  if (kind === "agency") {
    const raw = String(name || "").replace(/\s+/g, " ").trim();
    if (!raw) return { family: "agency", key: "", display: "" };
    const { canonical_id, canonical_name } = canonicalAgency(raw);
    return { family: "agency", key: canonical_id, display: canonical_name };
  }
  const stem = vendorStem(name);
  return { family: "vendor", key: stem, display: stem };
}
