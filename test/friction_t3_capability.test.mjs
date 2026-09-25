/**
 * Discovery money watches re-check minRemainingDays at email preparation
 * (and retry), so a yesterday-eligible preview cannot justify today's send.
 *
 * Site-node CI does not install worker mail dependencies. This file exercises
 * the shared predicate and the prepared-message cutoff without importing
 * worker/src/alerts.mjs. Full mail-sink delivery lives in
 * worker/test/friction_t3_delivery.test.mjs.
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
  procurementDigestRow,
  stampDigestIdentity,
} from "../site/procurement_digest_compile.mjs";
import {
  projectDeadlinesFromNoticeRow,
} from "../site/procurement_deadline_projection.mjs";
import {
  applyMinRemainingDaysPreference,
  applyPreparedMinRemainingDaysEligibility,
  nycCivicDayISO,
  rowMeetsMinRemainingDays,
} from "../site/money_watch_min_remaining_days.mjs";
import {
  resolveTypedSourceDeadlines,
} from "../warehouse/lib/typed_source_deadline.mjs";
import { recordsFromMtaOpportunityFixtures } from "../warehouse/lib/mta_opportunities.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { withPinnedClock, testClockISOString } from "./helpers/test_clock.mjs";
import { sanitize } from "../worker/src/lib/filter.mjs";
import { compileSub, mergeCompiledRows, useProcurementDigestSnapshot } from "../worker/src/lib/compile.mjs";
import { compileSub_d1, toDigestRow } from "../worker/src/lib/compile_d1.mjs";
import {
  SECTION_STATUS,
  enqueueEvaluatedSection,
  listDeliveredItemIds,
  listWatchMembership,
} from "../worker/src/lib/digest_outbox.mjs";
import { applyPreparedDigestQueryRevisionCutoff } from "../worker/src/lib/watch_query_revision.mjs";
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

async function moneySub({ filter, keySuffix = "lead" } = {}) {
  const preparedFilter = discoveryFilter(filter);
  const key = `sub:t3-${keySuffix}`;
  return {
    key,
    email: EMAIL,
    lens: "money",
    filter: preparedFilter,
    freq: "daily",
    channel: "email",
    createdAt: "2026-06-01T00:00:00.000Z",
    lang: "en",
    subscriber_id: await deriveSubscriberId(EMAIL),
    watch_id: await deriveWatchId(key),
  };
}

function prepCtx(iso) {
  const now = new Date(iso);
  return {
    today: now.toISOString().slice(0, 10),
    now,
    nowMs: now.getTime(),
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

/** Shape a prepared section the way individual and rollup paths hand to the cutoff. */
function preparedSection(sub, rows, { action = "match", kind = "subscription" } = {}) {
  return {
    sub: sub.key,
    subKey: sub.key,
    watchId: sub.watch_id,
    lens: "money",
    filter: sub.filter,
    kind,
    action,
    new: rows.length,
    forecasts: 0,
    freshRows: rows,
    outboxItems: rows.map((row) => ({
      watch_id: sub.watch_id,
      item_id: row.request_id ? `notice:${row.request_id}` : row.procurement_id,
    })),
    markSeenIds: rows.map((row) => row.request_id || row.procurement_id).filter(Boolean),
    noticeIds: rows.map((row) => row.request_id || row.procurement_id).filter(Boolean),
  };
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
  // Bare civic-day strings must not shift under timezone conversion.
  assert.equal(nycCivicDayISO("2026-09-12"), "2026-09-12");

  for (const entry of CORPUS) {
    const row = entry.row();
    await withPinnedClock(entry.passAt, () => {
      assert.equal(rowMeetsMinRemainingDays(row, 21, entry.passAt), true, `${entry.label} eligible at pass`);
    });
    await withPinnedClock(entry.failAt, () => {
      assert.equal(rowMeetsMinRemainingDays(row, 21, entry.failAt), false, `${entry.label} ineligible at fail`);
    });

    const filter = discoveryFilter({ minRemainingDays: 21 });
    const section = preparedSection({
      key: `sub:${entry.label}`,
      watch_id: `watch:${entry.label}`,
      filter,
    }, [row]);
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

  // Individual prepared-message boundary: owed row queued while eligible, cutoff at fail clock.
  {
    const sqlite = openOutboxDb();
    const sub = await moneySub({ filter: { minRemainingDays: 21 }, keySuffix: "indiv" });
    const row = native2138505Row();
    const env = { SUBS: kv({ [sub.key]: JSON.stringify(sub) }), DB: d1(sqlite) };
    await enqueueOwed(env, sub, [row], PASS_NATIVE);
    const membershipBefore = await listWatchMembership(env.DB, sub.watch_id);
    assert.equal(membershipBefore.some((item) => item.status === "owed"), true);

    const section = preparedSection(sub, [row]);
    const cutoff = await withPinnedClock(FAIL_NATIVE, () => (
      applyPreparedDigestQueryRevisionCutoff(env, [sub], [section], prepCtx(FAIL_NATIVE))
    ));
    assert.ok(cutoff.min_remaining_days_exclusions.length >= 1);
    assert.equal(section.freshRows.length, 0);
    assert.equal(section.outboxItems.length, 0);
    assert.equal(section.action, "none");
    const membershipAfter = await listWatchMembership(env.DB, sub.watch_id);
    assert.equal(
      membershipAfter.some((item) => item.status === "delivered"),
      false,
      "cutoff exclusion does not consume the delivery marker",
    );
    assert.equal(
      (await listDeliveredItemIds(env.DB, sub.watch_id)).length,
      0,
    );
  }

  // Rollup-shaped sections share the same cutoff.
  {
    const sqlite = openOutboxDb();
    const sub = await moneySub({ filter: { minRemainingDays: 21 }, keySuffix: "rollup" });
    const companion = await moneySub({
      filter: { noticeType: "award", minAmount: 1_000_000_000 },
      keySuffix: "rollup-quiet",
    });
    companion.subscriber_id = sub.subscriber_id;
    const row = dobNoticeRow();
    const env = {
      SUBS: kv({
        [sub.key]: JSON.stringify(sub),
        [companion.key]: JSON.stringify(companion),
      }),
      DB: d1(sqlite),
    };
    await enqueueOwed(env, sub, [row], PASS_DOB);
    const sections = [
      preparedSection(sub, [row], { kind: "rollup" }),
      preparedSection(companion, [], { action: "none", kind: "rollup" }),
    ];
    await withPinnedClock(FAIL_DOB, () => (
      applyPreparedDigestQueryRevisionCutoff(env, [sub, companion], sections, prepCtx(FAIL_DOB))
    ));
    assert.equal(sections[0].freshRows.length, 0);
    assert.equal(sections[0].outboxItems.length, 0);
    assert.equal(sections[0].action, "none");
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
    const fallbackEligible = applyMinRemainingDaysPreference(mergeCompiledRows(q, []), filter, clock);

    const d1Compiled = compileSub_d1(sub, todayISO);
    assert.ok(d1Compiled?.opts);
    const control = asD1NoticeColumns(dobNoticeRow(), { requestId: "20260707026" });
    const d1Eligible = applyMinRemainingDaysPreference(
      mergeCompiledRows(q, [toDigestRow(control)]),
      filter,
      clock,
    );

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
    const textEligible = applyMinRemainingDaysPreference(textEval.rows || [], filter, clock);

    const ids = (rows) => rows
      .map((row) => row.procurement_id || row.request_id)
      .filter(Boolean)
      .sort();

    assert.ok(ids(fallbackEligible).includes("procurement:contract_reporter_number:2138505"));
    assert.ok(ids(d1Eligible).includes("procurement:contract_reporter_number:2138505"));
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

    for (const rows of [snapshotEligible, fallbackEligible, d1Eligible, textEligible]) {
      const after = applyMinRemainingDaysPreference(rows, filter, FAIL_NATIVE);
      assert.equal(
        after.some((row) => row.procurement_id === "procurement:contract_reporter_number:2138505"),
        false,
      );
    }

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
  const section = preparedSection({
    key: "sub:exact",
    watch_id: "watch:exact",
    filter: exactFilter,
  }, [exactRow]);
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

  const unsetSection = preparedSection({
    key: "sub:unset",
    watch_id: "watch:unset",
    filter: unsetFilter,
  }, unsetRows);
  const unsetPrep = applyPreparedMinRemainingDaysEligibility([unsetSection], {
    watches: [{ key: "sub:unset", watch_id: "watch:unset", filter: unsetFilter, lens: "money" }],
    clock: FAIL_NATIVE,
  });
  assert.equal(unsetPrep.rebuilt, false);
  assert.equal(unsetSection.freshRows.length, unsetRows.length);
});

test("A4 suppressed rows stay undelivered; extension restores once; retry does not duplicate", async () => {
  const sqlite = openOutboxDb();
  const sub = await moneySub({ filter: { minRemainingDays: 21 }, keySuffix: "a4" });
  const row = dobNoticeRow();
  const env = { SUBS: kv({ [sub.key]: JSON.stringify(sub) }), DB: d1(sqlite) };
  await enqueueOwed(env, sub, [row], PASS_DOB);

  const section = preparedSection(sub, [row]);
  await withPinnedClock(FAIL_DOB, () => (
    applyPreparedDigestQueryRevisionCutoff(env, [sub], [section], prepCtx(FAIL_DOB))
  ));
  assert.equal(section.freshRows.length, 0);
  assert.equal(section.outboxItems.length, 0);
  let membership = await listWatchMembership(env.DB, sub.watch_id);
  const owedItem = membership.find((item) => item.item_id === "notice:20260707026");
  assert.ok(owedItem);
  assert.equal(owedItem.status, "owed");
  assert.equal((await listDeliveredItemIds(env.DB, sub.watch_id)).length, 0);

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

  const restoredSection = preparedSection(sub, [extended]);
  await withPinnedClock(FAIL_DOB, () => (
    applyPreparedDigestQueryRevisionCutoff(env, [sub], [restoredSection], prepCtx(FAIL_DOB))
  ));
  assert.equal(restoredSection.freshRows.length, 1, "extended row becomes available once");
  assert.equal(restoredSection.outboxItems.length, 1);

  // Retry of the same prepared batch does not invent a second delivery marker.
  await withPinnedClock(FAIL_DOB, () => (
    applyPreparedDigestQueryRevisionCutoff(env, [sub], [restoredSection], prepCtx(FAIL_DOB))
  ));
  assert.equal(restoredSection.freshRows.length, 1);
  assert.equal((await listDeliveredItemIds(env.DB, sub.watch_id)).length, 0);
  membership = await listWatchMembership(env.DB, sub.watch_id);
  assert.equal(membership.find((item) => item.item_id === "notice:20260707026")?.status, "owed");
});

test("A5 preparation and retry entry points honor fixed clocks at the prepared-message boundary", async () => {
  assert.ok(OBJ_2138505);
  const sqlite = openOutboxDb();
  const sub = await moneySub({
    filter: { minRemainingDays: 21, keywords: ["construction"] },
    keySuffix: "a5",
  });
  const gi = governorsIslandNoticeRow();
  const env = { SUBS: kv({ [sub.key]: JSON.stringify(sub) }), DB: d1(sqlite) };

  const passSection = preparedSection(sub, [gi]);
  const passCutoff = await withPinnedClock(PASS_GI, () => (
    applyPreparedDigestQueryRevisionCutoff(env, [sub], [passSection], prepCtx(PASS_GI))
  ));
  assert.equal(passCutoff.min_remaining_days_exclusions.length, 0);
  assert.equal(passSection.freshRows.length, 1);
  assert.match(
    JSON.stringify(passSection.freshRows[0]),
    /Governors Island|20260727019/,
  );

  // Same-clock retry keeps the eligible row once; no duplicate exclusion/rebuild.
  const retrySection = preparedSection(sub, [gi]);
  await withPinnedClock(PASS_GI, () => (
    applyPreparedDigestQueryRevisionCutoff(env, [sub], [retrySection], prepCtx(PASS_GI))
  ));
  assert.equal(retrySection.freshRows.length, 1);

  // Next day at 20 remaining: preparation excludes even when the source still returns the row.
  const failSection = preparedSection(sub, [gi]);
  const failCutoff = await withPinnedClock(FAIL_GI, () => (
    applyPreparedDigestQueryRevisionCutoff(env, [sub], [failSection], prepCtx(FAIL_GI))
  ));
  assert.equal(failSection.freshRows.length, 0);
  assert.equal(failSection.outboxItems.length, 0);
  assert.ok(failCutoff.min_remaining_days_exclusions.some((entry) => (
    entry.request_id === "20260727019" || entry.digest_id === "20260727019"
  )));

  writeEvidence("prep-time-eligibility.json", {
    schema: "cityscroll.minimum_lead_time_prep_eligibility.v1",
    grounded_at_note: "preparation-time eligibility for discovery money watches",
    clocks: {
      governors_island_pass: PASS_GI,
      governors_island_fail: FAIL_GI,
      native_pass: PASS_NATIVE,
      native_fail: FAIL_NATIVE,
    },
    prepared_message_boundary: "applyPreparedDigestQueryRevisionCutoff",
    individual: {
      kept_on_pass: true,
      excluded_on_fail: true,
    },
    records: CORPUS.map((entry) => entry.id),
  });
});
