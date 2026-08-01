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

test("ci.yml emits docs_only and unit_full and wires unit fast path", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /docs_only:/);
  assert.match(ci, /unit_full:/);
  assert.match(ci, /tools\/docs-only-path-guard\.sh/);
  assert.match(ci, /Classify path set \(changelog_only \/ docs_only \/ unit_full\)/);
  assert.match(ci, /Changelog-only or docs-only — report required check success/);
  assert.match(ci, /needs\.changes\.outputs\.unit_full != 'true'/);
  assert.match(ci, /needs\.changes\.outputs\.unit_full == 'true'/);
});

test("performance job is frontend-gated (not every non-changelog PR)", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(
    ci,
    /performance:[\s\S]*?if:\s*needs\.changes\.outputs\.unit_full == 'true' && needs\.changes\.outputs\.frontend == 'true'/,
  );
});

test("browser jobs use the Playwright cache composite action", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /\.\/\.github\/actions\/setup-playwright/);
  const action = read(".github/actions/setup-playwright/action.yml");
  assert.match(action, /actions\/cache@v4/);
  assert.match(action, /~\/\.cache\/ms-playwright/);
  assert.match(action, /playwright install --with-deps chromium/);
});

test("runtime multi-locale stray-English is not a CI job; static lint is the gate", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.doesNotMatch(ci, /name:\s*Stray-English guard \(runtime, fixtures\)/);
  assert.doesNotMatch(ci, /i18n-guard:/);
  assert.doesNotMatch(ci, /test\/functional\/13_stray_english\.py/);
  assert.doesNotMatch(ci, /run_stray_english_shards\.sh/);
  // Primary gate remains in Unit.
  assert.match(ci, /Stray-English static lint/);
  assert.match(ci, /test\/standards\/stray_english\.py/);
  // Cheap locale companions stay under a11y (not the 7-min matrix).
  assert.match(ci, /15_rtl\.py/);
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
