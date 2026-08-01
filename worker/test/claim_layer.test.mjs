// Characterization for the shared claim-layer vocabulary (source assertion ≠
// interpretation ≠ derived conclusion). Charter: docs/adr/evidence-assertion-layer.md
//
// Metric: public_claim_labeled_disagree_rate on OCP-joined awards.
//
//   node --test worker/test/claim_layer.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAIM_LAYER_VERSION,
  CLAIM_CLASSIFICATIONS,
  sourceAssertionClaim,
  interpretationClaim,
  derivedConclusionClaim,
  conflictClaimBundle,
  labelOcpDisagreements,
  readerLabelFor,
  isCompleteClaimLayer,
  disagreementsFullyLabeled,
  measurePublicClaimLabeledDisagreeRate,
} from "../src/lib/claim_layer.mjs";
import { corroborateAward, joinOcpAward, OCP_SOURCE } from "../src/lib/ocp_awards.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const OCP_CASES = JSON.parse(
  readFileSync(join(ROOT, "worker/test/fixtures/claim-layer/ocp_joined_awards.json"), "utf8"),
);

test("classifications and reader labels stay three-way", () => {
  assert.equal(CLAIM_LAYER_VERSION, "claim_layer_v1");
  assert.deepEqual(Object.values(CLAIM_CLASSIFICATIONS).sort(), [
    "cityscroll_interpretation",
    "derived_conclusion",
    "source_assertion",
  ]);
  assert.equal(readerLabelFor("source_assertion"), "Source assertion");
  assert.equal(readerLabelFor("cityscroll_interpretation"), "CityScroll interpretation");
  assert.equal(readerLabelFor("derived_conclusion"), "Derived conclusion");
});

test("source assertions keep publisher provenance only", () => {
  const claim = sourceAssertionClaim({
    source_system: "city_record",
    source_field: "contract_amount",
    value: 999999,
    source_system_id: "20260723031",
  });
  assert.equal(claim.classification, "source_assertion");
  assert.equal(claim.source_system, "city_record");
  assert.equal(claim.value, 999999);
  assert.equal(Object.hasOwn(claim, "selected_value"), false);
});

test("unresolved interpretation never carries a selected winner", () => {
  const claim = interpretationClaim({
    status: "conflict",
    resolution: "unresolved",
    summary: "Values differ; neither selected.",
    selected_value: 250000,
    comparison_values: [999999, 250000],
  });
  assert.equal(claim.classification, "cityscroll_interpretation");
  assert.equal(claim.resolution, "unresolved");
  assert.equal(Object.hasOwn(claim, "selected_value"), false);
  assert.deepEqual(claim.comparison_values, [999999, 250000]);
});

test("derived conclusion cites evidence and is not a source assertion", () => {
  const claim = derivedConclusionClaim({
    fact: "canonical_name",
    label: "Dossier name",
    value: "Acme Construction LLC",
    summary: "Display name built from linked source name assertions.",
    evidence_assertion_ids: ["a1", "a2"],
  });
  assert.equal(claim.classification, "derived_conclusion");
  assert.deepEqual(claim.evidence_assertion_ids, ["a1", "a2"]);
  assert.notEqual(claim.classification, "source_assertion");
});

test("conflict bundle labels both assertions and leaves derived_conclusion null", () => {
  const bundle = conflictClaimBundle({
    fact: "contract_amount",
    label: "Contract amount",
    left: {
      source_system: "city_record",
      source_field: "contract_amount",
      value: 999999,
    },
    right: {
      source_system: OCP_SOURCE,
      source_field: "contract_amount",
      value: 250000,
    },
  });
  assert.equal(bundle.version, CLAIM_LAYER_VERSION);
  assert.equal(bundle.assertions.length, 2);
  assert.ok(bundle.assertions.every((a) => a.classification === "source_assertion"));
  assert.equal(bundle.interpretation.classification, "cityscroll_interpretation");
  assert.equal(bundle.interpretation.resolution, "unresolved");
  assert.equal(bundle.derived_conclusion, null);
});

test("OCP amount/date disagreement attaches claim_layer on each row", () => {
  const corr = corroborateAward(
    { amount: 999999, date: "2026-07-15" },
    { amount: 250000, date: "2026-07-30" },
  );
  assert.equal(corr.agree, false);
  assert.equal(corr.disagreements.length, 2);
  for (const row of corr.disagreements) {
    assert.ok(row.claim_layer, `expected claim_layer on ${row.field}`);
    assert.equal(row.claim_layer.version, CLAIM_LAYER_VERSION);
    assert.equal(row.claim_layer.assertions.length, 2);
    assert.equal(row.claim_layer.assertions[0].source_system, "city_record");
    assert.equal(row.claim_layer.assertions[1].source_system, OCP_SOURCE);
    assert.equal(row.claim_layer.interpretation.resolution, "unresolved");
    assert.equal(row.claim_layer.derived_conclusion, null);
  }
  const amount = corr.disagreements.find((d) => d.field === "amount");
  assert.equal(amount.claim_layer.assertions[0].value, 999999);
  assert.equal(amount.claim_layer.assertions[1].value, 250000);
});

test("labelOcpDisagreements is idempotent-safe on empty input", () => {
  assert.deepEqual(labelOcpDisagreements([]), []);
  assert.deepEqual(labelOcpDisagreements(null), []);
});

test("isCompleteClaimLayer requires assertions + unresolved interpretation + no winner", () => {
  const good = conflictClaimBundle({
    fact: "contract_amount",
    left: { source_system: "city_record", source_field: "contract_amount", value: 1 },
    right: { source_system: OCP_SOURCE, source_field: "contract_amount", value: 2 },
  });
  assert.equal(isCompleteClaimLayer(good), true);
  assert.equal(isCompleteClaimLayer(null), false);
  assert.equal(isCompleteClaimLayer({ ...good, derived_conclusion: { value: 1 } }), false);
  assert.equal(
    isCompleteClaimLayer({
      ...good,
      interpretation: { ...good.interpretation, resolution: "resolved", selected_value: 1 },
    }),
    false,
  );
  assert.equal(disagreementsFullyLabeled([{ field: "amount", claim_layer: good }]), true);
  assert.equal(disagreementsFullyLabeled([{ field: "amount", claim_layer: null }]), false);
});

test("public_claim_labeled_disagree_rate: product path moves 0 → 1 on OCP-joined disagrees", () => {
  const joined = OCP_CASES.cases.map((c) => {
    const join = joinOcpAward(c.notice, c.ocp_rows);
    return { id: c.id, notice_id: c.notice_id, ...join };
  });

  // Baseline: strip claim_layer (pre-#271 / unlabeled public surface).
  const unlabeled = joined.map((row) => {
    if (!row.corroboration) return row;
    return {
      ...row,
      corroboration: {
        ...row.corroboration,
        disagreements: (row.corroboration.disagreements || []).map((d) => {
          const { claim_layer: _drop, ...rest } = d;
          return rest;
        }),
      },
    };
  });

  const before = measurePublicClaimLabeledDisagreeRate(unlabeled);
  assert.equal(before.metric, "public_claim_labeled_disagree_rate");
  assert.equal(before.version, CLAIM_LAYER_VERSION);
  assert.ok(before.eligible >= 2, `expected ≥2 disagree cases, got ${before.eligible}`);
  assert.equal(before.labeled, 0, "unlabeled disagreements must not count");
  assert.equal(before.rate, 0, "baseline public_claim_labeled_disagree_rate is 0");

  const after = measurePublicClaimLabeledDisagreeRate(joined);
  assert.equal(after.eligible, before.eligible);
  assert.equal(after.labeled, after.eligible);
  assert.equal(after.rate, 1, "product join labels every OCP disagreement");

  // Agree + unmatched cases stay out of the denominator.
  const agree = joined.find((r) => r.id === "field-catering-agree");
  const unmatched = joined.find((r) => r.id === "field-unmatched-solicitation");
  assert.equal(agree?.status, "matched");
  assert.equal(agree?.corroboration?.agree, true);
  assert.equal(unmatched?.status, "unmatched");
  const agreeMetric = measurePublicClaimLabeledDisagreeRate([agree, unmatched]);
  assert.equal(agreeMetric.eligible, 0);
  assert.equal(agreeMetric.rate, 0);
});

test("public_claim_labeled_disagree_rate accepts lifecycle ocp_award envelope", () => {
  const corr = corroborateAward(
    { amount: 999999, date: "2026-07-15" },
    { amount: 250000, date: "2026-07-30" },
  );
  const lifecycle = {
    id: "lifecycle-wrap",
    ocp_award: {
      status: "matched",
      source: OCP_SOURCE,
      corroboration: corr,
    },
  };
  const metric = measurePublicClaimLabeledDisagreeRate([lifecycle]);
  assert.equal(metric.eligible, 1);
  assert.equal(metric.labeled, 1);
  assert.equal(metric.rate, 1);
});
