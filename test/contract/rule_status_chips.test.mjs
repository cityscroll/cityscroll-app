import { SITE_SOURCE } from "../helpers/site_source.mjs";
// Contract test for the rule-lifecycle status chips on the Rules lens (rules-status-chips).
// Asserts the wiring that links the precomputed /rules read model to the retained City Record
// snapshot and renders a stage chip + comment CTA — a drift guard in the shape of
// rule_location_display.test.mjs. node --test test/contract/*.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const html = SITE_SOURCE;

test("Rules lens consumes retained rule snapshots and joins lifecycle detail by request_id", () => {
  // List classification comes from the source-native static snapshot; the separate
  // cache-only lifecycle projection enriches detail readers by request_id.
  assert.match(html, /loadRulesDomainSnapshot\(\)/);
  assert.match(html, /rulesViewCache=\{rules:rows\}/);
  assert.match(html, /loadRulesView\(\)/);
  assert.match(html, /buildRulesStageMap\(/);
  assert.match(html, /stageMap\.get\(r\.request_id\)/);
});

test("feedCardHTML renders a rule status chip and leads with the comment CTA", () => {
  assert.match(html, /ruleStageChip\(r\._ruleStage\)/);
  assert.match(html, /ruleCommentAction\(r\._ruleStage\)/);
  // Comment-open leads the action row (the actionable moment is primary).
  assert.match(html, /ruleAct\?ruleAct:""\)\+/);
});

test("ruleStageChip maps every read-model stage to a non-hollow label", () => {
  // Every lifecycle stage the read model emits has a configured chip label, so an
  // unmatched or ambiguous state renders as a specific statement, never blank.
  for (const stage of ["proposed", "comment-open", "comment-closed", "hearing", "adopted", "effective", "unknown"]) {
    assert.match(html, new RegExp(`"${stage}"\\s*:\\s*\\{\\s*key:\\s*"rule_stage_${stage.replace("-", "_")}"`));
  }
});
