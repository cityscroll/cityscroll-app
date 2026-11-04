import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assessLiveness,
  assessPullRequest,
  formatBlockerComment,
  isCanaryCandidate,
  isManagedAutomationPullRequest,
  mergeState,
  runGuard,
} from "../tools/merge_pipeline_guard.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/merge_pipeline_guard.json", import.meta.url), "utf8"));
const now = new Date("2026-08-15T12:40:00.000Z").getTime();

test("dry-run detects a safely updateable behind PR without treating it as conflicting", () => {
  const result = assessPullRequest(fixture.pulls[0], {
    now,
    repository: "cityscroll/cityscroll-app",
    stallMinutes: 30,
  });
  assert.equal(result.state, "BEHIND");
  assert.equal(result.shouldUpdate, true);
  assert.equal(result.shouldComment, false);
});

test("dry-run detects a conflicting PR and never schedules an update", () => {
  const pr = fixture.pulls[1];
  assert.equal(mergeState(pr), "CONFLICTING");
  const result = assessPullRequest(pr, { now, repository: "cityscroll/cityscroll-app" });
  assert.equal(result.shouldUpdate, false);
  assert.equal(result.shouldComment, true);
  assert.match(formatBlockerComment(pr, result), /CONFLICTING/);
});

test("blocked and dirty merge states are loud blockers", () => {
  for (const state of ["blocked", "dirty"]) {
    const pr = { ...fixture.pulls[0], mergeable_state: state };
    const result = assessPullRequest(pr, { now, repository: "cityscroll/cityscroll-app" });
    assert.equal(result.shouldUpdate, false);
    assert.equal(result.shouldComment, true);
  }
});

test("only repository-owned scheduled producer branches are managed automation", () => {
  assert.equal(isManagedAutomationPullRequest({ head: { ref: "automation/connected-history-cycle" } }), true);
  assert.equal(isManagedAutomationPullRequest({ head: { ref: "data/first-class-refresh-20261103" } }), true);
  assert.equal(isManagedAutomationPullRequest({ head: { ref: "card/public-feature" } }), false);
});

test("dry-run detects a clean PR that has remained unmerged past the threshold", () => {
  const result = assessPullRequest(fixture.pulls[2], {
    now,
    repository: "cityscroll/cityscroll-app",
    stallMinutes: 30,
  });
  assert.equal(result.state, "CLEAN");
  assert.equal(result.aged, true);
  assert.equal(result.shouldComment, true);
});

test("liveness canary is stale when eligible PRs exist and main's tip is old", () => {
  const result = assessLiveness(fixture.main_tip, fixture.pulls, { now, canaryMinutes: 30 });
  assert.equal(result.candidateCount, 3);
  assert.equal(result.ageMinutes, 40);
  assert.equal(result.stale, true);
  assert.equal(isCanaryCandidate(fixture.pulls[0]), true);
});

test("workflow fixture mode is a write-free dry-run", () => {
  const output = execFileSync(
    process.execPath,
    ["tools/merge_pipeline_guard.mjs", "--dry-run", "--fixture", "test/fixtures/merge_pipeline_guard.json", "--now", "2026-08-15T12:40:00.000Z"],
    { encoding: "utf8" },
  );
  const report = JSON.parse(output);
  assert.deepEqual(report.updates, [101]);
  assert.deepEqual(report.comments.map((comment) => comment.number), [102, 103]);
  assert.equal(report.canary.stale, true);
});

test("repeated live evaluations update one marker comment instead of duplicating it", async () => {
  const comments = [];
  let creates = 0;
  let updates = 0;
  const api = {
    listOpenPulls: async () => [fixture.pulls[1]],
    getBranch: async () => ({ commit: { commit: { committer: { date: "2026-08-15T12:39:00.000Z" } } } }),
    getChecks: async () => ({ check_runs: [] }),
    getStatus: async () => ({ statuses: [] }),
    listReviews: async () => [],
    listComments: async () => comments,
    createComment: async (number, body) => { creates += 1; comments.push({ id: number, body }); },
    updateComment: async (id, body) => { updates += 1; comments[0] = { id, body }; },
    updateBranch: async () => { throw new Error("not expected"); },
    clearAutomationMergeIntent: async () => { throw new Error("not expected"); },
  };
  const options = { api, now, repository: "cityscroll/cityscroll-app", log: () => {} };
  await runGuard(options);
  await runGuard(options);
  assert.equal(creates, 1);
  assert.equal(updates, 0);
  assert.equal(comments.length, 1);
});

test("a failing automation head is disarmed once and keeps a durable receipt", async () => {
  const comments = [];
  const disabled = [];
  const pr = {
    ...fixture.pulls[0],
    node_id: "PR_node_automation",
    mergeable_state: "BLOCKED",
    auto_merge: { enabled_at: "2026-08-15T12:00:00Z" },
    head: { ...fixture.pulls[0].head, ref: "automation/connected-history-cycle" },
  };
  const api = {
    listOpenPulls: async () => [pr],
    getBranch: async () => ({ commit: { commit: { committer: { date: "2026-08-15T12:39:00.000Z" } } } }),
    getChecks: async () => ({ check_runs: [{ name: "Required CI", status: "completed", conclusion: "failure" }] }),
    getStatus: async () => ({ statuses: [] }),
    listReviews: async () => [],
    listComments: async () => comments,
    createComment: async (number, body) => { comments.push({ id: number, body }); },
    updateComment: async (id, body) => { comments[0] = { id, body }; },
    updateBranch: async () => { throw new Error("not expected"); },
    clearAutomationMergeIntent: async (nodeId) => { disabled.push(nodeId); return { dequeued: true }; },
  };

  const result = await runGuard({ api, now, repository: "cityscroll/cityscroll-app", log: () => {} });
  assert.deepEqual(disabled, ["PR_node_automation"]);
  assert.equal(result.evaluations[0].autoMergeDisabled, true);
  assert.match(comments[0].body, /Automatic merge was disabled/);
  assert.match(comments[0].body, /next scheduled run rebuilds from current `main`/);

  pr.auto_merge = null;
  const repeated = await runGuard({ api, now, repository: "cityscroll/cityscroll-app", log: () => {} });
  assert.deepEqual(disabled, ["PR_node_automation"], "an already-disarmed head is not mutated again");
  assert.equal(repeated.evaluations[0].automationFailing, true);
  assert.match(comments[0].body, /Automatic merge remains disabled/);
  assert.match(comments[0].body, /next scheduled run rebuilds from current `main`/);
});

test("failing checks never revoke merge intent from an ordinary contributor branch", async () => {
  let disabled = false;
  const pr = {
    ...fixture.pulls[0],
    node_id: "PR_node_contributor",
    mergeable_state: "BLOCKED",
    auto_merge: { enabled_at: "2026-08-15T12:00:00Z" },
    head: { ...fixture.pulls[0].head, ref: "card/public-feature" },
  };
  const api = {
    listOpenPulls: async () => [pr],
    getBranch: async () => ({ commit: { commit: { committer: { date: "2026-08-15T12:39:00.000Z" } } } }),
    getChecks: async () => ({ check_runs: [{ name: "Required CI", status: "completed", conclusion: "failure" }] }),
    getStatus: async () => ({ statuses: [] }),
    listReviews: async () => [],
    listComments: async () => [],
    createComment: async () => {},
    updateComment: async () => {},
    updateBranch: async () => {},
    clearAutomationMergeIntent: async () => { disabled = true; },
  };

  await runGuard({ api, now, repository: "cityscroll/cityscroll-app", log: () => {} });
  assert.equal(disabled, false);
});

test("workflow uses narrow permissions and guarded update semantics", () => {
  const workflow = readFileSync(new URL("../.github/workflows/merge-pipeline-guard.yml", import.meta.url), "utf8");
  const tool = readFileSync(new URL("../tools/merge_pipeline_guard.mjs", import.meta.url), "utf8");
  assert.match(workflow, /checks: read/);
  assert.match(workflow, /statuses: read/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(tool, /expected_head_sha/);
  assert.match(tool, /isInMergeQueue/);
  assert.match(tool, /dequeuePullRequest/);
  assert.match(tool, /disablePullRequestAutoMerge/);
  assert.doesNotMatch(`${workflow}\n${tool}`, /force\s*:\s*true/i);
});

test("scheduled guard verifies the live merge-queue policy against the checked-in file", () => {
  const workflow = readFileSync(new URL("../.github/workflows/merge-pipeline-guard.yml", import.meta.url), "utf8");
  const applyTool = readFileSync(new URL("../tools/apply_merge_queue_policy.mjs", import.meta.url), "utf8");
  // The drift check shells out to `gh`, so the step must hand it a token.
  assert.match(
    workflow,
    /Verify merge-queue policy is applied\n\s+env:\n\s+GH_TOKEN: \$\{\{ github\.token \}\}\n\s+run: node tools\/apply_merge_queue_policy\.mjs --check/,
  );
  // The check is compare-only; the scheduled guard must never mutate the ruleset.
  assert.match(applyTool, /--check/);
  assert.match(applyTool, /process\.exit\(1\)/);
});
