import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scriptPath = new URL("../tools/open_first_class_refresh_pr.sh", import.meta.url).pathname;
const workflow = readFileSync(new URL("../.github/workflows/first-class-refresh.yml", import.meta.url), "utf8");

const run = (cmd, args, cwd, env = {}) => {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return result;
};

const git = (cwd, ...args) => {
  const result = run("git", args, cwd);
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

// A working clone with one committed dataset file and one uncommitted change to
// it, plus a bare remote standing in for the repository.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "first-class-refresh-pr-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  const binDir = join(root, "bin");
  const ghLog = join(root, "gh-calls.log");

  run("git", ["init", "--bare", "-b", "main", remote], root);
  run("git", ["clone", remote, work], root);
  git(work, "config", "user.email", "refresh-test");
  git(work, "config", "user.name", "Test");
  mkdirSync(join(work, "site", "data"), { recursive: true });
  mkdirSync(join(work, "worker"), { recursive: true });
  writeFileSync(join(work, "site", "data", "dataset.json"), '{"vintage":"first"}\n');
  writeFileSync(join(work, "worker", "index.js"), "export default {};\n");
  git(work, "add", "-A");
  git(work, "commit", "-m", "Seed dataset");
  git(work, "push", "origin", "main");

  // The refresh regenerated the dataset.
  writeFileSync(join(work, "site", "data", "dataset.json"), '{"vintage":"second"}\n');

  mkdirSync(binDir);
  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> "${ghLog}"`,
      'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf "%s" "${GH_OPEN_PR:-}"; fi',
      "exit 0",
    ].join("\n") + "\n",
  );
  chmodSync(gh, 0o755);

  return { root, remote, work, binDir, ghLog };
}

const invoke = (f, env = {}) =>
  run("bash", [scriptPath], f.work, {
    PATH: `${f.binDir}:${process.env.PATH}`,
    PUSH_REMOTE: f.remote,
    BRANCH_DATE: "20260906",
    GH_TOKEN: "unused-in-test",
    REPOSITORY: "owner/name",
    ...env,
  });

const ghCalls = (f) => {
  try {
    return readFileSync(f.ghLog, "utf8");
  } catch {
    return "";
  }
};

test("first run of the day pushes a new branch and opens a pull request", () => {
  const f = fixture();
  try {
    const result = invoke(f);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /does not exist on the remote yet/);
    const pushed = git(f.work, "ls-remote", f.remote, "refs/heads/data/first-class-refresh-20260906");
    assert.ok(pushed.length > 0, "branch should exist on the remote");
    assert.match(ghCalls(f), /pr create/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a re-run on the same day replaces an existing branch instead of failing the lease", () => {
  const f = fixture();
  try {
    // An earlier run left the dated branch on the remote; its pull request was
    // closed, so nothing is open on that head.
    const first = invoke(f);
    assert.equal(first.status, 0, first.stderr);
    const firstSha = git(f.work, "ls-remote", f.remote, "refs/heads/data/first-class-refresh-20260906").split("\t")[0];

    // A second run starts from a fresh clone, which has no remote-tracking ref
    // for the dated branch — the condition that produced "stale info".
    const work2 = join(f.root, "work2");
    run("git", ["clone", f.remote, work2], f.root);
    git(work2, "config", "user.email", "refresh-test");
    git(work2, "config", "user.name", "Test");
    writeFileSync(join(work2, "site", "data", "dataset.json"), '{"vintage":"third"}\n');
    const second = run("bash", [scriptPath], work2, {
      PATH: `${f.binDir}:${process.env.PATH}`,
      PUSH_REMOTE: f.remote,
      BRANCH_DATE: "20260906",
      GH_TOKEN: "unused-in-test",
      REPOSITORY: "owner/name",
    });

    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already exists on the remote/);
    const secondSha = git(work2, "ls-remote", f.remote, "refs/heads/data/first-class-refresh-20260906").split("\t")[0];
    assert.notEqual(secondSha, firstSha, "the branch should now hold the newer refresh");
    // A closed pull request on the branch does not block a new one.
    assert.match(ghCalls(f), /pr create[\s\S]*pr create/);
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
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a run that regenerated nothing exits without touching the remote", () => {
  const f = fixture();
  try {
    git(f.work, "checkout", "--", "site/data/dataset.json");
    const result = invoke(f);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No dataset changes to publish/);
    assert.equal(git(f.work, "ls-remote", f.remote, "refs/heads/data/*"), "");
    assert.equal(ghCalls(f), "");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the pull request is opened with the automation token, not the job's own token", () => {
  // GitHub does not start workflows for events created by a job's own
  // GITHUB_TOKEN, so a pull request opened that way carries no checks and the
  // merge queue cannot admit it. The publishing step must use the same
  // automation token the other scheduled refreshes use.
  const step = workflow.slice(workflow.indexOf("Open a pull request with the refreshed datasets"));
  assert.match(step, /GH_TOKEN: \$\{\{ secrets\.REFRESH_PR_TOKEN \}\}/);
  assert.doesNotMatch(step, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(step, /GH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});

test("an empty token stops the run before it pushes anything", () => {
  const f = fixture();
  try {
    // PUSH_REMOTE is the test's own override, so it is cleared here to exercise
    // the path a real run takes when the automation token is missing.
    const result = run("bash", [scriptPath], f.work, {
      PATH: `${f.binDir}:${process.env.PATH}`,
      PUSH_REMOTE: "",
      BRANCH_DATE: "20260906",
      GH_TOKEN: "",
      REPOSITORY: "owner/name",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /GH_TOKEN is empty/);
    assert.equal(git(f.work, "ls-remote", f.remote, "refs/heads/data/*"), "");
    assert.equal(ghCalls(f), "");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("the refresh workflow publishes through the tested script and keeps its lease", () => {
  assert.match(workflow, /run: bash tools\/open_first_class_refresh_pr\.sh/);
  const script = readFileSync(scriptPath, "utf8");
  assert.match(script, /--force-with-lease=/);
  assert.doesNotMatch(script, /git push[^\n]*--force(\s|"|$)/);
  // The schedule and the set of datasets the job refreshes are unchanged.
  assert.match(workflow, /cron: "40 6 \* \* \*"/);
  assert.match(workflow, /node tools\/first_class_refresh\.mjs "\$mode"/);
});
