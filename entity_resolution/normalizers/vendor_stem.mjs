// Pure vendor-name identity normalizers (entity_resolution package).
//
// Behavior matches the historical compile.mjs / site vendorStem body
// (legal-suffix strip + punctuation fold) so call sites that re-export
// through worker/src/lib/normalize.mjs and compile.mjs see zero churn.

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
