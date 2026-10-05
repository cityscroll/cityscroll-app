import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  DIGEST_SHADOW_ATTENTION,
  buildDigestShadowFailureSummary,
  persistDigestShadowFailure,
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
          if (sql.includes("INSERT INTO digest_shadow_runs") || sql.includes("INSERT INTO digest_shadow_runs\n")) {
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
          if (sql.includes("DELETE FROM digest_shadow_previews")) return { success: true };
          if (sql.includes("digest_shadow_hold_states")) {
            holdStates.push(JSON.parse(this.args.at(-1)));
          }
          if (sql.includes("DELETE FROM digest_shadow_hold_overrides")) return { success: true };
          return { success: true };
        },
        async first() {
          if (sql.includes("FROM digest_shadow_runs WHERE run_day")) {
            return runs.get(this.args[0]) || null;
          }
          if (sql.includes("FROM digest_shadow_hold_overrides")) return null;
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

test("failure summary is a same-day run-level NEEDS_ATTENTION that stays fail-open", () => {
  const summary = buildDigestShadowFailureSummary(new Error("SODA 524 (source unavailable after 2 attempts)"), NOW);
  assert.equal(summary.run_day, DAY);
  assert.equal(summary.status, DIGEST_SHADOW_ATTENTION);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.affected_digest_ids, []);
  assert.equal(summary.redlines[0].digest_id, "run");
  assert.equal(summary.redlines[0].code, "render_error");
  assert.match(summary.failure.error, /SODA 524/);

  const hold = buildDigestShadowHoldState({ summary, now: `${DAY}T13:00:00.000Z` });
  assert.equal(hold.source_status, "REDLINES_WITHOUT_DIGEST_SCOPE");
  assert.equal(hold.delivery_policy, "ALL_DIGESTS_ELIGIBLE");
  assert.notEqual(hold.source_status, "MISSING_RUN");
});

test("recordDigestShadowReceipt persists FAILED when the rehearsal throws", async () => {
  const ALERT_STATE = kv();
  const now = new Date(NOW);
  const summary = buildDigestShadowFailureSummary(new Error("isolate wall time exhausted"), now);
  const receipt = await recordDigestShadowReceipt({ ALERT_STATE }, summary, now, new Error("isolate wall time exhausted"));
  assert.equal(receipt.status, "FAILED");
  assert.equal(receipt.complete, false);
  assert.match(receipt.error, /wall time/);
  assert.equal(JSON.parse(ALERT_STATE.store.get(`${DIGEST_SHADOW_LEDGER_PREFIX}${DAY}`)).status, "FAILED");
});

test("persistDigestShadowFailure writes D1 + hold + FAILED receipt so the day is not MISSING_RUN", async () => {
  const DB = shadowDb();
  const ALERT_STATE = kv();
  const out = await persistDigestShadowFailure(
    { DB, ALERT_STATE },
    new Error("upstream ingest hung until cron timeout"),
    { now: NOW },
  );
  assert.equal(out.run_day, DAY);
  assert.equal(out.status, DIGEST_SHADOW_ATTENTION);
  assert.equal(out.receipt.status, "FAILED");
  assert.equal(out.hold.delivery_policy, "ALL_DIGESTS_ELIGIBLE");
  assert.notEqual(out.hold.source_status, "MISSING_RUN");
  assert.ok(DB.runs.has(DAY), "same-day D1 run row must exist");
  const stored = JSON.parse(DB.runs.get(DAY).summary_json);
  assert.equal(stored.status, DIGEST_SHADOW_ATTENTION);
  assert.equal(stored.redlines[0].digest_id, "run");
});

test("0 10 cron runs the rehearsal before advisory ingest and records a failure when the rehearsal throws", async () => {
  const DB = shadowDb();
  const ALERT_STATE = kv();
  const env = { DB, ALERT_STATE };
  let releaseIngest;
  const hungIngest = new Promise((resolve) => { releaseIngest = resolve; });
  const worker = scheduledWorker({
    overrides: {
      runDigestShadow() { throw new Error("rehearsal exploded before persist"); },
      async persistDigestShadowFailure(_env, error) {
        return persistDigestShadowFailure(env, error, { now: NOW });
      },
      ingestNotices: () => hungIngest,
      prewarmNotices: async () => ({ warmed: 0 }),
      withWorkerAcquisitionReceipt: async (_env, _id, _runId, work) => work(),
      refreshPublicSearchUsageSnapshot: async () => ({}),
    },
  });

  await worker.run("0 10 * * *", env);
  assert.ok(worker.calls.includes("runDigestShadow"));
  assert.ok(
    worker.calls.indexOf("runDigestShadow") < worker.calls.indexOf("ingestNotices")
      || !worker.calls.includes("ingestNotices"),
    "rehearsal must not await ingest on the critical path",
  );
  assert.ok(DB.runs.has(DAY), "failure receipt must leave a same-day D1 row");
  assert.equal(JSON.parse(ALERT_STATE.store.get(`${DIGEST_SHADOW_LEDGER_PREFIX}${DAY}`)).status, "FAILED");

  releaseIngest({});
  await Promise.all(worker.pending);
});

test("0 10 cron still completes a successful rehearsal when advisory ingest fails afterward", async () => {
  const calls = [];
  const ALERT_STATE = kv();
  const env = { DB: shadowDb(), ALERT_STATE };
  const worker = scheduledWorker({
    overrides: {
      async runDigestShadow() {
        calls.push("runDigestShadow");
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
          affected_digest_ids: [],
        };
      },
      async recordDigestShadowReceipt(_env, summary) {
        calls.push("recordDigestShadowReceipt");
        return recordDigestShadowReceipt(env, summary, new Date(NOW));
      },
      async ingestNotices() {
        calls.push("ingestNotices");
        throw new Error("SODA 524 (source unavailable after 2 attempts)");
      },
      prewarmNotices: async () => {
        calls.push("prewarmNotices");
        return { warmed: 0 };
      },
      withWorkerAcquisitionReceipt: async (_env, _id, _runId, work) => work(),
      refreshPublicSearchUsageSnapshot: async () => ({}),
    },
  });

  await worker.run("0 10 * * *", env);
  await Promise.all(worker.pending);

  assert.deepEqual(
    calls.filter((name) => name === "runDigestShadow" || name === "recordDigestShadowReceipt" || name === "ingestNotices"),
    ["runDigestShadow", "recordDigestShadowReceipt", "ingestNotices"],
  );
  assert.equal(JSON.parse(ALERT_STATE.store.get(`${DIGEST_SHADOW_LEDGER_PREFIX}${DAY}`)).status, "READY");
  assert.ok(worker.errors.some((args) => args.join(" ").includes("SODA 524")));
});
