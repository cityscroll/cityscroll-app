import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { processAccountRollup } from "../src/alerts.mjs";

const migration = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");
const NOW = new Date("2026-08-10T13:00:00.000Z");
const DAY = "2026-08-10";

function kv() {
  const values = new Map();
  return {
    async get(key) { return values.get(key) || null; },
    async put(key, value) { values.set(key, String(value)); },
    async delete(key) { values.delete(key); },
    async list() { return { keys: [], list_complete: true }; },
  };
}

function d1(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            run() {
              const result = statement.run(...params);
              return { meta: { changes: Number(result.changes || 0) } };
            },
            all() { return { results: statement.all(...params) }; },
            first() { return statement.get(...params) || null; },
          };
        },
      };
    },
    async batch(statements) { return statements.map((statement) => statement.run()); },
  };
}

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  return { sqlite, DB: d1(sqlite) };
}

function sub(key, lens, filter = {}) {
  return {
    key,
    email: "owed@example.com",
    lens,
    filter,
    freq: "daily",
    channel: "email",
    lang: "en",
    subscriber_id: "subscriber:test",
    watch_id: `watch:${key}`,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function ctx() {
  let sends = 0;
  return {
    ctx: {
      FROM: "CityScroll <alerts@cityscroll.org>",
      LIVE: true,
      today: DAY,
      now: NOW,
      isMonday: false,
      heartbeatDays: 14,
      counts: () => ({ "per-run": sends, daily: sends }),
      caps: { "per-run": 25, daily: 50 },
      onSent: async () => { sends++; },
    },
    count: () => sends,
  };
}

async function withFetch({ provider = "accepted", rows = [], fn }) {
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes("api.resend.com/emails")) {
      sent.push(JSON.parse(options.body));
      if (provider === "failed") return { ok: false, status: 503, text: async () => "unavailable" };
      return { ok: true, json: async () => ({ id: "provider:test" }) };
    }
    if (target.includes("data.cityofnewyork.us") || target.includes("resource/")) {
      if (target.includes("bad")) throw new Error("SODA unavailable");
      return { ok: true, json: async () => rows };
    }
    return { ok: true, json: async () => [] };
  };
  try { return await fn(sent); } finally { globalThis.fetch = original; }
}

function env(DB) {
  return {
    DB,
    ALERT_STATE: kv(),
    ALERTS_LIVE: "true",
    RESEND_API_KEY: "test",
    TOKEN_SECRET: "s".repeat(32),
    CONFIRM_BASE: "https://api.cityscroll.org",
    MAX_PER_RUN: "25",
    MAX_SENDS_PER_DAY: "50",
  };
}

function insertOwed(sqlite, { watchId, itemId, payload, lens = "land", itemKind = "rezone" }) {
  sqlite.prepare(`INSERT INTO digest_outbox_items
    (watch_id, subscriber_id, item_id, lens, item_kind, payload_json, source_observed_at, first_owed_at, owed_origin)
    VALUES (?, 'subscriber:test', ?, ?, ?, ?, '2026-08-01', '2026-08-01T12:00:00Z', 'test')`)
    .run(watchId, itemId, lens, itemKind, JSON.stringify(payload));
}

test("rollup renders owed rows and accepts at most one scheduled delivery", async () => {
  const { sqlite, DB } = makeDb();
  const first = sub("one", "land", { status: "all" });
  const second = sub("two", "land", { status: "all" });
  insertOwed(sqlite, {
    watchId: first.watch_id,
    itemId: "land:OWED-1",
    payload: { project_id: "OWED-1", project_name: "Owed harbor project", public_status: "In review" },
  });
  const runContext = ctx();
  const runCtx = runContext.ctx;
  await withFetch({ rows: [], fn: async (sent) => {
    const result = await processAccountRollup(env(DB), [first, second], runCtx);
    assert.equal(sent.length, 1);
    assert.equal(result.sent, true);
    assert.match(sent[0].html, /Owed harbor project/);
    assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = 'land:OWED-1'").get().status, "delivered");

    // A newly owed item on the same UTC day cannot create a second occasion.
    insertOwed(sqlite, {
      watchId: first.watch_id,
      itemId: "land:OWED-2",
      payload: { project_id: "OWED-2", project_name: "Second owed project" },
    });
    const again = await processAccountRollup(env(DB), [first, second], runCtx);
    assert.equal(sent.length, 1);
    assert.equal(again.occasionReserved, true);
    assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = 'land:OWED-2'").get().status, "owed");
  }});
  sqlite.close();
});

test("accepted partial rollup delivers successful sections but keeps errored section owed", async () => {
  const { sqlite, DB } = makeDb();
  const good = sub("good", "money", { keywords: ["ok"] });
  const bad = sub("bad", "money", { keywords: ["bad"] });
  const row = { request_id: "NOTICE-OK", short_title: "Successful notice", agency_name: "DOT", start_date: "2026-08-10" };
  insertOwed(sqlite, {
    watchId: bad.watch_id,
    itemId: "notice:NOTICE-BAD",
    lens: "money",
    itemKind: "rfp",
    payload: { request_id: "NOTICE-BAD", short_title: "Previously owed failed-section notice" },
  });
  const runContext = ctx();
  const runCtx = runContext.ctx;
  await withFetch({ rows: [row], fn: async (sent) => {
    const result = await processAccountRollup(env(DB), [good, bad], runCtx);
    assert.equal(sent.length, 1);
    assert.equal(result.providerAccepted, true);
    assert.equal(result.sent, false);
    assert.equal(result.deliveryStatus, "partial_error");
    assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = 'notice:NOTICE-OK'").get().status, "delivered");
    assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = 'notice:NOTICE-BAD'").get().status, "owed");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items WHERE status = 'owed'").get().n, 1);
    assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_deliveries").get().status, "partial_error");
  }});
  sqlite.close();
});

test("provider failure leaves the rollup item owed and records no sent result", async () => {
  const { sqlite, DB } = makeDb();
  const watch = sub("one", "land", { status: "all" });
  insertOwed(sqlite, {
    watchId: watch.watch_id,
    itemId: "land:FAILED-1",
    payload: { project_id: "FAILED-1", project_name: "Provider failure project" },
  });
  const runContext = ctx();
  const runCtx = runContext.ctx;
  await withFetch({ provider: "failed", rows: [], fn: async (sent) => {
    const result = await processAccountRollup(env(DB), [watch], runCtx);
    assert.equal(sent.length, 1);
    assert.equal(result.sent, undefined);
    assert.match(result.error, /Resend 503/);
    assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = 'land:FAILED-1'").get().status, "owed");
    assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_deliveries").get().status, "failed");
  }});
  sqlite.close();
});
