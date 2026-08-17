// Browser-safe mirror of the product vendor identity normalizer. Keep this
// implementation byte-compatible with entity_resolution/normalizers/vendor_stem.mjs.

const VENDOR_STEM_SUFFIX =
  /\s+(INCORPORATED|INC|LLC|L\.L\.C|CORPORATION|CORP|COMPANY|CO|LTD|LIMITED|LP|LLP|PLLC|P\.C|PC|USA|OF NY|OF NEW YORK)\.?$/;

export function vendorStem(value) {
  let stem = String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .toUpperCase()
    .replace(/[.,'’&]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let previous;
  do {
    previous = stem;
    stem = stem.replace(VENDOR_STEM_SUFFIX, "").trim();
  } while (stem !== previous && stem.length > 3);
  return stem;
}
