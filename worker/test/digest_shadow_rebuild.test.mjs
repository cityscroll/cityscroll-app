import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDigestShadowRebuild,
  handleDigestShadowRebuildQueueMessage,
  normalizeDigestShadowRebuildScope,
} from "../src/digest_shadow_rebuild.mjs";

const NOW = new Date("2026-09-21T14:00:00.000Z");

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async first() {
    if (this.sql.includes("UPDATE digest_shadow_rebuild_items") && this.sql.includes("RETURNING attempt_count")) {
      const [startedAt, runId, digestId] = this.args;
      const item = this.db.items.get(`${runId}:${digestId}`);
      if (!item || !new Set(["queued", "running"]).has(item.status)) return null;
      item.status = "running";
      item.attempt_count += 1;
      item.started_at = startedAt;
      item.error = null;
      return { attempt_count: item.attempt_count };
    }
    if (this.sql.includes("FROM digest_shadow_rebuild_items")) {
      const items = [...this.db.items.values()].filter((item) => item.run_id === this.args[0]);
      if (this.sql.includes("COUNT(*)")) return { total: items.length,
        completed: items.filter((item) => item.status === "complete").length,
        failed: items.filter((item) => item.status === "failed").length };
      if (this.sql.includes("digest_id >")) return items.filter((item) => item.digest_id > this.args[1])
        .sort((a, b) => a.digest_id.localeCompare(b.digest_id))[0] || null;
      return items.find((item) => item.digest_id === this.args[1]) || null;
    }
    if (this.sql.includes("digest_shadow_rebuild_runs")) return this.db.runs.get(this.args[0]) || null;
    if (this.sql.includes("FROM digest_shadow_runs")) return this.db.mainRuns.get(this.args[0]) || null;
    return null;
  }

  async all() {
    if (this.sql.includes("digest_shadow_rebuild_items")) {
      return { results: [...this.db.items.values()].filter((item) => item.run_id === this.args[0])
        .map(({ result_json, job_json, ...item }) => ({ ...item, result_available: result_json != null })) };
    }
    return { results: [] };
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO digest_shadow_rebuild_runs")) {
      const [run_id, run_day, requested_digest_ids_json, base_summary_json, created_at, updated_at] = this.args;
      this.db.runs.set(run_id, {
        run_id, run_day, requested_digest_ids_json, base_summary_json, status: "queued", total_count: 0,
        completed_count: 0, failed_count: 0, receipt_json: null, error: null, created_at, updated_at,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT OR IGNORE INTO digest_shadow_rebuild_items")) {
      const [run_id, digest_id, job_json] = this.args;
      if (!this.db.items.has(`${run_id}:${digest_id}`)) {
        this.db.items.set(`${run_id}:${digest_id}`, {
          run_id, digest_id, job_json, status: "queued", attempt_count: 0,
          result_json: null, error: null, started_at: null, completed_at: null,
        });
      }
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO digest_shadow_runs")) {
      const [run_day, ran_at, status, digest_count, total_items, summary_json] = this.args;
      const expectedSummary = this.args.at(-1);
      const current = this.db.mainRuns.get(run_day);
      if (!current || current.summary_json === expectedSummary) {
        this.db.mainRuns.set(run_day, { run_day, ran_at, status, digest_count, total_items, summary_json });
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (this.sql.includes("DELETE FROM digest_shadow_previews")) {
      const [runDay, digestId, ownerDay, finalizationId] = this.args;
      const summary = JSON.parse(this.db.mainRuns.get(ownerDay)?.summary_json || "null");
      const changed = summary?.rebuild_finalization_id === finalizationId
        ? Number(this.db.previews.delete(`${runDay}:${digestId}`))
        : 0;
      return { success: true, meta: { changes: changed } };
    }
    if (this.sql.includes("INSERT INTO digest_shadow_previews")) {
      if (this.sql.includes("json_each")) {
        const [runId, runDay, finalizationId] = this.args;
        const summary = JSON.parse(this.db.mainRuns.get(runDay)?.summary_json || "null");
        if (summary?.rebuild_finalization_id !== finalizationId) return { meta: { changes: 0 } };
        for (const item of this.db.items.values()) {
          if (item.run_id !== runId || item.status !== "complete") continue;
          const result = JSON.parse(item.result_json || "null");
          if (!result?.preview) continue;
          const id = result.previewId || result.sub || result.watch || "unknown";
          const metadata = summary.previews.find((p) => p.digest_id === id);
          if (metadata) this.db.previews.set(`${runDay}:${id}`, { ...metadata,
            run_day: runDay, html: result.preview.html || "", watch_counts_json: JSON.stringify(metadata.watch_counts) });
        }
        return { meta: { changes: 1 } };
      }

      const [run_day, digest_id, recipient_redacted, subject, html, item_count, watch_counts_json,
        ownerDay, finalizationId] = this.args;
      const summary = JSON.parse(this.db.mainRuns.get(ownerDay)?.summary_json || "null");
      if (summary?.rebuild_finalization_id === finalizationId) {
        this.db.previews.set(`${run_day}:${digest_id}`, {
          run_day, digest_id, recipient_redacted, subject, html, item_count, watch_counts_json,
        });
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (this.sql.includes("UPDATE digest_shadow_rebuild_items")) {
      if (this.sql.includes("SET status = 'complete'")) {
        const [resultJson, completedAt, runId, digestId, attemptCount] = this.args;
        const item = this.db.items.get(`${runId}:${digestId}`);
        if (!item || item.status !== "running" || item.attempt_count !== attemptCount) {
          return { success: true, meta: { changes: 0 } };
        }
        item.status = "complete";
        item.result_json = resultJson;
        item.completed_at = completedAt;
      } else {
        const [error, runId, digestId, attemptCount] = this.args;
        const item = this.db.items.get(`${runId}:${digestId}`);
        if (!item || item.status !== "running" || item.attempt_count !== attemptCount) {
          return { success: true, meta: { changes: 0 } };
        }
        item.status = "queued";
        item.error = error;
      }
      return { success: true, meta: { changes: 1 } };
    }
    if (this.sql.includes("UPDATE digest_shadow_rebuild_runs")) {
      const run = this.db.runs.get(this.args.at(-1));
      if (!run) return { success: true };
      if (this.sql.includes("MAX(completed_count")) {
        const [completed, failed, updatedAt, status, receiptJson, error] = this.args;
        run.completed_count = Math.max(run.completed_count, completed);
        run.failed_count = Math.max(run.failed_count, failed);
        run.updated_at = updatedAt;
        if (!new Set(["complete", "failed"]).has(run.status)) {
          run.status = status;
          run.receipt_json = receiptJson;
          run.error = error;
        }
        return { success: true, meta: { changes: 1 } };
      }
      const fields = this.sql.match(/SET ([\s\S]+?)\s+WHERE/)[1].split(", ").map((field) => field.split(" = ")[0]);
      fields.forEach((field, index) => { run[field] = this.args[index]; });
      return { success: true, meta: { changes: 1 } };
    }
    return { success: true, meta: { changes: 1 } };
  }
}

class FakeD1 {
  constructor() {
    this.runs = new Map();
    this.items = new Map();
    this.mainRuns = new Map();
    this.previews = new Map();
  }

  prepare(sql) { return new Statement(this, sql); }

  async batch(statements) {
    for (const statement of statements) await statement.run();
    return statements.map(() => ({ success: true }));
  }
}

function kv() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) || null; },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); },
  };
}

test("rebuild scope is bounded and normalized", () => {
  assert.deepEqual(normalizeDigestShadowRebuildScope([" digest:two ", "digest:one", "digest:two"]), ["digest:one", "digest:two"]);
  assert.equal(normalizeDigestShadowRebuildScope(undefined), null);
  assert.throws(() => normalizeDigestShadowRebuildScope([]), /non-empty/);
  assert.throws(() => normalizeDigestShadowRebuildScope(["run"]), /invalid id/);
});

test("queue messages checkpoint one digest and complete the run with a receipt", async () => {
  const DB = new FakeD1();
  const queueMessages = [];
  const env = { DB, ALERT_STATE: kv(), DIGEST_SHADOW_QUEUE: { async send(message) { queueMessages.push(message); } } };
  const created = await createDigestShadowRebuild(env, { affectedDigestIds: ["digest:one"], now: NOW });
  assert.equal(created.status, "queued");
  assert.deepEqual(queueMessages, [{ type: "expand", run_id: created.run_id }]);

  DB.items.set(`${created.run_id}:digest:one`, {
    run_id: created.run_id,
    digest_id: "digest:one",
    job_json: JSON.stringify({ type: "sub", key: "sub:missing" }),
    status: "queued",
    attempt_count: 0,
    result_json: null,
    error: null,
    started_at: null,
    completed_at: null,
  });
  const run = DB.runs.get(created.run_id);
  run.status = "running";
  run.total_count = 1;

  const status = await handleDigestShadowRebuildQueueMessage(env, {
    body: { type: "digest", run_id: created.run_id, digest_id: "digest:one" },
  }, { now: NOW });
  assert.equal(status.status, "complete");
  assert.equal(status.completed_count, 1);
  assert.equal(DB.items.get(`${created.run_id}:digest:one`).status, "complete");
  assert.equal(status.receipt.status, "PARTIAL");
  assert.equal(status.receipt.rebuild_run_id, created.run_id);
});

test("an interrupted scoped rebuild resumes after its checkpoint without retrying the completed digest", async () => {
  const DB = new FakeD1();
  const env = { DB, ALERT_STATE: kv(), DIGEST_SHADOW_QUEUE: { async send() {} } };
  const created = await createDigestShadowRebuild(env, {
    affectedDigestIds: ["digest:one", "digest:two", "digest:three"],
    now: NOW,
  });
  const run = DB.runs.get(created.run_id);
  run.status = "running";
  run.total_count = 3;
  for (const digestId of ["digest:one", "digest:two", "digest:three"]) {
    DB.items.set(`${created.run_id}:${digestId}`, {
      run_id: created.run_id,
      digest_id: digestId,
      job_json: JSON.stringify({ type: "sub", key: `missing:${digestId}` }),
      status: "queued",
      attempt_count: 0,
      result_json: null,
      error: null,
      started_at: null,
      completed_at: null,
    });
  }

  // The worker limit ends this invocation after the first per-digest queue item.
  const interrupted = await handleDigestShadowRebuildQueueMessage(env, {
    type: "digest", run_id: created.run_id, digest_id: "digest:one",
  }, { now: NOW });
  assert.equal(interrupted.status, "running");
  assert.equal(interrupted.completed_count, 1);
  assert.equal(DB.items.get(`${created.run_id}:digest:one`).status, "complete");
  assert.equal(interrupted.receipt.complete, false);
  assert.equal(interrupted.receipt.status, "PARTIAL");

  // Re-invoking the same run sees the checkpoint and is idempotent for digest:one.
  const resumed = await handleDigestShadowRebuildQueueMessage(env, {
    type: "digest", run_id: created.run_id, digest_id: "digest:one",
  }, { now: NOW });
  assert.equal(DB.items.get(`${created.run_id}:digest:one`).attempt_count, 1);
  for (const digestId of ["digest:two"]) {
    await handleDigestShadowRebuildQueueMessage(env, {
      type: "digest", run_id: created.run_id, digest_id: digestId,
    }, { now: NOW });
  }

  const finished = await handleDigestShadowRebuildQueueMessage(env, {
    type: "digest", run_id: created.run_id, digest_id: "digest:three",
  }, { now: NOW });
  assert.equal(finished.status, "complete");
  assert.equal(finished.complete, true);
  assert.equal(finished.completed_count, 3);
  assert.equal(finished.receipt.complete, false);
  assert.equal(finished.receipt.status, "PARTIAL");
});

// The result checkpoint and final aggregate are separate writes. A retry must complete
// the aggregate even when the per-digest result was already durable before the failure.
test("replayed completed item repairs interrupted finalization", async () => {
  const DB = new FakeD1();
  const env = { DB, ALERT_STATE: kv(), DIGEST_SHADOW_QUEUE: { async send() {} } };
  const created = await createDigestShadowRebuild(env, { affectedDigestIds: ["digest:one"], now: NOW });
  const run = DB.runs.get(created.run_id);
  run.status = "running";
  run.total_count = 1;
  DB.items.set(`${created.run_id}:digest:one`, {
    run_id: created.run_id, digest_id: "digest:one",
    job_json: JSON.stringify({ type: "sub", key: "sub:missing" }),
    status: "queued", attempt_count: 0, result_json: null, error: null,
  });
  const batch = DB.batch.bind(DB);
  let failed = false;
  DB.batch = async (statements) => {
    if (!failed) { failed = true; throw new Error("finalization interrupted"); }
    return batch(statements);
  };
  const message = { type: "digest", run_id: created.run_id, digest_id: "digest:one" };
  await assert.rejects(handleDigestShadowRebuildQueueMessage(env, message, { now: NOW }), /finalization interrupted/);
  assert.equal(DB.items.get(`${created.run_id}:digest:one`).status, "complete");
  const finished = await handleDigestShadowRebuildQueueMessage(env, message, { now: NOW });
  assert.equal(finished.status, "complete");
  assert.equal(finished.receipt.status, "PARTIAL");
  assert.equal(DB.items.get(`${created.run_id}:digest:one`).attempt_count, 1);
});

test("a stale failed attempt cannot revert a newer completed rebuild item", async () => {
  const DB = new FakeD1();
  const env = { DB, ALERT_STATE: kv(), DIGEST_SHADOW_QUEUE: { async send() {} } };
  const created = await createDigestShadowRebuild(env, { affectedDigestIds: ["digest:one"], now: NOW });
  const run = DB.runs.get(created.run_id);
  run.status = "running";
  run.total_count = 1;
  DB.items.set(`${created.run_id}:digest:one`, {
    run_id: created.run_id, digest_id: "digest:one",
    job_json: JSON.stringify({ type: "sub", key: "sub:one" }),
    status: "queued", attempt_count: 0, result_json: null, error: null,
  });
  let finishSuccess;
  let finishFailure;
  let entered = 0;
  let bothEntered;
  const enteredGate = new Promise((resolve) => { bothEntered = resolve; });
  const markEntered = () => {
    entered += 1;
    if (entered === 2) bothEntered();
  };
  const successGate = new Promise((resolve) => { finishSuccess = resolve; });
  const failureGate = new Promise((_, reject) => { finishFailure = reject; });
  const message = { type: "digest", run_id: created.run_id, digest_id: "digest:one" };
  const fails = handleDigestShadowRebuildQueueMessage(env, message, {
    now: NOW,
    runTargetFn: async () => {
      markEntered();
      return failureGate;
    },
  });
  const succeeds = handleDigestShadowRebuildQueueMessage(env, message, {
    now: NOW,
    runTargetFn: async () => {
      markEntered();
      await successGate;
      return { previews: [], redlines: [], upstream_incidents: [], _rendered_previews: [] };
    },
  });
  await enteredGate;
  finishSuccess();
  const completed = await succeeds;
  finishFailure(new Error("duplicate failed late"));
  await assert.rejects(fails, /duplicate failed late/);
  assert.equal(completed.status, "complete");
  assert.equal(DB.items.get(`${created.run_id}:digest:one`).status, "complete");
  assert.equal(DB.runs.get(created.run_id).completed_count, 1);
  assert.equal(DB.runs.get(created.run_id).status, "complete");
});

test("a stale successful attempt cannot overwrite a newer completed rebuild item", async () => {
  const DB = new FakeD1();
  const env = { DB, ALERT_STATE: kv(), DIGEST_SHADOW_QUEUE: { async send() {} } };
  const created = await createDigestShadowRebuild(env, { affectedDigestIds: ["digest:one"], now: NOW });
  const run = DB.runs.get(created.run_id);
  run.status = "running";
  run.total_count = 1;
  DB.items.set(`${created.run_id}:digest:one`, {
    run_id: created.run_id, digest_id: "digest:one",
    job_json: JSON.stringify({ type: "sub", key: "sub:one" }),
    status: "queued", attempt_count: 0, result_json: null, error: null,
  });
  let finishStale;
  let finishCurrent;
  let entered = 0;
  let bothEntered;
  const enteredGate = new Promise((resolve) => { bothEntered = resolve; });
  const markEntered = () => {
    entered += 1;
    if (entered === 2) bothEntered();
  };
  const staleGate = new Promise((resolve) => { finishStale = resolve; });
  const currentGate = new Promise((resolve) => { finishCurrent = resolve; });
  const message = { type: "digest", run_id: created.run_id, digest_id: "digest:one" };
  const stale = handleDigestShadowRebuildQueueMessage(env, message, {
    now: NOW,
    runTargetFn: async () => {
      markEntered();
      await staleGate;
      return { marker: "stale", previews: [], redlines: [], upstream_incidents: [], _rendered_previews: [] };
    },
  });
  const current = handleDigestShadowRebuildQueueMessage(env, message, {
    now: NOW,
    runTargetFn: async () => {
      markEntered();
      await currentGate;
      return { marker: "current", previews: [], redlines: [], upstream_incidents: [], _rendered_previews: [] };
    },
  });
  await enteredGate;
  finishCurrent();
  const completed = await current;
  finishStale();
  const staleResult = await stale;
  assert.equal(completed.status, "complete");
  assert.equal(staleResult.status, "complete");
  assert.equal(JSON.parse(DB.items.get(`${created.run_id}:digest:one`).result_json).marker, "current");
  assert.equal(JSON.parse(DB.mainRuns.get(run.run_day).summary_json).rebuild_run_id, created.run_id);
});

test("rebuild aggregate CAS rejects a newer scheduled result without side effects", async () => {
  const DB = new FakeD1();
  const ALERT_STATE = kv();
  const env = { DB, ALERT_STATE, DIGEST_SHADOW_QUEUE: { async send() {} } };
  const created = await createDigestShadowRebuild(env, { affectedDigestIds: ["digest:one"], now: NOW });
  const run = DB.runs.get(created.run_id);
  run.status = "running";
  run.total_count = 1;
  const started = {
    run_day: run.run_day, status: "STARTED", phase: "started", complete: false,
    invocation_id: "shadow:old", previews: [], redlines: [], upstream_incidents: [],
  };
  DB.mainRuns.set(run.run_day, {
    run_day: run.run_day,
    status: "STARTED",
    summary_json: JSON.stringify(started),
  });
  DB.items.set(`${created.run_id}:digest:one`, {
    run_id: created.run_id, digest_id: "digest:one",
    job_json: JSON.stringify({ type: "sub", key: "sub:one" }),
    status: "queued", attempt_count: 0, result_json: null, error: null,
  });
  const batch = DB.batch.bind(DB);
  DB.batch = async (statements) => {
    const newer = {
      run_day: run.run_day, status: "READY", phase: "finalized", complete: true,
      invocation_id: "shadow:new", previews: [{ digest_id: "digest:new", item_count: 1 }],
      redlines: [], upstream_incidents: [],
    };
    DB.mainRuns.set(run.run_day, {
      run_day: run.run_day,
      status: "READY",
      summary_json: JSON.stringify(newer),
    });
    DB.previews.set(`${run.run_day}:digest:new`, { run_day: run.run_day, digest_id: "digest:new" });
    DB.batch = batch;
    return batch(statements);
  };

  const finished = await handleDigestShadowRebuildQueueMessage(env, {
    type: "digest", run_id: created.run_id, digest_id: "digest:one",
  }, {
    now: NOW,
    runTargetFn: async () => ({
      previews: [{ digest_id: "digest:one", item_count: 1 }],
      redlines: [],
      upstream_incidents: [],
      _rendered_previews: [{
        digest_id: "digest:one", recipient_redacted: "on***@example.test", subject: "One",
        html: "<p>One</p>", item_count: 1, watch_counts: [],
      }],
    }),
  });
  const stored = JSON.parse(DB.mainRuns.get(run.run_day).summary_json);
  assert.equal(finished.status, "failed");
  assert.match(finished.error, /changed during rebuild finalization/);
  assert.equal(stored.invocation_id, "shadow:new");
  assert.equal(stored.rebuild_run_id, undefined);
  assert.equal(DB.previews.has(`${run.run_day}:digest:new`), true);
  assert.equal(DB.previews.has(`${run.run_day}:digest:one`), false);
  assert.equal(ALERT_STATE.values.size, 0);
});

test("scoped rebuild cannot certify an incomplete STARTED base", async () => {
  const DB = new FakeD1();
  const env = { DB, ALERT_STATE: kv(), DIGEST_SHADOW_QUEUE: { async send() {} } };
  DB.mainRuns.set("2026-09-21", {
    run_day: "2026-09-21",
    status: "STARTED",
    summary_json: JSON.stringify({
      run_day: "2026-09-21",
      status: "STARTED",
      phase: "started",
      complete: false,
      previews: [],
      redlines: [],
      upstream_incidents: [],
    }),
  });
  const created = await createDigestShadowRebuild(env, { affectedDigestIds: ["digest:one"], now: NOW });
  const run = DB.runs.get(created.run_id);
  run.status = "running";
  run.total_count = 1;
  DB.items.set(`${created.run_id}:digest:one`, {
    run_id: created.run_id, digest_id: "digest:one",
    job_json: JSON.stringify({ type: "sub", key: "sub:one" }),
    status: "queued", attempt_count: 0, result_json: null, error: null,
  });
  const finished = await handleDigestShadowRebuildQueueMessage(env, {
    type: "digest", run_id: created.run_id, digest_id: "digest:one",
  }, {
    now: NOW,
    runTargetFn: async () => ({
      previewId: "digest:one", skipped: "no-new",
    }),
  });
  const summary = JSON.parse(DB.mainRuns.get(run.run_day).summary_json);
  assert.equal(finished.receipt.status, "PARTIAL");
  assert.equal(summary.status, "NEEDS_ATTENTION");
  assert.equal(summary.phase, "partial_rebuild");
  assert.equal(summary.complete, false);
  assert.equal(summary.rebuild_complete, false);
  assert.equal(summary.redlines.at(-1).code, "rebuild_partial_incomplete_base");
});

test("partial aggregate retry resumes side effects after receipt interruption", async () => {
  const DB = new FakeD1();
  const ALERT_STATE = kv();
  DB.mainRuns.set("2026-09-21", {
    run_day: "2026-09-21",
    status: "STARTED",
    summary_json: JSON.stringify({
      run_day: "2026-09-21", status: "STARTED", phase: "started", complete: false,
      previews: [], redlines: [], upstream_incidents: [],
    }),
  });
  let interrupt = true;
  const put = ALERT_STATE.put.bind(ALERT_STATE);
  ALERT_STATE.put = async (key, value) => {
    if (interrupt && key.startsWith("ops:digest:shadow:")) {
      interrupt = false;
      throw new Error("receipt interrupted");
    }
    return put(key, value);
  };
  const env = { DB, ALERT_STATE, DIGEST_SHADOW_QUEUE: { async send() {} } };
  const created = await createDigestShadowRebuild(env, { affectedDigestIds: ["digest:one"], now: NOW });
  const run = DB.runs.get(created.run_id);
  run.status = "running";
  run.total_count = 1;
  DB.items.set(`${created.run_id}:digest:one`, {
    run_id: created.run_id, digest_id: "digest:one",
    job_json: JSON.stringify({ type: "sub", key: "sub:one" }),
    status: "queued", attempt_count: 0, result_json: null, error: null,
  });
  const message = { type: "digest", run_id: created.run_id, digest_id: "digest:one" };
  await assert.rejects(handleDigestShadowRebuildQueueMessage(env, message, {
    now: NOW,
    runTargetFn: async () => ({ previewId: "digest:one", skipped: "no-new" }),
  }), /receipt interrupted/);
  const stored = JSON.parse(DB.mainRuns.get(run.run_day).summary_json);
  assert.equal(stored.rebuild_complete, false);
  assert.ok(stored.rebuild_finalization_id);
  const resumed = await handleDigestShadowRebuildQueueMessage(env, message, { now: NOW });
  assert.equal(resumed.status, "complete");
  assert.equal(resumed.receipt.status, "PARTIAL");
});

test("concurrent finalizers converge on one accepted rebuild result", async () => {
  const DB = new FakeD1();
  const env = { DB, ALERT_STATE: kv(), DIGEST_SHADOW_QUEUE: { async send() {} } };
  const created = await createDigestShadowRebuild(env, {
    affectedDigestIds: ["digest:one", "digest:two"],
    now: NOW,
  });
  const run = DB.runs.get(created.run_id);
  run.status = "running";
  run.total_count = 2;
  for (const digestId of ["digest:one", "digest:two"]) {
    DB.items.set(`${created.run_id}:${digestId}`, {
      run_id: created.run_id, digest_id: digestId,
      job_json: JSON.stringify({ type: "sub", key: digestId }),
      status: "complete", attempt_count: 1,
      result_json: JSON.stringify({ previewId: digestId, skipped: "no-new" }),
      error: null,
    });
  }
  const [first, second] = await Promise.all([
    handleDigestShadowRebuildQueueMessage(env, {
      type: "digest", run_id: created.run_id, digest_id: "digest:one",
    }, { now: NOW }),
    handleDigestShadowRebuildQueueMessage(env, {
      type: "digest", run_id: created.run_id, digest_id: "digest:two",
    }, { now: NOW }),
  ]);
  assert.equal(first.status, "complete");
  assert.equal(second.status, "complete");
  const stored = JSON.parse(DB.mainRuns.get(run.run_day).summary_json);
  assert.equal(stored.rebuild_run_id, created.run_id);
  assert.ok(stored.rebuild_finalization_id);
});

test("rebuild preserves upstream degradation in terminal evidence", async () => {
  const DB = new FakeD1();
  const env = { DB, ALERT_STATE: kv(), DIGEST_SHADOW_QUEUE: { async send() {} } };
  DB.mainRuns.set("2026-09-21", {
    run_day: "2026-09-21",
    status: "READY",
    summary_json: JSON.stringify({
      run_day: "2026-09-21", status: "READY", phase: "finalized", complete: true,
      previews: [], redlines: [], upstream_incidents: [],
    }),
  });
  const created = await createDigestShadowRebuild(env, { affectedDigestIds: ["digest:one"], now: NOW });
  const run = DB.runs.get(created.run_id);
  run.status = "running";
  run.total_count = 1;
  DB.items.set(`${created.run_id}:digest:one`, {
    run_id: created.run_id, digest_id: "digest:one",
    job_json: JSON.stringify({ type: "sub", key: "sub:one" }),
    status: "queued", attempt_count: 0, result_json: null, error: null,
  });
  const finished = await handleDigestShadowRebuildQueueMessage(env, {
    type: "digest", run_id: created.run_id, digest_id: "digest:one",
  }, {
    now: NOW,
    runTargetFn: async () => ({
      previewId: "digest:one",
      error: "SODA 524 after retry budget",
    }),
  });
  const summary = JSON.parse(DB.mainRuns.get(run.run_day).summary_json);
  assert.equal(finished.receipt.status, "DEGRADED");
  assert.equal(summary.status, "DEGRADED_UPSTREAM");
  assert.deepEqual(summary.upstream_sources_unavailable, ["soda"]);
});

test("scoped rebuild retains an unchanged historical zero redline", async () => {
  const DB = new FakeD1();
  const ALERT_STATE = kv();
  ALERT_STATE.values.set("digest:daylog:2026-09-20", JSON.stringify({
    day: "2026-09-20",
    entries: [{ day: "2026-09-20", id: "sub:quiet", noticeCount: 3, forecasts: 0 }],
  }));
  DB.mainRuns.set("2026-09-21", {
    run_day: "2026-09-21",
    status: "NEEDS_ATTENTION",
    summary_json: JSON.stringify({
      run_day: "2026-09-21", status: "NEEDS_ATTENTION", phase: "finalized", complete: true,
      previews: [], upstream_incidents: [],
      redlines: [{ code: "historical_watch_zero", digest_id: "digest:quiet" }],
    }),
  });
  const env = { DB, ALERT_STATE, DIGEST_SHADOW_QUEUE: { async send() {} } };
  const created = await createDigestShadowRebuild(env, {
    affectedDigestIds: ["digest:quiet"],
    now: NOW,
  });
  const run = DB.runs.get(created.run_id);
  run.status = "running";
  run.total_count = 1;
  DB.items.set(`${created.run_id}:digest:quiet`, {
    run_id: created.run_id, digest_id: "digest:quiet",
    job_json: JSON.stringify({ type: "sub", key: "sub:quiet" }),
    status: "queued", attempt_count: 0, result_json: null, error: null,
  });
  await handleDigestShadowRebuildQueueMessage(env, {
    type: "digest", run_id: created.run_id, digest_id: "digest:quiet",
  }, {
    now: NOW,
    runTargetFn: async () => ({
      sub: "sub:quiet", previewId: "digest:quiet", found: 0, new: 0, forecasts: 0,
      action: "heartbeat", emailRedacted: "qu***@example.test",
      preview: {
        subject: "Quiet",
        html: '<a href="https://cityscroll.org/context">Context</a><a href="https://cityscroll.org/unsubscribe">Unsubscribe</a>',
        listUnsubscribe: "<https://cityscroll.org/unsubscribe>",
      },
    }),
  });
  const summary = JSON.parse(DB.mainRuns.get(run.run_day).summary_json);
  assert.equal(summary.status, "NEEDS_ATTENTION");
  assert.equal(summary.redlines.filter((item) => item.code === "historical_watch_zero").length, 1);
  assert.equal(summary.redlines.some((item) => item.code === "aggregate_count_collapse"), false);
});

test("full rebuild reuses scheduled history validation and evaluated count", async () => {
  const DB = new FakeD1();
  const ALERT_STATE = kv();
  ALERT_STATE.values.set("digest:daylog:2026-09-20", JSON.stringify({
    day: "2026-09-20",
    entries: [{ day: "2026-09-20", id: "sub:quiet", noticeCount: 3, forecasts: 0 }],
  }));
  DB.mainRuns.set("2026-09-21", {
    run_day: "2026-09-21",
    status: "STARTED",
    summary_json: JSON.stringify({
      run_day: "2026-09-21", status: "STARTED", phase: "started", complete: false,
      previews: [], redlines: [], upstream_incidents: [],
    }),
  });
  const env = { DB, ALERT_STATE, DIGEST_SHADOW_QUEUE: { async send() {} } };
  const created = await createDigestShadowRebuild(env, { now: NOW });
  const run = DB.runs.get(created.run_id);
  run.status = "running";
  run.total_count = 1;
  DB.items.set(`${created.run_id}:digest:quiet`, {
    run_id: created.run_id, digest_id: "digest:quiet",
    job_json: JSON.stringify({ type: "sub", key: "sub:quiet" }),
    status: "queued", attempt_count: 0, result_json: null, error: null,
  });
  const finished = await handleDigestShadowRebuildQueueMessage(env, {
    type: "digest", run_id: created.run_id, digest_id: "digest:quiet",
  }, {
    now: NOW,
    runTargetFn: async () => ({
      sub: "sub:quiet",
      previewId: "digest:quiet",
      kind: "subscription",
      found: 0,
      new: 0,
      forecasts: 0,
      action: "heartbeat",
      emailRedacted: "qu***@example.test",
      preview: {
        subject: "Quiet",
        html: '<a href="https://cityscroll.org/context">Context</a><a href="https://cityscroll.org/unsubscribe">Unsubscribe</a>',
        listUnsubscribe: "<https://cityscroll.org/unsubscribe>",
      },
    }),
  });
  const summary = JSON.parse(DB.mainRuns.get(run.run_day).summary_json);
  assert.equal(finished.receipt.status, "DEGRADED");
  assert.equal(summary.evaluated_count, 1);
  assert.equal(summary.complete, true);
  assert.equal(summary.rebuild_complete, true);
  assert.ok(summary.redlines.some((finding) => finding.code === "historical_watch_zero"));
});

test("rebuild evaluation remains frozen when queue work crosses UTC midnight", async () => {
  const DB = new FakeD1();
  DB.mainRuns.set("2026-09-21", {
    run_day: "2026-09-21",
    status: "STARTED",
    summary_json: JSON.stringify({
      run_day: "2026-09-21", status: "STARTED", phase: "started", complete: false,
      previews: [], redlines: [], upstream_incidents: [],
    }),
  });
  const ALERT_STATE = kv();
  const env = { DB, ALERT_STATE, DIGEST_SHADOW_QUEUE: { async send() {} } };
  const created = await createDigestShadowRebuild(env, { now: NOW });
  const run = DB.runs.get(created.run_id);
  run.status = "running";
  run.total_count = 1;
  DB.items.set(`${created.run_id}:digest:one`, {
    run_id: created.run_id, digest_id: "digest:one",
    job_json: JSON.stringify({ type: "sub", key: "sub:one" }),
    status: "queued", attempt_count: 0, result_json: null, error: null,
  });
  let evaluatedAt;
  const nextDay = new Date("2026-09-22T00:05:00.000Z");
  const finished = await handleDigestShadowRebuildQueueMessage(env, {
    type: "digest", run_id: created.run_id, digest_id: "digest:one",
  }, {
    now: nextDay,
    runTargetFn: async (_env, _job, at) => {
      evaluatedAt = new Date(at).toISOString();
      return { previewId: "digest:one", skipped: "no-new" };
    },
  });
  const summary = JSON.parse(DB.mainRuns.get(run.run_day).summary_json);
  assert.equal(evaluatedAt, NOW.toISOString());
  assert.equal(summary.run_day, "2026-09-21");
  assert.equal(summary.ran_at, NOW.toISOString());
  assert.equal(finished.receipt.day, "2026-09-21");
  assert.equal(ALERT_STATE.values.has("ops:digest:shadow:2026-09-22"), false);
});

test("rebuild failed targets cannot produce READY evidence", async () => {
  const DB = new FakeD1();
  const env = { DB, ALERT_STATE: kv(), DIGEST_SHADOW_QUEUE: { async send() {} } };
  const created = await createDigestShadowRebuild(env, {
    affectedDigestIds: ["digest:one", "digest:missing"],
    now: NOW,
  });
  const run = DB.runs.get(created.run_id);
  run.status = "running";
  run.total_count = 2;
  DB.items.set(`${created.run_id}:digest:one`, {
    run_id: created.run_id, digest_id: "digest:one",
    job_json: JSON.stringify({ type: "sub", key: "sub:one" }),
    status: "queued", attempt_count: 0, result_json: null, error: null,
  });
  DB.items.set(`${created.run_id}:digest:missing`, {
    run_id: created.run_id, digest_id: "digest:missing",
    job_json: JSON.stringify({ type: "missing", digest_id: "digest:missing" }),
    status: "failed", attempt_count: 0, result_json: null, error: "digest-not-found",
  });
  const finished = await handleDigestShadowRebuildQueueMessage(env, {
    type: "digest", run_id: created.run_id, digest_id: "digest:one",
  }, {
    now: NOW,
    runTargetFn: async () => ({
      previewId: "digest:one", skipped: "no-new",
    }),
  });
  const summary = JSON.parse(DB.mainRuns.get(run.run_day).summary_json);
  assert.equal(finished.status, "failed");
  assert.notEqual(finished.receipt.status, "READY");
  assert.equal(summary.status, "NEEDS_ATTENTION");
  assert.equal(summary.redlines[0].code, "rebuild_target_failed");
  assert.equal(summary.redlines[0].digest_id, "digest:missing");
});

// Execute the production SQL, including transaction/fence semantics, with a small
// transport ceiling. Unrelated private previews must never cross that boundary.
async function sqliteRecoveryFixture() {
  const { DatabaseSync } = await import('node:sqlite');
  const { readFileSync } = await import('node:fs');
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0014_digest_shadow.sql', '0015_digest_shadow_hold.sql',
    '0034_digest_shadow_rebuild.sql', '0035_digest_shadow_rebuild_base.sql']) {
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  const metrics = { maxBytes: 0, limit: 160_000 };
  function checked(value) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    metrics.maxBytes = Math.max(metrics.maxBytes, bytes);
    assert.ok(bytes <= metrics.limit, `D1 transport ${bytes} exceeds ${metrics.limit}`);
    return value;
  }
  const DB = {
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async first() { return checked(sqlite.prepare(sql).get(...args) || null); },
        async all() { return checked({ results: sqlite.prepare(sql).all(...args) }); },
        async run() { const out = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(out.changes) } }; },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const out = []; for (const statement of statements) out.push(await statement.run()); sqlite.exec('COMMIT'); return out; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  const env = { DB, ALERT_STATE: kv(), DIGEST_SHADOW_QUEUE: { async send() {} } };
  const created = await createDigestShadowRebuild(env, { now: NOW });
  sqlite.prepare("UPDATE digest_shadow_rebuild_runs SET status = 'running', total_count = 25 WHERE run_id = ?").run(created.run_id);
  const insert = sqlite.prepare(`INSERT INTO digest_shadow_rebuild_items
    (run_id, digest_id, job_json, status, result_json) VALUES (?, ?, '{}', ?, ?)`);
  for (let i = 0; i < 24; i++) {
    const id = `digest:${String(i).padStart(3, '0')}`;
    insert.run(created.run_id, id, 'complete', JSON.stringify({ previewId: id, new: 1,
      preview: { subject: 'Preview', html: '<li data-digest-item="1">item</li><a href="https://cityscroll.org/">Context</a><a href="https://api.cityscroll.org/unsubscribe?x=1">Unsubscribe</a>' + ' '.repeat(40_000) } }));
  }
  insert.run(created.run_id, 'digest:last', 'queued', null);
  return { sqlite, DB, env, runId: created.run_id, metrics };
}

test('recovery status and one-item progress do not transport unrelated preview bodies', async () => {
  const f = await sqliteRecoveryFixture();
  try {
    const { readDigestShadowRebuildStatus } = await import('../src/digest_shadow_rebuild.mjs');
    const status = await readDigestShadowRebuildStatus(f.DB, f.runId);
    assert.equal(status.items.length, 25);
    assert.equal(status.items[0].result_available, true);
    assert.equal(status.items[0].result_json, undefined);
    f.sqlite.prepare("UPDATE digest_shadow_rebuild_items SET status = 'queued' WHERE digest_id = 'digest:000'").run();
    const out = await handleDigestShadowRebuildQueueMessage(f.env, { type: 'digest', run_id: f.runId, digest_id: 'digest:last' },
      { now: NOW, runTargetFn: async () => ({ previewId: 'digest:last', skipped: 'no-new' }) });
    assert.equal(out.completed_count, 24);
    assert.equal(out.status, 'running');
  } finally { f.sqlite.close(); }
});

test('terminal validation pages legacy raw results and copies original bodies in SQL', async () => {
  const f = await sqliteRecoveryFixture();
  try {
    const original = f.sqlite.prepare("SELECT result_json FROM digest_shadow_rebuild_items WHERE digest_id = 'digest:000'").get().result_json;
    const out = await handleDigestShadowRebuildQueueMessage(f.env, { type: 'digest', run_id: f.runId, digest_id: 'digest:last' },
      { now: NOW, runTargetFn: async () => ({ previewId: 'digest:last', skipped: 'no-new' }) });
    assert.equal(out.status, 'complete');
    const stored = JSON.parse(f.sqlite.prepare('SELECT summary_json FROM digest_shadow_runs').get().summary_json);
    assert.equal(stored.status, 'READY');
    assert.equal(stored.evaluated_count, 25);
    assert.equal(stored.total_items, 24);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM digest_shadow_previews').get().n, 24);
    assert.equal(f.sqlite.prepare("SELECT html FROM digest_shadow_previews WHERE digest_id = 'digest:000'").get().html,
      JSON.parse(original).preview.html);
    assert.ok(f.metrics.maxBytes < f.metrics.limit);
  } finally { f.sqlite.close(); }
});

test('compact validation preserves real content, history, aggregate and ontology detectors', async () => {
  const { compactDigestShadowResult, buildDigestShadowSummary } = await import('../src/digest_shadow.mjs');
  const results = [
    { previewId: 'one', new: 2, preview: { subject: 'Preview', html: '<li data-digest-item="1">one</li><a href="#missing">bad</a>' } },
    { previewId: 'two', new: 0, found: 0, preview: { subject: 'Empty', html: '<a href="https://api.cityscroll.org/unsubscribe?x=1">Unsubscribe</a>' } },
    { previewId: 'three', skipped: 'no-new', selection_funnel: { source_candidates: 2, watermark_fresh: 0 } },
    { previewId: 'four', error: 'SODA 524 after retry budget' },
  ];
  const history = [{ day: '2026-09-20', entries: [{ id: 'two', new: 4 }], totalNotices: 100 }];
  const ontologyDelta = { contract: 'test', candidate_count: 1, emitted_count: 1, emitted: [{ type: 'event' }], receipts: [{ state: 'candidate' }] };
  const inline = buildDigestShadowSummary({ run: { results }, history, now: NOW, ontologyDelta });
  const compact = results.map(compactDigestShadowResult);
  const streamed = buildDigestShadowSummary({ run: { results: compact.map((r) => r.result) }, history, now: NOW, ontologyDelta,
    renderedContentRedlines: compact.flatMap((r) => r.contentRedlines) });
  delete inline._rendered_previews;
  delete streamed._rendered_previews;
  assert.deepEqual(streamed, inline);
  assert.ok(streamed.redlines.some((r) => r.code === 'count_list_mismatch'));
  assert.ok(streamed.redlines.some((r) => r.code === 'broken_digest_link'));
  assert.equal(streamed.upstream_incidents.length, 1);
});

test('dead letter finalizes a stranded item and is idempotent after completion', async () => {
  const f = await sqliteRecoveryFixture();
  try {
    const { handleDigestShadowRebuildDeadLetter } = await import('../src/digest_shadow_rebuild.mjs');
    f.sqlite.prepare("UPDATE digest_shadow_rebuild_items SET status = 'running', attempt_count = 4 WHERE digest_id = 'digest:last'").run();
    const message = { type: 'digest', run_id: f.runId, digest_id: 'digest:last' };
    const out = await handleDigestShadowRebuildDeadLetter(f.env, message, { now: NOW });
    assert.equal(out.status, 'failed');
    assert.equal(out.failed_count, 1);
    const summary = f.sqlite.prepare('SELECT summary_json FROM digest_shadow_runs').get().summary_json;
    assert.equal(JSON.parse(summary).status, 'NEEDS_ATTENTION');
    await handleDigestShadowRebuildDeadLetter(f.env, message, { now: NOW });
    assert.equal(f.sqlite.prepare('SELECT summary_json FROM digest_shadow_runs').get().summary_json, summary);
  } finally { f.sqlite.close(); }
});

test('dead letter rejects an unsupported finalize message', async () => {
  const f = await sqliteRecoveryFixture();
  try {
    const { handleDigestShadowRebuildDeadLetter } = await import('../src/digest_shadow_rebuild.mjs');
    await assert.rejects(
      handleDigestShadowRebuildDeadLetter(f.env, { type: 'finalize', run_id: f.runId }, { now: NOW }),
      /unknown digest shadow dead letter/,
    );
  } finally { f.sqlite.close(); }
});

test('dead letter retries aggregate failure without erasing a completed checkpoint', async () => {
  const f = await sqliteRecoveryFixture();
  try {
    const { handleDigestShadowRebuildDeadLetter } = await import('../src/digest_shadow_rebuild.mjs');
    f.sqlite.prepare("UPDATE digest_shadow_rebuild_items SET status = 'complete', result_json = ? WHERE digest_id = 'digest:last'")
      .run(JSON.stringify({ previewId: 'digest:last', skipped: 'no-new' }));
    const batch = f.DB.batch;
    f.DB.batch = async () => { throw new Error('durable store interrupted'); };
    const message = { type: 'digest', run_id: f.runId, digest_id: 'digest:last' };
    await assert.rejects(handleDigestShadowRebuildDeadLetter(f.env, message, { now: NOW }), /durable store interrupted/);
    assert.equal(f.sqlite.prepare("SELECT status FROM digest_shadow_rebuild_items WHERE digest_id = 'digest:last'").get().status, 'complete');
    f.DB.batch = batch;
    assert.equal((await handleDigestShadowRebuildDeadLetter(f.env, message, { now: NOW })).status, 'complete');
    assert.equal((await handleDigestShadowRebuildDeadLetter(f.env, message, { now: NOW })).status, 'complete');
  } finally { f.sqlite.close(); }
});

test('expansion exhaustion cannot certify a partial manifest', async () => {
  const f = await sqliteRecoveryFixture();
  try {
    const { handleDigestShadowRebuildDeadLetter } = await import('../src/digest_shadow_rebuild.mjs');
    f.sqlite.prepare("UPDATE digest_shadow_rebuild_runs SET status = 'dispatching' WHERE run_id = ?").run(f.runId);
    const out = await handleDigestShadowRebuildDeadLetter(f.env, { type: 'expand', run_id: f.runId }, { now: NOW });
    assert.equal(out.status, 'failed');
    const summary = JSON.parse(f.sqlite.prepare('SELECT summary_json FROM digest_shadow_runs').get().summary_json);
    assert.equal(summary.complete, false);
    assert.ok(summary.redlines.some((r) => r.code === 'rebuild_manifest_incomplete'));
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM digest_shadow_rebuild_items WHERE status = 'complete'").get().n, 24);
  } finally { f.sqlite.close(); }
});

test('stale reconciliation recovers lost messages and retries finalization independently', async () => {
  const f = await sqliteRecoveryFixture();
  try {
    const { reconcileStaleDigestShadowRebuilds } = await import('../src/digest_shadow_rebuild.mjs');
    const later = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);
    assert.deepEqual(await reconcileStaleDigestShadowRebuilds(f.env, { now: NOW }), []);
    const [out] = await reconcileStaleDigestShadowRebuilds(f.env, { now: later });
    assert.equal(out.status, 'failed');
    assert.equal(out.failed_count, 1);
    assert.deepEqual(await reconcileStaleDigestShadowRebuilds(f.env, { now: later }), []);
  } finally { f.sqlite.close(); }
});

test('real static rebuild keeps private HTML in D1 and out of logs without sending or advancing watermarks', async () => {
  const f = await sqliteRecoveryFixture();
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = [];
  const requests = [];
  const sentinel = 'PRIVATE-PREVIEW-SENTINEL';
  try {
    f.sqlite.prepare("UPDATE digest_shadow_rebuild_items SET status = 'queued' WHERE digest_id = 'digest:000'").run();
    f.sqlite.prepare("UPDATE digest_shadow_rebuild_items SET digest_id = 'watch:fixture', job_json = ? WHERE digest_id = 'digest:last'")
      .run(JSON.stringify({ type: 'static', watch: { id: 'fixture', label: 'Fixture', email: 'fixture-recipient', q: 'fixture' } }));
    f.env.ALERTS_LIVE = 'true';
    f.env.RESEND_API_KEY = 'test-not-a-key';
    f.env.QUEUE_DIGESTS = 'true';
    await f.env.ALERT_STATE.put('seen:fixture', JSON.stringify(['old-id']));
    const before = await f.env.ALERT_STATE.get('seen:fixture');
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      assert.match(String(url), /data.cityofnewyork.us/);
      return Response.json([{ request_id: '20260921001', start_date: '2026-09-21', short_title: sentinel, agency_name: 'Fixture' }]);
    };
    console.log = (...args) => logs.push(args.join(' '));
    await handleDigestShadowRebuildQueueMessage(f.env,
      { type: 'digest', run_id: f.runId, digest_id: 'watch:fixture' }, { now: NOW });
    const result = JSON.parse(f.sqlite.prepare("SELECT result_json FROM digest_shadow_rebuild_items WHERE digest_id = 'watch:fixture'").get().result_json);
    assert.match(result.preview.html, /PRIVATE-PREVIEW-SENTINEL/);
    assert.equal(logs.some((line) => line.includes(sentinel) || line.includes('fixture-recipient')), false);
    assert.equal(requests.length, 1);
    assert.equal(await f.env.ALERT_STATE.get('seen:fixture'), before);
    assert.equal([...f.env.ALERT_STATE.values.keys()].some((key) => /^(sendcount:|lastsent:|digest:daylog:)/.test(key)), false);
  } finally { globalThis.fetch = originalFetch; console.log = originalLog; f.sqlite.close(); }
});

test('mismatched preview identity cannot be promoted under another digest', async () => {
  const f = await sqliteRecoveryFixture();
  try {
    const out = await handleDigestShadowRebuildQueueMessage(f.env,
      { type: 'digest', run_id: f.runId, digest_id: 'digest:last' }, { now: NOW,
        runTargetFn: async () => ({ previewId: 'another-digest', new: 0, preview: { subject: 'Wrong', html: '' } }) });
    assert.equal(JSON.parse(f.sqlite.prepare('SELECT summary_json FROM digest_shadow_runs').get().summary_json).status, 'NEEDS_ATTENTION');
    assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM digest_shadow_previews WHERE digest_id = 'another-digest'").get().n, 0);
  } finally { f.sqlite.close(); }
});

test('SQL preview promotion is fenced against a newer summary committed before the batch', async () => {
  const f = await sqliteRecoveryFixture();
  try {
    const batch = f.DB.batch;
    const newer = JSON.stringify({ status: 'READY', complete: true, result_revision: 'newer', previews: [] });
    f.DB.batch = async (statements) => {
      f.sqlite.prepare("INSERT INTO digest_shadow_runs VALUES (?, ?, 'READY', 0, 0, ?)").run('2026-09-21', NOW.toISOString(), newer);
      f.DB.batch = batch;
      return batch(statements);
    };
    const out = await handleDigestShadowRebuildQueueMessage(f.env,
      { type: 'digest', run_id: f.runId, digest_id: 'digest:last' }, { now: NOW,
        runTargetFn: async () => ({ previewId: 'digest:last', skipped: 'no-new' }) });
    assert.equal(out.status, 'failed');
    assert.equal(f.sqlite.prepare('SELECT summary_json FROM digest_shadow_runs').get().summary_json, newer);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM digest_shadow_previews').get().n, 0);
  } finally { f.sqlite.close(); }
});

test('late dead letter cannot cancel a newer active claim', async () => {
  const f = await sqliteRecoveryFixture();
  try {
    const { handleDigestShadowRebuildDeadLetter } = await import('../src/digest_shadow_rebuild.mjs');
    f.sqlite.prepare("UPDATE digest_shadow_rebuild_items SET status = 'running', attempt_count = 5, started_at = ? WHERE digest_id = 'digest:last'").run(NOW.toISOString());
    const message = { type: 'digest', run_id: f.runId, digest_id: 'digest:last' };
    await assert.rejects(handleDigestShadowRebuildDeadLetter(f.env, message, { now: NOW }), /claim still active/);
    assert.equal(f.sqlite.prepare("SELECT status FROM digest_shadow_rebuild_items WHERE digest_id = 'digest:last'").get().status, 'running');
    f.sqlite.prepare("UPDATE digest_shadow_rebuild_items SET status = 'complete', result_json = ? WHERE digest_id = 'digest:last'")
      .run(JSON.stringify({ previewId: 'digest:last', skipped: 'no-new' }));
    assert.equal((await handleDigestShadowRebuildDeadLetter(f.env, message, { now: NOW })).status, 'complete');
  } finally { f.sqlite.close(); }
});

test('failed full manifest retains aggregate validation through a later scoped repair', async () => {
  const f = await sqliteRecoveryFixture();
  try {
    const { handleDigestShadowRebuildDeadLetter } = await import('../src/digest_shadow_rebuild.mjs');
    await f.env.ALERT_STATE.put('digest:daylog:2026-09-20', JSON.stringify({ day: '2026-09-20', totalNotices: 200 }));
    await handleDigestShadowRebuildDeadLetter(f.env,
      { type: 'digest', run_id: f.runId, digest_id: 'digest:last' }, { now: NOW });
    let summary = JSON.parse(f.sqlite.prepare('SELECT summary_json FROM digest_shadow_runs').get().summary_json);
    assert.ok(summary.redlines.some((r) => r.code === 'aggregate_count_collapse'));
    const repair = await createDigestShadowRebuild(f.env, { affectedDigestIds: ['digest:last'], now: NOW });
    f.sqlite.prepare("UPDATE digest_shadow_rebuild_runs SET status = 'running', total_count = 1 WHERE run_id = ?").run(repair.run_id);
    f.sqlite.prepare("INSERT INTO digest_shadow_rebuild_items (run_id, digest_id, job_json, status) VALUES (?, 'digest:last', '{}', 'queued')").run(repair.run_id);
    await handleDigestShadowRebuildQueueMessage(f.env,
      { type: 'digest', run_id: repair.run_id, digest_id: 'digest:last' }, { now: NOW,
        runTargetFn: async () => ({ previewId: 'digest:last', skipped: 'no-new' }) });
    summary = JSON.parse(f.sqlite.prepare('SELECT summary_json FROM digest_shadow_runs').get().summary_json);
    assert.equal(summary.status, 'NEEDS_ATTENTION');
    assert.ok(summary.redlines.some((r) => r.code === 'aggregate_count_collapse'));
  } finally { f.sqlite.close(); }
});

test('interrupted expansion resumes its sealed manifest and finalizes only after dispatch', async () => {
  const f = await sqliteRecoveryFixture();
  try {
    f.sqlite.exec('DELETE FROM digest_shadow_rebuild_items');
    f.sqlite.prepare("UPDATE digest_shadow_rebuild_runs SET status = 'queued', total_count = 0 WHERE run_id = ?").run(f.runId);
    const sent = [];
    f.env.DIGEST_SHADOW_QUEUE.send = async (message) => {
      if (sent.length === 1) throw new Error('dispatch interrupted');
      sent.push(message);
    };
    const expand = { type: 'expand', run_id: f.runId };
    await assert.rejects(handleDigestShadowRebuildQueueMessage(f.env, expand, { now: NOW }), /dispatch interrupted/);
    assert.equal(f.sqlite.prepare('SELECT status FROM digest_shadow_rebuild_runs').get().status, 'dispatching');
    const complete = await handleDigestShadowRebuildQueueMessage(f.env, sent[0], { now: NOW,
      runTargetFn: async () => ({ previewId: sent[0].digest_id, skipped: 'no-new' }) });
    assert.equal(complete.status, 'dispatching');
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM digest_shadow_runs').get().n, 0);
    const pending = [];
    f.env.DIGEST_SHADOW_QUEUE.send = async (message) => { pending.push(message); };
    // Retry must use the durable manifest, without rediscovering subscriptions.
    f.env.SUBS = { async list() { throw new Error('must not rediscover manifest'); } };
    await handleDigestShadowRebuildQueueMessage(f.env, expand, { now: NOW });
    assert.ok(pending.length > 0);
    assert.equal(pending.some((message) => message.digest_id === sent[0].digest_id), false);
    for (const message of pending) await handleDigestShadowRebuildQueueMessage(f.env, message, { now: NOW,
      runTargetFn: async () => ({ previewId: message.digest_id, skipped: 'no-new' }) });
    assert.equal(f.sqlite.prepare('SELECT status FROM digest_shadow_rebuild_runs').get().status, 'complete');
  } finally { f.sqlite.close(); }
});
