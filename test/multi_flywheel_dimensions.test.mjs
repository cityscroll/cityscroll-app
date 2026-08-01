// Per-dimension characterization for the multi-dimension flywheel.
//
//   node --test test/multi_flywheel_dimensions.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateDataIntegrity } from "../ontology/dimensions/data_integrity.mjs";
import { evaluateReadability, scoreView } from "../ontology/dimensions/readability.mjs";
import { evaluateOntologyEnrichment } from "../ontology/dimensions/ontology_enrichment.mjs";
import { evaluateCoverage } from "../ontology/dimensions/coverage.mjs";
import { evaluateCrossSourceConsistency } from "../ontology/dimensions/cross_source_consistency.mjs";
import { DIMENSION_IDS, DIMENSION_EVALUATORS } from "../ontology/dimensions/index.mjs";
import { checkOntologyRegistrySync } from "../ontology/sync.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

test("dimension catalog lists five evaluators", () => {
  assert.deepEqual(DIMENSION_IDS, [
    "data-integrity",
    "readability",
    "ontology-enrichment",
    "coverage",
    "cross-source-consistency",
  ]);
  for (const id of DIMENSION_IDS) {
    assert.equal(typeof DIMENSION_EVALUATORS[id], "function");
  }
});

test("data-integrity emits cards for always-null and broken-join features", () => {
  const inventory = loadJson("ontology/fixtures/dimensions/data_integrity_features.json");
  const result = evaluateDataIntegrity({ features: inventory.features });
  assert.equal(result.dimension, "data-integrity");
  assert.ok(result.metrics.features_checked >= 5);
  assert.ok(result.metrics.always_null >= 1);
  assert.ok(result.metrics.broken_join >= 1);
  assert.ok(result.cards.some((c) => c.id.includes("passport.rfx_document_url")));
  assert.ok(result.cards.some((c) => c.id.includes("bid-tabulations.bid_count")));
  // Healthy features do not emit
  assert.ok(!result.cards.some((c) => c.id.includes("legistar.person_vote")));
  for (const card of result.cards) {
    assert.equal(card.dimension, "data-integrity");
    assert.ok(card.verify);
    assert.ok(card.demo_win);
    assert.ok(card.lesson_class);
  }
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
    generated_at: "1970-01-01T00:00:00.000Z",
  });
  assert.equal(result.dimension, "ontology-enrichment");
  assert.ok(result.cards.length > 0);
  for (const card of result.cards) {
    assert.equal(card.dimension, "ontology-enrichment");
    assert.equal(card.emitted_by, "multi_flywheel");
    assert.ok(card.evidence.legacy_class);
    assert.ok(card.verify);
    assert.ok(card.demo_win);
  }
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
    cross_spine_bundles: [failPin],
  });
  assert.equal(result.dimension, "cross-source-consistency");
  assert.ok(result.metrics.open_disagreements >= 2);
  // Reconciled row must not emit
  assert.ok(!result.cards.some((c) => c.id.includes("demo-reconciled")));
  assert.ok(result.cards.some((c) => c.evidence?.field === "contract_amount"));
  assert.ok(result.cards.some((c) => c.evidence?.kind === "cross-spine-contradiction"));
  for (const card of result.cards) {
    assert.ok(card.verify);
    assert.ok(card.demo_win);
  }
});
