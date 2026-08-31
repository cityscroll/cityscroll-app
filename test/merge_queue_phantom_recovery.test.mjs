import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PhantomRecoveryError,
  REQUIRED_CHECKS,
  createFixtureAdapter,
  recoverPhantomMergeQueue,
} from "../tools/merge_queue_phantom_recovery.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/merge_queue_phantom_recovery.json", import.meta.url), "utf8"));
const base = fixture.positive;

function scenario(overrides = {}) {
  return {
    ...structuredClone(base),
    ...overrides,
    pullRequest: { ...structuredClone(base.pullRequest), ...(overrides.pullRequest || {}) },
    batches: overrides.batches || [],
    afterBatches: overrides.afterBatches || base.afterBatches,
  };
}

async function rejectsWith(scenarioValue, code, expectedOperations = []) {
  const adapter = createFixtureAdapter(scenarioValue);
  await assert.rejects(
    recoverPhantomMergeQueue({ input: scenarioValue.target, adapter }),
    (error) => error instanceof PhantomRecoveryError && error.code === code,
  );
  assert.deepEqual(adapter.operations, expectedOperations);
}

test("recovers one exact phantom signature and emits an idempotent receipt", async () => {
  const adapter = createFixtureAdapter(base);
  const first = await recoverPhantomMergeQueue({ input: base.target, adapter });
  assert.equal(first.schema, "cityscroll.merge_queue_phantom_recovery.v1");
  assert.equal(first.target.headSha, base.target.headSha);
  assert.equal(first.result.batchId, "MQB_1490_a");
  assert.deepEqual(adapter.operations, ["dequeuePullRequest", "enableAutoMerge", "recordAuditReceipt"]);
  await assert.rejects(
    recoverPhantomMergeQueue({ input: base.target, adapter }),
    (error) => error.code === "REPLAYED_SIGNATURE",
  );
  assert.deepEqual(adapter.operations, ["dequeuePullRequest", "enableAutoMerge", "recordAuditReceipt"]);
});

test("requires the exact PR/head and all required checks to be green and stable", async () => {
  assert.deepEqual(REQUIRED_CHECKS, base.pullRequest.requiredChecks.map((check) => check.name));
  await rejectsWith(scenario({ pullRequest: { requiredChecks: base.pullRequest.requiredChecks.map((check) => check.name === REQUIRED_CHECKS[0] ? { ...check, conclusion: "FAILURE" } : check) } }), "FAILING_CHECKS");
  await rejectsWith(scenario({ pullRequest: { requiredChecks: base.pullRequest.requiredChecks.map((check) => check.name === REQUIRED_CHECKS[0] ? { ...check, status: "IN_PROGRESS", conclusion: null } : check) } }), "PENDING_CHECKS");
  await rejectsWith(scenario({ pullRequest: { checksStable: false } }), "UNSTABLE_CHECKS");
  await rejectsWith(scenario({ pullRequest: { headRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } }), "CHANGED_HEAD");
});

test("rejects merge-state, intent, queue, and active-batch guards without mutation", async () => {
  await rejectsWith(scenario({ pullRequest: { mergeStateStatus: "CONFLICTING" } }), "CONFLICTING");
  await rejectsWith(scenario({ pullRequest: { mergeStateStatus: "UNKNOWN" } }), "UNKNOWN_MERGE_STATE");
  await rejectsWith(scenario({ pullRequest: { autoMergeRequest: null } }), "MISSING_INTENT");
  await rejectsWith(scenario({ pullRequest: { isInMergeQueue: true } }), "ALREADY_QUEUED");
  await rejectsWith(scenario({ batches: [{ id: "MQB_existing", pullNumber: 1490, headSha: base.target.headSha }] }), "ACTIVE_BATCH");
});

test("rejects missing checks, non-mergeable state, and policy mismatch", async () => {
  await rejectsWith(scenario({ pullRequest: { requiredChecks: [] } }), "MISSING_CHECKS");
  await rejectsWith(scenario({ pullRequest: { mergeable: "UNKNOWN" } }), "UNKNOWN_MERGEABILITY");
  await rejectsWith(scenario({ pullRequest: { mergeable: "CONFLICTING" } }), "CONFLICTING");
  await rejectsWith(scenario({ pullRequest: { autoMergeRequest: { enabled: true, mergeMethod: "MERGE" } } }), "POLICY_MISMATCH");
});

test("fails closed when the transition does not produce verified queue evidence", async () => {
  const transition = ["dequeuePullRequest", "enableAutoMerge"];
  await rejectsWith(scenario({ afterEnqueue: { ...base.afterEnqueue, isInMergeQueue: false } }), "QUEUE_MEMBERSHIP_NOT_CONFIRMED", transition);
  await rejectsWith(scenario({ afterBatches: [] }), "MISSING_NEW_BATCH", transition);
  await rejectsWith(scenario({ afterBatches: [base.afterBatches[0], { id: "MQB_1490_b", pullNumber: 1490, headSha: base.target.headSha }] }), "AMBIGUOUS_NEW_BATCH", transition);
});

test("fixture CLI is a deterministic gate for the positive and negative corpus", () => {
  const output = execFileSync(process.execPath, [
    "tools/merge_queue_phantom_recovery.mjs",
    "--fixture",
    "test/fixtures/merge_queue_phantom_recovery.json",
  ], { encoding: "utf8" });
  const report = JSON.parse(output);
  assert.equal(report.schema, "cityscroll.merge_queue_phantom_recovery.v1");
  assert.equal(report.negativeCases, 10);
});
