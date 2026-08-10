import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import worker from "../src/worker.mjs";
import {
  OWED_BACKLOG_QUERY,
  buildOwedBacklogBody,
  readOwedBacklog,
  scheduledTimes,
} from "../src/owed_backlog.mjs";
import { handleAdminOwedBacklog, renderAdminStatsPage } from "../src/admin.mjs";

const migration = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");

function d1FromSqlite(db) {
  return {
    prepare(sql) {
      return {
        all: async () => ({ results: db.prepare(sql).all() }),
      };
    },
  };
}

class MockKV {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  async list({ prefix = "" } = {}) {
    return { keys: [...this.values.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
  }
  async get(name) { return this.values.get(name) || null; }
}

function seedDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const addItem = sqlite.prepare(`INSERT INTO digest_outbox_items
    (watch_id, subscriber_id, item_id, lens, item_kind, payload_json, source_observed_at, first_owed_at, owed_origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  addItem.run("watch:1", "subscriber:one", "item:oldest", "rules", "notice", "{}", "2026-08-09T11:00:00Z", "2026-08-09T12:00:00Z", "test");
  addItem.run("watch:2", "subscriber:one", "item:newer", "meetings", "notice", "{}", "2026-08-10T11:00:00Z", "2026-08-10T12:00:00Z", "test");
  addItem.run("watch:3", "subscriber:two", "item:two", "money", "award", "{}", "2026-08-10T12:30:00Z", "2026-08-10T12:30:00Z", "test");
  sqlite.prepare(`INSERT INTO digest_outbox_deliveries
    (subscriber_id, scheduled_day, delivery_id, status, reserved_at, sent_at)
    VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`)
    .run("subscriber:one", "2026-08-09", "delivery:sent", "sent", "2026-08-09T13:00:00Z", "2026-08-09T13:01:00Z",
      "subscriber:one", "2026-08-10", "delivery:failed", "failed", "2026-08-10T13:00:00Z", null);
  return { sqlite, DB: d1FromSqlite(sqlite) };
}

test("owed backlog query is grouped, read-only, and selects the oldest item plus latest delivery", () => {
  assert.match(OWED_BACKLOG_QUERY, /FROM digest_outbox_items/);
  assert.match(OWED_BACKLOG_QUERY, /WHERE status = 'owed'/g);
  assert.match(OWED_BACKLOG_QUERY, /GROUP BY subscriber_id/);
  assert.match(OWED_BACKLOG_QUERY, /MIN\(first_owed_at\)/);
  assert.match(OWED_BACKLOG_QUERY, /ROW_NUMBER\(\) OVER/);
  assert.doesNotMatch(OWED_BACKLOG_QUERY, /INSERT|UPDATE|DELETE/i);
});

test("readOwedBacklog returns per-subscriber counts, oldest item, and latest delivery state", async () => {
  const { sqlite, DB } = seedDb();
  const SUBS = new MockKV({
    "sub:one": JSON.stringify({ subscriber_id: "subscriber:one", email: "person@example.com", paused: false }),
    "sub:one-paused": JSON.stringify({ subscriber_id: "subscriber:one", email: "person@example.com", paused: true }),
  });
  const body = await readOwedBacklog({ DB, SUBS }, { now: "2026-08-10T13:01:00Z" });
  assert.equal(body.available, true);
  assert.equal(body.summary.owed_count, 3);
  assert.equal(body.next_scheduled_at, "2026-08-11T13:00:00.000Z");
  assert.equal(body.subscriber_metadata_available, true);
  assert.deepEqual(body.subscribers[0], {
    subscriber_id: "subscriber:one",
    subscriber_label: "pe***@example.com",
    active_watch_count: 1,
    owed_count: 2,
    oldest_owed_at: "2026-08-09T12:00:00Z",
    oldest_age_seconds: 90060,
    oldest_age: "1d 1h",
    oldest_lens: "rules",
    oldest_item_id: "item:oldest",
    last_sent_at: "2026-08-09T13:01:00Z",
    last_delivery_status: "failed",
    next_scheduled_at: "2026-08-11T13:00:00.000Z",
    overdue: true,
  });
  assert.equal(body.subscribers[1].subscriber_label, "subscriber:two");
  assert.equal(body.subscribers[1].active_watch_count, 0);
  assert.equal(body.subscribers[1].overdue, true);
  assert.equal(JSON.stringify(body).includes("person@example.com"), false);
  sqlite.close();
});

test("scheduled boundary makes an old owed row overdue only after 13:00 UTC", () => {
  assert.equal(scheduledTimes("2026-08-10T12:59:59Z").nextScheduledAt, "2026-08-10T13:00:00.000Z");
  const row = {
    subscriber_id: "subscriber:one", owed_count: 1, oldest_owed_at: "2026-08-10T12:59:00Z",
    oldest_lens: "rules", oldest_item_id: "item:oldest",
  };
  assert.equal(buildOwedBacklogBody([row], { now: "2026-08-10T12:59:59Z" }).subscribers[0].overdue, false);
  assert.equal(buildOwedBacklogBody([row], { now: "2026-08-10T13:00:01Z" }).subscribers[0].overdue, true);
});

test("owed-backlog auth fails closed, allows GET only, and handles empty D1 tables", async () => {
  const url = "https://w/admin/owed-backlog?key=secret";
  assert.equal((await handleAdminOwedBacklog(new Request(url), {})).status, 404);
  assert.equal((await handleAdminOwedBacklog(new Request("https://w/admin/owed-backlog"), { ADMIN_KEY: "secret" })).status, 401);
  assert.equal((await handleAdminOwedBacklog(new Request(url, { method: "POST" }), { ADMIN_KEY: "secret" })).status, 405);
  assert.equal((await handleAdminOwedBacklog(new Request(url), { ADMIN_KEY: "secret" })).status, 503);

  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  const response = await handleAdminOwedBacklog(new Request(url), { ADMIN_KEY: "secret", DB: d1FromSqlite(sqlite) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.summary, { subscriber_count: 0, owed_count: 0, overdue_subscriber_count: 0 });
  assert.deepEqual(body.subscribers, []);
  sqlite.close();
});

test("worker registers the route and the stats HTML card renders the overdue badge and link", async () => {
  const { DB, sqlite } = seedDb();
  const SUBS = new MockKV({
    "sub:one": JSON.stringify({ subscriber_id: "subscriber:one", email: "person@example.com", paused: false }),
  });
  const response = await worker.fetch(new Request("https://w/admin/owed-backlog?key=secret"), {
    ADMIN_KEY: "secret", DB, SUBS,
  }, {});
  assert.equal(response.status, 200);
  const html = renderAdminStatsPage({ generated: "2026-08-10T13:01:00Z" }, await response.json(), "/admin/owed-backlog?key=secret");
  assert.match(html, /Owed delivery backlog/);
  assert.match(html, /OVERDUE/);
  assert.match(html, /href="\/admin\/owed-backlog\?key=secret"/);
  assert.match(html, /pe\*\*\*@example\.com/);
  assert.doesNotMatch(html, /person@example\.com/);
  sqlite.close();
});
