import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  DIGEST_SHADOW_ATTENTION,
  DIGEST_SHADOW_DEGRADED_UPSTREAM,
  DIGEST_SHADOW_FRESHNESS_SUBREQUEST_BUDGET,
  DIGEST_SHADOW_STARTED,
  applyFreshnessDegradation,
  buildDigestShadowFailureSummary,
  buildDigestShadowStartedSummary,
  finalizeDigestShadowRun,
  persistDigestShadowFailure,
  persistDigestShadowStarted,
  runBudgetedNoticeFreshness,
} from "../src/digest_shadow.mjs";
import { buildDigestShadowHoldState } from "../src/digest_shadow_hold.mjs";
import {
  DIGEST_SHADOW_LEDGER_PREFIX,
  recordDigestShadowReceipt,
} from "../src/reliability_watchdogs.mjs";

const NOW = "2026-10-05T10:00:45.000Z";
const DAY = "2026-10-05";
const source = readFileSync(new URL("../src/worker.mjs", import.meta.url), "utf8");

// Execute the committed entrypoint with imported jobs replaced at the boundary,
// matching worker/test/search_usage_schedule.test.mjs.
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
        return {};
      };
    }
  }
  vm.runInNewContext(source.replace(/^import[\s\S]*?;\s*/gm, "")
    .replace("export default", "globalThis.worker ="), context);
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  return {
    calls,
    errors,
    pending,
    run: (cron, env) => context.worker.scheduled({ cron }, env, ctx),
  };
}

function kv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, String(value)); },
  };
}

function shadowDb() {
  const runs = new Map();
  const holdStates = [];
  return {
    runs,
    holdStates,
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        async run() {
          if (sql.includes("INSERT INTO digest_shadow_runs")) {
            const [runDay, ranAt, status, digestCount, totalItems, summaryJson] = this.args;
            runs.set(runDay, {
              run_day: runDay,
              ran_at: ranAt,
              status,
              digest_count: digestCount,
              total_items: totalItems,
              summary_json: summaryJson,
            });
          }
          if (sql.includes("digest_shadow_hold_states")) {
            holdStates.push(JSON.parse(this.args.at(-1)));
          }
          return { success: true };
        },
        async first() {
          if (sql.includes("FROM digest_shadow_runs WHERE run_day")) {
            return runs.get(this.args[0]) || null;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
      };
      return statement;
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
    },
  };
}

function readySummary() {
  return {
    contract: "digest-shadow.v1",
    run_day: DAY,
    ran_at: NOW,
    ok: true,
    status: "READY",
    digest_count: 1,
    evaluated_count: 1,
    total_items: 0,
    redlines: [],
    upstream_incidents: [],
    upstream_sources_unavailable: [],
    affected_digest_ids: [],
  };
}

test("STARTED summary is a same-day fail-open state, not MISSING_RUN", () => {
  const summary = buildDigestShadowStartedSummary(NOW);
  assert.equal(summary.run_day, DAY);
  assert.equal(summary.status, DIGEST_SHADOW_STARTED);
  const hold = buildDigestShadowHoldState({ summary, now: `${DAY}T13:00:00.000Z` });
  assert.equal(hold.source_status, "STARTED_NOT_FINISHED");
  assert.equal(hold.delivery_policy, "ALL_DIGESTS_ELIGIBLE");
  assert.notEqual(hold.source_status, "MISSING_RUN");
});

test("failure summary is a same-day run-level NEEDS_ATTENTION that stays fail-open", () => {
  const summary = buildDigestShadowFailureSummary(new Error("SODA 524 (source unavailable after 2 attempts)"), NOW);
  assert.equal(summary.status, DIGEST_SHADOW_ATTENTION);
  assert.equal(summary.redlines[0].digest_id, "run");
  const hold = buildDigestShadowHoldState({ summary, now: `${DAY}T13:00:00.000Z` });
  assert.equal(hold.delivery_policy, "ALL_DIGESTS_ELIGIBLE");
  assert.notEqual(hold.source_status, "MISSING_RUN");
});

test("ledger receipt finalizes STARTED → READY / DEGRADED / FAILED", async () => {
  const ALERT_STATE = kv();
  const now = new Date(NOW);
  assert.equal(
    (await recordDigestShadowReceipt({ ALERT_STATE }, buildDigestShadowStartedSummary(now), now)).status,
    "STARTED",
  );
  assert.equal(
    (await recordDigestShadowReceipt({ ALERT_STATE }, readySummary(), now)).status,
    "READY",
  );
  assert.equal(
    (await recordDigestShadowReceipt({ ALERT_STATE }, {
      ...readySummary(),
      status: DIGEST_SHADOW_DEGRADED_UPSTREAM,
      ok: true,
    }, now)).status,
    "DEGRADED",
  );
  assert.equal(
    (await recordDigestShadowReceipt(
      { ALERT_STATE },
      buildDigestShadowFailureSummary(new Error("isolate wall time exhausted"), now),
      now,
      new Error("isolate wall time exhausted"),
    )).status,
    "FAILED",
  );
});

test("freshness time budget exhaustion returns degraded without throwing", async () => {
  const out = await runBudgetedNoticeFreshness({}, {
    budgetMs: 20,
    maxSubrequests: 100,
    ingestFn: async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { noticeRequestIds: [] };
    },
    prewarmFn: async () => ({ warmed: 0 }),
  });
  assert.equal(out.degraded, true);
  assert.match(out.reason, /time budget exhausted/);
  assert.equal(out.code, "FRESHNESS_TIME_BUDGET");
});

test("freshness subrequest budget exhaustion returns degraded", async () => {
  const out = await runBudgetedNoticeFreshness({}, {
    budgetMs: 5_000,
    maxSubrequests: 2,
    ingestFn: async () => {
      await globalThis.fetch("https://example.test/1");
      await globalThis.fetch("https://example.test/2");
      await globalThis.fetch("https://example.test/3");
      return { noticeRequestIds: [] };
    },
    prewarmFn: async () => ({ warmed: 0 }),
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  assert.equal(out.degraded, true);
  assert.match(out.reason, /subrequest budget exhausted/);
  assert.equal(out.code, "FRESHNESS_SUBREQUEST_BUDGET");
  assert.ok(out.subrequests > DIGEST_SHADOW_FRESHNESS_SUBREQUEST_BUDGET || out.subrequests > 2);
});

test("applyFreshnessDegradation promotes READY to DEGRADED_UPSTREAM without naming a held digest", () => {
  const degraded = applyFreshnessDegradation(readySummary(), {
    degraded: true,
    reason: "digest shadow freshness time budget exhausted (90000ms)",
    budget_ms: 90_000,
    subrequest_budget: 40,
    subrequests: 149,
    elapsed_ms: 900_046,
  });
  assert.equal(degraded.status, DIGEST_SHADOW_DEGRADED_UPSTREAM);
  assert.equal(degraded.ok, true);
  assert.deepEqual(degraded.affected_digest_ids, []);
  assert.ok(degraded.upstream_sources_unavailable.includes("soda"));
  const hold = buildDigestShadowHoldState({ summary: degraded, now: `${DAY}T13:00:00.000Z` });
  assert.equal(hold.delivery_policy, "ALL_DIGESTS_ELIGIBLE");
});

test("persistDigestShadowStarted leaves a same-day row a killed cron would still have", async () => {
  const DB = shadowDb();
  const ALERT_STATE = kv();
  const out = await persistDigestShadowStarted({ DB, ALERT_STATE }, { now: NOW });
  assert.equal(out.status, DIGEST_SHADOW_STARTED);
  assert.equal(out.receipt.status, "STARTED");
  assert.equal(out.hold.source_status, "STARTED_NOT_FINISHED");
  assert.ok(DB.runs.has(DAY));
  assert.notEqual(out.hold.source_status, "MISSING_RUN");
});

test("persistDigestShadowFailure finalizes FAILED over the started day", async () => {
  const DB = shadowDb();
  const ALERT_STATE = kv();
  await persistDigestShadowStarted({ DB, ALERT_STATE }, { now: NOW });
  const out = await persistDigestShadowFailure(
    { DB, ALERT_STATE },
    new Error("rehearsal exploded before persist"),
    { now: NOW },
  );
  assert.equal(out.status, DIGEST_SHADOW_ATTENTION);
  assert.equal(out.receipt.status, "FAILED");
  assert.equal(JSON.parse(DB.runs.get(DAY).summary_json).status, DIGEST_SHADOW_ATTENTION);
});

test("0 10 cron writes STARTED before freshness, still runs shadow when freshness degrades", async () => {
  const DB = shadowDb();
  const ALERT_STATE = kv();
  const env = { DB, ALERT_STATE };
  const order = [];
  // 2026-10-05 production shape: CF internalError after ~900s / 149 subrequests during
  // advisory freshness before any shadow receipt. STARTED must land first; budget exhaustion
  // degrades upstream; the rehearsal still finalizes.
  const freshnessDegraded = {
    ok: false,
    degraded: true,
    reason: "digest shadow freshness time budget exhausted (90000ms)",
    code: "FRESHNESS_TIME_BUDGET",
    budget_ms: 90_000,
    subrequest_budget: 40,
    subrequests: 149,
    elapsed_ms: 900_046,
  };
  const worker = scheduledWorker({
    overrides: {
      // Real helpers: the VM stubs every import; leave these wired to production behavior.
      applyFreshnessDegradation,
      async persistDigestShadowStarted() {
        order.push("started");
        return persistDigestShadowStarted(env, { now: NOW });
      },
      async runBudgetedNoticeFreshness() {
        order.push("freshness");
        assert.ok(DB.runs.has(DAY), "STARTED row must exist before freshness");
        assert.equal(JSON.parse(DB.runs.get(DAY).summary_json).status, DIGEST_SHADOW_STARTED);
        return freshnessDegraded;
      },
      async runDigestShadow() {
        order.push("shadow");
        return readySummary();
      },
      async finalizeDigestShadowRun(_env, summary, opts) {
        order.push("finalize");
        return finalizeDigestShadowRun(env, summary, { ...(opts || {}), now: NOW });
      },
      refreshPublicSearchUsageSnapshot: async () => ({}),
    },
  });

  await worker.run("0 10 * * *", env);
  assert.deepEqual(order, ["started", "freshness", "shadow", "finalize"]);
  assert.equal(JSON.parse(DB.runs.get(DAY).summary_json).status, DIGEST_SHADOW_DEGRADED_UPSTREAM);
  assert.equal(JSON.parse(ALERT_STATE.store.get(`${DIGEST_SHADOW_LEDGER_PREFIX}${DAY}`)).status, "DEGRADED");
  assert.equal(
    buildDigestShadowHoldState({
      summary: JSON.parse(DB.runs.get(DAY).summary_json),
      now: `${DAY}T13:00:00.000Z`,
    }).delivery_policy,
    "ALL_DIGESTS_ELIGIBLE",
  );
});

test("0 10 cron still finalizes FAILED when the rehearsal throws after STARTED", async () => {
  const DB = shadowDb();
  const ALERT_STATE = kv();
  const env = { DB, ALERT_STATE };
  const worker = scheduledWorker({
    overrides: {
      async persistDigestShadowStarted() {
        return persistDigestShadowStarted(env, { now: NOW });
      },
      async runBudgetedNoticeFreshness() {
        return { ok: true, degraded: false, result: {}, prewarm: {} };
      },
      runDigestShadow() { throw new Error("rehearsal exploded before persist"); },
      async persistDigestShadowFailure(_env, error) {
        return persistDigestShadowFailure(env, error, { now: NOW });
      },
      refreshPublicSearchUsageSnapshot: async () => ({}),
    },
  });

  await worker.run("0 10 * * *", env);
  assert.ok(DB.runs.has(DAY));
  assert.equal(JSON.parse(ALERT_STATE.store.get(`${DIGEST_SHADOW_LEDGER_PREFIX}${DAY}`)).status, "FAILED");
  assert.notEqual(
    buildDigestShadowHoldState({
      summary: JSON.parse(DB.runs.get(DAY).summary_json),
      now: `${DAY}T13:00:00.000Z`,
    }).source_status,
    "MISSING_RUN",
  );
});
