/**
 * A 10:00 UTC digest-shadow handoff that stays STARTED after its first rebuild
 * attempt must get one external started-stall recovery observation after the
 * playbook's 12-minute rebuild grace and before the 12:45 UTC hold cutoff.
 *
 * Why: digest-shadow-monitor at 10:10 often sees phase=rebuild_queued within
 * grace and defers. Deferred items reopen only on a newer monitor observation.
 * With only 10:10 and 13:10 slots, nothing observes between grace expiry (~10:12)
 * and the 12:45 cutoff, so the playbook cannot enqueue before delivery boundary.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { STARTED_STALL_REBUILD_GRACE_MS } from "../tools/repair_playbooks.mjs";
import { planScheduledSlots, slotInstant, slotKey } from "../tools/external_schedule_runner.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const JOBS = JSON.parse(readFileSync(join(ROOT, "../tools/external_schedule_jobs.json"), "utf8"));
const HOLD_CUTOFF_UTC = "12:45:00.000Z";

function digestShadowJob() {
  const job = (JOBS.jobs || []).find((row) => row.id === "digest-shadow-monitor");
  assert.ok(job, "digest-shadow-monitor must be registered");
  return job;
}

function cronMinuteUtc(expression) {
  const [minute, hour] = String(expression).trim().split(/\s+/);
  assert.match(minute, /^\d+$/);
  assert.match(hour, /^\d+$/);
  return Number(hour) * 60 + Number(minute);
}

test("digest-shadow-monitor schedules one observation after rebuild grace and before the hold cutoff", () => {
  const job = digestShadowJob();
  const graceEndMinute = 10 * 60 + Math.ceil(STARTED_STALL_REBUILD_GRACE_MS / 60_000); // 10:00 + 12m → 10:12
  const cutoffMinute = cronMinuteUtc(`45 12 * * *`);
  const slots = (job.schedule || []).map(cronMinuteUtc).sort((a, b) => a - b);
  const recoverySlots = slots.filter((minute) => minute > graceEndMinute && minute < cutoffMinute);
  assert.ok(
    recoverySlots.length >= 1,
    `expected a digest-shadow-monitor slot after 10:${String(graceEndMinute % 60).padStart(2, "0")} and before 12:45; got ${JSON.stringify(job.schedule)}`,
  );
});

test("a post-grace monitor slot is owed when the 10:10 observation deferred inside grace", () => {
  const job = digestShadowJob();
  const day = "2026-10-21";
  const afterTenTen = new Date(`${day}T10:11:00.000Z`);
  const beforeCutoff = new Date(`${day}T${HOLD_CUTOFF_UTC}`);
  // Ledger settled the 10:10 alert slot; the next owed slot must land after grace
  // and before the hold cutoff so waiting_upstream can reopen and enqueue.
  const plan = planScheduledSlots(job, {
    now: beforeCutoff,
    ledger: { last_slot: slotKey(new Date(`${day}T10:10:00.000Z`)) },
  });
  assert.ok(plan.run, "expected a later digest-shadow-monitor slot before the hold cutoff");
  const owed = slotInstant(plan.run);
  assert.ok(owed);
  assert.ok(owed > afterTenTen, `owed slot ${plan.run} must be after the 10:10 observation`);
  assert.ok(owed < beforeCutoff, `owed slot ${plan.run} must be before the 12:45 hold cutoff`);
  const ageFromHandoffMs = owed.getTime() - Date.parse(`${day}T10:00:00.000Z`);
  assert.ok(
    ageFromHandoffMs >= STARTED_STALL_REBUILD_GRACE_MS,
    `owed slot ${plan.run} must be at or past the ${STARTED_STALL_REBUILD_GRACE_MS / 60000}m rebuild grace`,
  );
});
