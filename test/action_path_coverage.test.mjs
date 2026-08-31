import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ACTION_PATH_COVERAGE_CLASSIFICATIONS,
  ACTION_PATH_COVERAGE_SCHEMA,
  actionPathCoverageFindings,
  assertActionPathCoverageContract,
  classifyActionPathCoverageRow,
  labeledRatio,
  measureActionPathCoverage,
} from "../ontology/action_path_coverage.mjs";
import { evaluateActionPathCoverage } from "../ontology/dimensions/action_path_coverage.mjs";
import { DIMENSION_IDS } from "../ontology/dimensions/index.mjs";
import {
  assembleActionPathCoverageReceipt,
  assertActionPathCoverageReceipt,
  collectActionPathCoverageRows,
  COVERAGE_JSON,
} from "../tools/lib/action_path_coverage.mjs";
import { buildActionPathCoverageFromRepo } from "../tools/build_action_path_coverage.mjs";

const committed = JSON.parse(readFileSync(new URL(`../${COVERAGE_JSON}`, import.meta.url), "utf8"));

function classOf(receipt, id) {
  return receipt.rows.find((row) => row.id === id)?.classification;
}

test("unknown ratios stay unknown instead of becoming zero", () => {
  assert.deepEqual(labeledRatio(0, 0), { value: null, basis: "unknown" });
  assert.notEqual(labeledRatio(0, 0).value, 0);
});

test("diagnostic classes distinguish absence, unknown, replay, grounded, and stale", () => {
  assert.equal(classifyActionPathCoverageRow({
    action_present: false,
    action_available: false,
  }), "no_action");
  assert.equal(classifyActionPathCoverageRow({
    action_present: true,
    action_available: true,
    target_status: "grounded",
    continuation_status: "none",
  }), "action_only");
  assert.equal(classifyActionPathCoverageRow({
    action_present: true,
    action_available: true,
    target_status: "unknown",
  }), "target_unknown");
  assert.equal(classifyActionPathCoverageRow({
    action_present: true,
    action_available: true,
    target_status: "grounded",
    continuation_status: "unknown",
    continuation_proposed: true,
  }), "continuation_unknown");
  assert.equal(classifyActionPathCoverageRow({
    action_present: true,
    action_available: true,
    target_status: "grounded",
    continuation_proposed: true,
    continuation_status: "not_replayable",
  }), "continuation_not_replayable");
  assert.equal(classifyActionPathCoverageRow({
    action_present: true,
    action_available: true,
    target_status: "grounded",
    continuation_status: "grounded",
  }), "grounded_path");
  assert.equal(classifyActionPathCoverageRow({
    action_present: true,
    action_available: true,
    target_status: "grounded",
    continuation_status: "grounded",
    opportunity_stale: true,
    opportunity_claimed_current: true,
  }), "stale_opportunity");
});

test("committed coverage receipt matches a fresh measurement of retained fixtures", () => {
  const rebuilt = buildActionPathCoverageFromRepo();
  assert.deepEqual(rebuilt, committed);
  assertActionPathCoverageReceipt(rebuilt);
});

test("metrics use measured denominators and keep DOT on one rulemaking", () => {
  assert.equal(committed.schema, ACTION_PATH_COVERAGE_SCHEMA);
  assert.equal(committed.reward_button_density, false);
  assert.equal(committed.unknown_as_zero, false);
  assert.equal(committed.metrics.actions_sampled.basis, "measured");
  assert.equal(committed.metrics.continuations_proposed.basis, "measured");
  assert.equal(committed.metrics.entities_sampled.basis, "measured");
  assert.equal(committed.metrics.application_ctas.basis, "measured");
  assert.equal(committed.metrics.cross_board_inference_violations.value, 0);
  assert.equal(committed.metrics.cross_board_inference_violations.basis, "measured");
  assert.equal(committed.dot_bicycle_racks.same_rulemaking, true);
  assert.equal(committed.dot_bicycle_racks.rulemaking_subject, "rulemaking:dot:bicycle-owned-racks");
  assert.equal(committed.metrics.grounded_target_rate.basis, "derived");
  assert.ok(committed.metrics.actions_sampled.value >= 1);
  assert.ok(committed.metrics.application_ctas.value >= 1);
  assert.ok(committed.metrics.current_application_ctas_with_current_source.value >= 1);
});

test("Council, DOT, Community Board, no-action, and stale cases keep their classes", () => {
  assert.equal(classOf(committed, "council-action-only"), "action_only");
  assert.equal(classOf(committed, "council-single-continuation"), "continuation_not_replayable");
  assert.equal(classOf(committed, "council-multiple-candidates"), "continuation_unknown");
  assert.equal(classOf(committed, "council-unsupported-lossy"), "continuation_not_replayable");
  assert.equal(classOf(committed, "council-unavailable-action"), "no_action");
  assert.equal(classOf(committed, "dot-t1-before-hearing"), "grounded_path");
  assert.equal(classOf(committed, "dot-t2-after-adoption"), "grounded_path");
  assert.equal(classOf(committed, "dot-t3-after-effective"), "grounded_path");
  assert.equal(classOf(committed, "dot-t1-after-comment-close"), "stale_opportunity");
  assert.equal(classOf(committed, "cb-bronx-no-apply"), "no_action");
  assert.equal(classOf(committed, "cb-stale-application"), "stale_opportunity");
  assert.equal(classOf(committed, "cb-current-application"), "action_only");
  assert.equal(classOf(committed, "no-action-archive"), "no_action");
  assert.equal(classOf(committed, "target-unknown-comment"), "target_unknown");
  for (const name of ACTION_PATH_COVERAGE_CLASSIFICATIONS) {
    assert.ok(committed.classifications[name].length >= 1, name);
  }
});

test("unsupported targets, non-replayable continuations, stale opportunities, and cross-board inference fail closed", () => {
  const rows = collectActionPathCoverageRows();
  const poisoned = [
    ...rows,
    {
      id: "cross-board-inherit",
      family: "community_board",
      entity_ref: "community-board:queens-cb-06",
      action_present: true,
      action_available: true,
      target_status: "grounded",
      continuation_status: "none",
      cross_board_inference: true,
      synthetic_action: true,
      broad_fallback: true,
    },
  ];
  const measured = measureActionPathCoverage(poisoned);
  assert.equal(measured.gate.cross_board_inference_violations, 1);
  assert.equal(measured.gate.broad_fallback, true);
  assert.equal(measured.gate.synthetic_action_reward, true);
  const findings = actionPathCoverageFindings(measured).map((row) => row.message);
  assert.equal(findings.some((message) => /cross_board_inference/i.test(message)), true);
  assert.throws(() => assertActionPathCoverageContract(measured));
});

test("a no-action civic object does not lower coverage by adding a synthetic action", () => {
  const honest = measureActionPathCoverage([
    {
      id: "empty-record",
      entity_ref: "notice:none",
      action_present: false,
      action_available: false,
      target_status: "missing",
      continuation_status: "none",
    },
  ]);
  assert.equal(honest.rows[0].classification, "no_action");
  assert.equal(honest.metrics.entities_with_current_action.value, 0);
  const fake = measureActionPathCoverage([
    {
      id: "empty-record",
      entity_ref: "notice:none",
      action_present: true,
      action_available: true,
      target_status: "grounded",
      continuation_status: "none",
      synthetic_action: true,
    },
  ]);
  assert.equal(fake.gate.synthetic_action_reward, true);
  assert.throws(() => assertActionPathCoverageContract(fake, { requireAllClasses: false }));
});

test("the action-path dimension is registered and stays quiet on the committed sample", () => {
  assert.equal(DIMENSION_IDS.includes("action-path"), true);
  const rows = collectActionPathCoverageRows();
  const result = evaluateActionPathCoverage({ action_path_coverage_rows: rows });
  assert.equal(result.dimension, "action-path");
  assert.equal(result.metrics.cross_board_inference_violations, 0);
  assert.deepEqual(result.cards, []);
  assert.equal(result.metrics.reward_button_density, false);
});

test("collecting from retained evidence keeps DOT identity and zero cross-board inference", () => {
  const receipt = assembleActionPathCoverageReceipt();
  assert.equal(receipt.dot_bicycle_racks.same_rulemaking, true);
  assert.equal(receipt.rows.every((row) => row.cross_board_inference === false), true);
  assert.doesNotMatch(JSON.stringify(receipt), /all DOT rules|all DOT hearings|button density/i);
});
