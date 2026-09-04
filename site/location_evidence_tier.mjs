/**
 * One canonical location-match evidence contract (PS-04).
 *
 * CityScroll already distinguishes stronger, source-backed place evidence from weaker,
 * heuristic placement in several places — site/location_derivation.mjs's per-method
 * confidence table, tools/lib/district_activity.mjs's map-assembly basis labeling, and
 * site/near_you_explanation_path.mjs's explanation-path ranking. Each of those grew its
 * own inline strong/derived/weak threshold, so the same raw evidence could be graded
 * differently depending on which renderer looked at it. This module is the single place
 * that grading happens: every caller derives a tier by calling into this module rather
 * than re-deriving one from a confidence number or a method name.
 *
 * Naming reuses the repository's existing `confidence_tier` vocabulary ("strong" /
 * "derived" / "weak", already used across site/, tools/, and worker/ for both location
 * and non-location evidence) rather than introducing a direct/derived/fallback synonym
 * set. The concepts line up exactly with the card's own language:
 *   strong  — direct, strong source-backed placement (point-in-polygon coordinates,
 *             publisher-supplied district, matter address, structured building identity)
 *   derived — a deterministic transformation from sufficiently grounded evidence
 *   weak    — heuristic, centroid-based, generic-text, or otherwise low-specificity
 *             placement (the card's "fallback")
 *
 * The tier ranks consistency of downstream behavior, not truth: "derived" is not "bad"
 * and "strong" is not a guarantee. Raw method + provenance stay attached beneath the
 * tier (see buildLocationEvidence) — the tier never replaces them.
 */

const clean = (value, max = 240) => String(value ?? "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max) || null;

export const LOCATION_EVIDENCE_SCHEMA = "cityscroll.location_evidence.v1";

/** The one canonical tier vocabulary. Reused verbatim as the existing `confidence_tier` field. */
export const LOCATION_EVIDENCE_TIERS = Object.freeze(["strong", "derived", "weak"]);

export function isLocationEvidenceTier(value) {
  return LOCATION_EVIDENCE_TIERS.includes(value);
}

/**
 * Methods that are strong, source-backed placement even without an accompanying numeric
 * confidence score: structured coordinates resolved by point-in-polygon, a publisher-
 * supplied council/community district, a matter's own address/borough/title place, or an
 * equivalent registry-backed structured bag. Mirrors the card's own worked example list
 * (PS-04) plus the equivalent methods already treated as strong in
 * tools/lib/district_activity.mjs and site/near_you_explanation_path.mjs.
 */
export const STRONG_LOCATION_METHODS = Object.freeze(new Set([
  "coordinates_pip",
  "civic_address_pip",
  "publisher_council",
  "publisher_district",
  "cd_intersects_council",
  "matter_address",
  "matter_body_borough",
  "matter_title_place",
  "structured_bag",
  "community_board",
  "community_board_ontology",
]));

/**
 * Methods whose own numeric confidence is not a reliable basis for an exact-place claim,
 * regardless of how confident the extractor scored them: a last-resort agency headquarters
 * pin, a vendor mailing address, or a district centroid standing in for a boundary lookup.
 * These are the card's own "heuristic, centroid-based, ... low-specificity placement"
 * examples. Used by locationEvidenceTierForExactPlace — the policy gate for predicates that
 * require exact local applicability (PS-04 AC3) — not by the base classifier, so a caller
 * that only wants the raw evidence-quality read (e.g. map display) is unaffected.
 */
export const WEAK_EXACT_PLACE_METHODS = Object.freeze(new Set([
  "agency_hq",
  "vendor_address",
  "vendor_place",
  "cd_centroid_council",
]));

function methodOf(evidence = {}) {
  return String(evidence.method || evidence.placement_method || evidence.source_method || "").trim();
}

/**
 * The one canonical evidence-tier classifier. Every caller that needs a strong/derived/weak
 * read from a method + confidence pair calls this instead of re-deriving a threshold.
 *
 * Precedence: an already-computed, valid tier is trusted as-is (a caller closer to the raw
 * extraction may already know more than method + a single confidence number). Otherwise a
 * numeric confidence is thresholded (>=0.8 strong, >=0.55 derived, else weak — the exact
 * thresholds already used throughout the repository, kept bit-for-bit so this refactor does
 * not move any existing match's tier). With neither, a known strong-source method promotes
 * to "strong"; anything else is "derived" (a placement exists, but its confidence is
 * unmeasured, not proven weak).
 */
export function classifyLocationEvidence(evidence = {}) {
  if (isLocationEvidenceTier(evidence.confidence_tier)) return evidence.confidence_tier;
  const numeric = Number(evidence.confidence);
  if (Number.isFinite(numeric)) {
    return numeric >= 0.8 ? "strong" : numeric >= 0.55 ? "derived" : "weak";
  }
  return STRONG_LOCATION_METHODS.has(methodOf(evidence)) ? "strong" : "derived";
}

/**
 * The tier as it applies to a predicate that requires exact local applicability (e.g.
 * "this record's place role is affected_area for the exact district the user selected").
 * A weak-exact-place method forces "weak" here even if its raw evidence read as "derived",
 * because that class of method is known to be too low-specificity to back an exact claim.
 * `allowWeakMethods` is the explicit policy escape hatch AC3 requires: without it, no weak
 * fallback evidence can silently pass this gate.
 */
export function locationEvidenceTierForExactPlace(evidence = {}, { allowWeakMethods = false } = {}) {
  const base = classifyLocationEvidence(evidence);
  if (!allowWeakMethods && WEAK_EXACT_PLACE_METHODS.has(methodOf(evidence))) return "weak";
  return base;
}

/** True unless the evidence is weak for an exact-place predicate (PS-04 AC3). */
export function locationEvidenceAllowsExactPredicate(evidence = {}, options = {}) {
  return locationEvidenceTierForExactPlace(evidence, options) !== "weak";
}

/**
 * Compose the full canonical evidence record: normalized tier alongside the raw method and
 * provenance beneath it (PS-04 AC1). Never drops the raw fields — the tier is additive.
 */
export function buildLocationEvidence(raw = {}) {
  const method = clean(raw.method || raw.placement_method, 100);
  const tier = classifyLocationEvidence({
    method,
    confidence: raw.confidence,
    confidence_tier: raw.confidence_tier,
  });
  return {
    schema: LOCATION_EVIDENCE_SCHEMA,
    tier,
    method,
    method_version: clean(raw.method_version, 40),
    source_id: clean(raw.source_id ?? raw.source, 160),
    boundary_vintage: clean(raw.boundary_vintage, 80),
    confidence: raw.confidence ?? raw.confidence_tier ?? null,
  };
}

/**
 * Coverage-by-tier metric (PS-04 AC8): `local_matches_by_evidence_tier`, and by domain where
 * a domain accessor is supplied. `items` is any list of evidence-shaped objects (raw slots,
 * located_in edges, or buildLocationEvidence() records all work — only method/confidence/
 * confidence_tier are read).
 */
export function summarizeLocationEvidenceTiers(items = [], { domainOf } = {}) {
  const byTier = { strong: 0, derived: 0, weak: 0 };
  const byDomain = {};
  for (const item of items) {
    const tier = classifyLocationEvidence(item);
    byTier[tier] += 1;
    if (typeof domainOf !== "function") continue;
    const domain = domainOf(item);
    if (!domain) continue;
    if (!byDomain[domain]) byDomain[domain] = { strong: 0, derived: 0, weak: 0 };
    byDomain[domain][tier] += 1;
  }
  return {
    schema: "cityscroll.local_matches_by_evidence_tier.v1",
    total: items.length,
    by_tier: byTier,
    by_domain: byDomain,
  };
}
