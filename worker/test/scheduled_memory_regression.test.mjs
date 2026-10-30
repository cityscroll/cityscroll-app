import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(new URL("../src/worker.mjs", import.meta.url), "utf8");
const HOLD_MS = 25;
const SCHEDULED_AT = "2026-10-29T08:00:00.000Z";
const PRODUCTION_LIKE_ZAP_PROJECTS = 300;
const ZAP_PROJECT_WORKING_SET_MIB = 12;
const MEMORY_BUDGET_MIB = 36;

function allocateFixture(megabytes, label) {
  const rows = [];
  const count = Math.floor((megabytes * 1024 * 1024) / 96);
  for (let index = 0; index < count; index += 1) {
    rows.push({
      label,
      index,
      value: `${label}-${index}-abcdefghijklmnopqrstuvwxyz0123456789`,
    });
  }
  return rows;
}

function scheduledWorker(overrides = {}) {
  const calls = [];
  const pending = [];
  const morningOptions = [];
  const context = {
    Date,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    console: { log() {}, error() {} },
  };
  for (const match of SOURCE.matchAll(/import\s+\{([^}]+)\}\s+from\s+"[^"]+";/g)) {
    for (const entry of match[1].split(",").map((value) => value.trim()).filter(Boolean)) {
      const name = entry.split(/\s+as\s+/).at(-1);
      context[name] = async (...args) => {
        calls.push(name);
        if (overrides[name]) return overrides[name](...args);
        if (name === "withWorkerAcquisitionReceipt") return args[3](args[4]?.signal);
        return {};
      };
    }
  }
  vm.runInNewContext(
    SOURCE.replace(/^import[\s\S]*?;\s*/gm, "").replace("export default", "globalThis.worker ="),
    context,
  );
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  return {
    calls,
    pending,
    morningOptions,
    run: (cron) => context.worker.runScheduled({ cron, scheduledTime: SCHEDULED_AT }, {}, ctx),
  };
}

async function measureScheduledPeak(cron) {
  const active = new Map();
  const observations = [];
  const stepPeaks = new Map();
  let peakConcurrent = 0;
  let peakFixtureMiB = 0;
  let peakHeapMiB = 0;

  const hold = async (label, megabytes, step = label) => {
    const fixture = allocateFixture(megabytes, label);
    active.set(label, fixture);
    peakConcurrent = Math.max(peakConcurrent, active.size);
    const fixtureMiB = [...active.values()].reduce(
      (total, rows) => total + rows.length * 96 / 1024 / 1024,
      0,
    );
    peakFixtureMiB = Math.max(
      peakFixtureMiB,
      fixtureMiB,
    );
    stepPeaks.set(step, Math.max(stepPeaks.get(step) || 0, fixtureMiB));
    peakHeapMiB = Math.max(peakHeapMiB, process.memoryUsage().heapUsed / 1024 / 1024);
    observations.push({ label, step, concurrent: active.size, fixtureMiB, heapMiB: peakHeapMiB });
    await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
    active.delete(label);
    globalThis.gc?.();
  };

  const worker = scheduledWorker({
    refreshPublicSearchUsageSnapshot: () => hold("search-usage", 6),
    reconcileStaleDigestShadowRebuilds: () => hold("shadow-reconcile", 12),
    recoverStalledDigestShadowRuns: () => hold("shadow-recovery", 12),
    startMorningZapOutcomes: (ctx, _env, _runId, _refresh, _logger, _lookup, options) => {
      worker.morningOptions.push(options || {});
      const concurrency = Number(options?.concurrency) || 4;
      const task = (async () => {
        // The real scheduled roster is capped at 300 projects. Run the same
        // bounded waves here so a four-project wave cannot hide behind a
        // single small placeholder fixture.
        for (let index = 0; index < PRODUCTION_LIKE_ZAP_PROJECTS; index += concurrency) {
          const wave = Math.min(concurrency, PRODUCTION_LIKE_ZAP_PROJECTS - index);
          await Promise.all(Array.from({ length: wave }, (_, offset) => hold(
            `morning-zap-${index + offset}`,
            ZAP_PROJECT_WORKING_SET_MIB,
            "morning-zap",
          )));
        }
      })();
      ctx.waitUntil(task);
      return task;
    },
    refreshMeetingOutcomes: () => cron === "0 8 * * *" ? hold("meeting-outcomes", 18) : {},
    runAlerts: async () => {
      await hold("digest", 24);
      return { receipt: { sent: 0, enqueued: 0 } };
    },
  });

  await worker.run(cron);
  await Promise.all(worker.pending);
  return {
    peakConcurrent,
    peakFixtureMiB,
    peakHeapMiB,
    stepPeaks: Object.fromEntries(stepPeaks),
    morningOptions: worker.morningOptions,
    observations,
  };
}

for (const cron of ["0 8 * * *", "0 13 * * *"]) {
  test(`${cron} scheduled path stays below the Worker memory budget`, async () => {
    const result = await measureScheduledPeak(cron);
    assert.ok(
      result.peakFixtureMiB < MEMORY_BUDGET_MIB,
      `${cron} fixture working set ${result.peakFixtureMiB.toFixed(1)} MiB; observations=${JSON.stringify(result.observations)}`,
    );
    if (typeof globalThis.gc === "function") {
      assert.ok(
        result.peakHeapMiB < 80,
        `${cron} peak heap ${result.peakHeapMiB.toFixed(1)} MiB; observations=${JSON.stringify(result.observations)}`,
      );
    }
    assert.ok(
      result.peakConcurrent <= 2,
      `${cron} peak concurrency ${result.peakConcurrent}; observations=${JSON.stringify(result.observations)}`,
    );
    if (cron === "0 8 * * *") {
      assert.equal(result.morningOptions[0]?.concurrency, 2);
      assert.ok(
        result.stepPeaks["morning-zap"] < MEMORY_BUDGET_MIB,
        `08:00 morning-zap peak ${result.stepPeaks["morning-zap"]?.toFixed(1)} MiB; observations=${JSON.stringify(result.observations)}`,
      );
    }
  });
}
