// Contract test for the rule-lifecycle status chips on the Rules lens (rules-status-chips).
// Asserts the wiring that links the precomputed /rules read model to the live City Record
// rows and renders a stage chip + comment CTA — a drift guard in the shape of
// rule_location_display.test.mjs. node --test test/contract/*.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");

test("Rules lens consumes the /rules read model and joins it by request_id (precompute-first)", () => {
  // The lifecycle enrichment comes from the materialized read model, not a live upstream
  // NYC Rules fetch from the client.
  assert.match(html, /loadRulesView\(\)/);
  assert.match(html, /buildRulesStageMap\(/);
  assert.match(html, /stageMap\.get\(row\.request_id\)/);
  assert.match(html, /row\._ruleStage=rec/);
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
