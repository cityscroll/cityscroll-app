import assert from "node:assert/strict";
import test from "node:test";

import { scoreTopicMatch } from "../site/process_conformance.mjs";
import {
  TOPIC_NORMALIZATION_REGISTRY,
  TOPIC_NORMALIZATION_VERSION,
  normalizeTopicEvidence,
  validateTopicNormalizationRegistry,
} from "../site/topic_normalization.mjs";
import { routeCrossSpineEdge } from "../entity_resolution/cross_domain/edge_policy.mjs";

test("reviewed topic registry is versioned and every mapping cites residual examples and sources", () => {
  assert.deepEqual(validateTopicNormalizationRegistry(), {
    ok: true,
    mappings: 4,
    version: TOPIC_NORMALIZATION_VERSION,
  });
  for (const mapping of TOPIC_NORMALIZATION_REGISTRY.mappings) {
    assert.ok(mapping.evidence.length > 0, mapping.id);
    for (const evidence of mapping.evidence) {
      assert.match(evidence.corpus, /^cross_spine_(?:gold_v3|shadow_census_v1)$/);
      assert.ok(evidence.residual_id, mapping.id);
      assert.ok(evidence.examples.length >= 2, mapping.id);
      assert.deepEqual(evidence.source_systems, ["nyc_legistar", "city_record"]);
    }
  }
});

test("official publisher acronym and reviewed morphology normalize candidate topics", () => {
  const acronym = scoreTopicMatch(
    "Regulate commercial waste zones",
    { label: "DSNY Proposed Implementation Dates for Manhattan West CWZs" },
  );
  assert.deepEqual(acronym.shared, ["commercial", "waste", "zone"]);
  assert.equal(acronym.method, "reviewed_topic_overlap_v1");
  assert.equal(acronym.normalization.registry_version, TOPIC_NORMALIZATION_VERSION);

  const morphology = scoreTopicMatch(
    "Establish structural inspection thresholds",
    { label: "Structural inspections threshold amendments" },
  );
  assert.deepEqual(morphology.shared, ["structural", "inspection"]);
});

test("publisher terminology remains phrase-bound and needs a second supported concept", () => {
  const reviewed = scoreTopicMatch(
    "Hold a hearing for a landmark under consideration",
    { label: "Landmarks designation hearing" },
  );
  assert.deepEqual(reviewed.shared, ["landmark", "designation"]);

  const oneConcept = scoreTopicMatch("landmark", { label: "landmarks" });
  assert.equal(oneConcept.score, 0, "singular/plural forms must not count as two concepts");
  assert.deepEqual(oneConcept.shared, []);
});

test("a meeting alias candidate remains blocked without temporal evidence", () => {
  const topic = scoreTopicMatch(
    "Hold a hearing for a landmark under consideration",
    { label: "Landmarks designation hearing" },
  );
  const route = routeCrossSpineEdge({
    relation: "mandate_meeting",
    features: {
      agency_exact: true,
      event_kind_match: true,
      subject_scope_overlap: topic.shared,
      temporal_compatible: false,
    },
  });
  assert.equal(topic.method, "reviewed_topic_overlap_v1");
  assert.equal(route.public, false);
  assert.equal(route.tier, "evidence_only");
  assert.ok(route.evidence.missing.includes("temporal_compatible"));
});

test("ambiguous acronyms and broad civic words abstain", () => {
  for (const [left, right] of [
    ["DOT map public hearing", "dot plan public meeting"],
    ["REC plan for buildings", "Records retention rule for buildings"],
    ["Public hearing notice", "City meeting agenda"],
  ]) {
    const match = scoreTopicMatch(left, { label: right });
    assert.equal(match.score, 0, `${left} || ${right}`);
    assert.equal(match.method, null);
  }

  const raw = normalizeTopicEvidence("DEP DOT REC BID MAP", []);
  assert.deepEqual(raw.tokens, []);
  assert.deepEqual(raw.applied, []);
});
