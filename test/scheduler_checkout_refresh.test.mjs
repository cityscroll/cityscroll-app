import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isolatedGitEnv } from "../tools/architecture_evidence_shards.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";
import {
  CHECKOUT_REFRESH_HANDOFF,
  recordCheckoutRefresh,
  refreshSchedulerCheckout,
  restartRefreshedCycle,
  runCheckoutGit,
} from "../tools/lib/scheduler_checkout_refresh.mjs";
import { replayOutbox } from "../tools/external_schedule_outbox.mjs";

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8", env: isolatedGitEnv({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }),
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(run) {
  await withTempDir("scheduler-checkout", async (dir) => {
    const upstream = join(dir, "upstream");
    const root = join(dir, "scheduler");
    await mkdir(upstream);
    git(upstream, "init", "-b", "main");
    git(upstream, "config", "user.name", "Test");
    git(upstream, "config", "user.email", "test@example.invalid");
    await writeFile(join(upstream, "version.mjs"), 'export default "old";\n');
    git(upstream, "add", ".");
    git(upstream, "commit", "-m", "Initial version");
    git(dir, "clone", upstream, root);
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.invalid");
    const before = git(root, "rev-parse", "HEAD");
    await writeFile(join(upstream, "version.mjs"), 'export default "new";\n');
    git(upstream, "commit", "-am", "Updated version");
    const after = git(upstream, "rev-parse", "HEAD");
    await run({ dir, upstream, root, before, after });
  });
}

test("checkout refresh applies a fast-forward and reports both revisions", async () => {
  await fixture(async ({ root, before, after }) => {
    const receipt = await refreshSchedulerCheckout(root);
    assert.deepEqual(receipt, { status: "updated", revision_before: before, revision_after: after, reason: null });
    assert.equal(git(root, "rev-parse", "HEAD"), after);
    assert.match(await readFile(join(root, "version.mjs"), "utf8"), /new/);
    assert.equal((await refreshSchedulerCheckout(root)).status, "current");
  });
});

for (const change of ["unstaged", "staged", "untracked"]) {
  test(`checkout refresh refuses a ${change} dirty tree before network access`, async () => {
    await fixture(async ({ root, before }) => {
      await writeFile(join(root, change === "untracked" ? "local.txt" : "version.mjs"), "local change\n");
      if (change === "staged") git(root, "add", ".");
      const receipt = await refreshSchedulerCheckout(root, {
        runGit: (path, args, options) => {
          assert.ok(!args.includes("fetch") && !args.includes("ls-remote"));
          return runCheckoutGit(path, args, options);
        },
      });
      assert.equal(receipt.reason, "dirty-tree");
      assert.equal(receipt.revision_before, before);
      assert.equal(receipt.revision_after, before);
      assert.equal(git(root, "rev-parse", "HEAD"), before);
    });
  });
}

test("checkout refresh refuses divergence without merging local commits", async () => {
  await fixture(async ({ root }) => {
    await writeFile(join(root, "local.txt"), "local commit\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "Local change");
    const before = git(root, "rev-parse", "HEAD");
    const receipt = await refreshSchedulerCheckout(root);
    assert.equal(receipt.reason, "diverged");
    assert.equal(receipt.revision_after, before);
    assert.equal(git(root, "rev-parse", "HEAD"), before);
  });
});

test("checkout refresh refuses detached and non-default branches", async () => {
  await fixture(async ({ root, before }) => {
    git(root, "checkout", "--detach");
    assert.equal((await refreshSchedulerCheckout(root)).reason, "detached-head");
    git(root, "checkout", "-b", "local-change");
    assert.equal((await refreshSchedulerCheckout(root)).reason, "not-default-branch");
    assert.equal(git(root, "rev-parse", "HEAD"), before);
  });
});

test("checkout refresh discovers a changed default branch instead of trusting origin/HEAD", async () => {
  await fixture(async ({ root, upstream }) => {
    git(upstream, "checkout", "-b", "stable");
    assert.equal(git(root, "symbolic-ref", "refs/remotes/origin/HEAD"), "refs/remotes/origin/main");
    assert.equal((await refreshSchedulerCheckout(root)).reason, "not-default-branch");
  });
});

test("fetch timeout kills the transport and refuses without moving HEAD", { timeout: 10_000 }, async () => {
  await fixture(async ({ root, before }) => {
    let killed = false;
    let fetchStarted = false;
    const receipt = await refreshSchedulerCheckout(root, {
      fetchTimeoutMs: 500,
      runGit: (path, args, options) => {
        if (args.includes("ls-remote")) return Promise.resolve({ code: 0, stdout: "ref: refs/heads/main\tHEAD\n" });
        if (!args.includes("fetch")) return runCheckoutGit(path, args, options);
        fetchStarted = true;
        return runCheckoutGit(path, args, { ...options, spawnImpl: (_command, _args, spawnOptions) => {
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], spawnOptions);
          child.on("exit", (_code, signal) => { killed = signal === "SIGKILL"; });
          return child;
        } });
      },
    });
    assert.equal(fetchStarted, true);
    assert.equal(killed, true);
    assert.equal(receipt.reason, "fetch-timeout");
    assert.equal(receipt.revision_after, before);
    assert.equal(git(root, "rev-parse", "HEAD"), before);
  });
});

test("fetch failure never falls back to an older FETCH_HEAD", async () => {
  await fixture(async ({ root, before }) => {
    git(root, "fetch", "origin");
    const receipt = await refreshSchedulerCheckout(root, {
      runGit: (path, args, options) => args.includes("fetch")
        ? Promise.resolve({ code: 1, stdout: "", timed_out: false }) : runCheckoutGit(path, args, options),
    });
    assert.equal(receipt.reason, "fetch-failed");
    assert.equal(git(root, "rev-parse", "HEAD"), before);
  });
});

test("edits arriving during fetch are refused", async () => {
  await fixture(async ({ root, before }) => {
    const receipt = await refreshSchedulerCheckout(root, {
      runGit: async (path, args, options) => {
        const result = await runCheckoutGit(path, args, options);
        if (args.includes("fetch")) await writeFile(join(root, "local.txt"), "new edit\n");
        return result;
      },
    });
    assert.equal(receipt.reason, "dirty-tree");
    assert.equal(git(root, "rev-parse", "HEAD"), before);
  });
});

test("24 consecutive refusals create one configuration issue and success closes it", async () => {
  await withTempDir("scheduler-checkout-state", async (stateDir) => {
    const issues = [];
    const github = {
      listIssues: async () => issues.filter((row) => row.state === "open"),
      listComments: async () => [],
      createIssue: async (issue) => { const row = { ...issue, number: 1, state: "open" }; issues.push(row); return row; },
      createComment: async () => { throw new Error("Repeated refusal must not add comments"); },
      updateIssue: async (_number, patch) => Object.assign(issues[0], patch),
    };
    const refresh = { status: "refused", reason: "dirty-tree", revision_before: "a".repeat(40), revision_after: "a".repeat(40) };
    let receipt;
    for (let cycle = 1; cycle <= 25; cycle++) {
      const now = new Date(`2026-09-09T13:${String(cycle).padStart(2, "0")}:00Z`);
      receipt = await recordCheckoutRefresh(stateDir, refresh, now);
      await replayOutbox({ stateDir, github, now });
      assert.equal(issues.length, cycle < 24 ? 0 : 1);
    }
    assert.equal(receipt.consecutive_refusals, 25);
    assert.match(issues[0].title, /Scheduler configuration/);
    assert.match(issues[0].body, /dirty-tree/);
    const now = new Date("2026-09-09T13:26:00Z");
    github.createComment = async () => {};
    const recovered = await recordCheckoutRefresh(stateDir, { ...refresh, status: "current", reason: null }, now);
    await replayOutbox({ stateDir, github, now });
    assert.equal(issues[0].state, "closed");
    assert.equal(recovered.consecutive_refusals, 0);
    assert.equal((await recordCheckoutRefresh(stateDir, refresh, now)).consecutive_refusals, 1);
    const stored = JSON.parse(await readFile(join(stateDir, "checkout-refresh", "latest.json"), "utf8"));
    assert.equal(stored.reason, "dirty-tree");
    assert.equal(stored.revision_before, refresh.revision_before);
    assert.equal(stored.revision_after, refresh.revision_after);
  });
});

test("re-execution loads the refreshed module and hands off the same receipt once", async () => {
  await fixture(async ({ root, dir, before, after }) => {
    const script = join(dir, "cycle.mjs");
    const output = join(dir, "observed.json");
    await writeFile(script, `import version from ${JSON.stringify(join(root, "version.mjs"))};
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(output)}, JSON.stringify({version, refresh: JSON.parse(process.env.${CHECKOUT_REFRESH_HANDOFF})}));`);
    const receipt = await refreshSchedulerCheckout(root);
    assert.equal(await restartRefreshedCycle(root, [script], receipt), 0);
    const observed = JSON.parse(await readFile(output, "utf8"));
    assert.equal(observed.version, "new");
    assert.equal(observed.refresh.revision_before, before);
    assert.equal(observed.refresh.revision_after, after);
  });
});

test("the due-cycle receipt carries the refresh handoff and its actual source revision", async () => {
  await withTempDir("scheduler-cycle-receipt", async (stateDir) => {
    const receipt = {
      status: "updated", revision_before: "a".repeat(40), revision_after: "b".repeat(40),
      reason: null, consecutive_refusals: 0,
    };
    const offline = join(stateDir, "offline.mjs");
    await writeFile(offline, "globalThis.fetch = () => { throw new Error('Unexpected network access'); };\n");
    const result = spawnSync(process.execPath, [
      "--import", offline, fileURLToPath(new URL("../tools/external_schedule_runner.mjs", import.meta.url)),
      "--due", "--state-dir", stateDir,
    ], {
      encoding: "utf8", timeout: 10_000,
      env: {
        [CHECKOUT_REFRESH_HANDOFF]: JSON.stringify(receipt),
        CITYSCROLL_SOURCE_REVISION: "c".repeat(40),
        CITYSCROLL_ADMIN_KEY_FILE: join(stateDir, "absent-key"),
        GH_TOKEN_FILE: join(stateDir, "absent-token"),
      },
    });
    // An uncredentialed cycle still emits its receipt; first-run slot ledgers
    // seed from now and do not run any monitor or cross the network.
    assert.equal(result.status, 1, result.stderr);
    const cycle = JSON.parse(result.stdout);
    assert.deepEqual(cycle.checkout_refresh, receipt);
    assert.deepEqual(cycle.heartbeat.checkout_refresh, receipt);
    assert.equal(cycle.heartbeat.source_revision, receipt.revision_after);
    assert.equal(cycle.heartbeat.reason, "admin-credential-missing");
    assert.deepEqual(cycle.due, []);
  });
});
