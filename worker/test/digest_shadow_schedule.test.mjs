import { DatabaseSync } from "node:sqlite";
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
  recordDigestShadowProgress,
  runDigestShadow,
} from "../src/digest_shadow.mjs";
import { ingestNotices } from "../src/ingest.mjs";
import {
  buildDigestShadowHoldState,
  recordDigestShadowHoldState,
  resolveDigestShadowHold,
} from "../src/digest_shadow_hold.mjs";
import {
  DIGEST_SHADOW_LEDGER_PREFIX,
  digestWatchdogSnapshot,
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
  const context = { Date, crypto, console: { log() {}, error: (...args) => errors.push(args) } };
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
    run: (cron, env, scheduledTime = new Date(now).getTime()) => context.worker.runScheduled({ cron, scheduledTime }, env, ctx),
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
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE digest_shadow_runs (
      run_day TEXT PRIMARY KEY, ran_at TEXT NOT NULL, status TEXT NOT NULL,
      digest_count INTEGER NOT NULL, total_items INTEGER NOT NULL, summary_json TEXT NOT NULL
    );
    CREATE TABLE digest_shadow_previews (
      run_day TEXT NOT NULL, digest_id TEXT NOT NULL, recipient_redacted TEXT,
      subject TEXT NOT NULL, html TEXT NOT NULL, item_count INTEGER NOT NULL,
      watch_counts_json TEXT NOT NULL, PRIMARY KEY (run_day, digest_id)
    );
    CREATE TABLE digest_shadow_hold_states (
      run_day TEXT PRIMARY KEY, contract TEXT NOT NULL, evaluated_at TEXT NOT NULL,
      source_status TEXT NOT NULL, delivery_policy TEXT NOT NULL, cutoff_at TEXT NOT NULL,
      delivery_boundary_at TEXT NOT NULL, expires_at TEXT NOT NULL, state_json TEXT NOT NULL
    );
    CREATE TABLE digest_shadow_hold_overrides (
      run_day TEXT NOT NULL, digest_id TEXT NOT NULL, created_at TEXT NOT NULL,
      reason TEXT NOT NULL, PRIMARY KEY (run_day, digest_id)
    );
  `);
  const statement = (sql, args = []) => ({
    bind: (...next) => statement(sql, next),
    run: async () => sqlite.prepare(sql).run(...args),
    first: async () => sqlite.prepare(sql).get(...args) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    runs: {
      has: (runDay) => Boolean(sqlite.prepare("SELECT 1 FROM digest_shadow_runs WHERE run_day = ?").get(runDay)),
      get: (runDay) => sqlite.prepare("SELECT * FROM digest_shadow_runs WHERE run_day = ?").get(runDay),
    },
    prepare: (sql) => statement(sql),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        for (const item of statements) await item.run();
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
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
    ingestFn: async (_env, { fetchFn }) => {
      await fetchFn("https://example.test/1");
      await fetchFn("https://example.test/2");
      await fetchFn("https://example.test/3");
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

test("freshness cancellation is invocation-local and prevents late success or prewarm", async () => {
  const originalFetch = globalThis.fetch;
  const receipts = [];
  let timedOutSignal;
  let timedOutPrewarm = false;
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() { return sql.includes("SELECT v FROM ingest_state") ? { v: "2026-10-01" } : null; },
        async run() { return { success: true }; },
      };
    },
    async batch() { return []; },
  };
  const acquisitionFn = async (_env, _source, _runId, work) => {
    try {
      const result = await work();
      receipts.push("succeeded");
      return result;
    } catch (error) {
      receipts.push("failed");
      throw error;
    }
  };
  const stalledTransport = async (_url, { signal }) => {
    timedOutSignal = signal;
    assert.equal(globalThis.fetch, originalFetch);
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const timedOut = runBudgetedNoticeFreshness({ DB: db }, {
    budgetMs: 15,
    ingestFn: ingestNotices,
    acquisitionFn,
    fetchImpl: stalledTransport,
    prewarmFn: async () => { timedOutPrewarm = true; },
  });
  const overlapping = runBudgetedNoticeFreshness({ DB: db }, {
    budgetMs: 1_000,
    ingestFn: ingestNotices,
    fetchImpl: async () => Response.json([]),
    prewarmFn: async () => ({ warmed: 0 }),
  });
  assert.equal(globalThis.fetch, originalFetch);
  const [timedOutResult, overlappingResult] = await Promise.all([timedOut, overlapping]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timedOutResult.code, "FRESHNESS_TIME_BUDGET");
  assert.equal(overlappingResult.ok, true);
  assert.equal(timedOutSignal.aborted, true);
  assert.equal(timedOutPrewarm, false);
  assert.deepEqual(receipts, ["failed"]);
  assert.equal(globalThis.fetch, originalFetch);
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
  assert.equal(out.hold.source_status, "DARK_PERIOD");
  assert.equal(out.hold.delivery_policy, "ALL_DIGESTS_HELD");
  assert.ok(DB.runs.has(DAY));
  assert.notEqual(out.hold.source_status, "MISSING_RUN");
});

test("persistDigestShadowFailure finalizes FAILED over the started day", async () => {
  const DB = shadowDb();
  const ALERT_STATE = kv();
  const started = await persistDigestShadowStarted({ DB, ALERT_STATE }, { now: NOW });
  const out = await persistDigestShadowFailure(
    { DB, ALERT_STATE },
    new Error("rehearsal exploded before persist"),
    { now: NOW, invocationId: started.invocation_id },
  );
  assert.equal(out.status, DIGEST_SHADOW_ATTENTION);
  assert.equal(out.receipt.status, "FAILED");
  assert.equal(JSON.parse(DB.runs.get(DAY).summary_json).status, DIGEST_SHADOW_ATTENTION);
});

test("scheduled shadow ownership fences overlapping terminal writes and previews", async () => {
  const DB = shadowDb();
  const ALERT_STATE = kv();
  const env = { DB, ALERT_STATE };
  const firstId = "shadow:first";
  const secondId = "shadow:second";
  assert.equal((await persistDigestShadowStarted(env, { now: NOW, invocationId: firstId })).write_accepted, true);
  assert.equal((await persistDigestShadowStarted(env, { now: NOW, invocationId: secondId })).write_accepted, true);

  const staleFinal = await finalizeDigestShadowRun(env, readySummary(), {
    now: NOW,
    invocationId: firstId,
  });
  assert.equal(staleFinal.write_accepted, false);

  const accepted = await finalizeDigestShadowRun(env, {
    ...readySummary(),
    previews: [{ digest_id: "digest:second", item_count: 1 }],
    _rendered_previews: [{
      digest_id: "digest:second",
      recipient_redacted: "se***@example.test",
      subject: "Second",
      html: "<p data-digest-item=\"1\">Second</p>",
      item_count: 1,
      watch_counts: [],
    }],
  }, { now: NOW, invocationId: secondId });
  assert.equal(accepted.write_accepted, true);

  assert.equal((await persistDigestShadowFailure(env, new Error("late failure"), {
    now: NOW,
    invocationId: firstId,
  })).write_accepted, false);
  assert.equal((await persistDigestShadowStarted(env, {
    now: NOW,
    invocationId: "shadow:retry",
  })).write_accepted, false);

  const stored = JSON.parse(DB.runs.get(DAY).summary_json);
  assert.equal(stored.status, "READY");
  assert.equal(stored.phase, "finalized");
  assert.equal(stored.complete, true);
  assert.equal(stored.invocation_id, secondId);
  const preview = await DB.prepare("SELECT digest_id FROM digest_shadow_previews WHERE run_day = ?")
    .bind(DAY).first();
  assert.equal(preview.digest_id, "digest:second");
  assert.equal(JSON.parse(ALERT_STATE.store.get(`${DIGEST_SHADOW_LEDGER_PREFIX}${DAY}`)).status, "READY");
});

test("same scheduled owner resumes terminal side effects without replacing its result", async () => {
  const DB = shadowDb();
  const ALERT_STATE = kv();
  const env = { DB, ALERT_STATE };
  const invocationId = "shadow:resume";
  await persistDigestShadowStarted(env, { now: NOW, invocationId });
  await assert.rejects(finalizeDigestShadowRun(env, {
    ...readySummary(),
    _rendered_previews: [{
      digest_id: "digest:ready",
      recipient_redacted: "re***@example.test",
      subject: "Ready",
      html: "<p data-digest-item=\"1\">Ready</p>",
      item_count: 1,
      watch_counts: [],
    }],
  }, {
    now: NOW,
    invocationId,
    recordReceiptFn: async () => { throw new Error("receipt unavailable"); },
  }), /receipt unavailable/);
  assert.equal(JSON.parse(DB.runs.get(DAY).summary_json).status, "READY");
  assert.equal(JSON.parse(ALERT_STATE.store.get(`${DIGEST_SHADOW_LEDGER_PREFIX}${DAY}`)).status, "STARTED");

  const resumed = await persistDigestShadowFailure(env, new Error("finalizer interrupted"), {
    now: NOW,
    invocationId,
  });
  assert.equal(resumed.write_accepted, true);
  assert.equal(resumed.status, "READY");
  assert.equal(resumed.receipt.status, "READY");
  assert.equal(JSON.parse(DB.runs.get(DAY).summary_json).status, "READY");
  const preview = await DB.prepare("SELECT digest_id FROM digest_shadow_previews WHERE run_day = ?")
    .bind(DAY).first();
  assert.equal(preview.digest_id, "digest:ready");
});

test("runDigestShadow retains rendered previews for its private finalizer", async () => {
  const DB = shadowDb();
  const summary = await runDigestShadow({ DB, ALERT_STATE: kv() }, {
    now: NOW,
    ontologyDeltaCandidates: [],
    runAlertsFn: async () => ({
      results: [{
        previewId: "digest:preview",
        emailRedacted: "pr***@example.test",
        new: 1,
        forecasts: 0,
        preview: {
          subject: "Preview",
          html: '<p data-digest-item="1"><a href="https://cityscroll.org/item">Item</a></p><a href="https://cityscroll.org/unsubscribe">Unsubscribe</a><a href="https://cityscroll.org/context">Context</a>',
        },
      }],
    }),
  });
  assert.equal(summary._rendered_previews[0].digest_id, "digest:preview");
});

test("scheduled retry reuses event identity and resumes terminal side effects only", async () => {
  const DB = shadowDb();
  const ALERT_STATE = kv();
  const env = { DB, ALERT_STATE };
  const calls = { freshness: 0, shadow: 0 };
  let interrupt = true;
  const worker = scheduledWorker({
    overrides: {
      async persistDigestShadowStarted(_env, options) {
        return persistDigestShadowStarted(env, options);
      },
      async runBudgetedNoticeFreshness() {
        calls.freshness += 1;
        return { ok: true, degraded: false, result: {}, prewarm: {} };
      },
      async runDigestShadow() {
        calls.shadow += 1;
        return readySummary();
      },
      async finalizeDigestShadowRun(_env, summary, options) {
        return finalizeDigestShadowRun(env, summary, {
          ...options,
          recordReceiptFn: interrupt
            ? async () => { interrupt = false; throw new Error("isolate interrupted"); }
            : null,
        });
      },
      async persistDigestShadowFailure() { throw new Error("isolate stopped"); },
      refreshPublicSearchUsageSnapshot: async () => ({}),
    },
  });
  const scheduledTime = Date.parse(NOW);
  await worker.run("0 10 * * *", env, scheduledTime);
  assert.equal(JSON.parse(DB.runs.get(DAY).summary_json).status, "READY");
  await worker.run("0 10 * * *", env, scheduledTime);
  assert.deepEqual(calls, { freshness: 1, shadow: 1 });
  assert.equal(JSON.parse(ALERT_STATE.store.get(`${DIGEST_SHADOW_LEDGER_PREFIX}${DAY}`)).status, "READY");
});

test("stale scheduled finalizer cannot publish hold or receipt after owner replacement", async () => {
  const DB = shadowDb();
  const ALERT_STATE = kv();
  const invocationId = "shadow:stale";
  await persistDigestShadowStarted({ DB, ALERT_STATE }, { now: NOW, invocationId });
  const originalPrepare = DB.prepare.bind(DB);
  let releaseHold;
  let holdEntered;
  const holdGate = new Promise((resolve) => { releaseHold = resolve; });
  const entered = new Promise((resolve) => { holdEntered = resolve; });
  DB.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (!sql.includes("INSERT INTO digest_shadow_hold_states")) return statement;
    return {
      bind(...args) {
        const bound = statement.bind(...args);
        return {
          async run() {
            holdEntered();
            await holdGate;
            return bound.run();
          },
        };
      },
    };
  };
  const stale = finalizeDigestShadowRun({ DB, ALERT_STATE }, readySummary(), {
    now: NOW,
    invocationId,
  });
  await entered;
  const newer = {
    ...readySummary(),
    rebuild_run_id: "rebuild:new",
    rebuild_finalization_id: "rebuild-final:new",
  };
  await originalPrepare(`UPDATE digest_shadow_runs SET status = ?, summary_json = ? WHERE run_day = ?`)
    .bind("READY", JSON.stringify(newer), DAY).run();
  releaseHold();
  const result = await stale;
  assert.equal(result.write_accepted, false);
  assert.equal(JSON.parse(ALERT_STATE.store.get(
    `${DIGEST_SHADOW_LEDGER_PREFIX}${DAY}:${invocationId}:started`,
  )).status, "STARTED");
});

test("same scheduled owner cannot regress READY hold to STARTED", async () => {
  const DB = shadowDb();
  const ALERT_STATE = kv();
  const invocationId = "shadow:same-owner";
  await persistDigestShadowStarted({ DB, ALERT_STATE }, { now: NOW, invocationId });
  const started = JSON.parse(DB.runs.get(DAY).summary_json);
  const originalPrepare = DB.prepare.bind(DB);
  let release;
  let entered;
  let pause = true;
  const gate = new Promise((resolve) => { release = resolve; });
  const startedWrite = new Promise((resolve) => { entered = resolve; });
  DB.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (!sql.includes("INSERT INTO digest_shadow_hold_states")) return statement;
    return {
      bind(...args) {
        const bound = statement.bind(...args);
        return {
          async run() {
            if (pause) {
              pause = false;
              entered();
              await gate;
            }
            return bound.run();
          },
        };
      },
    };
  };
  const staleHold = recordDigestShadowHoldState(DB, started, { now: NOW, receiptStore: ALERT_STATE });
  await startedWrite;
  const ready = await finalizeDigestShadowRun({ DB, ALERT_STATE }, readySummary(), {
    now: NOW,
    invocationId,
  });
  assert.equal(ready.status, "READY");
  release();
  assert.equal((await staleHold).write_accepted, false);
  const row = await originalPrepare(
    "SELECT state_json FROM digest_shadow_hold_states WHERE run_day = ?",
  ).bind(DAY).first();
  assert.equal(JSON.parse(row.state_json).source_status, "READY");
});

test("same-owner STARTED receipt cannot overwrite READY revision", async () => {
  const DB = shadowDb();
  const ALERT_STATE = kv();
  const owner = "shadow:receipt-owner";
  const started = {
    ...buildDigestShadowStartedSummary(NOW),
    invocation_id: owner,
    result_revision: `${owner}:started`,
  };
  const ready = {
    ...readySummary(),
    invocation_id: owner,
    result_revision: "ready-revision",
  };
  await DB.prepare(`INSERT INTO digest_shadow_runs
    (run_day, ran_at, status, digest_count, total_items, summary_json) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(DAY, NOW, "READY", 1, 0, JSON.stringify(ready)).run();
  const put = ALERT_STATE.put.bind(ALERT_STATE);
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const startedWrite = new Promise((resolve) => { entered = resolve; });
  ALERT_STATE.put = async (name, value) => {
    if (name.endsWith(":started")) {
      entered();
      await gate;
    }
    return put(name, value);
  };
  const stale = recordDigestShadowReceipt({ ALERT_STATE }, started, new Date(NOW));
  await startedWrite;
  await recordDigestShadowReceipt({ ALERT_STATE }, ready, new Date(NOW));
  release();
  await stale;
  const snapshot = await digestWatchdogSnapshot({ DB, ALERT_STATE }, {
    now: new Date(NOW),
    deadlineHour: 24,
  });
  assert.equal(snapshot.shadow.status, "READY");
  assert.equal(snapshot.shadow.result_revision, "ready-revision");
});

test("D1-unavailable hold resolution ignores unverifiable mutable cache", async () => {
  const ALERT_STATE = kv();
  await ALERT_STATE.put("digest:shadow:hold:last-known:2026-10-05", JSON.stringify({
    run_day: DAY,
    source_status: "READY",
    delivery_policy: "ALL_DIGESTS_ELIGIBLE",
  }));
  const state = await resolveDigestShadowHold(null, {
    now: NOW,
    receiptStore: ALERT_STATE,
  });
  assert.equal(state.source_status, "HOLD_STORE_UNAVAILABLE");
  assert.equal(state.fail_policy, "fail_open_without_digest_scope");
});

test("watchdog selects the receipt owned by the current D1 summary", async () => {
  const DB = shadowDb();
  const ALERT_STATE = kv();
  const current = { ...readySummary(), invocation_id: "shadow:current" };
  await DB.prepare(`INSERT INTO digest_shadow_runs
    (run_day, ran_at, status, digest_count, total_items, summary_json) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(DAY, NOW, "READY", 1, 0, JSON.stringify(current)).run();
  await ALERT_STATE.put(`${DIGEST_SHADOW_LEDGER_PREFIX}${DAY}`, JSON.stringify({ status: "FAILED" }));
  await recordDigestShadowReceipt({ ALERT_STATE }, current, new Date(NOW));
  await ALERT_STATE.put(`${DIGEST_SHADOW_LEDGER_PREFIX}${DAY}`, JSON.stringify({ status: "FAILED" }));
  const snapshot = await digestWatchdogSnapshot({ DB, ALERT_STATE }, {
    now: new Date(NOW),
    deadlineHour: 24,
  });
  assert.equal(snapshot.shadow.status, "READY");
  assert.equal(snapshot.shadow.owner, "shadow:current");
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
      async persistDigestShadowStarted(_env, options) {
        order.push("started");
        return persistDigestShadowStarted(env, { ...options, now: NOW });
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
      async persistDigestShadowStarted(_env, options) {
        return persistDigestShadowStarted(env, { ...options, now: NOW });
      },
      async runBudgetedNoticeFreshness() {
        return { ok: true, degraded: false, result: {}, prewarm: {} };
      },
      runDigestShadow() { throw new Error("rehearsal exploded before persist"); },
      async persistDigestShadowFailure(_env, error, options) {
        return persistDigestShadowFailure(env, error, { ...options, now: NOW });
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

test("progress survives interruption and cannot overwrite finalized evidence", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("CREATE TABLE digest_shadow_runs (run_day TEXT PRIMARY KEY, status TEXT, summary_json TEXT)");
    sqlite.prepare("INSERT INTO digest_shadow_runs VALUES (?, 'STARTED', ?)")
      .run(DAY, JSON.stringify({ status: "STARTED", phase: "started", invocation_id: "shadow:owner" }));
    const db = { prepare: (sql) => ({ bind: (...args) => ({ run: async () => sqlite.prepare(sql).run(...args) }) }) };
    await recordDigestShadowProgress(
      db, DAY, { phase: "account_builds", evaluated_count: 20 }, NOW, "shadow:owner",
    );
    const read = () => JSON.parse(sqlite.prepare("SELECT summary_json FROM digest_shadow_runs").get().summary_json);
    assert.deepEqual(read(), {
      status: "STARTED",
      phase: "account_builds",
      invocation_id: "shadow:owner",
      evaluated_count: 20,
      progress_at: NOW,
    });
    await recordDigestShadowProgress(
      db, DAY, { phase: "wrong_owner", evaluated_count: 30 }, NOW, "shadow:stale",
    );
    assert.equal(read().phase, "account_builds");
    await recordDigestShadowProgress(
      db, DAY, { phase: "stale_static_writer", evaluated_count: 1 }, NOW, "shadow:owner",
    );
    assert.equal(read().evaluated_count, 20);
    sqlite.exec("UPDATE digest_shadow_runs SET status = 'READY'");
    await recordDigestShadowProgress(
      db, DAY, { phase: "late_writer", evaluated_count: 21 }, NOW, "shadow:owner",
    );
    assert.equal(read().phase, "account_builds");
  } finally { sqlite.close(); }
});
