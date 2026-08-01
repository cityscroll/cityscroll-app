// Characterization: automated changelog PRs must produce the required status checks
// that main's merge-queue ruleset names, including on changelog-only path sets. Without a
// fast path, path filters skip the suite and the queue waits forever for checks that never
// report. See .github/workflows/ci.yml (changelog_only) and update-changelog.yml.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Keep in sync with the required_status_checks contexts on main's ruleset
// (`gh api repos/OWNER/REPO/rulesets/...`) and with update-changelog.yml.
const REQUIRED_CHECK_NAMES = [
  "Unit tests (site + worker)",
  "Accessibility + language gate (axe on every PR)",
  "Reading-level ratchet gate (readable-or-else)",
];

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("ci.yml defines changelog_only so required jobs can fast-path", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /changelog_only:/);
  assert.match(ci, /id: path_class/);
  assert.match(ci, /tools\/changelog-path-guard\.sh/);
  assert.match(ci, /tools\/docs-only-path-guard\.sh/);
  assert.match(ci, /unit_full:/);
  for (const name of REQUIRED_CHECK_NAMES) {
    assert.match(ci, new RegExp(`name:\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  // Runtime multi-locale stray-English is not a required CI job.
  assert.doesNotMatch(ci, /name:\s*Stray-English guard \(runtime, fixtures\)/);
  assert.doesNotMatch(ci, /i18n-guard:/);
  assert.doesNotMatch(ci, /test\/functional\/13_stray_english\.py/);
  // Each required browser job must have a no-op success path for non-frontend / fast-path diffs.
  assert.match(ci, /Changelog-only, non-frontend, or unit-failed — report required check success/);
  assert.equal(
    (ci.match(/Changelog-only, non-frontend, or unit-failed — report required check success/g) || []).length,
    2,
    "a11y and reading-level each need a no-op success step",
  );
  assert.match(ci, /Changelog-only or docs-only — report required check success/);
});

test("required jobs stay runnable (not job-level skipped) so the check name always reports", () => {
  const ci = read(".github/workflows/ci.yml");
  // Job-level `if: needs.changes.outputs.frontend == 'true'` used to skip the
  // frontend-gated required jobs entirely, which can leave merge-queue required checks
  // without a SUCCESS conclusion on changelog-only path sets.
  assert.doesNotMatch(
    ci,
    /a11y-pr:[\s\S]*?\n    if:\s*needs\.changes\.outputs\.frontend\s*==\s*'true'/,
  );
  assert.doesNotMatch(
    ci,
    /reading-level:[\s\S]*?\n    if:\s*needs\.changes\.outputs\.frontend\s*==\s*'true'/,
  );
  assert.match(ci, /a11y-pr:[\s\S]*?\n    needs:\s*\[changes,\s*unit\]/);
  assert.match(ci, /reading-level:[\s\S]*?\n    needs:\s*\[changes,\s*unit\]/);
  assert.match(
    ci,
    /Changelog-only, non-frontend, or unit-failed — report required check success[\s\S]*?needs\.unit\.result == 'success'/,
  );
  assert.match(
    ci,
    /needs\.unit\.result == 'success'/,
  );
});

test("update-changelog.yml waits on the same three required check names", () => {
  const wf = read(".github/workflows/update-changelog.yml");
  for (const name of REQUIRED_CHECK_NAMES) {
    assert.match(wf, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(wf, /Stray-English guard \(runtime, fixtures\)/);
});

test("update-changelog.yml arms auto-merge without a strategy flag (merge queue owns squash)", () => {
  const wf = read(".github/workflows/update-changelog.yml");
  // gh pr merge --auto (no --squash/--merge/--rebase) when main is behind a merge queue.
  assert.match(wf, /gh pr merge "\$PR_NUMBER" --auto\b/);
  assert.doesNotMatch(wf, /gh pr merge "\$PR_NUMBER" --auto --squash/);
  assert.doesNotMatch(wf, /gh pr merge "\$PR_NUMBER" --auto --merge/);
});
