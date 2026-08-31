import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  RECEIPT_JSON,
  RECEIPT_MD,
  PROOF_JSON,
  buildLandPredictionBacktestFromRepo,
  proofReceiptFrom,
} from "../tools/build_land_prediction_backtest.mjs";
import {
  LAND_PREDICTION_BACKTEST_SCHEMA,
  renderBacktestMarkdown,
  stableStringify,
} from "../worker/src/lib/land_prediction_backtest.mjs";
import { reconcileDerivedArchitectureEvidence } from "../tools/architecture_evidence_shards.mjs";

test("committed stance-backtest receipt matches a frozen rebuild", () => {
  const rebuilt = buildLandPredictionBacktestFromRepo();
  const committed = JSON.parse(readFileSync(new URL(`../${RECEIPT_JSON}`, import.meta.url), "utf8"));
  const proof = readFileSync(new URL(`../${PROOF_JSON}`, import.meta.url), "utf8");
  const markdown = readFileSync(new URL(`../${RECEIPT_MD}`, import.meta.url), "utf8");
  const json = stableStringify(rebuilt);
  assert.equal(rebuilt.schema, LAND_PREDICTION_BACKTEST_SCHEMA);
  assert.equal(json, stableStringify(committed));
  assert.equal(proof, proofReceiptFrom(rebuilt, json));
  assert.equal(markdown, renderBacktestMarkdown(rebuilt));
  assert.match(markdown, /Kill criterion and promotion/);
  assert.match(markdown, /incumbent/);
  assert.doesNotMatch(markdown, /causal claim that a Council Member controls/);
});

test("architecture-evidence projections reconcile the LUP2-C7 card", () => {
  const result = reconcileDerivedArchitectureEvidence();
  assert.equal(result.status, "PASS", result.findings.join("; "));
  assert.equal(
    result.evidence.projections["warehouse/fixtures/land-use-prediction-v2/stance_backtest.v1.json"]
      .represented_card_ids.includes("cityscroll-landuse-prediction-v2/lup2-c7"),
    true,
  );
});
