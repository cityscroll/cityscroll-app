// A scheduled slot is a promise the trigger makes, and until now it could be
// broken silently. The trigger polls on an interval rather than at a wall-clock
// instant, and the phase of that poll drifts by however long the previous cycle
// took; once the drift crosses a minute boundary an entire wall-clock minute
// passes with no cycle in it. Due-ness was decided by comparing a cron
// expression against the single instant a cycle happened to sample, so a daily
// job whose only slot fell in that minute simply did not happen: no run, no
// result, no record, and a monitoring finding that stopped moving with nobody
// able to say why. These cases pin the ledger that ended that.
import assert from "node:assert/strict";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  MISSED_OUTSIDE_WINDOW,
  MISSED_RUNNER_ERROR,
  MISSED_SUPERSEDED,
  SLOT_CATCH_UP_MINUTES,
  planScheduledSlots,
  publishHeartbeat,
  readSlotLedger,
  settleScheduledJob,
  slotInstant,
  slotKey,
  slotsBetween,
} from "../tools/external_schedule_runner.mjs";
import { withTempDir } from "../tools/lib/with_temp_dir.mjs";

const WATCHDOG = { id: "source-freshness-watchdog", schedule: ["30 10 * * *"], runner: "source-freshness" };
const DIGEST = { id: "digest-shadow-monitor", schedule: ["10 10 * * *", "10 13 * * *"], runner: "digest-shadow" };

function ledgerAt(slot) {
  return { last_slot: slot };
}

/** Put a job's ledger where the cycle reads it from. */
async function seedLedger(stateDir, jobId, slot) {
  await mkdir(join(stateDir, "jobs", jobId), { recursive: true });
  await writeFile(
    join(stateDir, "jobs", jobId, "schedule.json"),
    `${JSON.stringify(ledgerAt(slot), null, 2)}\n`,
    "utf8",
  );
}

test("slot keys round-trip to the minute they name", () => {
  assert.equal(slotKey(new Date("2026-09-07T10:30:15.570Z")), "2026-09-07T10-30");
  assert.equal(slotInstant("2026-09-07T10-30").toISOString(), "2026-09-07T10:30:00.000Z");
  assert.equal(slotInstant("not-a-slot"), null);
});

test("a slot the poll skipped is still owed on the next cycle", () => {
  // The exact gap that lost a day of this watchdog: the cycles either side of
  // the slot sampled 10:29:20 and 10:31:22, so no cycle ever observed 10:30 and
  // the job was never due. The ledger asks what has passed since the last slot
  // it settled instead, so the skipped slot is still outstanding at 10:31.
  const plan = planScheduledSlots(WATCHDOG, {
    now: new Date("2026-09-07T10:31:22.310Z"),
    ledger: ledgerAt("2026-09-06T10-30"),
  });
  assert.equal(plan.run, "2026-09-07T10-30");
  assert.deepEqual(plan.missed, []);
  assert.equal(plan.last_slot, "2026-09-07T10-30");

  // Settling it advances the ledger, so the next cycle does not run it again.
  const after = planScheduledSlots(WATCHDOG, {
    now: new Date("2026-09-07T10:32:24.072Z"),
    ledger: ledgerAt(plan.last_slot),
  });
  assert.equal(after.run, null);
  assert.deepEqual(after.missed, []);
});

test("a slot that is run is keyed by the slot, not by the minute the cycle woke up", async () => {
  await withTempDir("crol-slots", async (stateDir) => {
    await seedLedger(stateDir, WATCHDOG.id, "2026-09-06T10-30");
    const seen = [];
    const settled = await settleScheduledJob(WATCHDOG, {
      stateDir,
      now: new Date("2026-09-07T10:31:22.310Z"),
      run: async (job, options) => {
        seen.push(options.runKey);
        return { result: { status: "degraded" } };
      },
    });
    // The result and its issue event are addressed by the promised slot, so a
    // late run settles the slot it was owed rather than opening a second one.
    assert.deepEqual(seen, ["2026-09-07T10-30"]);
    assert.equal(settled.summary.slot, "2026-09-07T10-30");
    const ledger = await readSlotLedger(stateDir, WATCHDOG.id);
    assert.equal(ledger.last_slot, "2026-09-07T10-30");
    assert.equal(ledger.last_run_status, "degraded");
  });
});

test("a job with no ledger claims no history it was not installed for", async () => {
  await withTempDir("crol-slots", async (stateDir) => {
    const ran = [];
    const settled = await settleScheduledJob(WATCHDOG, {
      stateDir,
      now: new Date("2026-09-07T14:02:00.000Z"),
      run: async (job, options) => { ran.push(options.runKey); return { result: { status: "healthy" } }; },
    });
    assert.deepEqual(ran, []);
    assert.deepEqual(settled.missed, []);
    assert.equal(settled.plan.seeded, true);
    // The seed adopts the newest slot strictly before now, so the very next
    // scheduled slot still runs on time.
    assert.equal((await readSlotLedger(stateDir, WATCHDOG.id)).last_slot, "2026-09-07T10-30");
  });
});

test("a skipped slot is recorded rather than dropped when a later slot supersedes it", async () => {
  await withTempDir("crol-slots", async (stateDir) => {
    await seedLedger(stateDir, DIGEST.id, "2026-09-06T13-10");
    const settled = await settleScheduledJob(DIGEST, {
      stateDir,
      now: new Date("2026-09-07T13:10:20.000Z"),
      run: async () => ({ result: { status: "healthy" } }),
    });
    // Both of the day's slots were owed. Monitors report present state, so the
    // later one is run and the earlier one is written down rather than replayed.
    assert.equal(settled.summary.slot, "2026-09-07T13-10");
    assert.deepEqual(settled.missed, [
      { id: DIGEST.id, slot: "2026-09-07T10-10", reason: MISSED_SUPERSEDED },
    ]);
    const record = JSON.parse(await readFile(join(stateDir, "missed", DIGEST.id, "2026-09-07T10-10.json"), "utf8"));
    assert.equal(record.job_id, DIGEST.id);
    assert.equal(record.slot, "2026-09-07T10-10");
    assert.equal(record.reason, MISSED_SUPERSEDED);
    assert.ok(Date.parse(record.observed_at) > 0, "a missed record carries when it was written");
  });
});

test("slots older than the catch-up window are named rather than replayed", async () => {
  await withTempDir("crol-slots", async (stateDir) => {
    // Four days of silence: one run brings the monitor current, and the stretch
    // the cycle declines to evaluate is stated instead of quietly forgotten.
    await seedLedger(stateDir, WATCHDOG.id, "2026-09-03T10-30");
    const settled = await settleScheduledJob(WATCHDOG, {
      stateDir,
      now: new Date("2026-09-07T10:30:00.000Z"),
      run: async () => ({ result: { status: "degraded" } }),
    });
    assert.equal(settled.summary.slot, "2026-09-07T10-30");
    const outside = settled.missed.find((row) => row.reason === MISSED_OUTSIDE_WINDOW);
    assert.ok(outside, "the unevaluated stretch is not named");
    // The record is addressed to the edge of the window, not to the last slot
    // the ledger settled: that slot ran, and what went unobserved is the
    // stretch between the two.
    assert.equal(outside.slot, "2026-09-06T08-30");
    const record = JSON.parse(await readFile(join(stateDir, "missed", WATCHDOG.id, "2026-09-06T08-30.json"), "utf8"));
    assert.equal(record.since, "2026-09-03T10-30");
    assert.match(record.detail, /catch-up window/);
  });
});

test("a runner that throws settles its slot instead of taking the cycle down", async () => {
  await withTempDir("crol-slots", async (stateDir) => {
    await seedLedger(stateDir, WATCHDOG.id, "2026-09-06T10-30");
    const logged = [];
    const settled = await settleScheduledJob(WATCHDOG, {
      stateDir,
      now: new Date("2026-09-07T10:30:00.000Z"),
      log: (line) => logged.push(line),
      run: async () => { throw new Error("source health receipt has no canonical contract"); },
    });
    assert.equal(settled.summary.status, "failed");
    assert.deepEqual(settled.missed, [
      { id: WATCHDOG.id, slot: "2026-09-07T10-30", reason: MISSED_RUNNER_ERROR },
    ]);
    const record = JSON.parse(await readFile(join(stateDir, "missed", WATCHDOG.id, "2026-09-07T10-30.json"), "utf8"));
    assert.match(record.detail, /no canonical contract/);
    assert.equal(logged.length, 1);
    // The ledger still advances, so a permanently broken runner reports once a
    // slot rather than retrying on every sixty-second cycle.
    assert.equal((await readSlotLedger(stateDir, WATCHDOG.id)).last_slot, "2026-09-07T10-30");
  });
});

test("the heartbeat carries the slots a cycle did not run", async () => {
  await withTempDir("crol-slots", async (stateDir) => {
    const previous = process.env.CITYSCROLL_ADMIN_KEY;
    process.env.CITYSCROLL_ADMIN_KEY = "secret";
    try {
      const runId = "2026-09-07T10-31:test:1";
      const missedSlots = [{ id: WATCHDOG.id, slot: "2026-09-07T10-30", reason: MISSED_SUPERSEDED }];
      let posted = null;
      const receipt = await publishHeartbeat(stateDir, new Date("2026-09-07T10:31:22.310Z"), [], {
        runId,
        sourceRevision: "0".repeat(40),
        missedSlots,
        fetchImpl: async (url, options) => {
          if (options?.method === "POST") {
            posted = JSON.parse(options.body);
            return { ok: true, status: 200, json: async () => ({ ok: true }) };
          }
          return { ok: true, status: 200, json: async () => ({ heartbeat: { run_id: runId, workflow: "com.cityscroll.external-schedules" } }) };
        },
      });
      // A cycle that skipped a promised slot must not read as a quiet one.
      assert.deepEqual(posted.missed_slots, missedSlots);
      assert.deepEqual(receipt.missed_slots, missedSlots);
      assert.equal(receipt.status, "succeeded");
      const stored = JSON.parse(await readFile(join(stateDir, "heartbeat", "latest.json"), "utf8"));
      assert.deepEqual(stored.missed_slots, missedSlots);
    } finally {
      if (previous === undefined) delete process.env.CITYSCROLL_ADMIN_KEY;
      else process.env.CITYSCROLL_ADMIN_KEY = previous;
    }
  });
});

test("every declared slot of a job is enumerable within the catch-up window", () => {
  const slots = slotsBetween(DIGEST, new Date("2026-09-06T13:10:00Z"), new Date("2026-09-07T13:10:00Z"));
  assert.deepEqual(slots.map(slotKey), ["2026-09-07T10-10", "2026-09-07T13-10"]);
  // The window is wide enough that a daily job recovers on the first cycle
  // after an outage rather than waiting a further day.
  assert.ok(SLOT_CATCH_UP_MINUTES >= 24 * 60, "the catch-up window is narrower than a daily slot");
});

test("no missed record is left behind when nothing was owed", async () => {
  await withTempDir("crol-slots", async (stateDir) => {
    await seedLedger(stateDir, WATCHDOG.id, "2026-09-07T10-30");
    const settled = await settleScheduledJob(WATCHDOG, {
      stateDir,
      now: new Date("2026-09-07T10:31:22.310Z"),
      run: async () => { throw new Error("nothing should run"); },
    });
    assert.equal(settled.summary, null);
    assert.deepEqual(settled.missed, []);
    await assert.rejects(readdir(join(stateDir, "missed", WATCHDOG.id)));
  });
});
