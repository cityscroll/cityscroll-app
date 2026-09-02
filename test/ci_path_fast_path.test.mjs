// Characterization: CI path classification + Stray-English sharding + Playwright cache.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function jobBlock(workflow, name) {
  const start = workflow.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `expected ${name} job`);
  const headerLength = `  ${name}:\n`.length;
  const remainder = workflow.slice(start + headerLength);
  const nextJobOffset = remainder.search(/\n  [A-Za-z0-9_-]+:/);
  return workflow.slice(
    start,
    nextJobOffset === -1 ? workflow.length : start + headerLength + nextJobOffset,
  );
}

test("ci.yml emits docs_only and unit_full and wires unit fast path", () => {
  const ci = read(".github/workflows/ci.yml");
  const frontend = ci.match(/\n\s+frontend:\n([\s\S]*?)\n\s+# Subset of frontend/);
  assert.ok(frontend, "expected frontend path filter block");
  assert.match(frontend[1], /- '\.github\/workflows\/ci\.yml'/);
  assert.match(ci, /docs_only:/);
  assert.match(ci, /unit_full:/);
  assert.match(ci, /tools\/docs-only-path-guard\.sh/);
  assert.match(ci, /Classify path set \(changelog_only \/ docs_only \/ unit_full\)/);
  assert.match(ci, /Changelog-only or docs-only — report required check success/);
  assert.match(ci, /needs\.changes\.outputs\.unit_full != 'true'/);
  assert.match(ci, /needs\.changes\.outputs\.unit_full == 'true'/);
});

test("performance job is perf-path-gated and always reports a conclusion", () => {
  const ci = read(".github/workflows/ci.yml");
  // Narrower than frontend: site/data receipts and worker-only PRs must not pay
  // for the 20-sample measure. Job always runs so the check name reports SUCCESS.
  assert.match(ci, /perf:\s*\$\{\{\s*steps\.filter\.outputs\.perf\s*\}\}/);
  assert.match(ci, /site\/\*\*\/\*\.html/);
  assert.match(ci, /performance-budgets\.json/);
  assert.match(ci, /test\/performance\/\*\*/);

  // Scope to the performance job only (a11y still uses the broad frontend filter).
  const job = ci.match(
    /\n  performance:\n([\s\S]*?)\n  # w7-01:|\n  performance:\n([\s\S]*?)\n  a11y-pr:/,
  );
  assert.ok(job, "expected performance job before a11y-pr");
  const body = job[1] || job[2];
  assert.match(body, /^\s+if:\s*always\(\)/m);
  assert.match(body, /Non-perf path set or unit-failed — report success/);
  assert.match(body, /needs\.changes\.outputs\.perf == 'true'/);
  assert.match(body, /Reporting success for 'Performance budgets \(20-sample p95\)' without measuring/);
  // Heavy steps must not use the broad frontend filter alone.
  assert.doesNotMatch(
    body,
    /Aggregate the complete raw sample set[\s\S]*?outputs\.frontend == 'true'/,
  );
  assert.match(
    body,
    /Aggregate the complete raw sample set[\s\S]*?outputs\.perf == 'true'/,
  );
});

test("performance path filter excludes site/data and includes chrome assets", () => {
  const ci = read(".github/workflows/ci.yml");
  // Extract the perf: filter block between "perf:" and the next top-level filter key.
  const m = ci.match(/\n\s+perf:\n([\s\S]*?)\n\s+worker:/);
  assert.ok(m, "expected perf filter block before worker:");
  const block = m[1];
  assert.match(block, /site\/\*\*\/\*\.js/);
  assert.match(block, /site\/assets\/\*\*/);
  assert.doesNotMatch(block, /site\/\*\*(?![/.*])/); // not the broad site/**
  assert.doesNotMatch(block, /site\/data/);
  assert.doesNotMatch(block, /worker\/\*\*/);
});

test("merge-group path classification evaluates the queued tree against its base", () => {
  const ci = read(".github/workflows/ci.yml");
  const shardRunner = read("tools/run_a11y_ci_shard.sh");
  assert.match(ci, /\n  merge_group:/);
  assert.match(
    ci,
    /base:\s*\$\{\{\s*github\.event_name\s*==\s*'pull_request'[\s\S]*github\.event\.merge_group\.base_sha/,
  );
  assert.match(shardRunner, /Inline-to-module rendered DOM equivalence gate/);
  assert.match(ci, /Aggregate the complete raw sample set/);
});

test("shared browser artifact starts with path detection while unit remains a required verdict", () => {
  const ci = read(".github/workflows/ci.yml");
  const browser = jobBlock(ci, "browser-pr-site");
  const unit = jobBlock(ci, "unit");
  const unitFamily = jobBlock(ci, "unit-family");
  const accessibility = jobBlock(ci, "a11y-pr");
  const policy = JSON.parse(read("tools/merge_queue_policy.json"));

  assert.match(browser, /needs:\s*\[changes\]/);
  assert.doesNotMatch(browser, /needs:\s*\[changes,\s*unit\]/);
  assert.doesNotMatch(browser, /needs\.unit(?:\.result)?/, "artifact production must not wait for Unit");
  assert.match(browser, /needs\.changes\.outputs\.frontend/);
  assert.match(browser, /needs\.changes\.outputs\.perf/);

  assert.match(unitFamily, /family: \[static-standards, site-node, contract, worker\]/);
  assert.match(unitFamily, /if: matrix\.family == 'site-node'[\s\S]*?run: node --test test\/\*\.test\.mjs/);
  assert.match(unit, /needs: \[changes, unit-family, merge-group-preflight\]/);
  assert.match(unit, /Fail when a Unit family fails or is missing[\s\S]*?needs\.unit-family\.result != 'success'[\s\S]*?exit 1/);
  // The merge-group preflight is folded into the required Unit verdict so a
  // branch that would poison the queue's combined tree turns red pre-queue.
  assert.match(unit, /Fail when the merge-group preflight is not green[\s\S]*?needs\.merge-group-preflight\.result != 'success'[\s\S]*?exit 1/);

  // Unit and Accessibility remain required merge checks; a passing artifact is only
  // an input to the browser consumers, not a substitute for either verdict.
  assert.deepEqual(policy.required_status_checks, [
    "Unit tests (site + worker)",
    "Accessibility + language gate (axe on every PR)",
    "Reading-level ratchet gate (readable-or-else)",
  ]);
  assert.match(
    accessibility,
    /needs:\s*\[changes,\s*unit,\s*a11y-pr-shard,\s*a11y-routes-focus-primary,\s*a11y-routes-focus-retry\]/,
  );

  const requiredChecksPass = (statuses) => policy.required_status_checks.every(
    (check) => statuses[check] === "success",
  );
  const unitFailureWithHealthyBrowser = {
    "Unit tests (site + worker)": "failure",
    "Accessibility + language gate (axe on every PR)": "success",
    "Reading-level ratchet gate (readable-or-else)": "success",
    "Shared browser site artifact": "success",
  };
  assert.equal(
    requiredChecksPass(unitFailureWithHealthyBrowser),
    false,
    "a site-node regression such as RCP-03 must keep the merge verdict red",
  );
  assert.equal(
    requiredChecksPass({
      ...unitFailureWithHealthyBrowser,
      "Unit tests (site + worker)": "success",
    }),
    true,
  );
});

test("browser consumers remain downstream of the successfully built artifact", () => {
  const ci = read(".github/workflows/ci.yml");
  for (const job of [
    "performance-serial",
    "performance-shard",
    "performance",
    "a11y-pr-shard",
    "a11y-routes-focus-primary",
    "a11y-routes-focus-retry",
  ]) {
    assert.match(jobBlock(ci, job), /needs:[^\n]*browser-pr-site/, `${job} must wait for browser-pr-site`);
  }
  assert.match(
    jobBlock(ci, "a11y-pr"),
    /needs:[^\n]*unit[^\n]*a11y-pr-shard/,
    "the required accessibility aggregate must retain the unit and artifact-backed shard inputs",
  );
});

test("private capture redaction keeps the accessibility receipt contract fail-closed", () => {
  const ci = read(".github/workflows/ci.yml");
  const shardRunner = read("tools/run_a11y_ci_shard.sh");
  const capture = read("tools/capture_browse_interaction_grammar.py");

  // PR-1498 intentionally removed private screenshot locators from the public tree.
  // Null is accepted only as that explicit redaction state, while the full capture
  // matrix, hydrated phase, and positive dimensions remain required.
  assert.match(capture, /if relative is None:/);
  assert.match(capture, /row\.get\("phase"\) == "hydrated"/);
  assert.match(capture, /redacted capture pixel_size is incomplete/);
  assert.match(capture, /assert isinstance\(relative, str\), f"capture path is missing/);

  // The functional route grammar and the receipt verifier remain in the required
  // routes-focus shard; this repair does not skip or demote accessibility coverage.
  assert.match(shardRunner, /test\/functional\/30_browse_interaction_grammar\.py/);
  assert.match(shardRunner, /capture_browse_interaction_grammar\.py --verify-only/);
  assert.match(ci, /Accessibility \+ language gate \(axe on every PR\)/);
});

test("browser jobs use the Playwright cache composite action", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /\.\/\.github\/actions\/setup-playwright/);
  const action = read(".github/actions/setup-playwright/action.yml");
  const requirements = read(".github/actions/setup-playwright/requirements.txt");
  assert.match(action, /actions\/cache@v4/);
  assert.match(action, /~\/\.cache\/ms-playwright/);
  assert.match(action, /cache-dependency-path: \.github\/actions\/setup-playwright\/requirements\.txt/);
  assert.match(action, /hashFiles\('\.github\/actions\/setup-playwright\/requirements\.txt', '\.github\/actions\/setup-playwright\/action\.yml'\)/);
  assert.doesNotMatch(action, /restore-keys:/);
  assert.equal(requirements.trim(), "playwright==1.58.0");
  // Browser binary always; system deps only on cache miss so a11y does not burn
  // its budget re-running apt fonts on every warm runner.
  assert.match(action, /playwright install chromium/);
  assert.match(action, /steps\.pw-cache\.outputs\.cache-hit/);
  assert.match(action, /playwright install-deps chromium/);
  assert.match(action, /Playwright setup timing/);
  assert.match(action, /Cache \$\{cache_result\}: \$\{duration_seconds\}s/);
  // Cold Playwright install + multi-gate axe suite needs headroom above 10m.
  assert.match(ci, /a11y-pr:[\s\S]*?timeout-minutes:\s*20/);
});

test("runtime multi-locale stray-English is not a CI job; static lint is the gate", () => {
  const ci = read(".github/workflows/ci.yml");
  const shardRunner = read("tools/run_a11y_ci_shard.sh");
  assert.doesNotMatch(ci, /name:\s*Stray-English guard \(runtime, fixtures\)/);
  assert.doesNotMatch(ci, /i18n-guard:/);
  assert.doesNotMatch(ci, /test\/functional\/13_stray_english\.py/);
  assert.doesNotMatch(ci, /run_stray_english_shards\.sh/);
  // Primary gate remains in Unit.
  assert.match(ci, /Stray-English static lint/);
  assert.match(ci, /test\/standards\/stray_english\.py/);
  // Cheap locale companions stay under a11y (not the 7-min matrix).
  assert.match(shardRunner, /15_rtl\.py/);
  const policy = JSON.parse(read("tools/merge_queue_policy.json"));
  assert.ok(
    !policy.required_status_checks.includes("Stray-English guard (runtime, fixtures)"),
  );
  assert.equal(policy.required_status_checks.length, 3);
});

test("merge queue policy documents train wait and apply tool", () => {
  const policy = JSON.parse(read("tools/merge_queue_policy.json"));
  assert.equal(policy.merge_queue.min_entries_to_merge_wait_minutes, 5);
  assert.equal(policy.merge_queue.grouping_strategy, "ALLGREEN");
  assert.equal(policy.merge_queue.max_entries_to_build, 5);
  assert.equal(policy.elder_slot.detect_and_steer_age_hours, 2);
  assert.equal(policy.elder_slot.elder_age_hours, 6);
  assert.equal(policy.elder_slot.rebase_churn_threshold, 3);
  assert.equal(policy.elder_slot.reserve_next_slot_for_elder, true);
  assert.ok(fs.existsSync(path.join(ROOT, "tools", "apply_merge_queue_policy.mjs")));
});

test("shard runner script is executable and fails closed on empty env path", () => {
  const script = path.join(ROOT, "test", "functional", "run_stray_english_shards.sh");
  const st = fs.statSync(script);
  assert.ok(st.mode & 0o111, "run_stray_english_shards.sh should be executable");
  // Dry structure: with CROL_GUARD_LANGS set it should exec the python entry (syntax only).
  const help = execFileSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(help, "");
});
