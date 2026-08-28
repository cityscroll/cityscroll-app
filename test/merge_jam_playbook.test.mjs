import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { buildJamPlaybook } from "../tools/merge_jam_playbook.mjs";

const source = JSON.parse(fs.readFileSync(new URL("./fixtures/merge-throughput/jam-playbook/source.json", import.meta.url), "utf8"));

test("classifies the shared clock-gate jam from merge-group evidence first", () => {
  const result = buildJamPlaybook(source);
  assert.equal(result.classify.class.id, "shared-gate-rot");
  assert.deepEqual(result.classify.decision_tree.map((step) => step.name), [
    "merge-group-log",
    "same-test-across-prs",
    "broken-main-classification",
    "pr-local-check-diagnosis",
  ]);
  assert.equal(result.classify.decision_tree[1].result, "correlated-not-causal");
  assert.match(result.classify.next_action, /settling window/i);
});

test("keeps UNKNOWN settling, queue identity, and repeated-arm guards fail-closed", () => {
  const result = buildJamPlaybook(source);
  assert.equal(result.arm_guard.can_arm, false);
  assert.equal(result.arm_guard.settling.settling, true);
  assert.equal(result.arm_guard.queue_branch.state, "match");
  assert.equal(result.arm_guard.repeated_transition_guard.blocked, true);
  assert.match(result.arm_guard.reasons.join("; "), /UNKNOWN|re-arm/);
  assert.equal(result.arm_guard.branch_action.action, "wait");
});

test("continues to deny arming when UNKNOWN outlasts its settling window", () => {
  const delayed = JSON.parse(JSON.stringify(source));
  delayed.main_state.last_transition_at = "2026-08-27T00:00:00Z";
  const result = buildJamPlaybook(delayed);
  assert.equal(result.arm_guard.settling.settling, false);
  assert.equal(result.arm_guard.settling.unknown, true);
  assert.equal(result.arm_guard.can_arm, false);
  assert.equal(result.arm_guard.branch_action.action, "wait");
});

test("requires CLEAN before arming and chooses guarded branch repair", () => {
  const behind = JSON.parse(JSON.stringify(source));
  behind.main_state.merge_state_status = "BEHIND";
  behind.rearm_history = [];
  const behindResult = buildJamPlaybook(behind);
  assert.equal(behindResult.arm_guard.can_arm, false);
  assert.equal(behindResult.arm_guard.branch_action.action, "update-branch");
  assert.match(behindResult.arm_guard.reasons.join("; "), /BEHIND/);

  const conflicting = JSON.parse(JSON.stringify(source));
  conflicting.main_state.merge_state_status = "CONFLICTING";
  conflicting.rearm_history = [];
  const conflictingResult = buildJamPlaybook(conflicting);
  assert.equal(conflictingResult.arm_guard.can_arm, false);
  assert.equal(conflictingResult.arm_guard.branch_action.action, "rebase");

  const clean = JSON.parse(JSON.stringify(source));
  clean.main_state.merge_state_status = "CLEAN";
  clean.main_state.health = "healthy";
  clean.rearm_history = [];
  const cleanResult = buildJamPlaybook(clean);
  assert.equal(cleanResult.arm_guard.can_arm, true);
  assert.deepEqual(cleanResult.arm_guard.reasons, []);
});

test("emits the repair loop and preserves policy composition", () => {
  const result = buildJamPlaybook(source);
  assert.equal(result.detector_receipt.validation, "passed");
  assert.equal(result.fix_card.fix_reference.pull_request, 1331);
  assert.equal(result.measured_delta.after.successful_dequeues, 544);
  assert.equal(result.measured_delta.after.ejections, 136);
  assert.equal(result.measured_delta.synchronized_batch_drain.minimum_successful_dequeues, 30);
  assert.equal(result.policy_proof.allgreen_unchanged, true);
  assert.equal(result.policy_proof.required_checks_unchanged, true);
  assert.equal(result.policy_proof.elder_anti_starvation.policy_module, "tools/elder_merge_slot.mjs");
});

test("replay is deterministic and rejects an unverified timeline", () => {
  const first = buildJamPlaybook(source);
  const second = buildJamPlaybook(JSON.parse(JSON.stringify(source)));
  assert.deepEqual(first, second);

  const invalid = JSON.parse(JSON.stringify(source));
  invalid.same_test_across_prs[0].timeline = "https://example.invalid/timeline";
  assert.throws(() => buildJamPlaybook(invalid), /timeline receipt drift/);
});
