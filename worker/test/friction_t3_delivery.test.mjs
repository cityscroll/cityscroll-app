/**
 * Mail-sink delivery coverage for preparation-time minRemainingDays.
 * Companion to test/friction_t3_capability.test.mjs (site-node safe).
 *
 *   node --test worker/test/friction_t3_delivery.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { procurementDigestRow, stampDigestIdentity } from "../../site/procurement_digest_compile.mjs";
import { projectDeadlinesFromNoticeRow } from "../../site/procurement_deadline_projection.mjs";
import { rowMeetsMinRemainingDays } from "../../site/money_watch_min_remaining_days.mjs";
import { resolveTypedSourceDeadlines } from "../../warehouse/lib/typed_source_deadline.mjs";
import { recordsFromMtaOpportunityFixtures } from "../../warehouse/lib/mta_opportunities.mjs";
import { buildSharedProcurementReadModel } from "../../site/shared_procurement_read_model.mjs";
import { withPinnedClock } from "../../test/helpers/test_clock.mjs";
import { sanitize } from "../src/lib/filter.mjs";
import { useProcurementDigestSnapshot } from "../src/lib/compile.mjs";
import {
  consumeDigestJob,
  processAccountRollup,
  processOneSub,
} from "../src/alerts.mjs";
import {
  SECTION_STATUS,
  enqueueEvaluatedSection,
  listDeliveredItemIds,
  listWatchMembership,
} from "../src/lib/digest_outbox.mjs";
import { deriveSubscriberId, deriveWatchId } from "../src/lib/subscriptions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const MTA_FIXTURES = read("warehouse/fixtures/authority-native-procurement/mta-opportunities.v1.json");
const DEADLINE_FIXTURES = read("warehouse/fixtures/authority-native-procurement/typed-source-deadlines.v1.json");
const DIGEST = read("site/data/procurement_digest_snapshot.json");
const OUTBOX_MIGRATION = readFileSync(join(ROOT, "worker/migrations/0018_digest_outbox.sql"), "utf8");
const REVISION_MIGRATION = readFileSync(join(ROOT, "worker/migrations/0030_digest_outbox_query_revision.sql"), "utf8");

const NATIVE_MODEL = buildSharedProcurementReadModel({
  sourceRecords: recordsFromMtaOpportunityFixtures(MTA_FIXTURES),
  generatedAt: MTA_FIXTURES.retrieved_at,
});
const OBJ_2138505 = NATIVE_MODEL.rows.find((row) => (
  row.procurement_id === "procurement:contract_reporter_number:2138505"
));
const DOB_FIXTURE = DEADLINE_FIXTURES.fixtures.find((row) => row.id === "dob-20260707026-current");

const PASS_NATIVE = "2026-09-11T16:00:00.000Z";
const FAIL_NATIVE = "2026-09-12T16:00:00.000Z";
const PASS_DOB = "2026-08-04T16:00:00.000Z";
const FAIL_DOB = "2026-08-05T16:00:00.000Z";
const PASS_GI = "2026-08-07T16:00:00.000Z";
const FAIL_GI = "2026-08-08T16:00:00.000Z";
const EMAIL = "prep-gate-delivery@example.com";
const SECRET = "s".repeat(32);

function dobNoticeRow(overrides = {}) {
  const projected = projectDeadlinesFromNoticeRow({
    request_id: "20260707026",
    agency_name: "Buildings",
    short_title: DOB_FIXTURE.short_title,
    type_of_notice_description: "Solicitation",
    due_date: "8/25/2026 1:00 PM",
    start_date: "2026-07-28",
    pin: "81026B0003",
  }, {
    resolution: resolveTypedSourceDeadlines(DOB_FIXTURE.assertions),
    source_url: DOB_FIXTURE.official_url,
  });
  return stampDigestIdentity({
    request_id: "20260707026",
    agency_name: "Buildings",
    short_title: DOB_FIXTURE.short_title,
    type_of_notice_description: "Solicitation",
    due_date: "8/25/2026 1:00 PM",
    start_date: "2026-07-28",
    pin: "81026B0003",
    response_deadline: projected.response_deadline,
    bid_opening: projected.bid_opening,
    ...overrides,
  });
}

function governorsIslandNoticeRow() {
  const projected = projectDeadlinesFromNoticeRow({
    request_id: "20260727019",
    agency_name: "Trust for Governors Island",
    short_title: "Governors Island Building 324 construction services",
    type_of_notice_description: "Solicitation",
    due_date: "8/28/2026 5:00 PM",
    start_date: "2026-07-31",
  });
  return stampDigestIdentity({
    request_id: "20260727019",
    agency_name: "Trust for Governors Island",
    short_title: "Governors Island Building 324 construction services",
    type_of_notice_description: "Solicitation",
    due_date: "8/28/2026 5:00 PM",
    start_date: "2026-07-31",
    response_deadline: projected.response_deadline,
    bid_opening: projected.bid_opening,
  });
}

function native2138505Row() {
  return stampDigestIdentity(procurementDigestRow(OBJ_2138505, NATIVE_MODEL));
}

function discoveryFilter(extra = {}) {
  return sanitize("money", { noticeType: "solicitation", ...extra });
}

function kv(map = {}) {
  return {
    get: async (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    put: async (k, v) => { map[k] = typeof v === "string" ? v : String(v); },
    delete: async (k) => { delete map[k]; },
    list: async (options = {}) => {
      const prefix = options.prefix || "";
      const keys = Object.keys(map).filter((k) => k.startsWith(prefix)).map((k) => ({ name: k }));
      return { keys, list_complete: true };
    },
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

function openOutboxDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(OUTBOX_MIGRATION);
  sqlite.exec(REVISION_MIGRATION);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS notices (
      request_id TEXT PRIMARY KEY,
      section TEXT, agency TEXT, type_of_notice TEXT, category TEXT,
      short_title TEXT, description TEXT, vendor_name TEXT, pin TEXT,
      contract_amount REAL, contract_amount_valid INTEGER,
      start_date TEXT, due_date TEXT, haystack TEXT
    );
    CREATE TABLE IF NOT EXISTS ingest_state (k TEXT PRIMARY KEY, v TEXT);
  `);
  return sqlite;
}

function subscriberMails(sent) {
  return (Array.isArray(sent) ? sent : []).filter((payload) => (
    String(payload?.to || "").toLowerCase().includes(EMAIL.toLowerCase())
  ));
}

function mailEnv(sqlite, subsMap, stateMap = {}, sent, { sodaRows = [] } = {}) {
  const seeded = { ...stateMap };
  for (const raw of Object.values(subsMap)) {
    try {
      const record = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (record?.key && seeded[`lastsent:${record.key}`] == null) {
        seeded[`lastsent:${record.key}`] = "2026-09-10";
      }
    } catch { /* ignore */ }
  }
  return {
    SUBS: kv(subsMap),
    ALERT_STATE: kv(seeded),
    DB: d1(sqlite),
    ALERTS_LIVE: "true",
    RESEND_API_KEY: "rk",
    TOKEN_SECRET: SECRET,
    CONFIRM_BASE: "https://api.cityscroll.org",
    fetch: async (url, opts) => {
      const u = String(url);
      if (u.includes("data.cityofnewyork.us") || u.includes("dg92-zbpx")) {
        return Response.json(sodaRows);
      }
      if (u.includes("api.resend.com")) {
        sent.push(JSON.parse(opts.body));
        return Response.json({ id: `email_${sent.length}` });
      }
      throw new Error(`unexpected fetch: ${u}`);
    },
  };
}

async function moneySub({ filter, keySuffix = "lead", subscriberId = null } = {}) {
  const preparedFilter = discoveryFilter(filter);
  const key = `sub:t3d-${keySuffix}`;
  return {
    key,
    email: EMAIL,
    lens: "money",
    filter: preparedFilter,
    freq: "daily",
    channel: "email",
    createdAt: "2026-06-01T00:00:00.000Z",
    lang: "en",
    subscriber_id: subscriberId || await deriveSubscriberId(EMAIL),
    watch_id: await deriveWatchId(key),
  };
}

function runCtx(iso, extras = {}) {
  const now = new Date(iso);
  return {
    FROM: "CityScroll <alerts@cityscroll.org>",
    LIVE: true,
    heartbeatDays: 14,
    today: now.toISOString().slice(0, 10),
    now,
    nowMs: now.getTime(),
    isMonday: now.getUTCDay() === 1,
    counts: () => ({ "per-run": 0, daily: 0 }),
    caps: { "per-run": 25, daily: 50 },
    onSent: async () => {},
    capturePreviews: true,
    ...extras,
  };
}

async function enqueueOwed(env, sub, rows, clockIso) {
  await enqueueEvaluatedSection(env.DB, {
    lens: "money",
    kind: "rfp",
    status: SECTION_STATUS.SUCCESS,
    freshRows: rows,
    sourceObservedAt: clockIso,
    owedOrigin: "test-prep-gate-delivery",
  }, {
    watchId: sub.watch_id,
    subscriberId: sub.subscriber_id,
    sourceObservedAt: clockIso,
    now: clockIso,
  });
}

test("delivery A1: individual and rollup prep exclude queued rows after threshold crossing", async () => {
  assert.ok(OBJ_2138505);
  assert.ok(DOB_FIXTURE);

  {
    const restoreSnapshot = useProcurementDigestSnapshot({ schema: DIGEST.schema, rows: [] });
    const sqlite = openOutboxDb();
    const sub = await moneySub({ filter: { minRemainingDays: 21 }, keySuffix: "indiv" });
    const sent = [];
    const env = mailEnv(sqlite, { [sub.key]: JSON.stringify(sub) }, {}, sent);
    const realFetch = globalThis.fetch;
    globalThis.fetch = env.fetch;
    try {
      await enqueueOwed(env, sub, [native2138505Row()], PASS_NATIVE);
      const result = await withPinnedClock(FAIL_NATIVE, () => processOneSub(env, sub, runCtx(FAIL_NATIVE)));
      assert.equal(result.sent, false);
      assert.equal(result.new, 0);
      assert.equal(subscriberMails(sent).length, 0);
      assert.equal(await env.ALERT_STATE.get(`seen:${sub.key}`), null);
      assert.equal((await listDeliveredItemIds(env.DB, sub.watch_id)).length, 0);
    } finally {
      globalThis.fetch = realFetch;
      restoreSnapshot();
    }
  }

  {
    const restoreSnapshot = useProcurementDigestSnapshot({ schema: DIGEST.schema, rows: [] });
    const sqlite = openOutboxDb();
    const sub = await moneySub({ filter: { minRemainingDays: 21 }, keySuffix: "rollup" });
    const companion = await moneySub({
      filter: { noticeType: "award", minAmount: 1_000_000_000 },
      keySuffix: "rollup-quiet",
      subscriberId: sub.subscriber_id,
    });
    const sent = [];
    const env = mailEnv(sqlite, {
      [sub.key]: JSON.stringify(sub),
      [companion.key]: JSON.stringify(companion),
    }, {}, sent);
    const realFetch = globalThis.fetch;
    globalThis.fetch = env.fetch;
    try {
      await enqueueOwed(env, sub, [dobNoticeRow()], PASS_DOB);
      const result = await withPinnedClock(FAIL_DOB, () => (
        processAccountRollup(env, [sub, companion], runCtx(FAIL_DOB))
      ));
      assert.equal(result.sent, false);
      assert.equal(result.new, 0);
      assert.equal(subscriberMails(sent).length, 0);
    } finally {
      globalThis.fetch = realFetch;
      restoreSnapshot();
    }
  }
});

test("delivery A4/A5: extension restores once; retry and fail-day clocks do not duplicate", async () => {
  const restoreSnapshot = useProcurementDigestSnapshot({ schema: DIGEST.schema, rows: [] });
  const sqlite = openOutboxDb();
  const sub = await moneySub({ filter: { minRemainingDays: 21 }, keySuffix: "a4" });
  const row = dobNoticeRow();
  const sent = [];
  const env = mailEnv(sqlite, { [sub.key]: JSON.stringify(sub) }, {
    [`lastsent:${sub.key}`]: "2026-08-04",
  }, sent);
  const realFetch = globalThis.fetch;
  globalThis.fetch = env.fetch;

  try {
    await enqueueOwed(env, sub, [row], PASS_DOB);
    const excluded = await withPinnedClock(FAIL_DOB, () => processOneSub(env, sub, runCtx(FAIL_DOB)));
    assert.equal(excluded.sent, false);
    assert.equal(subscriberMails(sent).length, 0);
    assert.equal(
      (await listWatchMembership(env.DB, sub.watch_id))
        .find((item) => item.item_id === "notice:20260707026")?.status,
      "owed",
    );

    const extended = dobNoticeRow({
      due_date: "9/15/2026 1:00 PM",
      response_deadline: {
        ...row.response_deadline,
        date: "2026-09-15",
        label: "Sep 15",
        source_text: "9/15/2026",
      },
    });
    assert.equal(rowMeetsMinRemainingDays(extended, 21, FAIL_DOB), true);
    sqlite.prepare(`
      UPDATE digest_outbox_items
         SET payload_json = ?
       WHERE watch_id = ? AND item_id = ? AND status = 'owed'
    `).run(JSON.stringify(extended), sub.watch_id, "notice:20260707026");

    const restored = await withPinnedClock(FAIL_DOB, () => processOneSub(env, sub, runCtx(FAIL_DOB)));
    assert.equal(restored.sent, true);
    assert.equal(restored.new, 1);
    assert.equal(subscriberMails(sent).length, 1);
    assert.ok((await listDeliveredItemIds(env.DB, sub.watch_id)).includes("notice:20260707026"));

    const retry = await withPinnedClock(FAIL_DOB, () => (
      consumeDigestJob(env, { type: "sub", key: sub.key }, { now: FAIL_DOB })
    ));
    assert.equal(retry.new, 0);
    assert.equal(subscriberMails(sent).length, 1);
  } finally {
    globalThis.fetch = realFetch;
    restoreSnapshot();
  }
});

test("delivery A5: SODA path honors pass/fail clocks into the mail sink", async () => {
  const restoreSnapshot = useProcurementDigestSnapshot({ schema: DIGEST.schema, rows: [] });
  const sqlite = openOutboxDb();
  const sub = await moneySub({
    filter: { minRemainingDays: 21, keywords: ["construction"] },
    keySuffix: "a5",
  });
  const gi = governorsIslandNoticeRow();
  sqlite.prepare("INSERT OR REPLACE INTO ingest_state (k, v) VALUES ('notices_cursor', ?)").run("2026-08-07");
  const sent = [];
  const env = mailEnv(sqlite, { [sub.key]: JSON.stringify(sub) }, {
    [`lastsent:${sub.key}`]: "2026-08-06",
  }, sent, { sodaRows: [gi] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = env.fetch;

  try {
    const pass = await withPinnedClock(PASS_GI, () => processOneSub(env, sub, runCtx(PASS_GI)));
    assert.equal(pass.sent, true);
    assert.ok(pass.new >= 1);
    assert.equal(subscriberMails(sent).length, 1);
    assert.match(subscriberMails(sent)[0].html, /Governors Island|20260727019/);

    const again = await withPinnedClock(PASS_GI, () => (
      consumeDigestJob(env, { type: "sub", key: sub.key }, { now: PASS_GI })
    ));
    assert.equal(again.sent === true && again.new > 0, false);
    assert.equal(subscriberMails(sent).length, 1);

    const failDay = await withPinnedClock(FAIL_GI, () => processOneSub(env, sub, runCtx(FAIL_GI)));
    assert.equal(failDay.new, 0);
    assert.equal(subscriberMails(sent).length, 1);
  } finally {
    globalThis.fetch = realFetch;
    restoreSnapshot();
  }
});
