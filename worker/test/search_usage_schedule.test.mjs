import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { searchActivityKey } from "../src/lib/search_activity.mjs";
import {
  PUBLIC_SEARCH_USAGE_KEY,
  readPublicSearchUsage,
  refreshPublicSearchUsageSnapshot,
} from "../src/lib/public_search_usage.mjs";
import { readSearchUsage } from "../src/lib/search_usage.mjs";
import { readSearchUsageDailySeries } from "../src/lib/search_usage_daily.mjs";
import { enqueueDigestJobs as enqueueDigestJobsReal } from "../src/alerts.mjs";

const NOW = "2026-09-09T08:00:00.000Z";
const CRONS = ["0 8 * * *", "0 10 * * *", "0 13 * * *"];
const source = readFileSync(new URL("../src/worker.mjs", import.meta.url), "utf8");

// Execute the committed entrypoint, with its imported jobs replaced at the boundary.
// The scheduler body itself is neither copied nor reduced to a source-string assertion.
function scheduledWorker({ now = NOW, overrides = {}, fetchImpl = null, sourceText = source, consoleImpl = null } = {}) {
  const calls = [];
  const errors = [];
  const logs = [];
  const pending = [];
  const context = {
    Date,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl || (() => { throw new Error("unexpected scheduled test fetch"); }),
    console: consoleImpl || { log: (...args) => logs.push(args), error: (...args) => errors.push(args) },
  };
  for (const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"[^"]+";/g)) {
    for (const entry of match[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const name = entry.split(/\s+as\s+/).at(-1);
      context[name] = async (...args) => {
        calls.push(name);
        if (overrides[name]) return overrides[name](...args);
        if (name === "withWorkerAcquisitionReceipt") {
          return args[3](args[4]?.signal);
        }
        if (name === "refreshPublicSearchUsageSnapshot") {
          return refreshPublicSearchUsageSnapshot(args[0], { now });
        }
        return {};
      };
    }
  }
  vm.runInNewContext(sourceText.replace(/^import[\s\S]*?;\s*/gm, "")
    .replace("export default", "globalThis.worker ="), context);
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  return { calls, errors, logs, pending, run: (cron, env, event = {}) => context.worker.runScheduled({ cron, ...event }, env, ctx) };
}

test("the 08:00 council refresh preserves each upstream request abort signal", async () => {
  let observedStatus = null;
  let requestSignal = null;
  const worker = scheduledWorker({
    fetchImpl: (_input, init = {}) => {
      requestSignal = init.signal;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true }), 20);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal.reason || new Error("request aborted"));
        }, { once: true });
      });
    },
    overrides: {
      async refreshMeetingOutcomes(_env, fetchImpl) {
        const requestDeadline = new AbortController();
        const response = fetchImpl("https://example.test/legistar", { signal: requestDeadline.signal });
        requestDeadline.abort(new Error("request deadline"));
        try {
          await response;
          observedStatus = "inner abort ignored";
          return { status: "failed", reason: observedStatus };
        } catch {
          observedStatus = "inner abort propagated";
          return { status: "success" };
        }
      },
    },
  });

  await worker.run("0 8 * * *", productionEnv());
  assert.equal(observedStatus, "inner abort propagated");
  assert.equal(requestSignal?.aborted, true);
});

function fixtureStore() {
  const values = new Map();
  const metadata = new Map();
  const writes = [];
  // Synthetic production executions: 47 returned records, ten returned none.
  // Six predate metadata-on-key, matching the legacy hydration path as well.
  for (let i = 0; i < 57; i += 1) {
    const receivedAtMs = Date.parse("2026-09-08T10:00:00Z") + i * 60000;
    const name = searchActivityKey({ receivedAtMs, receiptId: `fixture-${i}`, trafficClass: "production" });
    const returned = i < 47;
    const dimensions = {
      v: 1, execution: `fixture-${i}`, outcome: returned ? "matched" : "empty",
      recognized: false, visitor: null, subscriber: null, families: returned ? ["contracts"] : [],
    };
    values.set(name, JSON.stringify({
      execution_id: dimensions.execution, outcome: dimensions.outcome,
      recognized: false, family_counts: returned ? { contracts: 1 } : {},
    }));
    if (i >= 6) metadata.set(name, dimensions);
  }
  return {
    values, writes,
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); writes.push(key); },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...values.keys()].filter((key) => key.startsWith(prefix)).sort()
          .map((name) => ({ name, metadata: metadata.get(name) })),
        list_complete: true,
      };
    },
  };
}

function productionEnv() {
  return {
    ANALYTICS_ENVIRONMENT: "production",
    ALERT_STATE: fixtureStore(),
    DB: { prepare() { assert.fail("search-use publication must not depend on a D1 table"); } },
  };
}

for (const cron of CRONS) {
  test(`${cron} schedules one search-use refresh in its memory-safe phase`, async () => {
    const env = productionEnv();
    const worker = scheduledWorker();
    await worker.run(cron, env);
    await Promise.all(worker.pending);
    const searchUsageIndex = worker.calls.indexOf("refreshPublicSearchUsageSnapshot");
    assert.notEqual(searchUsageIndex, -1);
    assert.equal(worker.calls.filter((name) => name === "refreshPublicSearchUsageSnapshot").length, 1);
    if (cron === "0 13 * * *") {
      assert.equal(searchUsageIndex, worker.calls.length - 1, "13:00 search-use refresh follows scheduled delivery and maintenance");
    } else {
      assert.equal(searchUsageIndex, 0, "morning and rehearsal refreshes retain their independent start");
    }
    if (cron === "0 8 * * *") {
      assert.equal(worker.calls.filter((name) => name === "startMorningZapOutcomes").length, 1);
    }
    assert.equal(worker.pending.length, cron === "0 13 * * *" ? 2 : 1, "the platform retains scheduled work and the independent refresh");
    const published = await readPublicSearchUsage(env, { now: NOW });
    assert.equal(published.available, true);
    assert.equal(published.refresh.verified_at, NOW);
  });
}

test("a throwing delivery job cannot skip search-use publication or later refreshes", async () => {
  const env = productionEnv();
  const worker = scheduledWorker({ overrides: {
    runAlerts() { throw new Error("delivery unavailable"); },
  } });
  await worker.run("0 13 * * *", env);
  await Promise.all(worker.pending);
  assert.equal((await readPublicSearchUsage(env, { now: NOW })).available, true);
  assert.ok(worker.calls.includes("prewarmStats"), "later scheduled refreshes must still run");
  assert.ok(worker.errors.some((args) => /digest delivery failed/.test(args.join(" "))));
});

test("a 13:00 branch throw still schedules the deferred search-use refresh", async () => {
  const env = productionEnv();
  const worker = scheduledWorker({
    consoleImpl: {
      log(message) {
        if (message === "digest delivery: starting") throw new Error("scheduled branch failed");
      },
      error() {},
    },
  });
  await assert.rejects(worker.run("0 13 * * *", env), /scheduled branch failed/);
  await Promise.all(worker.pending);
  assert.equal(worker.calls.filter((name) => name === "refreshPublicSearchUsageSnapshot").length, 1);
  assert.equal((await readPublicSearchUsage(env, { now: NOW })).available, true);
});

test("a timed-out digest step finalizes failure and releases later scheduled refreshes", async () => {
  const env = { ...productionEnv(), SCHEDULED_STEP_DEADLINE_MS: 5 };
  const jobs = Array.from({ length: 201 }, (_, index) => ({ key: `job:${index}` }));
  const claim = [];
  const queueBatches = [];
  const terminal = [];
  const worker = scheduledWorker({ overrides: {
    recordDigestDeliveryStarted() {
      const receipt = { status: "STARTED", accepted_sends: 0, enqueued: 0, jobs_done: 0 };
      claim.push(receipt);
      return receipt;
    },
    runAlerts(_env, _watches, options) {
      return options.enqueueJobs(jobs).then(() => ({ receipt: { sent: 0, enqueued: jobs.length } }));
    },
    enqueueDigestJobs(_env, pending, options) {
      return enqueueDigestJobsReal({
        DIGEST_QUEUE: {
          sendBatch: async (batch) => { queueBatches.push(batch); },
        },
      }, pending, {
        ...options,
        onBatch: async (progress) => {
          await options.onBatch?.(progress);
          if (progress.enqueued === 100) await new Promise((resolve) => setTimeout(resolve, 20));
        },
      });
    },
    recordDigestDeliveryReceipt(_env, receipt, _now, error) {
      const status = error ? "FAILED" : "TERMINAL";
      terminal.push({ receipt, error, status });
      return { status };
    },
  } });
  await worker.run("0 13 * * *", env);
  await Promise.all(worker.pending);
  assert.equal(terminal.length, 1, "the timed-out digest must still attempt a terminal receipt");
  assert.deepEqual(claim[0], { status: "STARTED", accepted_sends: 0, enqueued: 0, jobs_done: 0 });
  assert.equal(terminal[0].receipt.enqueued, 100, "the failed receipt keeps the accepted first-batch lower bound");
  assert.equal(terminal[0].status, "FAILED");
  assert.match(String(terminal[0].error?.message || terminal[0].error), /scheduled-step deadline/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(queueBatches.length, 1, "a deadline between batches must not replay the first batch");
  assert.ok(worker.calls.includes("refreshPayrollTitleMart"), "payroll must not be starved by delivery");
  assert.ok(worker.calls.includes("refreshProperties"), "address refresh must not be starved by delivery");
  assert.ok(worker.errors.some((args) => /digest delivery failed/.test(args.join(" "))));
});

test("a later queue batch failure finalizes FAILED with an accepted lower bound and no replay", async () => {
  const env = productionEnv();
  const jobs = Array.from({ length: 201 }, (_, index) => ({ key: `job:${index}` }));
  const claim = [];
  const queueBatches = [];
  const terminal = [];
  let deliveryRuns = 0;
  const worker = scheduledWorker({ overrides: {
    recordDigestDeliveryStarted() {
      const receipt = { status: "STARTED", accepted_sends: 0, enqueued: 0, jobs_done: 0 };
      claim.push(receipt);
      return receipt;
    },
    runAlerts(_env, _watches, options) {
      deliveryRuns += 1;
      return options.enqueueJobs(jobs).then(() => ({ receipt: { sent: 0, enqueued: jobs.length } }));
    },
    enqueueDigestJobs(_env, pending, options) {
      return enqueueDigestJobsReal({
        DIGEST_QUEUE: {
          sendBatch: async (batch) => {
            queueBatches.push(batch);
            if (queueBatches.length === 2) throw new Error("second digest batch rejected");
          },
        },
      }, pending, options);
    },
    recordDigestDeliveryReceipt(_env, receipt, _now, error) {
      const status = error ? "FAILED" : "TERMINAL";
      terminal.push({ receipt, error, status });
      return { status };
    },
  } });
  await worker.run("0 13 * * *", env);
  await Promise.all(worker.pending);
  assert.deepEqual(claim[0], { status: "STARTED", accepted_sends: 0, enqueued: 0, jobs_done: 0 });
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].receipt.enqueued, 100, "the failed receipt must retain only the known accepted batches");
  assert.equal(terminal[0].status, "FAILED");
  assert.match(String(terminal[0].error?.message || terminal[0].error), /second digest batch rejected/);
  assert.equal(queueBatches.length, 2, "the failing batch is attempted once");
  assert.equal(deliveryRuns, 1, "a failed fan-out does not replay the scheduled delivery");
});

test("single-message queue fallback reaches one terminal receipt without replay", async () => {
  const env = productionEnv();
  const jobs = [{ key: "fallback:0" }, { key: "fallback:1" }, { key: "fallback:2" }];
  const claim = [];
  const sent = [];
  const terminal = [];
  let deliveryRuns = 0;
  const worker = scheduledWorker({ overrides: {
    recordDigestDeliveryStarted() {
      const receipt = { status: "STARTED", accepted_sends: 0, enqueued: 0, jobs_done: 0 };
      claim.push(receipt);
      return receipt;
    },
    runAlerts(_env, _watches, options) {
      deliveryRuns += 1;
      return options.enqueueJobs(jobs).then(() => ({ receipt: { sent: 0, enqueued: jobs.length } }));
    },
    enqueueDigestJobs(_env, pending, options) {
      return enqueueDigestJobsReal({
        DIGEST_QUEUE: {
          send: async (job) => { sent.push(job); },
        },
      }, pending, options);
    },
    recordDigestDeliveryReceipt(_env, receipt, _now, error) {
      const status = error ? "FAILED" : "TERMINAL";
      terminal.push({ receipt, error, status });
      return { status };
    },
  } });
  await worker.run("0 13 * * *", env);
  await Promise.all(worker.pending);
  assert.deepEqual(claim[0], { status: "STARTED", accepted_sends: 0, enqueued: 0, jobs_done: 0 });
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].error, null);
  assert.equal(terminal[0].status, "TERMINAL");
  assert.equal(terminal[0].receipt.enqueued, jobs.length);
  assert.deepEqual(sent, jobs, "fallback writes each message exactly once");
  assert.equal(deliveryRuns, 1, "fallback completion does not replay the scheduled delivery");
});

test("a healthy multi-minute digest delivery is not aborted by its scheduled deadline", async () => {
  // Keep a healthy 130-second delivery just beyond the old two-minute bound, then
  // scale the clock so the regression stays fast while exercising the real boundary.
  const deadline = source.match(/const SCHEDULED_DIGEST_DEADLINE_MS = ([^;]+);/);
  assert.ok(deadline, "scheduled digest deadline must remain explicit");
  const scale = 1_000;
  const healthyDeliveryMs = (130 * 1_000) / scale;
  const scaledSource = source.replace(
    deadline[0],
    `const SCHEDULED_DIGEST_DEADLINE_MS = (${deadline[1]}) / ${scale};`,
  );
  const env = productionEnv();
  const terminal = [];
  const worker = scheduledWorker({ sourceText: scaledSource, overrides: {
    recordDigestDeliveryStarted() { return { status: "STARTED" }; },
    runAlerts() {
      return new Promise((resolve) => setTimeout(() => resolve({
        receipt: { sent: 1, enqueued: 339 },
      }), healthyDeliveryMs));
    },
    recordDigestDeliveryReceipt(_env, receipt, _now, error) {
      terminal.push({ receipt, error });
      return { status: error ? "FAILED" : "TERMINAL" };
    },
  } });
  await worker.run("0 13 * * *", env);
  await Promise.all(worker.pending);
  assert.equal(terminal.length, 1, "healthy delivery must reach its terminal receipt");
  assert.equal(terminal[0].error, null, "healthy delivery must not be timed out");
  assert.deepEqual(terminal[0].receipt, { sent: 1, enqueued: 339 });
  assert.ok(!worker.errors.some((args) => /digest delivery failed/.test(args.join(" "))));
});

test("a terminal receipt KV failure is loud without stranding later refreshes", async () => {
  const env = productionEnv();
  env.ALERT_STATE.put = async () => { throw new Error("terminal receipt KV unavailable"); };
  const worker = scheduledWorker({ overrides: {
    recordDigestDeliveryStarted() { return { status: "STARTED" }; },
    runAlerts() { return { receipt: { sent: 1, enqueued: 2 } }; },
    async recordDigestDeliveryReceipt(_env) { await _env.ALERT_STATE.put("digest:terminal", "TERMINAL"); },
  } });
  await worker.run("0 13 * * *", env);
  assert.ok(worker.calls.includes("refreshPayrollTitleMart"));
  assert.ok(worker.calls.includes("refreshProperties"));
  assert.ok(worker.errors.some((args) => /digest delivery terminal receipt failed/.test(args.join(" "))));
});

test("STARTED write failure does not skip delivery or its terminal receipt", async () => {
  const env = productionEnv();
  let alerts = 0;
  let terminal = 0;
  const worker = scheduledWorker({ overrides: {
    async recordDigestDeliveryStarted() {
      throw new Error("ALERT_STATE put rate limited");
    },
    async runAlerts() {
      alerts += 1;
      return { receipt: { sent: 1, enqueued: 0 } };
    },
    async recordDigestDeliveryReceipt(_env, receipt) {
      terminal += 1;
      return { status: "TERMINAL", accepted_sends: Number(receipt?.sent) || 0 };
    },
  } });
  await worker.run("0 13 * * *", env);
  await Promise.all(worker.pending);
  assert.equal(alerts, 1, "delivery must run exactly once when STARTED throws");
  assert.equal(terminal, 1, "terminal receipt must still be written");
  assert.equal(worker.calls.filter((name) => name === "runAlerts").length, 1);
  assert.equal(worker.calls.filter((name) => name === "recordDigestDeliveryReceipt").length, 1);
  assert.ok(worker.errors.some((args) => /STARTED receipt failed/.test(args.join(" "))));
  assert.ok(
    worker.calls.indexOf("runAlerts") > worker.calls.indexOf("recordDigestDeliveryStarted"),
    "STARTED attempt still precedes delivery",
  );
});

test("a stalled advisory job cannot delay search-use publication", async () => {
  let release;
  const advisory = new Promise((resolve) => { release = resolve; });
  const env = productionEnv();
  const worker = scheduledWorker({ overrides: { refreshZapProjectsLookup: () => advisory } });
  const run = worker.run("0 8 * * *", env);
  try {
    assert.equal(worker.pending.length, 1);
    await Promise.all(worker.pending);
    assert.equal((await readPublicSearchUsage(env, { now: NOW })).available, true);
  } finally {
    release({});
    await run;
  }
});

test("a publication exception does not stop the other scheduled jobs", async () => {
  const worker = scheduledWorker({ overrides: {
    refreshPublicSearchUsageSnapshot() { throw new Error("publication unavailable"); },
  } });
  await worker.run("0 13 * * *", productionEnv());
  await Promise.all(worker.pending);
  assert.ok(worker.calls.includes("runAlerts"));
  assert.ok(worker.calls.includes("prewarmStats"));
  assert.ok(worker.errors.some((args) => args.join(" ").includes("publication unavailable")));
});

test("cost probe schedule suppresses edge-cache writes", async () => {
  const received = [];
  const worker = scheduledWorker({ overrides: {
    prewarmNotices(...args) { received.push(["notices", ...args]); return {}; },
    prewarmStats(...args) { received.push(["stats", ...args]); return {}; },
  } });
  await worker.run("0 13 * * *", productionEnv(), { costProbe: true });
  assert.equal(received.find(([name]) => name === "notices")[3].skipEdgeCacheWrite, true);
  assert.equal(received.find(([name]) => name === "stats")[2].skipCacheWrite, true);
});

test("digest shadow queue handoff logs stay free of rendered bodies; cost probes suppress the summary", async () => {
  const privateSubject = "CityScroll: still watching — tenant coalition";
  const overrides = {
    persistDigestShadowStarted: () => ({ status: "STARTED", write_accepted: true }),
    createDigestShadowRebuild: () => ({
      run_id: "digest-shadow-rebuild:test",
      status: "queued",
      run_day: "2026-09-09",
      // Rendered bodies must never reach scheduled logs even if a stub leaks them.
      _rendered_previews: [{ subject: privateSubject }],
    }),
    markDigestShadowRebuildQueued: () => ({ write_accepted: true }),
  };
  const normal = scheduledWorker({ overrides });
  await normal.run("0 10 * * *", productionEnv());
  assert.ok(normal.calls.includes("createDigestShadowRebuild"));
  assert.ok(normal.calls.includes("markDigestShadowRebuildQueued"));
  assert.equal(normal.calls.includes("runDigestShadow"), false);
  const summaries = normal.logs.filter(([label]) => label === "digest shadow rebuild queued:");
  assert.equal(summaries.length, 1);
  assert.equal(JSON.parse(summaries[0][1]).rebuild_run_id, "digest-shadow-rebuild:test");
  assert.equal(normal.logs.some((args) => args.join(" ").includes(privateSubject)), false);

  const probe = scheduledWorker({ overrides });
  await probe.run("0 10 * * *", productionEnv(), { costProbe: true });
  assert.ok(probe.calls.includes("createDigestShadowRebuild"));
  assert.equal(probe.logs.some(([label]) => label === "digest shadow rebuild queued:"), false);
  assert.equal(probe.logs.some((args) => args.join(" ").includes(privateSubject)), false);
});

test("57 retained executions publish unchanged counts when their period is established", async () => {
  const env = productionEnv();
  env.SEARCH_ACTIVITY_MEASURED_SINCE = "2026-09-08T00:00:00.000Z";
  const usage = await readSearchUsage(env, { now: NOW });
  assert.equal(usage.executions_observed, 57);
  assert.equal(usage.scan.hydrated_receipts, 6);
  assert.equal(usage.scan.scan_complete, true);
  assert.equal(usage.unclassified_receipts, 0);
  const worker = scheduledWorker();
  await worker.run("0 8 * * *", env);
  await Promise.all(worker.pending);
  const published = await readPublicSearchUsage(env, { now: NOW });
  assert.deepEqual(published.periods.map((period) => period.metrics.map((metric) => metric.value)),
    [[57, 47], [57, 47]]);
  const daily = await readSearchUsageDailySeries(env, { now: NOW });
  assert.equal(daily.newest_day, "2026-09-08");
});

test("bootstrap waits for its first measured day to close and later windows leave it unchanged", async () => {
  const env = productionEnv();
  const first = scheduledWorker();
  await first.run("0 8 * * *", env);
  await Promise.all(first.pending);
  assert.equal((await readSearchUsageDailySeries(env, { now: NOW })).newest_day, null);
  assert.equal(JSON.parse(env.ALERT_STATE.values.get(PUBLIC_SEARCH_USAGE_KEY)).measured_since,
    "2026-09-09T00:00:00.000Z");
  const next = scheduledWorker({ now: "2026-09-10T08:00:00.000Z" });
  await next.run("0 8 * * *", env);
  await Promise.all(next.pending);
  const key = "stats:public:search-usage:day:2026-09-09";
  const stored = env.ALERT_STATE.values.get(key);
  assert.ok(stored);
  assert.deepEqual(JSON.parse(stored).metrics, { searches_run: 0, searches_returning_records: 0 });
  const later = scheduledWorker({ now: "2026-09-10T10:00:00.000Z" });
  await later.run("0 10 * * *", env);
  await Promise.all(later.pending);
  assert.equal(env.ALERT_STATE.values.get(key), stored);
  assert.equal(env.ALERT_STATE.writes.filter((name) => name === key).length, 1);
});
