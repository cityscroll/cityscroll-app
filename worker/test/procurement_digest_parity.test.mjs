import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { processOneSub } from "../src/alerts.mjs";
import { useProcurementDigestSnapshot } from "../src/lib/compile.mjs";
import { sanitize } from "../src/lib/filter.mjs";
import { buildSharedProcurementReadModel } from "../../site/shared_procurement_read_model.mjs";

const cohort = JSON.parse(readFileSync(
  new URL("../../test/fixtures/procurement_search/golden_cohort.json", import.meta.url),
  "utf8",
));
const model = buildSharedProcurementReadModel({
  sourceRecords: cohort.source_records,
  generatedAt: cohort.generated_at,
});
const CROL_NEGATIVE_ID = "procurement:contract:CT101520271400806";
const migration = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");
const DAY = "2026-08-18";
const NOW = new Date("2026-08-18T13:00:00.000Z");

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

function watch(extra = {}) {
  return {
    key: extra.key || "sub:crol-negative",
    email: extra.email || "owed@example.com",
    lens: "money",
    filter: extra.filter || sanitize("money", {
      procurement_id: CROL_NEGATIVE_ID,
      noticeType: "award",
    }),
    freq: "daily",
    channel: "email",
    lang: "en",
    subscriber_id: extra.subscriber_id || "subscriber:test",
    watch_id: extra.watch_id || "watch:crol-negative",
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

async function withFetch({ sodaRows = [], fn }) {
  const original = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes("api.resend.com/emails")) {
      sent.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: "provider:test" }) };
    }
    if (target.includes("data.cityofnewyork.us") || target.includes("resource/")) {
      return { ok: true, json: async () => sodaRows };
    }
    return { ok: true, json: async () => [] };
  };
  try { return await fn(sent); } finally { globalThis.fetch = original; }
}

test("CROL-negative procurement match is compiled, enqueued, and emailed without a notice id", async () => {
  const { sqlite, DB } = makeDb();
  const state = kv();
  const sub = watch();
  const restore = useProcurementDigestSnapshot(model);
  try {
    await withFetch({ sodaRows: [], fn: async (sent) => {
      const result = await processOneSub(env(DB, state), sub, runCtx());
      assert.equal(result.error, undefined, result.error || "no error");
      assert.equal(result.sent, true);
      assert.equal(result.action, "match");
      assert.equal(result.new, 1);
      assert.deepEqual(result.noticeIds, [CROL_NEGATIVE_ID]);
      assert.equal(sent.length, 1);
      assert.match(sent[0].html, /Small purchase legal services/);
      assert.match(sent[0].html, /\/procurements\/procurement%3Acontract%3ACT101520271400806/);
      assert.match(sent[0].html, /data-procurement-id="procurement:contract:CT101520271400806"/);
      assert.doesNotMatch(sent[0].html, /RequestDetail/);
      assert.doesNotMatch(sent[0].html, /\/notices\//);
      const owed = sqlite.prepare("SELECT item_id, item_kind, payload_json, status FROM digest_outbox_items").get();
      assert.equal(owed.item_id, CROL_NEGATIVE_ID);
      assert.equal(owed.item_kind, "award");
      assert.equal(owed.status, "delivered");
      const payload = JSON.parse(owed.payload_json);
      assert.equal(payload.procurement_id, CROL_NEGATIVE_ID);
      assert.equal(payload.request_id, undefined);
    }});

    await withFetch({ sodaRows: [], fn: async (sent) => {
      const result = await processOneSub(env(DB, state), sub, runCtx());
      assert.equal(result.error, undefined, result.error || "no error");
      assert.equal(result.new, 0);
      assert.notEqual(result.action, "match");
      assert.equal(sent.some((email) => /Small purchase legal services/.test(email.html)), false);
    }});
  } finally {
    restore();
    sqlite.close();
  }
});

test("agency award watches deliver CROL-negative snapshot rows when City Record is empty", async () => {
  const { sqlite, DB } = makeDb();
  const state = kv();
  const sub = watch({
    key: "sub:comptroller-awards",
    watch_id: "watch:comptroller-awards",
    filter: sanitize("money", { noticeType: "award", agency: "Office of the Comptroller" }),
  });
  const restore = useProcurementDigestSnapshot(model);
  try {
    await withFetch({ sodaRows: [], fn: async (sent) => {
      const result = await processOneSub(env(DB, state), sub, runCtx());
      assert.equal(result.sent, true);
      assert.equal(result.action, "match");
      assert.equal(result.new, 1);
      assert.match(sent[0].html, /Small purchase legal services/);
      assert.match(sent[0].html, /View contract on CityScroll/);
      assert.doesNotMatch(sent[0].html, /RequestDetail/);
    }});
  } finally {
    restore();
    sqlite.close();
  }
});
