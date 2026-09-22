import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FIRST_CLASS_REFRESH_ISSUE_MARKER,
  evaluateFirstClassRefreshHealth,
  reconcileFirstClassRefreshIssue,
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

test("the scheduled reliability workflow runs the refresh health detector with narrow issue access", () => {
  const workflow = readFileSync(new URL("../.github/workflows/reliability-watchdogs.yml", import.meta.url), "utf8");
  assert.match(workflow, /first-class-refresh-health:/);
  assert.match(workflow, /actions: read\n\s+contents: read\n\s+issues: write/);
  assert.match(workflow, /node tools\/first_class_refresh_health\.mjs/);
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
