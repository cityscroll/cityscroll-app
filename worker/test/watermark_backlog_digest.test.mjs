// Watermark-backlog digest policy: after a stall, the next regular send folds
// every owed item since last successful delivery (lastsent), grouped by watch,
// and labels the coverage range. No separate manual catch-up drain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { processAccountRollup, processOneSub } from "../src/alerts.mjs";

const migration = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");
const NOW = new Date("2026-08-10T13:00:00.000Z");
const DAY = "2026-08-10";
const LAST_SENT = "2026-08-05";
const NEXT_NOW = new Date("2026-08-11T13:00:00.000Z");
const NEXT_DAY = "2026-08-11";

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

function sub(key, lens, filter = {}, extra = {}) {
  return {
    key,
    email: extra.email || "owed@example.com",
    lens,
    filter,
    freq: extra.freq || "daily",
    channel: "email",
    lang: "en",
    subscriber_id: extra.subscriber_id || "subscriber:test",
    watch_id: extra.watch_id || `watch:${key}`,
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function runCtx() {
  let sends = 0;
  return {
    FROM: "CityScroll <alerts@cityscroll.org>",
    LIVE: true,
    today: DAY,
    now: NOW,
    isMonday: false,
    heartbeatDays: 14,
    counts: () => ({ "per-run": sends, daily: sends }),
    caps: { "per-run": 25, daily: 50 },
    onSent: async () => { sends++; },
    capturePreviews: true,
  };
}

function env(DB, ALERT_STATE = kv()) {
  return {
    DB,
    ALERT_STATE,
    ALERTS_LIVE: "true",
    RESEND_API_KEY: "test",
    TOKEN_SECRET: "s".repeat(32),
    CONFIRM_BASE: "https://api.cityscroll.org",
    MAX_PER_RUN: "25",
    MAX_SENDS_PER_DAY: "50",
  };
}

async function withFetch({ rows = [], fn }) {
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes("api.resend.com/emails")) {
      sent.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: "provider:test" }) };
    }
    if (target.includes("data.cityofnewyork.us") || target.includes("resource/")) {
      return { ok: true, json: async () => rows };
    }
    return { ok: true, json: async () => [] };
  };
  try { return await fn(sent); } finally { globalThis.fetch = original; }
}

function insertOwed(sqlite, { watchId, itemId, payload, lens = "land", itemKind = "rezone", firstOwedAt, subscriberId = "subscriber:test" }) {
  sqlite.prepare(`INSERT INTO digest_outbox_items
    (watch_id, subscriber_id, item_id, lens, item_kind, payload_json, source_observed_at, first_owed_at, owed_origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stall')`)
    .run(
      watchId,
      subscriberId,
      itemId,
      lens,
      itemKind,
      JSON.stringify(payload),
      String(firstOwedAt).slice(0, 10),
      firstOwedAt,
    );
}

test("processOneSub folds a multi-day owed backlog into the next digest and labels the range", async () => {
  const { sqlite, DB } = makeDb();
  const watch = sub("sub:one", "land", { status: "all" });
  const owed = [
    { day: "2026-08-06T12:00:00Z", id: "OWED-A", name: "Harbor backlog Monday" },
    { day: "2026-08-07T12:00:00Z", id: "OWED-B", name: "Harbor backlog Tuesday" },
    { day: "2026-08-08T12:00:00Z", id: "OWED-C", name: "Harbor backlog Wednesday" },
    { day: "2026-08-09T12:00:00Z", id: "OWED-D", name: "Harbor backlog Thursday" },
  ];
  for (const item of owed) {
    insertOwed(sqlite, {
      watchId: watch.watch_id,
      itemId: `land:${item.id}`,
      firstOwedAt: item.day,
      payload: { project_id: item.id, project_name: item.name, public_status: "In review" },
    });
  }
  const state = kv();
  await state.put(`lastsent:${watch.key}`, LAST_SENT);
  await withFetch({ rows: [], fn: async (sent) => {
    const result = await processOneSub(env(DB, state), watch, runCtx());
    assert.equal(result.error, undefined, result.error || "no error");
    assert.equal(result.sent, true);
    assert.equal(result.action, "match");
    assert.equal(sent.length, 1);
    assert.equal(result.new, owed.length);
    for (const item of owed) {
      assert.match(sent[0].html, new RegExp(item.name));
      assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items WHERE item_id = ?").get(`land:${item.id}`).status, "delivered");
    }
    assert.match(sent[0].subject, /catching up/i);
    assert.match(sent[0].subject, /Aug 5|last digest/i);
    assert.match(sent[0].html, /data-digest-coverage="catch-up"/);
    assert.match(sent[0].html, /Catching up: 4 items since your last digest on Aug 5/);
    assert.doesNotMatch(sent[0].html, /subscriber:|watch:/);
  }});
  sqlite.close();
});

test("provider-confirmed catch-up survives a post-send failure and advances the next window", async () => {
  const state = kv();
  const key = "sub:partial-catch-up";
  const watch = sub(key, "money", { minAmount: 500000, keywords: ["construction"] });
  await state.put(`lastsent:${key}`, LAST_SENT);
  const firstRows = [{
    request_id: "20260810001",
    start_date: "2026-08-10T00:00:00.000",
    agency_name: "DDC",
    short_title: "Backlog construction project",
    contract_amount: "900000",
    section_name: "Procurement",
  }];
  const secondRows = [...firstRows, {
    request_id: "20260811001",
    start_date: "2026-08-11T00:00:00.000",
    agency_name: "DDC",
    short_title: "New construction project",
    contract_amount: "800000",
    section_name: "Procurement",
  }];
  const firstCtx = {
    ...runCtx(),
    today: DAY,
    now: NOW,
    onSent: async () => { throw new Error("send counter unavailable"); },
  };
  const secondCtx = {
    ...runCtx(),
    today: NEXT_DAY,
    now: NEXT_NOW,
  };
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes("api.resend.com/emails")) {
      sent.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: `provider:${sent.length}` }) };
    }
    return { ok: true, json: async () => (target.includes("data.cityofnewyork.us") ? firstRows : []) };
  };
  try {
    const first = await processOneSub(env(undefined, state), watch, firstCtx);
    assert.equal(first.error, "send counter unavailable");
    assert.equal(sent.length, 1, "the provider accepted the catch-up email before the later failure");
    assert.equal(await state.get(`lastsent:${key}`), DAY, "confirmed send must advance the watermark");

    globalThis.fetch = async (url, options) => {
      const target = String(url);
      if (target.includes("api.resend.com/emails")) {
        sent.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ id: `provider:${sent.length}` }) };
      }
      return { ok: true, json: async () => (target.includes("data.cityofnewyork.us") ? secondRows : []) };
    };
    const second = await processOneSub(env(undefined, state), watch, secondCtx);
    assert.equal(second.error, undefined, second.error || "next digest should complete");
    assert.equal(second.new, 1, "the next window starts at the confirmed catch-up watermark");
    assert.equal(sent.length, 2);
    const secondText = sent[1].html.replace(/<[^>]+>/g, "");
    assert.match(secondText, /New construction project/);
    assert.doesNotMatch(secondText, /Backlog construction project/);
    assert.equal(await state.get(`lastsent:${key}`), NEXT_DAY);
  } finally {
    globalThis.fetch = original;
  }
});

test("processAccountRollup folds owed items for every watch and drops none since the watermark", async () => {
  const { sqlite, DB } = makeDb();
  const first = sub("sub:land", "land", { status: "all" });
  const second = sub("sub:money", "money", { keywords: ["construction"] });
  const landOwed = [
    { day: "2026-08-06T12:00:00Z", id: "LAND-1", name: "Queens rezoning held Monday" },
    { day: "2026-08-08T12:00:00Z", id: "LAND-2", name: "Queens rezoning held Wednesday" },
  ];
  const moneyOwed = [
    { day: "2026-08-07T12:00:00Z", id: "20260807001", title: "Construction award held Tuesday" },
    { day: "2026-08-09T12:00:00Z", id: "20260809001", title: "Construction award held Thursday" },
    { day: "2026-08-09T18:00:00Z", id: "20260809002", title: "Construction award held Thursday evening" },
  ];
  for (const item of landOwed) {
    insertOwed(sqlite, {
      watchId: first.watch_id,
      itemId: `land:${item.id}`,
      firstOwedAt: item.day,
      payload: { project_id: item.id, project_name: item.name, public_status: "In review" },
    });
  }
  for (const item of moneyOwed) {
    insertOwed(sqlite, {
      watchId: second.watch_id,
      itemId: `notice:${item.id}`,
      lens: "money",
      itemKind: "rfp",
      firstOwedAt: item.day,
      payload: { request_id: item.id, short_title: item.title, agency_name: "DDC" },
    });
  }
  const state = kv();
  await state.put(`lastsent:${first.key}`, LAST_SENT);
  await state.put(`lastsent:${second.key}`, LAST_SENT);
  await withFetch({ rows: [], fn: async (sent) => {
    const result = await processAccountRollup(env(DB, state), [first, second], runCtx());
    assert.equal(result.error, undefined, result.error || "no error");
    assert.equal(result.sent, true);
    assert.equal(result.kind, "rollup");
    assert.equal(sent.length, 1);
    const html = sent[0].html;
    const expected = [...landOwed.map((item) => item.name), ...moneyOwed.map((item) => item.title)];
    const htmlPlain = html.replace(/<[^>]+>/g, "");
    for (const title of expected) {
      assert.match(htmlPlain, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.equal(result.new, expected.length);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items WHERE status = 'owed'").get().n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items WHERE status = 'delivered'").get().n, expected.length);
    assert.equal(await state.get(`lastsent:${first.key}`), DAY, "land watch watermark advances after rollup send");
    assert.equal(await state.get(`lastsent:${second.key}`), DAY, "money watch watermark advances after rollup send");
    assert.match(sent[0].subject, /catching up/i);
    assert.match(sent[0].subject, /Aug 5|last digest/i);
    assert.match(html, /data-digest-coverage="catch-up"/);
    assert.match(html, /Catching up: 5 items since your last digest on Aug 5/);
    assert.match(html, /Queens rezoning held Monday[\s\S]*Queens rezoning held Wednesday/);
    assert.doesNotMatch(html, /subscriber:test|watch:sub:/);
  }});
  sqlite.close();
});

test("next regular digest after a 500-plus owed stall still includes every owed row", async () => {
  const { sqlite, DB } = makeDb();
  const watch = sub("sub:many", "land", { status: "all" });
  const companion = sub("sub:quiet", "land", { status: "all" });
  const titles = [];
  for (let i = 0; i < 520; i++) {
    const id = `BULK-${String(i).padStart(4, "0")}`;
    const name = `Bulk held project ${id}`;
    titles.push(name);
    insertOwed(sqlite, {
      watchId: watch.watch_id,
      itemId: `land:${id}`,
      firstOwedAt: `2026-08-0${(i % 4) + 6}T12:${String(i % 60).padStart(2, "0")}:00Z`,
      payload: { project_id: id, project_name: name, public_status: "In review" },
    });
  }
  const state = kv();
  await state.put(`lastsent:${watch.key}`, LAST_SENT);
  await state.put(`lastsent:${companion.key}`, LAST_SENT);
  await withFetch({ rows: [], fn: async (sent) => {
    const result = await processAccountRollup(env(DB, state), [watch, companion], runCtx());
    assert.equal(result.sent, true);
    assert.equal(result.new, 520);
    assert.equal(sent.length, 1);
    for (const name of titles) assert.match(sent[0].html, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items WHERE status = 'owed'").get().n, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items WHERE status = 'delivered'").get().n, 520);
    assert.match(sent[0].subject, /catching up/i);
  }});
  sqlite.close();
});

test("a normal one-period window does not use the catching-up label", async () => {
  const { sqlite, DB } = makeDb();
  const watch = sub("sub:daily", "land", { status: "all" });
  insertOwed(sqlite, {
    watchId: watch.watch_id,
    itemId: "land:TODAY-1",
    firstOwedAt: "2026-08-10T12:00:00Z",
    payload: { project_id: "TODAY-1", project_name: "Same-period harbor project", public_status: "In review" },
  });
  const state = kv();
  await state.put(`lastsent:${watch.key}`, "2026-08-09");
  await withFetch({ rows: [], fn: async (sent) => {
    const result = await processOneSub(env(DB, state), watch, runCtx());
    assert.equal(result.sent, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0].html, /Same-period harbor project/);
    assert.doesNotMatch(sent[0].subject, /catching up/i);
    assert.match(sent[0].html, /data-digest-coverage="current"/);
    assert.match(sent[0].html, /1 new .+ since Aug 9/);
  }});
  sqlite.close();
});

test("field case: consecutive mixed-rollup deliveries do not repeat catching-up since Aug 25", async () => {
  const { sqlite, DB } = makeDb();
  const matching = sub("sub:matching", "land", { status: "all" });
  const quiet = sub("sub:quiet-sibling", "land", { status: "all" });
  insertOwed(sqlite, {
    watchId: matching.watch_id,
    itemId: "land:20260829-1",
    firstOwedAt: "2026-08-29T12:00:00Z",
    payload: { project_id: "20260829-1", project_name: "Saturday harbor item", public_status: "In review" },
  });
  const state = kv();
  await state.put(`lastsent:${matching.key}`, "2026-08-25");
  await state.put(`lastsent:${quiet.key}`, "2026-08-25");
  const firstCtx = { ...runCtx(), today: "2026-08-29", now: new Date("2026-08-29T13:00:00.000Z") };
  const secondCtx = { ...runCtx(), today: "2026-08-30", now: new Date("2026-08-30T13:00:00.000Z") };
  await withFetch({ rows: [], fn: async (sent) => {
    const first = await processAccountRollup(env(DB, state), [matching, quiet], firstCtx);
    assert.equal(first.error, undefined, first.error || "first send should complete");
    assert.equal(first.sent, true);
    assert.equal(first.new, 1);
    assert.equal(sent.length, 1);
    const firstText = sent[0].html.replace(/<[^>]+>/g, "");
    assert.match(firstText, /Catching up: 1 items since your last digest on Aug 25/);
    assert.equal(await state.get(`lastsent:${matching.key}`), "2026-08-29");
    assert.equal(
      await state.get(`lastsent:${quiet.key}`),
      "2026-08-29",
      "quiet sibling covered by the delivered email must advance lastsent",
    );

    insertOwed(sqlite, {
      watchId: matching.watch_id,
      itemId: "land:20260830-1",
      firstOwedAt: "2026-08-30T12:00:00Z",
      payload: { project_id: "20260830-1", project_name: "Sunday harbor item", public_status: "In review" },
    });
    const second = await processAccountRollup(env(DB, state), [matching, quiet], secondCtx);
    assert.equal(second.error, undefined, second.error || "second send should complete");
    assert.equal(second.sent, true);
    assert.equal(second.new, 1);
    assert.equal(sent.length, 2);
    const secondText = sent[1].html.replace(/<[^>]+>/g, "");
    assert.match(secondText, /Sunday harbor item/);
    assert.doesNotMatch(secondText, /Catching up: 1 items since your last digest on Aug 25/);
    assert.doesNotMatch(sent[1].subject, /catching up/i);
    assert.equal(await state.get(`lastsent:${matching.key}`), "2026-08-30");
    assert.equal(await state.get(`lastsent:${quiet.key}`), "2026-08-30");
  }});
  sqlite.close();
});

test("provider rejection does not advance lastsent", async () => {
  const { sqlite, DB } = makeDb();
  const watch = sub("sub:fail-send", "land", { status: "all" });
  insertOwed(sqlite, {
    watchId: watch.watch_id,
    itemId: "land:FAIL-1",
    firstOwedAt: "2026-08-26T12:00:00Z",
    payload: { project_id: "FAIL-1", project_name: "Rejected harbor item", public_status: "In review" },
  });
  const state = kv();
  await state.put(`lastsent:${watch.key}`, "2026-08-25");
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("api.resend.com/emails")) {
      return { ok: false, status: 500, text: async () => "provider down" };
    }
    return { ok: true, json: async () => [] };
  };
  try {
    const result = await processOneSub(env(DB, state), watch, {
      ...runCtx(),
      today: "2026-08-26",
      now: new Date("2026-08-26T13:00:00.000Z"),
    });
    assert.ok(result.error);
    assert.match(String(result.error), /Resend 500|provider down/);
    assert.notEqual(result.sent, true);
    assert.equal(await state.get(`lastsent:${watch.key}`), "2026-08-25");
  } finally {
    globalThis.fetch = original;
  }
  sqlite.close();
});
