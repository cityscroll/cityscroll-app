// Per-dimension characterization for the multi-dimension flywheel.
//
//   node --test test/multi_flywheel_dimensions.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateDataIntegrity,
  computeNotPublishedRate,
  classifyNotPublishedClaim,
  enumerateNotPublishedClaims,
  evaluateNotPublishedClaims,
  NOT_PUBLISHED_THRESHOLDS,
} from "../ontology/dimensions/data_integrity.mjs";
import { evaluateReadability, scoreView } from "../ontology/dimensions/readability.mjs";
import { evaluateOntologyEnrichment } from "../ontology/dimensions/ontology_enrichment.mjs";
import { evaluateCoverage } from "../ontology/dimensions/coverage.mjs";
import { evaluateCrossSourceConsistency } from "../ontology/dimensions/cross_source_consistency.mjs";
import { evaluateLocationResolution } from "../ontology/dimensions/location_resolution.mjs";
import { DIMENSION_IDS, DIMENSION_EVALUATORS } from "../ontology/dimensions/index.mjs";
import { checkOntologyRegistrySync } from "../ontology/sync.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

test("dimension catalog lists six evaluators", () => {
  assert.deepEqual(DIMENSION_IDS, [
    "data-integrity",
    "readability",
    "ontology-enrichment",
    "coverage",
    "cross-source-consistency",
    "location-resolution",
  ]);
  for (const id of DIMENSION_IDS) {
    assert.equal(typeof DIMENSION_EVALUATORS[id], "function");
  }
});

test("computeNotPublishedRate combines recent + historical population", () => {
  const rate = computeNotPublishedRate({
    recent: { size: 20, not_published: 20 },
    historical: { size: 20, not_published: 20 },
    non_null_examples: 0,
  });
  assert.equal(rate.n, 40);
  assert.equal(rate.not_published, 40);
  assert.equal(rate.rate, 1);
  assert.equal(rate.rate_label, "40/40");
  assert.equal(rate.spread_ok, true);

  const healthy = computeNotPublishedRate({
    recent: { size: 15, not_published: 2 },
    historical: { size: 15, not_published: 1 },
    non_null_examples: 27,
  });
  assert.equal(healthy.n, 30);
  assert.ok(healthy.rate < 0.2);
  assert.equal(healthy.non_null, 27);
});

test("classifyNotPublishedClaim flags ~100% when public source has data", () => {
  const rate = computeNotPublishedRate({
    recent: { size: 20, not_published: 20 },
    historical: { size: 20, not_published: 20 },
  });
  const red = classifyNotPublishedClaim(rate, {
    sample: {
      public_source_has_data: true,
      classification_hint: "mislabeled",
    },
  });
  assert.equal(red.red_flag, true);
  assert.equal(red.classification, "mislabeled");

  const withheld = classifyNotPublishedClaim(rate, {
    sample: {
      public_source_has_data: false,
      classification_hint: "genuinely_withheld",
    },
  });
  assert.equal(withheld.red_flag, false);
  assert.equal(withheld.classification, "genuinely_withheld");

  const tiny = classifyNotPublishedClaim(
    computeNotPublishedRate({ recent: { size: 2, not_published: 2 } }),
    { sample: { public_source_has_data: true } },
  );
  assert.equal(tiny.classification, "insufficient_sample");
  assert.equal(tiny.red_flag, false);
  assert.ok(NOT_PUBLISHED_THRESHOLDS.red_flag_rate >= 0.95);
});

test("data-integrity core: population not-published-rate emits red flags continuously", () => {
  const gap_taxonomy = loadJson("site/data/gap_taxonomy.json");
  const samples = loadJson("ontology/fixtures/dimensions/not_published_claim_samples.json");
  const features = loadJson("ontology/fixtures/dimensions/data_integrity_features.json");

  const enumerated = enumerateNotPublishedClaims(gap_taxonomy);
  assert.ok(enumerated.some((c) => c.id === "subsidy-field-company-place-money"));
  assert.ok(enumerated.every((c) => c.source === "gap_taxonomy" || c.id));

  const result = evaluateDataIntegrity({
    gap_taxonomy,
    not_published_samples: samples,
    features: features.features,
  });
  assert.equal(result.dimension, "data-integrity");
  assert.ok(result.metrics.not_published_claims_checked >= 5);
  assert.ok(result.metrics.not_published_red_flags >= 2, "expected ≥2 red flags");
  assert.ok(result.metrics.not_published_genuinely_withheld >= 1);
  assert.ok(result.metrics.not_published_healthy >= 1);

  // Core red flags from credibility audit
  assert.ok(
    result.cards.some((c) => c.id.includes("subsidy-field-company-place-money")),
    "Build NYC money ~100% not-published red flag",
  );
  assert.ok(
    result.cards.some((c) => c.id.includes("meeting-person-votes")),
    "person votes never-ingested red flag",
  );
  // Genuinely withheld package docs must NOT emit a red-flag bug card
  assert.ok(
    !result.cards.some((c) => c.id.includes("procurement-solicitation-documents") && c.evidence?.kind === "not_published_rate_red_flag"),
    "package documents are verified withhold, not a join bug",
  );

  const money = result.findings.find((f) => f.claim_id === "subsidy-field-company-place-money");
  assert.ok(money);
  assert.equal(money.red_flag, true);
  assert.equal(money.rate.rate, 1);
  assert.equal(money.classification, "mislabeled");

  // Secondary feature inventory still works
  assert.ok(result.metrics.features_checked >= 5);
  assert.ok(result.cards.some((c) => c.id.includes("passport.rfx_document_url")));
  assert.ok(result.cards.some((c) => c.id.includes("bid-tabulations.bid_count")));
  assert.ok(!result.cards.some((c) => c.id.includes("legistar.person_vote") && c.evidence?.method === "feature_non_null_example"));

  for (const card of result.cards) {
    assert.equal(card.dimension, "data-integrity");
    assert.ok(card.verify);
    assert.ok(card.demo_win);
  }

  // Pure path without gap taxonomy still evaluates sample inventory
  const sampleOnly = evaluateNotPublishedClaims(samples.claims);
  assert.ok(sampleOnly.metrics.red_flags >= 2);
});

test("readability scores views and cards unusable ones", () => {
  const good = scoreView({ hierarchy_score: 0.8, density_score: 0.4, dump_smell: 0.1 });
  assert.equal(good.unusable, false);
  assert.ok(good.overall >= 0.5);

  const bad = scoreView({ hierarchy_score: 0.2, density_score: 0.95, dump_smell: 0.9 });
  assert.equal(bad.unusable, true);

  const inventory = loadJson("ontology/fixtures/dimensions/readability_views.json");
  const result = evaluateReadability({ views: inventory.views });
  assert.equal(result.dimension, "readability");
  assert.ok(result.metrics.unusable >= 2);
  assert.ok(result.cards.some((c) => c.id.includes("raw-source-records-dump")));
  assert.ok(result.cards.some((c) => c.id.includes("gap-taxonomy-dense-table")));
  assert.ok(!result.cards.some((c) => c.id.includes("notice-lifecycle-money")));
  for (const card of result.cards) {
    assert.ok(card.evidence.scores);
    assert.ok(card.verify.includes("readability") || card.verify.length > 10);
  }
});

test("ontology-enrichment wraps legacy planner with dimension cards", () => {
  const source_coverage = loadJson("entity_resolution/source_coverage.json");
  const gap_taxonomy = loadJson("site/data/gap_taxonomy.json");
  const result = evaluateOntologyEnrichment({
    source_coverage,
    gap_taxonomy,
    registry_sync: checkOntologyRegistrySync(),
    cross_spine: { checked: 1, contradictions: 0 },
    actionability: { rate: 1, sample_size: 1 },
    temporal_scorecard: loadJson(
      "worker/test/fixtures/civic-time/expected_temporal_completeness.json",
    ),
    lifecycle_coherence_scorecard: loadJson(
      "worker/test/fixtures/lifecycle-coherence/expected_coherence.json",
    ),
    generated_at: "1970-01-01T00:00:00.000Z",
  });
  assert.equal(result.dimension, "ontology-enrichment");
  assert.ok(result.cards.length > 0);
  for (const card of result.cards) {
    assert.equal(card.dimension, "ontology-enrichment");
    assert.equal(card.emitted_by, "multi_flywheel");
    if (!String(card.evidence?.kind || "").includes("scorecard")) {
      assert.ok(card.evidence.legacy_class);
    }
    assert.ok(card.verify);
    assert.ok(card.demo_win);
  }
  assert.equal(result.metrics.temporal_completeness_rate, 0.9091);
  assert.equal(result.metrics.procurement_lifecycle_coherence_rate, 0.5);
  assert.equal(result.metrics.award_solicitation_recovery_rate, 0.8);
  assert.ok(result.cards.some((c) => c.id.includes("temporal-completeness")));
  assert.ok(result.cards.some((c) => c.id.includes("procurement-lifecycle-coherence")));
});

test("coverage emits for dual-write gaps and declared-not-ingested sources", () => {
  const source_contracts = loadJson("site/data/source_contracts.json");
  const source_coverage = loadJson("entity_resolution/source_coverage.json");
  const result = evaluateCoverage({ source_contracts, source_coverage });
  assert.equal(result.dimension, "coverage");
  assert.ok(result.metrics.declared_live >= 1);
  // Known dual-write gaps in source_coverage (e.g. doing-business, nycha)
  const dualWriteCards = result.cards.filter((c) => c.evidence?.kind === "dual-write-gap");
  assert.ok(dualWriteCards.length >= 1, "expected at least one dual-write gap card");
  for (const card of result.cards) {
    assert.equal(card.dimension, "coverage");
    assert.ok(card.verify);
    assert.ok(card.demo_win);
  }
});

test("cross-source-consistency emits open disagreements and spine failures", () => {
  const inventory = loadJson("ontology/fixtures/dimensions/cross_source_disagreements.json");
  const failPin = loadJson("ontology/fixtures/cross_spine/fail_pin_mismatch.json");
  const result = evaluateCrossSourceConsistency({
    disagreements: inventory.disagreements,
    claim_labeled_disagree_families: inventory.claim_labeled_disagree_families,
    cross_spine_bundles: [failPin],
  });
  assert.equal(result.dimension, "cross-source-consistency");
  assert.ok(result.metrics.open_disagreements >= 2);
  // Reconciled row must not emit
  assert.ok(!result.cards.some((c) => c.id.includes("demo-reconciled")));
  assert.ok(result.cards.some((c) => c.evidence?.field === "contract_amount"));
  assert.ok(result.cards.some((c) => c.evidence?.kind === "cross-spine-contradiction"));
  assert.equal(result.metrics.claim_families_checked, 2);
  assert.equal(result.metrics.claim_families_below_full_coverage, 1);
  assert.ok(result.cards.some((c) =>
    c.evidence?.join_family === "passport-contracts-x-checkbook-contracts"
    && c.evidence?.public_claim_labeled_disagree_rate === 0));
  assert.ok(!result.cards.some((c) =>
    c.evidence?.join_family === "city-record-x-ocp-awards"));
  for (const card of result.cards) {
    assert.ok(card.verify);
    assert.ok(card.demo_win);
  }
});

test("location-resolution measures corpora, districts, and boundary vintage without card flood", () => {
  const inventory = loadJson("ontology/fixtures/dimensions/location_resolution.json");
  const result = evaluateLocationResolution({ location_resolution: inventory });
  assert.equal(result.dimension, "location-resolution");
  assert.equal(result.metrics.lens_rates["meetings-hearings"].located_rate, 1);
  assert.equal(result.metrics.lens_rates.property.located_rate, 1);
  assert.equal(result.metrics.district_rates.community_resolution_rate, 1);
  assert.equal(result.metrics.district_rates.council_resolution_rate, 1);
  assert.equal(result.metrics.district_rates.district_resolution_rate, 1);
  // Shared contracted layer stamps current labeled vintages for both sources.
  assert.equal(result.metrics.boundary_metrics.checked, 2);
  assert.equal(result.metrics.boundary_metrics.stale, 0);
  assert.equal(result.metrics.boundary_metrics.current, 2);
  assert.equal(result.metrics.boundary_metrics.boundary_vintage_current_rate, 1);
  assert.ok(inventory.boundaries.every((b) => b.status === "contracted" && b.vintage_at));
  // No flood: located corpora + districts + current vintages → empty card queue.
  assert.deepEqual(result.cards, []);
});
