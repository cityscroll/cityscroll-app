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
    if (this.sql.includes("digest_shadow_rebuild_runs")) return this.db.runs.get(this.args[0]) || null;
    if (this.sql.includes("FROM digest_shadow_runs")) return this.db.mainRuns.get(this.args[0]) || null;
    return null;
  }

  async all() {
    if (this.sql.includes("digest_shadow_rebuild_items")) {
      return { results: [...this.db.items.values()].filter((item) => item.run_id === this.args[0]) };
    }
    return { results: [] };
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO digest_shadow_rebuild_runs")) {
      const [run_id, run_day, requested_digest_ids_json, created_at, updated_at] = this.args;
      this.db.runs.set(run_id, {
        run_id, run_day, requested_digest_ids_json, status: "queued", total_count: 0,
        completed_count: 0, failed_count: 0, receipt_json: null, error: null, created_at, updated_at,
      });
      return { success: true };
    }
    if (this.sql.includes("INSERT OR IGNORE INTO digest_shadow_rebuild_items")) {
      const [run_id, digest_id, job_json] = this.args;
      if (!this.db.items.has(`${run_id}:${digest_id}`)) {
        this.db.items.set(`${run_id}:${digest_id}`, {
          run_id, digest_id, job_json, status: "queued", attempt_count: 0,
          result_json: null, error: null, started_at: null, completed_at: null,
        });
      }
      return { success: true };
    }
    if (this.sql.includes("INSERT INTO digest_shadow_runs")) {
      const [run_day, ran_at, status, digest_count, total_items, summary_json] = this.args;
      this.db.mainRuns.set(run_day, { run_day, ran_at, status, digest_count, total_items, summary_json });
      return { success: true };
    }
    if (this.sql.includes("DELETE FROM digest_shadow_previews")) {
      this.db.previews.delete(`${this.args[0]}:${this.args[1]}`);
      return { success: true };
    }
    if (this.sql.includes("INSERT INTO digest_shadow_previews")) {
      const [run_day, digest_id, recipient_redacted, subject, html, item_count, watch_counts_json] = this.args;
      this.db.previews.set(`${run_day}:${digest_id}`, {
        run_day, digest_id, recipient_redacted, subject, html, item_count, watch_counts_json,
      });
      return { success: true };
    }
    if (this.sql.includes("UPDATE digest_shadow_rebuild_items")) {
      const item = this.db.items.get(`${this.args.at(-2)}:${this.args.at(-1)}`);
      if (!item) return { success: true };
      if (this.sql.includes("SET status = 'running'")) {
        item.status = "running";
        item.attempt_count += 1;
        item.started_at = this.args[0];
      } else if (this.sql.includes("SET status = 'complete'")) {
        item.status = "complete";
        item.result_json = this.args[0];
        item.completed_at = this.args[1];
      } else {
        if (item.status !== "running") return { success: true };
        item.status = "queued";
        item.error = this.args[0];
      }
      return { success: true };
    }
    if (this.sql.includes("UPDATE digest_shadow_rebuild_runs")) {
      const run = this.db.runs.get(this.args.at(-1));
      if (!run) return { success: true };
      if (this.sql.includes("MAX(completed_count")) {
        const [completed, failed, updatedAt, status, receiptJson] = this.args;
        run.completed_count = Math.max(run.completed_count, completed);
        run.failed_count = Math.max(run.failed_count, failed);
        run.updated_at = updatedAt;
        if (!new Set(["complete", "failed"]).has(run.status)) {
          run.status = status;
          run.receipt_json = receiptJson;
        }
        return { success: true };
      }
      const fields = this.sql.match(/SET ([\s\S]+?)\s+WHERE/)[1].split(", ").map((field) => field.split(" = ")[0]);
      fields.forEach((field, index) => { run[field] = this.args[index]; });
      return { success: true };
    }
    return { success: true };
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
  assert.equal(status.receipt.status, "READY");
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
  assert.equal(finished.receipt.complete, true);
  assert.equal(finished.receipt.status, "READY");
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
  assert.equal(finished.receipt.status, "READY");
  assert.equal(DB.items.get(`${created.run_id}:digest:one`).attempt_count, 1);
});

test("a failed duplicate cannot revert a concurrently completed rebuild item", async () => {
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
  const succeeds = handleDigestShadowRebuildQueueMessage(env, message, {
    now: NOW,
    runTargetFn: async () => {
      markEntered();
      await successGate;
      return { previews: [], redlines: [], upstream_incidents: [], _rendered_previews: [] };
    },
  });
  const fails = handleDigestShadowRebuildQueueMessage(env, message, {
    now: NOW,
    runTargetFn: async () => {
      markEntered();
      return failureGate;
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

test("rebuild finalizes a STARTED base as terminal READY evidence", async () => {
  const DB = new FakeD1();
  const env = { DB, ALERT_STATE: kv(), DIGEST_SHADOW_QUEUE: { async send() {} } };
  const created = await createDigestShadowRebuild(env, { affectedDigestIds: ["digest:one"], now: NOW });
  const run = DB.runs.get(created.run_id);
  run.status = "running";
  run.total_count = 1;
  DB.mainRuns.set(run.run_day, {
    run_day: run.run_day,
    status: "STARTED",
    summary_json: JSON.stringify({
      run_day: run.run_day,
      status: "STARTED",
      phase: "started",
      complete: false,
      previews: [],
      redlines: [],
      upstream_incidents: [],
    }),
  });
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
      status: "READY", ok: true, previews: [], redlines: [], upstream_incidents: [], _rendered_previews: [],
    }),
  });
  const summary = JSON.parse(DB.mainRuns.get(run.run_day).summary_json);
  assert.equal(finished.receipt.status, "READY");
  assert.equal(summary.status, "READY");
  assert.equal(summary.phase, "finalized");
  assert.equal(summary.complete, true);
  assert.equal(summary.rebuild_complete, true);
});

test("rebuild preserves upstream degradation in terminal evidence", async () => {
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
  const finished = await handleDigestShadowRebuildQueueMessage(env, {
    type: "digest", run_id: created.run_id, digest_id: "digest:one",
  }, {
    now: NOW,
    runTargetFn: async () => ({
      status: "DEGRADED_UPSTREAM",
      ok: true,
      previews: [],
      redlines: [],
      upstream_incidents: [{
        code: "upstream_unavailable",
        digest_id: "digest:one",
        evidence: { source: "soda" },
      }],
      _rendered_previews: [],
    }),
  });
  const summary = JSON.parse(DB.mainRuns.get(run.run_day).summary_json);
  assert.equal(finished.receipt.status, "DEGRADED");
  assert.equal(summary.status, "DEGRADED_UPSTREAM");
  assert.deepEqual(summary.upstream_sources_unavailable, ["soda"]);
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
      status: "READY", ok: true, previews: [], redlines: [], upstream_incidents: [], _rendered_previews: [],
    }),
  });
  const summary = JSON.parse(DB.mainRuns.get(run.run_day).summary_json);
  assert.equal(finished.status, "failed");
  assert.notEqual(finished.receipt.status, "READY");
  assert.equal(summary.status, "NEEDS_ATTENTION");
  assert.equal(summary.redlines[0].code, "rebuild_target_failed");
  assert.equal(summary.redlines[0].digest_id, "digest:missing");
});
