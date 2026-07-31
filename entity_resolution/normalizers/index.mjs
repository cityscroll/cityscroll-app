// entity_resolution/normalizers — public normalize surface (er-03 + er-08).
//
// Family-aware helpers for candidate generation and later matchers.
// Worker call sites keep importing worker/src/lib/normalize.mjs, which
// re-exports this module for zero churn.

export {
  VENDOR_STEM_METHOD,
  VENDOR_STEM_VERSION,
  VENDOR_SUFFIX,
  vendorStem,
  sameVendorStem,
} from "./vendor_stem.mjs";

export {
  canonicalAgency,
  agencyCanonicalId,
  sameAgency,
} from "./agency.mjs";

import { vendorStem } from "./vendor_stem.mjs";
import { canonicalAgency } from "./agency.mjs";

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
