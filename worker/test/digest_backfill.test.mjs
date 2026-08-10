import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import worker from "../src/worker.mjs";
import { readOwedBacklog } from "../src/owed_backlog.mjs";
import { deriveBackfillTestData } from "./helpers/digest_backfill_fixture.mjs";
import {
  DELIVERED_LAND_ITEM_ID,
  FIRST_PAYLOAD_MANIFEST,
  runFirstPayloadBackfill,
} from "../src/digest_backfill.mjs";

const migration = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");

function d1FromSqlite(sqlite) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          const statement = sqlite.prepare(sql);
          return {
            run() {
              const result = statement.run(...params);
              return { meta: { changes: Number(result.changes || 0) } };
            },
            first() { return statement.get(...params) || null; },
            all() { return { results: statement.all(...params) }; },
          };
        },
        all() { return { results: sqlite.prepare(sql).all() }; },
        first() { return sqlite.prepare(sql).get() || null; },
      };
    },
    async batch(statements) { return statements.map((statement) => statement.run()); },
  };
}

class MockKV {
  constructor(values) { this.values = new Map(Object.entries(values)); }
  async list({ prefix = "" } = {}) {
    return {
      keys: [...this.values.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
    };
  }
  async get(name) { return this.values.get(name) || null; }
}

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const data = deriveBackfillTestData();
  const values = Object.fromEntries(data.subscriptions.map(({ key, record }) => [key, JSON.stringify(record)]));
  return { sqlite, DB: d1FromSqlite(sqlite), SUBS: new MockKV(values), data };
}

test("exact first payload is 45 owed rows plus one reconciled land tombstone and is idempotent", async () => {
  const { sqlite, DB, SUBS, data } = fixture();
  const first = await runFirstPayloadBackfill({ ...data, db: DB, subscriptions: data.subscriptions });
  const second = await runFirstPayloadBackfill({ ...data, db: DB, subscriptions: data.subscriptions });

  assert.equal(first.enqueued, 45);
  assert.equal(first.duplicates, 0);
  assert.equal(second.enqueued, 0);
  assert.equal(second.duplicates, 45);
  assert.deepEqual(first.backlog, { total_count: 46, owed_count: 45, delivered_count: 1 });
  assert.deepEqual(second.backlog, first.backlog);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items WHERE status = 'owed'").get().n, 45);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items WHERE status = 'delivered'").get().n, 1);
  assert.equal(sqlite.prepare("SELECT item_id FROM digest_outbox_items WHERE status = 'delivered'").get().item_id, DELIVERED_LAND_ITEM_ID);
  assert.equal(sqlite.prepare("SELECT delivered_at, owed_origin FROM digest_outbox_items WHERE item_id = ?").get(DELIVERED_LAND_ITEM_ID).delivered_at, "2026-08-10T15:31:15Z");
  assert.equal(sqlite.prepare("SELECT owed_origin, source_observed_at, first_owed_at, delivered_at FROM digest_outbox_items WHERE status = 'owed' LIMIT 1").get().owed_origin, "recovery-2026-08-10");
  assert.equal(sqlite.prepare("SELECT source_observed_at FROM digest_outbox_items WHERE status = 'owed' LIMIT 1").get().source_observed_at, "2026-08-10");
  assert.equal(sqlite.prepare("SELECT first_owed_at FROM digest_outbox_items WHERE status = 'owed' LIMIT 1").get().first_owed_at, "2026-08-10T16:00:00Z");
  assert.equal(sqlite.prepare("SELECT delivered_at FROM digest_outbox_items WHERE status = 'owed' LIMIT 1").get().delivered_at, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items WHERE lens = 'rules'").get().n, 25);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items WHERE lens = 'meetings'").get().n, 20);

  const panel = await readOwedBacklog({ DB, SUBS }, { now: "2026-08-10T16:05:00Z" });
  assert.equal(panel.summary.owed_count, 45);
  assert.equal(panel.summary.subscriber_count, 1);
  sqlite.close();
});

test("backfill refuses unreconciled land coverage before writing any row", async () => {
  const { sqlite, DB, data } = fixture();
  await assert.rejects(
    runFirstPayloadBackfill({ ...data, db: DB, subscriptions: data.subscriptions, deliveryEvidence: { reconciled: false } }),
    /not reconciled/,
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items").get().n, 0);
  sqlite.close();
});

test("guarded admin backfill path never crosses the send boundary", async () => {
  const { sqlite, DB, SUBS, data } = fixture();
  let sendCalls = 0;
  const env = {
    ADMIN_KEY: "secret",
    DB,
    SUBS,
    sendEmail() { sendCalls += 1; },
  };
  const response = await worker.fetch(new Request("https://w/admin/digest-backfill?key=secret", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      payload_id: data.payloadId,
      owner_email: data.ownerEmail,
      first_owed_at: data.firstOwedAt,
      delivery_evidence: data.deliveryEvidence,
      source_snapshots: data.sourceSnapshots,
    }),
  }), env, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).backlog.owed_count, 45);
  assert.equal(sendCalls, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items").get().n, 46);
  sqlite.close();
});

test("manifest remains the exact 25-rule plus 20-meeting request set", () => {
  assert.equal(FIRST_PAYLOAD_MANIFEST.rules.length, 25);
  assert.equal(FIRST_PAYLOAD_MANIFEST.meetings.length, 20);
  assert.equal(new Set(FIRST_PAYLOAD_MANIFEST.rules).size, 25);
  assert.equal(new Set(FIRST_PAYLOAD_MANIFEST.meetings).size, 20);
});
