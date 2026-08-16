import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { buildMergeQueueEjectionReport } from "../tools/report_merge_queue_ejections.mjs";

const policy = {
  repository: "cityscroll/cityscroll-app",
  ruleset_id: 18899568,
  merge_queue: {
    merge_method: "SQUASH",
    grouping_strategy: "ALLGREEN",
    max_entries_to_build: 5,
    min_entries_to_merge: 1,
    max_entries_to_merge: 5,
    min_entries_to_merge_wait_minutes: 5,
    check_response_timeout_minutes: 60,
  },
  required_status_checks: ["Unit", "Accessibility", "Reading level"],
};

const ruleset = {
  rules: [
    { type: "merge_queue", parameters: { ...policy.merge_queue } },
    {
      type: "required_status_checks",
      parameters: {
        required_status_checks: policy.required_status_checks.map((context) => ({ context })),
      },
    },
  ],
};

function pullRequest(number, events, hasNextPage = false) {
  return {
    number,
    url: `https://github.com/cityscroll/cityscroll-app/pull/${number}`,
    timelineItems: { nodes: events, pageInfo: { hasNextPage } },
  };
}

test("report keeps successful dequeues separate from provenance-bearing ejections", () => {
  const report = buildMergeQueueEjectionReport({
    policy,
    ruleset,
    since: "2026-08-04T02:42:09Z",
    observedAt: "2026-08-16T21:30:00Z",
    pullRequests: [
      pullRequest(10, [
        { createdAt: "2026-08-03T23:00:00Z", reason: "failed_checks", actor: { login: "github-merge-queue" } },
        { createdAt: "2026-08-05T10:00:00Z", reason: "failed_checks", actor: { login: "github-merge-queue" } },
        { createdAt: "2026-08-05T10:15:00Z", reason: "merged", actor: { login: "github-merge-queue" } },
      ]),
      pullRequest(11, [
        { createdAt: "2026-08-06T12:00:00Z", reason: "manual", actor: { login: "operator" } },
      ]),
    ],
  });

  assert.equal(report.capacity.model, "one_native_train");
  assert.equal(report.capacity.max_entries_to_build, 5);
  assert.equal(report.capacity.larger_train_proposed, false);
  assert.equal(report.ruleset_proof.live_matches_committed_policy, true);
  assert.equal(report.queue_removal_proof.removal_events_observed, 3);
  assert.equal(report.queue_removal_proof.successful_dequeues_after_merge, 1);
  assert.equal(report.queue_removal_proof.ejections, 2);
  assert.equal(report.queue_removal_proof.automatic_ejections, 1);
  assert.equal(report.queue_removal_proof.manual_removals, 1);
  assert.deepEqual(report.queue_removal_proof.ejections_by_reason, {
    failed_checks: 1,
    manual: 1,
  });
  assert.equal(report.ejection_events.length, 2);
  assert.ok(report.ejection_events.every((event) => event.pull_request_url));
});

test("report fails closed when a pull-request removal history is truncated", () => {
  assert.throws(
    () => buildMergeQueueEjectionReport({
      policy,
      ruleset,
      since: "2026-08-04T02:42:09Z",
      observedAt: "2026-08-16T21:30:00Z",
      pullRequests: [pullRequest(12, [], true)],
    }),
    /more than 100 queue-removal events/,
  );
});

test("committed receipt preserves the five-entry ceiling and required checks", () => {
  const committedPolicy = JSON.parse(
    fs.readFileSync(new URL("../tools/merge_queue_policy.json", import.meta.url), "utf8"),
  );
  const receipt = JSON.parse(
    fs.readFileSync(new URL("../docs/evidence/merge-queue-cap/ejection-report.json", import.meta.url), "utf8"),
  );

  assert.equal(committedPolicy.merge_queue.max_entries_to_build, 5);
  assert.equal(receipt.capacity.max_entries_to_build, 5);
  assert.equal(receipt.capacity.larger_train_proposed, false);
  assert.equal(receipt.ruleset_proof.live_matches_committed_policy, true);
  assert.deepEqual(
    receipt.ruleset_proof.committed_required_status_checks,
    committedPolicy.required_status_checks,
  );
  assert.equal(
    receipt.queue_removal_proof.ejections,
    receipt.ejection_events.length,
  );
  assert.equal(
    receipt.queue_removal_proof.removal_events_observed,
    receipt.queue_removal_proof.successful_dequeues_after_merge +
      receipt.queue_removal_proof.ejections,
  );
});
