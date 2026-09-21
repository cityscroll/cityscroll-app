import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function jobBlock(source, jobId) {
  const start = source.search(new RegExp(`^  ${jobId}:\\s*$`, "m"));
  assert.ok(start >= 0, `missing job ${jobId}`);
  const fromJob = source.slice(start);
  const next = fromJob.slice(1).search(/^  [A-Za-z0-9_-]+:\s*$/m);
  return next === -1 ? fromJob : fromJob.slice(0, next + 1);
}

function jobIf(source, jobId) {
  const block = jobBlock(source, jobId);
  const match = block.match(/\n    if:\s*(.+)\n/);
  assert.ok(match, `job ${jobId} has no top-level if`);
  return match[1].trim();
}

const MERGE_GROUP_SKIP = "always() && github.event_name != 'merge_group'";

const TRIMMED_JOBS = [
  "performance-serial",
  "performance-shard",
  "performance",
  "browser-journeys-pr",
  "a11y-pr",
  "a11y-pr-shard",
  "a11y-rendered-census-primary",
  "a11y-routes-focus-primary",
];

const TRIMMED_RETRY_JOBS = [
  "a11y-rendered-census-retry",
  "a11y-routes-focus-retry",
];

const GUARDRAIL_KEEP_JOBS = [
  "unit-family",
  "merge-group-preflight",
  "unit",
  "browser-pr-site",
  "reading-level",
];

test("trimmed CI jobs skip cleanly on merge_group", () => {
  const ci = read(".github/workflows/ci.yml");
  for (const jobId of TRIMMED_JOBS) {
    assert.equal(jobIf(ci, jobId), MERGE_GROUP_SKIP, `${jobId} must skip on merge_group`);
  }
  for (const jobId of TRIMMED_RETRY_JOBS) {
    const condition = jobIf(ci, jobId);
    assert.match(
      condition,
      /github\.event_name\s*!=\s*'merge_group'/,
      `${jobId} must skip on merge_group`,
    );
    assert.match(condition, /always\(\)/, `${jobId} must retain always()`);
  }
  // Functional Playwright stays dispatch-only, so it never reports on merge_group.
  assert.match(
    jobIf(ci, "functional"),
    /github\.event_name\s*==\s*'workflow_dispatch'/,
  );
  assert.match(ci, /browser-a11y/);
  assert.match(ci, /test\/functional\/run\.sh/);
});

test("guardrail-1 CI jobs do not skip on merge_group", () => {
  const ci = read(".github/workflows/ci.yml");
  for (const jobId of GUARDRAIL_KEEP_JOBS) {
    const block = jobBlock(ci, jobId);
    assert.doesNotMatch(
      block,
      /\n    if:[^\n]*merge_group/,
      `${jobId} must not carry a merge_group skip`,
    );
  }
  assert.match(ci, /Pages Function Node built-in import gate/);
  assert.match(ci, /tools\/check_pages_bundle_node_builtins\.mjs/);
  assert.match(read("test/pages_bundle_node_builtins.test.mjs"), /Pages Function import graph/);
});

test("time-travel and home-path-leak workflows run on merge_group", () => {
  const timeTravel = read(".github/workflows/time-travel.yml");
  const homePath = read(".github/workflows/no-home-path-leak.yml");
  const architecture = read(".github/workflows/architecture-reconciliation.yml");
  assert.match(timeTravel, /^  merge_group:\s*$/m);
  assert.match(homePath, /^  merge_group:\s*$/m);
  assert.match(architecture, /^  merge_group:\s*$/m);
  assert.match(timeTravel, /name:\s*Time-travel \(\$\{\{ matrix\.family \}\}, \+\$\{\{ matrix\.shift \}\}d\)/);
  assert.match(homePath, /name:\s*Reject absolute home paths/);
  assert.match(architecture, /name:\s*Reconcile architecture evidence/);
});

test("documented merge-queue required checks match policy and workflow job names", () => {
  const policy = JSON.parse(read("tools/merge_queue_policy.json"));
  const docs = read("docs/ci.md");
  const ci = read(".github/workflows/ci.yml");
  const remain = [
    "Unit tests (site + worker)",
    "Reading-level ratchet gate (readable-or-else)",
  ];
  const remove = ["Accessibility + language gate (axe on every PR)"];

  assert.deepEqual(policy.required_status_checks, remain);
  for (const name of remain) {
    assert.match(docs, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(ci, new RegExp(`name:\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  for (const name of remove) {
    assert.match(docs, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(docs, /Remove from the ruleset required list[\s\S]*?Accessibility \+ language gate/);
    assert.ok(!policy.required_status_checks.includes(name));
    assert.match(ci, new RegExp(`name:\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  assert.match(docs, /Remain in the ruleset required list/);
});
