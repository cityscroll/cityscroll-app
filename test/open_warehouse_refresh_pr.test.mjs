import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scriptPath = new URL("../tools/open_warehouse_refresh_pr.sh", import.meta.url).pathname;
const openerScript = readFileSync(new URL("../ops/first-class-refresh/run-warehouse-refresh.sh", import.meta.url), "utf8");

const run = (cmd, args, cwd, env = {}) => {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return result;
};

const git = (cwd, ...args) => {
  const result = run("git", args, cwd);
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

// A pushed branch with a committed warehouse refresh, standing in for the
// state run-warehouse-refresh.sh leaves the checkout in right before it hands
// off to this script: HEAD on the dated branch, already pushed to the remote.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "warehouse-refresh-pr-"));
  try {
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const binDir = join(root, "bin");
    const ghLog = join(root, "gh-calls.log");
    const ghCreated = join(root, "gh-created");

    run("git", ["init", "--bare", "-b", "main", remote], root);
    run("git", ["clone", remote, work], root);
    git(work, "config", "user.email", "warehouse-refresh-test");
    git(work, "config", "user.name", "Test");
    mkdirSync(join(work, "site", "data"), { recursive: true });
    writeFileSync(join(work, "site", "data", "dataset.json"), '{"vintage":"first"}\n');
    git(work, "add", "-A");
    git(work, "commit", "-m", "Seed dataset");
    git(work, "push", "origin", "main");

    git(work, "checkout", "-b", "data/warehouse-refresh-20260906");
    writeFileSync(join(work, "site", "data", "dataset.json"), '{"vintage":"second"}\n');
    git(work, "add", "-A");
    git(work, "commit", "-m", "Refresh warehouse-backed resident datasets");
    git(work, "push", "origin", "HEAD");

    mkdirSync(binDir);
    const gh = join(binDir, "gh");
    writeFileSync(
      gh,
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> "${ghLog}"`,
        'if [ "$1" = "pr" ] && [ "$2" = "list" ] && [[ " $* " == *" --head "* ]]; then',
        `  if [ -n "\${GH_OPEN_PR:-}" ]; then printf "%s" "$GH_OPEN_PR"; elif [ -f "${ghCreated}" ]; then printf "%s" "\${GH_CREATED_PR:-4321}"; rm -f "${ghCreated}"; fi`,
        'elif [ "$1" = "pr" ] && [ "$2" = "create" ]; then',
        `  touch "${ghCreated}"`,
        'elif [ "$1" = "pr" ] && [ "$2" = "view" ] && [[ " $* " == *"headRefOid"* ]]; then',
        '  printf "%s\\tOPEN\\n" "$(git rev-parse HEAD)"',
        'elif [ "$1" = "pr" ] && [ "$2" = "view" ] && [[ " $* " == *"comments,reviews,commits"* ]]; then',
        '  pr="$3"',
        '  var="GH_TOUCHES_${pr}"',
        '  printf "%s" "${!var:-0}"',
        'elif [ "$1" = "pr" ] && [ "$2" = "checks" ]; then',
        '  printf "%s" "${GH_CHECK_BUCKETS:-pass}"',
        '  exit "${GH_CHECK_EXIT:-0}"',
        'elif [ "$1" = "pr" ] && [ "$2" = "merge" ]; then',
        '  exit "${GH_MERGE_EXIT:-0}"',
        'elif [ "$1" = "pr" ] && [ "$2" = "list" ] && [[ " $* " == *" --base "* ]]; then',
        '  printf "%s" "${GH_OLDER_PRS:-}"',
        'fi',
        "exit 0",
      ].join("\n") + "\n",
    );
    chmodSync(gh, 0o755);

    return { root, remote, work, binDir, ghLog };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

const invoke = (f, env = {}) =>
  run("bash", [scriptPath, "data/warehouse-refresh-20260906", "main", "data/warehouse-refresh-"], f.work, {
    PATH: `${f.binDir}:${process.env.PATH}`,
    ...env,
  });

const ghCalls = (f) => {
  try {
    return readFileSync(f.ghLog, "utf8");
  } catch {
    return "";
  }
};

test("a branch with no open pull request gets one opened and queued", () => {
  const f = fixture();
  try {
    const result = invoke(f);
    assert.equal(result.status, 0, result.stderr);
    assert.match(ghCalls(f), /pr create --fill --head data\/warehouse-refresh-20260906 --base main/);
    assert.match(ghCalls(f), /pr merge 4321 --auto --match-head-commit [0-9a-f]{40}/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("an open pull request on the branch is updated rather than duplicated", () => {
  const f = fixture();
  try {
    const result = invoke(f, { GH_OPEN_PR: "1234" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updated existing pull request #1234/);
    assert.doesNotMatch(ghCalls(f), /pr create/);
    assert.match(ghCalls(f), /pr merge 1234 --auto --match-head-commit [0-9a-f]{40}/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a queued refresh closes every untouched older open refresh as superseded", () => {
  const f = fixture();
  try {
    const result = invoke(f, { GH_OLDER_PRS: "111\n222\n4321\n" });
    assert.equal(result.status, 0, result.stderr);
    const calls = ghCalls(f);
    const queuedAt = calls.indexOf("pr merge 4321 --auto");
    const firstCloseAt = calls.indexOf("pr close 111");
    assert.ok(queuedAt >= 0, "the current refresh should be queued");
    assert.ok(firstCloseAt > queuedAt, "predecessors close only after the current head is queued");
    assert.match(calls, /pr close 111 --comment Superseded by #4321/);
    assert.match(calls, /pr close 222 --comment Superseded by #4321/);
    assert.doesNotMatch(calls, /pr close 4321/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a predecessor with a human comment or extra commit is left open", () => {
  const f = fixture();
  try {
    const result = invoke(f, { GH_OLDER_PRS: "111\n222\n4321\n", GH_TOUCHES_111: "2" });
    assert.equal(result.status, 0, result.stderr);
    const calls = ghCalls(f);
    assert.match(result.stdout, /Leaving pull request #111 open/);
    assert.doesNotMatch(calls, /pr close 111/);
    assert.match(calls, /pr close 222 --comment Superseded by #4321/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a queue failure leaves predecessors open for the next bounded retry", () => {
  const f = fixture();
  try {
    const result = invoke(f, { GH_OLDER_PRS: "111\n", GH_MERGE_EXIT: "1" });
    assert.equal(result.status, 1);
    assert.match(ghCalls(f), /pr merge 4321 --auto/);
    assert.doesNotMatch(ghCalls(f), /pr close 111/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a red existing refresh is not re-armed and leaves predecessors open", () => {
  const f = fixture();
  try {
    const result = invoke(f, {
      GH_OPEN_PR: "1234",
      GH_OLDER_PRS: "111\n",
      GH_CHECK_BUCKETS: "fail",
      GH_CHECK_EXIT: "1",
    });
    assert.equal(result.status, 1);
    const calls = ghCalls(f);
    assert.match(calls, /pr checks 1234 --required/);
    assert.doesNotMatch(calls, /pr merge 1234/);
    assert.doesNotMatch(calls, /pr close 111/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the warehouse refresh job publishes through the tested opener", () => {
  assert.match(openerScript, /open_warehouse_refresh_pr\.sh" "\$DATA_BRANCH" "\$DEFAULT_BRANCH" "\$DATA_BRANCH_PREFIX"/);
});
