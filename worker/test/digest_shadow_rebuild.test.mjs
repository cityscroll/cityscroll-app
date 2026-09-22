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
    if (this.sql.includes("UPDATE digest_shadow_rebuild_items")) {
      const item = this.db.items.get(`${this.args.at(-2)}:${this.args.at(-1)}`);
      if (!item) return { success: true };
      if (this.sql.includes("status = 'running'")) {
        item.status = "running";
        item.attempt_count += 1;
        item.started_at = this.args[0];
      } else if (this.sql.includes("status = 'complete'")) {
        item.status = "complete";
        item.result_json = this.args[0];
        item.completed_at = this.args[1];
      } else {
        item.status = "queued";
        item.error = this.args[0];
      }
      return { success: true };
    }
    if (this.sql.includes("UPDATE digest_shadow_rebuild_runs")) {
      const run = this.db.runs.get(this.args.at(-1));
      if (!run) return { success: true };
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
