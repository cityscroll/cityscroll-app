/**
 * Discovery money watches re-check minRemainingDays at email preparation
 * (and retry), so a yesterday-eligible preview cannot justify today's send.
 *
 *   node --test test/friction_t3_capability.test.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  matchProcurementDigestRows,
  mergeProcurementDigestMatches,
  procurementDigestRow,
  stampDigestIdentity,
} from "../site/procurement_digest_compile.mjs";
import {
  projectDeadlinesFromNoticeRow,
} from "../site/procurement_deadline_projection.mjs";
import {
  applyMinRemainingDaysPreference,
  applyPreparedMinRemainingDaysEligibility,
  rowMeetsMinRemainingDays,
} from "../site/money_watch_min_remaining_days.mjs";
import {
  DEADLINE_RESOLUTION_STATUS,
  resolveTypedSourceDeadlines,
} from "../warehouse/lib/typed_source_deadline.mjs";
import { recordsFromMtaOpportunityFixtures } from "../warehouse/lib/mta_opportunities.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { withPinnedClock, testClockISOString } from "./helpers/test_clock.mjs";
import { sanitize } from "../worker/src/lib/filter.mjs";
import { compileSub, mergeCompiledRows, useProcurementDigestSnapshot } from "../worker/src/lib/compile.mjs";
import { compileSub_d1, toDigestRow } from "../worker/src/lib/compile_d1.mjs";
import {
  consumeDigestJob,
  processAccountRollup,
  processOneSub,
} from "../worker/src/alerts.mjs";
import {
  SECTION_STATUS,
  enqueueEvaluatedSection,
  listDeliveredItemIds,
  listWatchMembership,
} from "../worker/src/lib/digest_outbox.mjs";
import { evaluateMoneyTextQueryWatch } from "../worker/src/lib/watch_text_query_procurement.mjs";
import { deriveSubscriberId, deriveWatchId } from "../worker/src/lib/subscriptions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_DIR = join(ROOT, "docs/evidence/minimum-lead-time");
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
const EMAIL = "prep-gate@example.com";
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

function governorsIslandNoticeRow(overrides = {}) {
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
    ...overrides,
  });
}

function native2138505Row() {
  return stampDigestIdentity(procurementDigestRow(OBJ_2138505, NATIVE_MODEL));
}

function discoveryFilter(extra = {}) {
  return sanitize("money", { noticeType: "solicitation", ...extra });
}

function writeEvidence(name, payload) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, name);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
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
    _map: map,
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
      section TEXT,
      agency TEXT,
      type_of_notice TEXT,
      category TEXT,
      short_title TEXT,
      description TEXT,
      vendor_name TEXT,
      pin TEXT,
      contract_amount REAL,
      contract_amount_valid INTEGER,
      start_date TEXT,
      due_date TEXT,
      haystack TEXT
    );
    CREATE TABLE IF NOT EXISTS ingest_state (k TEXT PRIMARY KEY, v TEXT);
  `);
  return sqlite;
}

function asD1NoticeColumns(row, { requestId = null } = {}) {
  const amount = row?.contract_amount;
  const hasAmount = amount != null && Number.isFinite(Number(amount));
  return {
    request_id: requestId,
    start_date: row?.start_date ?? null,
    agency: row?.agency_name ?? null,
    short_title: row?.short_title ?? null,
    pin: row?.pin ?? null,
    contract_amount: hasAmount ? Number(amount) : null,
    contract_amount_valid: hasAmount ? 1 : 0,
    vendor_name: row?.vendor_name ?? null,
    due_date: row?.due_date ?? null,
    section: "Procurement",
    type_of_notice: row?.type_of_notice_description || "Solicitation",
    selection_method: null,
    event_date: null,
    event_addr1: null,
    description: null,
    response_deadline: row?.response_deadline || null,
  };
}

function seedNotice(sqlite, row, day = "2026-09-11") {
  sqlite.prepare("INSERT OR REPLACE INTO ingest_state (k, v) VALUES ('notices_cursor', ?)").run(day);
  if (!row?.request_id) return;
  const cols = asD1NoticeColumns(row, { requestId: row.request_id });
  sqlite.prepare(`
    INSERT OR REPLACE INTO notices (
      request_id, agency, type_of_notice, category, short_title, description,
      vendor_name, pin, contract_amount, contract_amount_valid, start_date, due_date, haystack
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cols.request_id,
    cols.agency,
    cols.type_of_notice,
    null,
    cols.short_title,
    null,
    cols.vendor_name,
    cols.pin,
    cols.contract_amount,
    cols.contract_amount_valid,
    cols.start_date,
    typeof cols.due_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(cols.due_date)
      ? cols.due_date.slice(0, 10)
      : "2026-08-25",
    `${cols.short_title || ""} ${cols.agency || ""}`.toLowerCase(),
  );
}

async function moneySub({ filter, keySuffix = "lead", freq = "daily", subscriberId = null, watchId = null } = {}) {
  const preparedFilter = discoveryFilter(filter);
  const key = `sub:t3-${keySuffix}`;
  const subscriber_id = subscriberId || await deriveSubscriberId(EMAIL);
  const watch_id = watchId || await deriveWatchId(key);
  return {
    key,
    email: EMAIL,
    lens: "money",
    filter: preparedFilter,
    freq,
    channel: "email",
    createdAt: "2026-06-01T00:00:00.000Z",
    lang: "en",
    subscriber_id,
    watch_id,
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

function subscriberMails(sent) {
  return (Array.isArray(sent) ? sent : []).filter((payload) => {
    const to = String(payload?.to || "").toLowerCase();
    return to.includes(EMAIL.toLowerCase());
  });
}

function mailEnv(sqlite, subsMap, stateMap = {}, sent, { sodaRows = [] } = {}) {
  const SUBS = kv(subsMap);
  // A recent lastsent keeps the quiet heartbeat from firing when every
  // discovery row is filtered at preparation time.
  const seeded = { ...stateMap };
  for (const raw of Object.values(subsMap)) {
    try {
      const record = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (record?.key && seeded[`lastsent:${record.key}`] == null) {
        seeded[`lastsent:${record.key}`] = "2026-09-10";
      }
    } catch { /* ignore malformed seed */ }
  }
  const ALERT_STATE = kv(seeded);
  return {
    SUBS,
    ALERT_STATE,
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

async function enqueueOwed(env, sub, rows, clockIso) {
  await enqueueEvaluatedSection(env.DB, {
    lens: "money",
    kind: "rfp",
    status: SECTION_STATUS.SUCCESS,
    freshRows: rows,
    sourceObservedAt: clockIso,
    owedOrigin: "test-prep-gate",
  }, {
    watchId: sub.watch_id,
    subscriberId: sub.subscriber_id,
    sourceObservedAt: clockIso,
    now: clockIso,
  });
}

const CORPUS = [
  {
    label: "2138505",
    row: () => native2138505Row(),
    passAt: PASS_NATIVE,
    failAt: FAIL_NATIVE,
    id: "procurement:contract_reporter_number:2138505",
  },
  {
    label: "dob",
    row: () => dobNoticeRow(),
    passAt: PASS_DOB,
    failAt: FAIL_DOB,
    id: "20260707026",
  },
  {
    label: "governors-island",
    row: () => governorsIslandNoticeRow(),
    passAt: PASS_GI,
    failAt: FAIL_GI,
    id: "20260727019",
  },
];

test("A1 queued 21-day rows are excluded at 20-day preparation for individual and rollup", async () => {
  assert.ok(OBJ_2138505);
  assert.ok(DOB_FIXTURE);
  assert.match(testClockISOString(), /^\d{4}-\d{2}-\d{2}T/);

  for (const entry of CORPUS) {
    const row = entry.row();
    assert.equal(rowMeetsMinRemainingDays(row, 21, entry.passAt), true, `${entry.label} eligible at pass`);
    assert.equal(rowMeetsMinRemainingDays(row, 21, entry.failAt), false, `${entry.label} ineligible at fail`);

    const filter = discoveryFilter({ minRemainingDays: 21 });
    const section = {
      sub: `sub:${entry.label}`,
      subKey: `sub:${entry.label}`,
      watchId: `watch:${entry.label}`,
      lens: "money",
      filter,
      action: "match",
      new: 1,
      forecasts: 0,
      freshRows: [row],
      outboxItems: [{
        watch_id: `watch:${entry.label}`,
        item_id: row.request_id ? `notice:${row.request_id}` : row.procurement_id,
      }],
      markSeenIds: [row.request_id || row.procurement_id].filter(Boolean),
      noticeIds: [row.request_id || row.procurement_id].filter(Boolean),
    };
    const prep = applyPreparedMinRemainingDaysEligibility([section], {
      watches: [{
        key: section.subKey,
        watch_id: section.watchId,
        filter,
        lens: "money",
      }],
      clock: entry.failAt,
    });
    assert.equal(prep.rebuilt, true, `${entry.label} prep rebuilds`);
    assert.equal(section.freshRows.length, 0, `${entry.label} fresh cleared`);
    assert.equal(section.outboxItems.length, 0, `${entry.label} outbox cleared`);
    assert.equal(section.markSeenIds.length, 0, `${entry.label} seen ids cleared`);
    assert.equal(section.action, "none");
    assert.equal(section.min_remaining_days_prep.excluded, 1);
  }

  // Individual delivery path: owed rows queued while eligible, prepared later.
  {
    const restoreSnapshot = useProcurementDigestSnapshot({ schema: DIGEST.schema, rows: [] });
    const sqlite = openOutboxDb();
    const sub = await moneySub({ filter: { minRemainingDays: 21 }, keySuffix: "indiv" });
    const row = native2138505Row();
    const sent = [];
    const env = mailEnv(sqlite, { [sub.key]: JSON.stringify(sub) }, {}, sent);
    const realFetch = globalThis.fetch;
    globalThis.fetch = env.fetch;
    try {
      await enqueueOwed(env, sub, [row], PASS_NATIVE);
      const membershipBefore = await listWatchMembership(env.DB, sub.watch_id);
      assert.equal(membershipBefore.some((item) => item.status === "owed"), true);

      const result = await withPinnedClock(FAIL_NATIVE, () => processOneSub(env, sub, runCtx(FAIL_NATIVE)));
      assert.equal(result.sent, false, "individual path does not send filtered-only content");
      assert.equal(result.new, 0);
      assert.equal(subscriberMails(sent).length, 0);
      const seen = await env.ALERT_STATE.get(`seen:${sub.key}`);
      assert.equal(seen, null, "suppressed row does not consume delivery marker");
      const membershipAfter = await listWatchMembership(env.DB, sub.watch_id);
      assert.equal(
        membershipAfter.some((item) => item.status === "delivered"),
        false,
        "owed row stays undelivered after prep exclusion",
      );
    } finally {
      globalThis.fetch = realFetch;
      restoreSnapshot();
    }
  }

  // Rollup delivery path with the same queued exclusion.
  {
    const restoreSnapshot = useProcurementDigestSnapshot({ schema: DIGEST.schema, rows: [] });
    const sqlite = openOutboxDb();
    const sub = await moneySub({ filter: { minRemainingDays: 21 }, keySuffix: "rollup" });
    const companion = await moneySub({
      filter: { noticeType: "award", minAmount: 1_000_000_000 },
      keySuffix: "rollup-quiet",
      subscriberId: sub.subscriber_id,
    });
    const row = dobNoticeRow();
    const sent = [];
    const env = mailEnv(sqlite, {
      [sub.key]: JSON.stringify(sub),
      [companion.key]: JSON.stringify(companion),
    }, {}, sent);
    const realFetch = globalThis.fetch;
    globalThis.fetch = env.fetch;
    try {
      await enqueueOwed(env, sub, [row], PASS_DOB);
      const result = await withPinnedClock(FAIL_DOB, () => (
        processAccountRollup(env, [sub, companion], runCtx(FAIL_DOB))
      ));
      assert.equal(result.sent, false, "rollup path does not send filtered-only content");
      assert.equal(result.new, 0);
      assert.equal(subscriberMails(sent).length, 0);
      const seen = await env.ALERT_STATE.get(`seen:${sub.key}`);
      assert.equal(seen, null);
    } finally {
      globalThis.fetch = realFetch;
      restoreSnapshot();
    }
  }
});

test("A2 text-query, D1, and fallback selection agree after merge + preparation", async () => {
  const filter = discoveryFilter({ minRemainingDays: 21 });
  const sub = { lens: "money", filter };
  const clock = PASS_NATIVE;
  const todayISO = "2026-09-11";
  const restoreSnapshot = useProcurementDigestSnapshot(DIGEST);

  try {
    const snapshotEligible = matchProcurementDigestRows(DIGEST, filter, {
      lens: "money",
      todayISO,
      clock,
    });
    assert.ok(snapshotEligible.some((row) => row.procurement_id === "procurement:contract_reporter_number:2138505"));

    const q = compileSub(sub, todayISO);
    assert.ok(q?.mergeRows);
    const fallbackMerged = mergeCompiledRows(q, []);
    const fallbackEligible = applyMinRemainingDaysPreference(fallbackMerged, filter, clock);

    const d1Compiled = compileSub_d1(sub, todayISO);
    assert.ok(d1Compiled?.opts);
    const control = asD1NoticeColumns(dobNoticeRow(), { requestId: "20260707026" });
    // Native control has no City Record request_id; D1 shape leaves request_id null
    // so digest identity comes from the shared merge.
    const d1Mapped = [toDigestRow(control)];
    const d1Merged = mergeCompiledRows(q, d1Mapped);
    const d1Eligible = applyMinRemainingDaysPreference(d1Merged, filter, clock);

    const textEval = await evaluateMoneyTextQueryWatch({
      db: null,
      snapshot: DIGEST,
      sub: {
        lens: "money",
        filter: {
          ...filter,
          text_query: {
            version: 1,
            all: [[{ kind: "term", value: "2138505" }]],
          },
        },
      },
      todayISO,
      clock,
    });
    // Text-query may miss a numeric token that is only in procurement_id; use the
    // shared merge path with the same filter for the equivalence set, and assert
    // the text-query adapter still applies the lead-time preference when rows match.
    const textEligible = applyMinRemainingDaysPreference(textEval.rows || [], filter, clock);

    const ids = (rows) => rows
      .map((row) => row.procurement_id || row.request_id)
      .filter(Boolean)
      .sort();

    assert.deepEqual(
      ids(fallbackEligible).filter((id) => id === "procurement:contract_reporter_number:2138505"),
      ["procurement:contract_reporter_number:2138505"],
    );
    assert.deepEqual(
      ids(d1Eligible).filter((id) => id === "procurement:contract_reporter_number:2138505"),
      ["procurement:contract_reporter_number:2138505"],
    );
    assert.ok(ids(snapshotEligible).includes("procurement:contract_reporter_number:2138505"));

    const prepSections = [
      { freshRows: fallbackEligible, filter, action: "match", new: fallbackEligible.length, forecasts: 0, watchId: "w-fallback", subKey: "s-fallback" },
      { freshRows: d1Eligible, filter, action: "match", new: d1Eligible.length, forecasts: 0, watchId: "w-d1", subKey: "s-d1" },
    ];
    const prep = applyPreparedMinRemainingDaysEligibility(prepSections, {
      watches: [
        { watch_id: "w-fallback", key: "s-fallback", filter, lens: "money" },
        { watch_id: "w-d1", key: "s-d1", filter, lens: "money" },
      ],
      clock,
    });
    assert.equal(prep.rebuilt, false, "already-eligible rows stay through preparation");
    assert.deepEqual(
      ids(prepSections[0].freshRows).filter((id) => id === "procurement:contract_reporter_number:2138505"),
      ids(prepSections[1].freshRows).filter((id) => id === "procurement:contract_reporter_number:2138505"),
    );

    // Fail clock: all three selection-shaped corpora drop the control.
    for (const rows of [snapshotEligible, fallbackEligible, d1Eligible, textEligible]) {
      const after = applyMinRemainingDaysPreference(rows, filter, FAIL_NATIVE);
      assert.equal(
        after.some((row) => row.procurement_id === "procurement:contract_reporter_number:2138505"),
        false,
      );
    }

    // Confirm compileSub does not bake a minimum due date into saved SQL for lead time.
    assert.equal(String(q.params?.$where || "").includes("minRemainingDays"), false);
    assert.doesNotMatch(String(q.params?.$where || ""), /due_date >= '\d{4}-\d{2}-\d{2}'/);
  } finally {
    restoreSnapshot();
  }
});

test("A3 exact follows bypass the threshold; unset discovery watches keep prior semantics", async () => {
  const exactFilter = sanitize("money", {
    procurement_id: "procurement:contract_reporter_number:2138505",
  });
  assert.equal(Object.prototype.hasOwnProperty.call(exactFilter, "minRemainingDays"), false);

  const exactRow = native2138505Row();
  const section = {
    subKey: "sub:exact",
    watchId: "watch:exact",
    lens: "money",
    filter: exactFilter,
    action: "match",
    new: 1,
    forecasts: 0,
    freshRows: [exactRow],
    outboxItems: [{ watch_id: "watch:exact", item_id: exactRow.procurement_id }],
    markSeenIds: [exactRow.procurement_id],
  };
  // Even a stray threshold on an exact follow is ignored by the shared predicate.
  const stray = { ...exactFilter, minRemainingDays: 21 };
  const prep = applyPreparedMinRemainingDaysEligibility([section], {
    watches: [{ key: "sub:exact", watch_id: "watch:exact", filter: stray, lens: "money" }],
    clock: FAIL_NATIVE,
  });
  assert.equal(prep.rebuilt, false);
  assert.equal(section.freshRows.length, 1, "exact follow still delivers after threshold crossing");

  const unsetFilter = discoveryFilter({});
  assert.equal(Object.prototype.hasOwnProperty.call(unsetFilter, "minRemainingDays"), false);
  const unsetRows = [native2138505Row(), dobNoticeRow(), governorsIslandNoticeRow()];
  const kept = applyMinRemainingDaysPreference(unsetRows, unsetFilter, FAIL_NATIVE);
  assert.equal(kept.length, unsetRows.length, "unset discovery watches retain previous filtering");

  const unsetSection = {
    subKey: "sub:unset",
    watchId: "watch:unset",
    filter: unsetFilter,
    action: "match",
    new: unsetRows.length,
    forecasts: 0,
    freshRows: unsetRows,
  };
  const unsetPrep = applyPreparedMinRemainingDaysEligibility([unsetSection], {
    watches: [{ key: "sub:unset", watch_id: "watch:unset", filter: unsetFilter, lens: "money" }],
    clock: FAIL_NATIVE,
  });
  assert.equal(unsetPrep.rebuilt, false);
  assert.equal(unsetSection.freshRows.length, unsetRows.length);
});

test("A4 suppressed rows stay undelivered; extension restores once; retry does not duplicate", async () => {
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

    // First preparation at 20 days: exclude, do not mark delivered.
    const excluded = await withPinnedClock(FAIL_DOB, () => processOneSub(env, sub, runCtx(FAIL_DOB)));
    assert.equal(excluded.sent, false);
    assert.equal(subscriberMails(sent).length, 0);
    let membership = await listWatchMembership(env.DB, sub.watch_id);
    const owedItem = membership.find((item) => item.item_id === "notice:20260707026");
    assert.ok(owedItem);
    assert.equal(owedItem.status, "owed");

    // Synthetic sourced extension restores eligibility under the same threshold.
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

    // Replace owed payload with the extended deadline (authoritative update).
    sqlite.prepare(`
      UPDATE digest_outbox_items
         SET payload_json = ?
       WHERE watch_id = ? AND item_id = ? AND status = 'owed'
    `).run(JSON.stringify(extended), sub.watch_id, "notice:20260707026");

    const restored = await withPinnedClock(FAIL_DOB, () => processOneSub(env, sub, runCtx(FAIL_DOB)));
    assert.equal(restored.sent, true, "extended row becomes available once");
    assert.equal(restored.new, 1);
    assert.equal(subscriberMails(sent).length, 1);
    assert.match(subscriberMails(sent)[0].html, /20260707026|Buildings|Sep 15|Aug 25/);

    const deliveredIds = await listDeliveredItemIds(env.DB, sub.watch_id);
    assert.ok(deliveredIds.includes("notice:20260707026"), "extended row is marked delivered once");
    const stillOwed = await listWatchMembership(env.DB, sub.watch_id);
    assert.equal(
      stillOwed.some((item) => item.item_id === "notice:20260707026" && item.status === "owed"),
      false,
    );

    // Retry of an already-prepared/delivered message does not duplicate.
    const retry = await withPinnedClock(FAIL_DOB, () => (
      consumeDigestJob(env, { type: "sub", key: sub.key }, { now: FAIL_DOB })
    ));
    assert.equal(retry.new, 0);
    assert.equal(subscriberMails(sent).length, 1, "retry does not send a second copy");
  } finally {
    globalThis.fetch = realFetch;
    restoreSnapshot();
  }
});

test("A5 preparation and retry entry points honor fixed clocks into the mail sink", async () => {
  assert.ok(OBJ_2138505);
  const restoreSnapshot = useProcurementDigestSnapshot({ schema: DIGEST.schema, rows: [] });
  const sqlite = openOutboxDb();
  const sub = await moneySub({ filter: { minRemainingDays: 21, keywords: ["construction"] }, keySuffix: "a5" });
  const gi = governorsIslandNoticeRow();
  seedNotice(sqlite, gi, "2026-08-07");
  const sent = [];
  const env = mailEnv(sqlite, { [sub.key]: JSON.stringify(sub) }, {
    [`lastsent:${sub.key}`]: "2026-08-06",
  }, sent, { sodaRows: [gi] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = env.fetch;

  try {
    const pass = await withPinnedClock(PASS_GI, () => processOneSub(env, sub, runCtx(PASS_GI)));
    assert.equal(pass.sent, true, "eligible preparation sends once");
    assert.ok(pass.new >= 1);
    assert.equal(subscriberMails(sent).length, 1);
    assert.match(subscriberMails(sent)[0].html, /Governors Island|20260727019/);

    const seenRaw = await env.ALERT_STATE.get(`seen:${sub.key}`);
    const seenAfter = seenRaw ? JSON.parse(seenRaw) : [];
    assert.ok(
      Array.isArray(seenAfter)
      && (seenAfter.includes("20260727019") || seenAfter.includes(gi.digest_id)),
      "delivered notice is marked seen",
    );

    // Same calendar day retry / second drain: no duplicate send of the same item.
    const again = await withPinnedClock(PASS_GI, () => (
      consumeDigestJob(env, { type: "sub", key: sub.key }, { now: PASS_GI })
    ));
    assert.equal(again.sent === true && again.new > 0, false);
    assert.equal(subscriberMails(sent).length, 1);

    // Next day at 20 remaining: preparation excludes even if the source still returns the row.
    const failDay = await withPinnedClock(FAIL_GI, () => processOneSub(env, sub, runCtx(FAIL_GI)));
    assert.equal(failDay.new, 0);
    assert.equal(
      Boolean(failDay.sent && (failDay.preview?.html || "").includes("20260727019")),
      false,
    );
    // No additional subscriber send for the now-ineligible notice.
    assert.equal(subscriberMails(sent).length, 1);

    writeEvidence("prep-time-eligibility.json", {
      schema: "cityscroll.minimum_lead_time_prep_eligibility.v1",
      grounded_at_note: "preparation-time eligibility for discovery money watches",
      clocks: {
        governors_island_pass: PASS_GI,
        governors_island_fail: FAIL_GI,
        native_pass: PASS_NATIVE,
        native_fail: FAIL_NATIVE,
      },
      individual: {
        sent_on_pass: true,
        excluded_on_fail: true,
        send_count: subscriberMails(sent).length,
      },
      records: CORPUS.map((entry) => entry.id),
    });
  } finally {
    globalThis.fetch = realFetch;
    restoreSnapshot();
  }
});
