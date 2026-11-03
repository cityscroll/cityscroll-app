import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRST_CLASS_REFRESH_ISSUE_MARKER,
  evaluateFirstClassRefreshHealth,
  loadManagedFirstClassRefreshIssues,
  reconcileFirstClassRefreshIssue,
  renderFirstClassRefreshIssue,
} from "../tools/first_class_refresh_health.mjs";

const asOf = "2026-09-22T12:00:00.000Z";
const run = (id, conclusion, createdAt) => ({
  id,
  run_number: id,
  event: "schedule",
  status: "completed",
  conclusion,
  created_at: createdAt,
  updated_at: createdAt,
  html_url: `https://github.example/actions/runs/${id}`,
});

test("one recent scheduled failure stays below the alert threshold", () => {
  const result = evaluateFirstClassRefreshHealth([
    run(2, "failure", "2026-09-22T06:40:00.000Z"),
    run(1, "success", "2026-09-21T06:40:00.000Z"),
  ], { asOf });
  assert.equal(result.healthy, true);
  assert.equal(result.consecutive_failures, 1);
});

test("a second consecutive scheduled failure alerts", () => {
  const result = evaluateFirstClassRefreshHealth([
    run(3, "failure", "2026-09-22T06:40:00.000Z"),
    run(2, "failure", "2026-09-21T06:40:00.000Z"),
    run(1, "success", "2026-09-20T06:40:00.000Z"),
  ], { asOf });
  assert.equal(result.healthy, false);
  assert.equal(result.consecutive_failures, 2);
  assert.match(result.reasons.join(" "), /2 consecutive/);
});

test("36 hours without a scheduled success alerts independently of the streak", () => {
  const result = evaluateFirstClassRefreshHealth([
    run(2, "failure", "2026-09-22T06:40:00.000Z"),
    run(1, "success", "2026-09-20T23:00:00.000Z"),
  ], { asOf });
  assert.equal(result.healthy, false);
  assert.match(result.reasons.join(" "), /no successful scheduled run for 37 hours/);
});

test("issue reconciliation creates once, deduplicates, and closes on recovery", async () => {
  const failing = evaluateFirstClassRefreshHealth([
    run(3, "failure", "2026-09-22T06:40:00.000Z"),
    run(2, "failure", "2026-09-21T06:40:00.000Z"),
    run(1, "success", "2026-09-20T06:40:00.000Z"),
  ], { asOf });
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    return { number: 42, ...body };
  };
  const failures = failing.recent_failures.map((failedRun) => ({ run: failedRun, failingStep: "Refresh: Run acquisition" }));
  const created = await reconcileFirstClassRefreshIssue({ evaluation: failing, failures, request });
  assert.equal(created.action, "created");
  assert.equal(calls.length, 1);
  const openIssue = { number: 42, title: calls[0].body.title, body: calls[0].body.body };
  const duplicate = await reconcileFirstClassRefreshIssue({ evaluation: failing, failures, openIssue, request });
  assert.equal(duplicate.action, "unchanged");
  assert.equal(calls.length, 1);

  const recovered = evaluateFirstClassRefreshHealth([
    run(4, "success", "2026-09-22T11:00:00.000Z"),
    ...failing.recent_failures,
  ], { asOf });
  const closed = await reconcileFirstClassRefreshIssue({ evaluation: recovered, openIssue, request });
  assert.equal(closed.action, "closed");
  assert.equal(calls.at(-1).body.state, "closed");
  assert.match(calls.at(-1).body.body, new RegExp(FIRST_CLASS_REFRESH_ISSUE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("issue discovery paginates past pull requests and unrelated issues", async () => {
  const markerIssue = { number: 42, body: FIRST_CLASS_REFRESH_ISSUE_MARKER };
  const pages = [
    Array.from({ length: 100 }, (_, index) => ({ number: 1000 + index, body: "unrelated" })),
    [{ number: 43, pull_request: {}, body: FIRST_CLASS_REFRESH_ISSUE_MARKER }, markerIssue],
  ];
  const paths = [];
  const issues = await loadManagedFirstClassRefreshIssues(async (_method, path) => {
    paths.push(path);
    return pages[paths.length - 1];
  });

  assert.deepEqual(paths, [
    "/issues?state=open&per_page=100&page=1",
    "/issues?state=open&per_page=100&page=2",
  ]);
  assert.deepEqual(issues, [markerIssue]);
});

test("unhealthy reconciliation keeps the newest issue and closes stale duplicates", async () => {
  const evaluation = evaluateFirstClassRefreshHealth([
    run(3, "failure", "2026-09-22T06:40:00.000Z"),
    run(2, "failure", "2026-09-21T06:40:00.000Z"),
    run(1, "success", "2026-09-20T06:40:00.000Z"),
  ], { asOf });
  const body = renderFirstClassRefreshIssue(evaluation);
  const calls = [];
  const result = await reconcileFirstClassRefreshIssue({
    evaluation,
    openIssues: [
      { number: 41, title: "Older", body: FIRST_CLASS_REFRESH_ISSUE_MARKER },
      { number: 42, title: "First-class dataset refresh needs attention", body },
    ],
    request: async (method, path, requestBody) => {
      calls.push({ method, path, body: requestBody });
      return requestBody;
    },
  });

  assert.equal(result.action, "deduplicated");
  assert.equal(result.issue_number, 42);
  assert.deepEqual(result.duplicate_issue_numbers, [41]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/issues/41");
  assert.equal(calls[0].body.state, "closed");
  assert.match(calls[0].body.body, /Superseded by #42/);
});

test("recovery closes every managed issue left by an earlier duplicate", async () => {
  const evaluation = evaluateFirstClassRefreshHealth([
    run(4, "success", "2026-09-22T11:00:00.000Z"),
  ], { asOf });
  const calls = [];
  const result = await reconcileFirstClassRefreshIssue({
    evaluation,
    openIssues: [
      { number: 41, body: FIRST_CLASS_REFRESH_ISSUE_MARKER },
      { number: 42, body: FIRST_CLASS_REFRESH_ISSUE_MARKER },
    ],
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      return body;
    },
  });

  assert.equal(result.action, "closed");
  assert.equal(result.issue_number, 42);
  assert.deepEqual(result.closed_issue_numbers, [41, 42]);
  assert.deepEqual(calls.map((call) => call.path), ["/issues/41", "/issues/42"]);
  assert.ok(calls.every((call) => call.body.state === "closed"));
});
