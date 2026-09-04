import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCATION_EVIDENCE_SCHEMA,
  LOCATION_EVIDENCE_TIERS,
  STRONG_LOCATION_METHODS,
  WEAK_EXACT_PLACE_METHODS,
  classifyLocationEvidence,
  locationEvidenceTierForExactPlace,
  locationEvidenceAllowsExactPredicate,
  buildLocationEvidence,
  summarizeLocationEvidenceTiers,
} from "../site/location_evidence_tier.mjs";
import {
  compactDistrictRecord,
  geographyPlacementDecision,
} from "../tools/lib/district_activity.mjs";
import {
  buildNearYouExplanationCandidates,
  selectNearYouExplanationPath,
} from "../site/near_you_explanation_path.mjs";
import {
  FIXTURE_COMMUNITY_DISTRICT_SUBJECT,
  FIXTURE_GEOGRAPHY_NODES,
  FIXTURE_MANDATE_BACKLINKS,
  FIXTURE_ONE_RECORDS,
} from "./fixtures/place_scope_contract/geography.mjs";

// PS-04: one canonical location-match evidence contract, derived in a single layer and
// consumed identically by Near You explanation and Following/map evaluation.

test("A6: fixtures cover direct/derived/weak — the card's own worked example methods", () => {
  // "direct" (strong) — point-in-polygon coordinates, a publisher-supplied district, a
  // matter's own address/borough/title place, an equivalent structured bag.
  for (const method of [
    "coordinates_pip", "publisher_council", "publisher_district",
    "matter_address", "matter_body_borough", "matter_title_place", "structured_bag",
  ]) {
    assert.equal(classifyLocationEvidence({ method }), "strong", method);
    assert.ok(STRONG_LOCATION_METHODS.has(method), method);
  }
  // "derived" — a deterministic transformation from sufficiently grounded evidence, read
  // here as a mid-band numeric confidence with no method override.
  assert.equal(classifyLocationEvidence({ method: "venue_line", confidence: 0.7 }), "derived");
  assert.equal(classifyLocationEvidence({ confidence: 0.55 }), "derived");
  // "weak" (fallback) — heuristic, centroid-based, or generic-text placement.
  assert.equal(classifyLocationEvidence({ method: "agency_hq", confidence: 0.35 }), "weak");
  assert.equal(classifyLocationEvidence({ confidence: 0.1 }), "weak");
  assert.deepEqual([...LOCATION_EVIDENCE_TIERS], ["strong", "derived", "weak"]);
});

test("classifyLocationEvidence: thresholds are exact and an explicit tier is trusted as-is", () => {
  assert.equal(classifyLocationEvidence({ confidence: 0.8 }), "strong");
  assert.equal(classifyLocationEvidence({ confidence: 0.79999 }), "derived");
  assert.equal(classifyLocationEvidence({ confidence: 0.55 }), "derived");
  assert.equal(classifyLocationEvidence({ confidence: 0.549 }), "weak");
  // An already-computed tier from an upstream stamp wins over a method or number that
  // would otherwise suggest a different read.
  assert.equal(classifyLocationEvidence({ method: "agency_hq", confidence: 0.99, confidence_tier: "derived" }), "derived");
  // An unmeasured method with no numeric confidence is "derived", not silently "weak" —
  // a placement exists; its strength merely was not scored.
  assert.equal(classifyLocationEvidence({ method: "some_unmodeled_method" }), "derived");
});

test("A2/A3: the exact-place predicate gate is one canonical layer, and policy is the only override", () => {
  for (const method of WEAK_EXACT_PLACE_METHODS) {
    // Even evidence that would score "strong" or "derived" on its own is forced weak for
    // an exact-place claim, because the method itself is too low-specificity to back one.
    assert.equal(locationEvidenceTierForExactPlace({ method, confidence: 0.95 }), "weak", method);
    assert.equal(locationEvidenceAllowsExactPredicate({ method, confidence: 0.95 }), false, method);
    // The explicit policy escape hatch AC3 requires — never an implicit default.
    assert.equal(
      locationEvidenceAllowsExactPredicate({ method, confidence: 0.95 }, { allowWeakMethods: true }),
      true,
      method,
    );
  }
  for (const method of STRONG_LOCATION_METHODS) {
    assert.equal(locationEvidenceAllowsExactPredicate({ method }), true, method);
  }
});

test("A1: buildLocationEvidence exposes tier, raw method, and provenance beneath it", () => {
  const evidence = buildLocationEvidence({
    method: "matter_title_place",
    confidence: 0.88,
    source_id: "district-activity-placement",
    boundary_vintage: "2026-05-26",
    method_version: "1.0.0",
  });
  assert.equal(evidence.schema, LOCATION_EVIDENCE_SCHEMA);
  assert.equal(evidence.tier, "strong");
  assert.equal(evidence.method, "matter_title_place");
  assert.equal(evidence.method_version, "1.0.0");
  assert.equal(evidence.source_id, "district-activity-placement");
  assert.equal(evidence.boundary_vintage, "2026-05-26");
  // The tier never replaces the raw confidence it was derived from.
  assert.equal(evidence.confidence, 0.88);
});

test("A8: local_matches_by_evidence_tier coverage, and by domain where practical", () => {
  const items = [
    { method: "coordinates_pip", domain: "meetings" },
    { method: "matter_title_place", domain: "meetings" },
    { confidence: 0.6, domain: "money" },
    { method: "agency_hq", confidence: 0.3, domain: "money" },
  ];
  const summary = summarizeLocationEvidenceTiers(items, { domainOf: (item) => item.domain });
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.by_tier, { strong: 2, derived: 1, weak: 1 });
  assert.deepEqual(summary.by_domain.meetings, { strong: 2, derived: 0, weak: 0 });
  assert.deepEqual(summary.by_domain.money, { strong: 0, derived: 1, weak: 1 });
});

test("A5: Following/map evaluation and Near You explanation exclude the same weak evidence", () => {
  for (const method of WEAK_EXACT_PLACE_METHODS) {
    // Following's public-geography membership gate (feeds the standing-watch match index).
    const routed = geographyPlacementDecision({ method });
    assert.equal(routed.decision, "evidence_only", method);
    // The same method, read through the one canonical classifier used everywhere else.
    assert.equal(locationEvidenceAllowsExactPredicate({ method }), false, method);
  }
  // A strong method clears both gates.
  const strong = geographyPlacementDecision({ method: "coordinates_pip" });
  assert.equal(strong.decision, "public");
  assert.equal(locationEvidenceAllowsExactPredicate({ method: "coordinates_pip" }), true);
});

test("A7: no existing strong geographic match disappears — the map basis for a strong slot stays strong", () => {
  for (const method of STRONG_LOCATION_METHODS) {
    const record = compactDistrictRecord("meetings", { request_id: "n-strong" }, [
      { borough: "Brooklyn", community: "K18", council: "42", method, confidence: 0.9 },
    ]);
    assert.equal(record.confidence, "strong", method);
    assert.notEqual(record.basis, "Weak fallback", method);
  }
  // A known weak method still lands in the existing "Weak fallback" bucket, unchanged.
  const weak = compactDistrictRecord("meetings", { request_id: "n-weak" }, [
    { borough: "Manhattan", community: null, council: null, method: "agency_hq", confidence: 0.35 },
  ]);
  assert.equal(weak.basis, "Weak fallback");
  assert.equal(weak.confidence, "weak");
});

test("A1/A4: Near You explanation candidates expose the canonical tier, consistent with their basis", () => {
  const candidates = buildNearYouExplanationCandidates({
    record: FIXTURE_ONE_RECORDS.matterHere.record,
    lens: "meetings",
    locatedEdges: FIXTURE_ONE_RECORDS.matterHere.locatedEdges,
    geographyNodes: FIXTURE_GEOGRAPHY_NODES,
    mandateBacklinks: FIXTURE_MANDATE_BACKLINKS,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].location.tier, "strong");
  assert.equal(candidates[0].location.place_role, "matter");
});

test("A2/A3: a weak-method placement never wins an exact-place explanation, even when the record's own basis label would not have caught it", () => {
  // Deliberately not "Weak fallback" as the record basis — this isolates the new canonical
  // evidence-tier gate in selectNearYouExplanationPath from the pre-existing, string-based
  // NON_DISTRICT_BASES exclusion in buildNearYouExplanationCandidates (see
  // site/near_you_explanation_path.mjs). Before PS-04, nothing stopped this candidate from
  // winning: the edge is decision:"public" and the record's basis passes the district gate.
  const record = { id: "psc-901", basis: "Affected area" };
  const locatedEdges = [{
    type: "located_in",
    from: `notice:${record.id}`,
    to: FIXTURE_COMMUNITY_DISTRICT_SUBJECT,
    decision: "public",
    method: "district_activity_placement_v1",
    method_version: "1.0.0",
    confidence: "derived",
    evidence: { lens: "meetings", placement_method: "agency_hq", boundary_vintage: "2026-05-26" },
  }];
  const candidates = buildNearYouExplanationCandidates({
    record,
    lens: "meetings",
    locatedEdges,
    geographyNodes: FIXTURE_GEOGRAPHY_NODES,
    mandateBacklinks: FIXTURE_MANDATE_BACKLINKS,
  });
  assert.equal(candidates.length, 1, "the candidate is built — the gate belongs at selection time");
  assert.equal(candidates[0].location.tier, "derived", "raw tier read, unaware of the exact-place policy yet");

  const scope = {
    place: {
      boroughs: [], community_districts: ["K18"], council_districts: [], location_scope: null,
    },
  };
  assert.equal(
    selectNearYouExplanationPath(candidates, scope),
    null,
    "a weak-exact-place method must not silently satisfy the exact community-district predicate",
  );

  // Policy may explicitly allow it in the future — but the base build must not; there is no
  // implicit policy override today, so the same edge is still excluded by default.
  assert.equal(
    locationEvidenceAllowsExactPredicate({ method: "agency_hq", confidence_tier: "derived" }),
    false,
  );
});
