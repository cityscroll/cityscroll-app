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

const NOW = "2026-09-09T08:00:00.000Z";
const CRONS = ["0 8 * * *", "0 10 * * *", "0 13 * * *"];
const source = readFileSync(new URL("../src/worker.mjs", import.meta.url), "utf8");

// Execute the committed entrypoint, with its imported jobs replaced at the boundary.
// The scheduler body itself is neither copied nor reduced to a source-string assertion.
function scheduledWorker({ now = NOW, overrides = {} } = {}) {
  const calls = [];
  const errors = [];
  const pending = [];
  const context = { Date, console: { log() {}, error: (...args) => errors.push(args) } };
  for (const match of source.matchAll(/import\s+\{([^}]+)\}\s+from\s+"[^"]+";/g)) {
    for (const entry of match[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const name = entry.split(/\s+as\s+/).at(-1);
      context[name] = async (...args) => {
        calls.push(name);
        if (overrides[name]) return overrides[name](...args);
        if (name === "refreshPublicSearchUsageSnapshot") {
          return refreshPublicSearchUsageSnapshot(args[0], { now });
        }
        return {};
      };
    }
  }
  vm.runInNewContext(source.replace(/^import[\s\S]*?;\s*/gm, "")
    .replace("export default", "globalThis.worker ="), context);
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  return { calls, errors, pending, run: (cron, env) => context.worker.scheduled({ cron }, env, ctx) };
}

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
  test(`${cron} starts one search-use refresh before its other jobs`, async () => {
    const env = productionEnv();
    const worker = scheduledWorker();
    await worker.run(cron, env);
    await Promise.all(worker.pending);
    assert.equal(worker.calls[0], "refreshPublicSearchUsageSnapshot");
    assert.equal(worker.calls.filter((name) => name === "refreshPublicSearchUsageSnapshot").length, 1);
    assert.equal(worker.pending.length, 1, "the platform retains the independent refresh");
    const published = await readPublicSearchUsage(env, { now: NOW });
    assert.equal(published.available, true);
    assert.equal(published.refresh.verified_at, NOW);
  });
}

test("a throwing delivery job cannot skip search-use publication", async () => {
  const env = productionEnv();
  const worker = scheduledWorker({ overrides: {
    runAlerts() { throw new Error("delivery unavailable"); },
  } });
  await assert.rejects(worker.run("0 13 * * *", env), /delivery unavailable/);
  await Promise.all(worker.pending);
  assert.equal((await readPublicSearchUsage(env, { now: NOW })).available, true);
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
