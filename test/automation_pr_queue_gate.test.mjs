import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = new URL("../tools/queue_automation_pr_after_checks.sh", import.meta.url).pathname;
const HEAD = "a".repeat(40);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "automation-pr-queue-gate-"));
  const ghLog = join(root, "gh.log");
  const checkCount = join(root, "check-count");
  const gh = join(root, "gh");
  writeFileSync(gh, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${ghLog}"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\t%s\\n' "\${GH_HEAD:-${HEAD}}" "\${GH_STATE:-OPEN}"
elif [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  count=0
  [ ! -f "${checkCount}" ] || count="$(cat "${checkCount}")"
  count=$((count + 1))
  printf '%s' "$count" > "${checkCount}"
  sequence="\${GH_CHECK_SEQUENCE:-pass}"
  IFS=',' read -r -a states <<< "$sequence"
  index=$((count - 1))
  [ "$index" -lt "\${#states[@]}" ] || index=$((\${#states[@]} - 1))
  bucket="\${states[$index]}"
  [ "$bucket" != "none" ] && printf '%s' "$bucket"
  case "$bucket" in
    pass|skipping) exit 0 ;;
    pending|none) exit 8 ;;
    *) exit 1 ;;
  esac
fi
exit 0
`);
  chmodSync(gh, 0o755);
  return { root, ghLog };
}

function runGate(fixture, env = {}) {
  return spawnSync("bash", [SCRIPT, "4321", HEAD], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.root}:${process.env.PATH}`,
      AUTOMATION_CHECK_MAX_ATTEMPTS: "3",
      AUTOMATION_CHECK_POLL_SECONDS: "0",
      ...env,
    },
  });
}

function calls(fixture) {
  return readFileSync(fixture.ghLog, "utf8");
}

test("a previously disarmed red automation pull request is never re-armed", () => {
  const f = fixture();
  try {
    const result = runGate(f, { GH_CHECK_SEQUENCE: "fail" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /automatic merge remains disabled/);
    assert.match(calls(f), /pr checks 4321 --required/);
    assert.doesNotMatch(calls(f), /pr merge/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("pending required checks are bounded and the exact green head is queued", () => {
  const f = fixture();
  try {
    const result = runGate(f, { GH_CHECK_SEQUENCE: "none,pending,pass" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(calls(f), new RegExp(`pr merge 4321 --auto --match-head-commit ${HEAD}`));
    assert.equal((calls(f).match(/pr checks/g) || []).length, 3);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a changed automation head cannot inherit a green result", () => {
  const f = fixture();
  try {
    const result = runGate(f, { GH_HEAD: "b".repeat(40), GH_CHECK_SEQUENCE: "pass" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /moved from/);
    assert.doesNotMatch(calls(f), /pr checks|pr merge/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("all fixed-branch refresh producers use the green-check queue gate", () => {
  for (const path of [
    ".github/workflows/connected-history-cycle.yml",
    ".github/workflows/doing-business-warehouse-lookup.yml",
    ".github/workflows/geocoder-address-index.yml",
  ]) {
    const workflow = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(workflow, /bash tools\/queue_automation_pr_after_checks\.sh/);
    assert.doesNotMatch(workflow, /run: gh pr merge/);
  }
});
