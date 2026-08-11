// Durable join-gate policy: product strategies + correct denominators.
//
//   node --test test/join_gate_policy.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateRc1PlanPassportGate,
  evaluateUlurpRecommendationGate,
  missingProductStrategies,
  selectUsefulnessGate,
  USEFULNESS_THRESHOLD,
} from "../ontology/join_gate_policy.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("selectUsefulnessGate prefers joinable-candidate rates over catalog coverage", () => {
  const decision = selectUsefulnessGate({
    zap_universe: {
      joined: 152,
      total: 27971,
      rate: 0.0054,
      role: "catalog_coverage",
    },
    recommendation_rows_hit_zap: {
      joined: 80,
      total: 91,
      rate: 0.8791,
      role: "gate",
    },
  });
  assert.equal(decision.selected.id, "recommendation_rows_hit_zap");
  assert.equal(decision.ok, true);
  assert.ok(decision.selected.rate >= USEFULNESS_THRESHOLD);
});

test("selectUsefulnessGate does not let a weak exact-only contrast kill a stronger product join", () => {
  const decision = selectUsefulnessGate({
    exact_only_fixed_sorted: {
      joined: 0,
      total: 100,
      rate: 0,
      role: "contrast",
      label: "legacy fixed_sorted exact",
    },
    identifier_bearing_prefix: {
      joined: 92,
      total: 121,
      rate: 0.76,
      role: "gate",
      label: "identifier_bearing pin_prefix_of_epin",
    },
  });
  assert.equal(decision.selected.id, "identifier_bearing_prefix");
  assert.equal(decision.ok, true);
});

test("missingProductStrategies flags skipped passport prefix joins", () => {
  assert.deepEqual(
    missingProductStrategies(["exact"], ["exact", "pin_prefix_of_epin", "epin_prefix_of_pin"]),
    ["pin_prefix_of_epin", "epin_prefix_of_pin"],
  );
  assert.deepEqual(
    missingProductStrategies(
      ["exact", "pin_prefix_of_epin", "epin_prefix_of_pin"],
      ["exact", "pin_prefix_of_epin", "epin_prefix_of_pin"],
    ),
    [],
  );
});

test("ULURP re-gate ships on recommendation-row denominator from prior rates", () => {
  const prior = JSON.parse(readFileSync(
    join(ROOT, "site/data/ulurp_recommendation_sources/verification_receipts/ulurp_recommendations_2026-07-30.json"),
    "utf8",
  ));
  const gate = evaluateUlurpRecommendationGate(prior.join_measurement.rates);
  assert.equal(gate.selected.id, "recommendation_rows_hit_zap");
  assert.ok(gate.selected.rate >= 0.3);
  assert.equal(gate.materialize, true);
  assert.match(gate.wrong_universe_note, /Property Disposition/i);
});

test("2026-08-11 ULURP receipt records shipped gate on recommendation rows", () => {
  const receipt = JSON.parse(readFileSync(
    join(ROOT, "site/data/ulurp_recommendation_sources/verification_receipts/ulurp_recommendations_2026-08-11.json"),
    "utf8",
  ));
  assert.equal(receipt.join_measurement.gate.materialize, true);
  assert.equal(receipt.join_measurement.gate.selected.id, "recommendation_rows_hit_zap");
  assert.ok(receipt.join_measurement.rates.recommendation_rows_hit_zap.rate >= 0.3);
  assert.ok(receipt.join_measurement.rates.zap_ulurp_numbered_either.rate < 0.3);
  const lookup = JSON.parse(readFileSync(
    join(ROOT, "site/data/ulurp_recommendations_lookup.json"),
    "utf8",
  ));
  assert.equal(lookup.bridge.materialize, true);
  assert.ok(Object.keys(lookup.by_ulurp_key).length > 0);
});

test("RC-1 2026-08-11 receipt clears identifier-bearing prefix gate", () => {
  const receipt = JSON.parse(readFileSync(
    join(ROOT, "site/data/procurement_plan_sources/verification_receipts/procurement_plans_2026-08-11.json"),
    "utf8",
  ));
  const path = receipt.join_measurement.paths.mocs_ll63_to_passport;
  assert.equal(path.sample_method, "identifier_bearing");
  assert.ok(path.rate >= 0.3);
  assert.ok(path.precision >= 0.95);
  assert.equal(path.materialize, true);
  assert.ok(path.method_counts.pin_prefix_of_epin > 0);
  const decision = evaluateRc1PlanPassportGate({
    ...path,
    strategies_attempted: ["exact", "pin_prefix_of_epin", "epin_prefix_of_pin"],
  });
  assert.equal(decision.materialize, true);
  assert.equal(receipt.headline.shipped, true);
  assert.ok(receipt.headline.bridge_edges > 0);
  const lookup = JSON.parse(readFileSync(
    join(ROOT, "site/data/procurement_planning_thread_lookup.json"),
    "utf8",
  ));
  assert.equal(lookup.rows.length, receipt.payload_contract.production_bridge_edges);
});

test("engineering lessons document the join false-negative class", () => {
  const text = readFileSync(join(ROOT, "ontology/engineering-lessons.md"), "utf8");
  assert.match(text, /join-false-negative|joinable.candidate|product.?join|prefix/i);
  assert.match(text, /denominator/i);
});
