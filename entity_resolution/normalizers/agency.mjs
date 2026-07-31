// Agency identity normalizers for the entity_resolution package.
//
// Agency surfaces go through the City Record alias map in
// worker/src/lib/agencies.mjs (canonicalAgency). This module is the package
// import surface so ER code has one normalize family for vendor + agency.

import { canonicalAgency } from "../../worker/src/lib/agencies.mjs";

/** Agency identity via the City Record alias map. */
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
