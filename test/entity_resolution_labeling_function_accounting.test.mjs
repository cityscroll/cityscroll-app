import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { accountLabelingFunctions, LABELING_FUNCTIONS_VERSION } from "../entity_resolution/evaluation/labeling_functions.mjs";
import { FEATURES_VERSION } from "../entity_resolution/features/index.mjs";

const feature = (pair_id, overrides = {}) => ({
  pair_id,
  features: {
    features_version: FEATURES_VERSION,
    family: "vendor",
    stem_equal: false,
    token_jaccard: 0,
    legal_form_conflict: false,
    typo_proximity: { close: false },
    stem_truncation: false,
    abbreviation_matches: 0,
    left_token_count: 2,
    right_token_count: 2,
    shared_tokens: [],
    hard_id_equal: false,
    ...overrides,
  },
});

test("accounting reports coverage, overlap, conflict, and gold accuracy with denominators", () => {
  const report = accountLabelingFunctions({
    rows: [
      feature("a", { stem_equal: true, token_jaccard: 1 }),
      feature("b", { stem_equal: true, legal_form_conflict: true, token_jaccard: 1 }),
      feature("c"),
    ],
    gold: [{ pair_id: "a", label: "same" }, { pair_id: "b", label: "same" }],
  });
  assert.equal(report.accounting_version, LABELING_FUNCTIONS_VERSION);
  assert.equal(report.population.pair_count, 3);
  assert.equal(report.population.covered_pair_count, 2);
  assert.equal(report.population.conflict_pair_count, 1);
  const stem = report.labeling_functions.find((row) => row.name === "vendor_stem_equal_v0").metrics;
  assert.deepEqual({ coverage: stem.coverage_count, overlap: stem.overlap_count, conflict: stem.conflict_count },
    { coverage: 2, overlap: 2, conflict: 1 });
  assert.equal(stem.empirical_accuracy, 1);
  const legal = report.labeling_functions.find((row) => row.name === "vendor_legal_form_conflict_v0").metrics;
  assert.equal(legal.coverage_count, 1);
  assert.equal(legal.overlap_count, 1);
  assert.equal(legal.conflict_count, 1);
  assert.equal(legal.empirical_accuracy, 0);
});

test("accounting rejects a different feature version", () => {
  const row = JSON.parse(readFileSync("entity_resolution/eval/bakeoff/2026-08-06/candidate_pairs.jsonl", "utf8").split("\n")[0]);
  row.features.features_version = "wrong_features_v0";
  assert.throws(() => accountLabelingFunctions({ rows: [row] }), /requires pair_features_v2/);
});
