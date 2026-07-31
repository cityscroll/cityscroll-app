// Entity-resolution normalizers (er-03) — thin re-export of the package surface (er-08).
//
// Call sites (compile.mjs, tests, ingest projections) keep importing this path
// so behavior and import graph stay stable while the modular monolith boundary
// lives under entity_resolution/normalizers/.

export {
  VENDOR_STEM_METHOD,
  VENDOR_STEM_VERSION,
  VENDOR_SUFFIX,
  vendorStem,
  sameVendorStem,
  canonicalAgency,
  agencyCanonicalId,
  sameAgency,
  normalizeEntity,
} from "../../../entity_resolution/normalizers/index.mjs";
