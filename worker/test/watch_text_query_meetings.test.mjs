import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { processOneSub } from "../src/alerts.mjs";
import { handleFeed } from "../src/feed.mjs";
import { handleFollowing } from "../src/following.mjs";
import { compileSub, scopedMeetingWatchRows } from "../src/lib/compile.mjs";
import { applyWatchPatch } from "../src/lib/prefs.mjs";
import { prepareWatchFilter, sanitize } from "../src/lib/filter.mjs";
import { describeFilter } from "../src/lib/confirm_email.mjs";
import { MEETING_MANIFEST_KEY } from "../src/lib/route_read_model_kv.mjs";
import {
  QUERY_REVISION_SUPPRESSION,
  owedPayloadMatchesExpression,
  queryRevisionForFilter,
  stampWatchQueryRevision,
} from "../src/lib/watch_query_revision.mjs";
import {
  cityRecordNoticeId,
  evaluateMeetingTextQueryWatch,
  meetingRowsFromNoticeMaterialization,
} from "../src/lib/watch_text_query_meetings.mjs";
import { TEXT_QUERY_EVAL_STATUS } from "../src/lib/evaluate_watch_text_query.mjs";
import {
  MEETING_BODY_STATUS,
  evaluateMeetingRecords,
  meetingBodyStatus,
  projectMeetingNoticeFields,
} from "../../site/watch_text_query_eval.mjs";
import { matchesTextQuery as matchFields } from "../../site/watch_text_query.mjs";

const CLOCK = "2026-09-01";
const NOW = new Date("2026-09-01T13:00:00.000Z");
const RAT_ID = "20260803009";
const TRANSLATION_ID = "20260106034";
const CART_PHRASE = "communication access realtime translation";

const materialization = JSON.parse(readFileSync(
  new URL("../../site/data/meeting_notice_materialization.json", import.meta.url),
  "utf8",
));
const titleSnapshot = JSON.parse(readFileSync(
  new URL("../../test/fixtures/watch_text_query/procurement_titles_snapshot.json", import.meta.url),
  "utf8",
));
const migration = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");

const meetingRows = meetingRowsFromNoticeMaterialization(materialization.rows);
const strategyTitle = titleSnapshot.rows.find((row) => /strategy/i.test(row.short_title || ""))?.short_title;

const term = (value) => ({ kind: "term", value });
const phrase = (value) => ({ kind: "phrase", value });
const expr = (all, none = []) => ({ version: 1, all, none });

const RAT = expr([[term("rat")]]);
const TRANSLATION = expr([[term("translation")]]);
const ANY_RAT_OR_CORRECTION = expr([[term("rat"), term("correction")]]);
const PHRASE_RAT_INSPECTIONS = expr([[phrase("rat inspections")]]);
const EXCLUDE_CART = expr([[term("rat"), term("correction")]], [phrase(CART_PHRASE)]);

function noticeId(row) {
  return cityRecordNoticeId(row);
}

function idsOf(rows) {
  return [...new Set(rows.map(noticeId).filter(Boolean))].sort();
}

function watch(filter, extra = {}) {
  const prepared = prepareWatchFilter("meetings", { keywords: [], ...filter });
  assert.equal(prepared.ok, true, prepared.reason);
  return {
    key: extra.key || "sub:meetings-precise",
    email: extra.email || "owed@example.com",
    lens: "meetings",
    filter: prepared.filter,
    freq: "daily",
    channel: "email",
    lang: "en",
    subscriber_id: extra.subscriber_id || "subscriber:meetings",
    watch_id: extra.watch_id || "watch:meetings-precise",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function meetingKv(rows) {
  const key = "meetings:v1:test:2026-09";
  const values = new Map([
    [MEETING_MANIFEST_KEY, JSON.stringify({
      schema_version: 1,
      kind: "meetings",
      version: "test",
      slices: { "2026-09": key },
    })],
    [key, JSON.stringify({ rows })],
  ]);
  return {
    get: async (name) => values.get(name) || null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true }),
  };
}

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(migration);
  return {
    sqlite,
    DB: {
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
    },
  };
}

function envForMeetings(rows) {
  const { sqlite, DB } = d1();
  return {
    sqlite,
    env: {
      DB,
      ALERT_STATE: meetingKv(rows),
      ALERTS_LIVE: "true",
      RESEND_API_KEY: "test",
      TOKEN_SECRET: "s".repeat(32),
      CONFIRM_BASE: "https://api.cityscroll.org",
      MAX_PER_RUN: "25",
      MAX_SENDS_PER_DAY: "50",
      GIT_COMMIT_SHA: "test",
    },
  };
}

function runCtx() {
  let sends = 0;
  return {
    FROM: "CityScroll <alerts@cityscroll.org>",
    LIVE: true,
    today: CLOCK,
    now: NOW,
    isMonday: false,
    heartbeatDays: 14,
    counts: () => ({ "per-run": sends, daily: sends }),
    caps: { "per-run": 25, daily: 50 },
    onSent: async () => { sends += 1; },
    capturePreviews: true,
  };
}

async function withFetch(fn) {
  const original = globalThis.fetch;
  const soda = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("api.resend.com/emails")) {
      return { ok: true, json: async () => ({ id: "provider:test" }) };
    }
    if (target.includes("data.cityofnewyork.us") || target.includes("resource/")) {
      soda.push(target);
      throw new Error(`publisher fetch is not allowed on precise evaluation: ${target}`);
    }
    return { ok: true, json: async () => [] };
  };
  try {
    return await fn(soda);
  } finally {
    globalThis.fetch = original;
  }
}

test("A1: whole-token rat admits 20260803009; Strategy is a lexical negative, not a meeting", async () => {
  assert.ok(strategyTitle, "frozen procurement snapshot still has a Strategy title");
  assert.match(strategyTitle, /Strategy/i);
  assert.equal(matchFields([strategyTitle], RAT), false, "rat must not match Strategy as a substring");

  const evaluated = await evaluateMeetingTextQueryWatch({
    sub: watch({ text_query: RAT }),
    todayISO: CLOCK,
    clock: CLOCK,
    sourceRows: meetingRows,
  });
  assert.equal(evaluated.status, TEXT_QUERY_EVAL_STATUS.complete);
  assert.deepEqual(idsOf(evaluated.rows), [RAT_ID]);
  const admitted = evaluated.rows[0];
  assert.equal(admitted.title || admitted.short_title, "New Rules Relating to Rat Inspections");
  assert.equal(evaluated.rows.some((row) => /strategy/i.test(row.title || row.short_title || "")), false);
});

test("A2: grouped alternatives, required phrases, and exclusions share preview/save/email/feed rows", async () => {
  const { env, sqlite } = envForMeetings(meetingRows);
  const grouped = watch({ text_query: ANY_RAT_OR_CORRECTION });
  const excluded = watch({ text_query: EXCLUDE_CART });
  const phrased = watch({ text_query: PHRASE_RAT_INSPECTIONS });

  const groupedEval = await evaluateMeetingTextQueryWatch({
    env, sub: grouped, todayISO: CLOCK, clock: CLOCK, sourceRows: meetingRows,
  });
  assert.deepEqual(idsOf(groupedEval.rows), [TRANSLATION_ID, RAT_ID].sort());

  const excludedEval = await evaluateMeetingTextQueryWatch({
    env, sub: excluded, todayISO: CLOCK, clock: CLOCK, sourceRows: meetingRows,
  });
  assert.deepEqual(idsOf(excludedEval.rows), [RAT_ID]);

  const phraseEval = await evaluateMeetingTextQueryWatch({
    env, sub: phrased, todayISO: CLOCK, clock: CLOCK, sourceRows: meetingRows,
  });
  assert.deepEqual(idsOf(phraseEval.rows), [RAT_ID]);

  const preview = await handleFollowing(
    new Request("https://cityscroll.org/following/?lens=meetings&tq_i0=rat&tq_i1=correction"),
    env,
    {},
    { todayISO: CLOCK, sourceRows: meetingRows, fetchImpl: async () => { throw new Error("publisher fetch is forbidden"); } },
  );
  const previewHtml = await preview.text();
  assert.match(previewHtml, new RegExp(RAT_ID));
  assert.match(previewHtml, new RegExp(TRANSLATION_ID));
  assert.match(previewHtml, /data-following-precise/);

  const saved = applyWatchPatch(
    { email: "owed@example.com", lens: "meetings", filter: { keywords: [] }, freq: "daily" },
    { filter: excluded.filter },
  );
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.record.filter.text_query, excluded.filter.text_query);
  assert.match(describeFilter("meetings", excluded.filter), /rat|correction/i);

  await withFetch(async (soda) => {
    const single = await processOneSub(env, excluded, runCtx());
    assert.equal(soda.length, 0);
    assert.notEqual(single.skipped, "text-query-unavailable");
    const emailed = (single.noticeIds || []).join(" ");
    assert.match(emailed, new RegExp(RAT_ID));
    assert.doesNotMatch(emailed, new RegExp(TRANSLATION_ID));
  });

  const feedUrl = new URL("https://api.cityscroll.org/feed.xml");
  feedUrl.searchParams.set("lens", "meetings");
  feedUrl.searchParams.set("filter", JSON.stringify(excluded.filter));
  const feedRes = await handleFeed(new Request(feedUrl), env, {});
  assert.equal(feedRes.status, 200);
  const feedXml = await feedRes.text();
  assert.match(feedXml, new RegExp(RAT_ID));
  assert.doesNotMatch(feedXml, new RegExp(TRANSLATION_ID));

  const compiled = compileSub(excluded, CLOCK);
  assert.equal(compiled.kind, "meetings");
  assert.equal(compiled.soda, false);
  assert.ok(compiled.textQuery);
  sqlite.close();
});

test("A2: predicates run before the page limit and incomplete evaluation is preserved", async () => {
  const publicTerm = expr([[term("public")]]);
  const allMatching = evaluateMeetingRecords(meetingRows, {
    expression: publicTerm,
    limit: 500,
    scanBudget: 500,
    clock: CLOCK,
  });
  assert.ok(allMatching.rows.length > 5, "frozen projection has more than a page of public matches");
  const paged = evaluateMeetingRecords(meetingRows, {
    expression: publicTerm,
    limit: 5,
    scanBudget: 500,
    clock: CLOCK,
  });
  assert.equal(paged.rows.length, 5);
  assert.equal(paged.status, TEXT_QUERY_EVAL_STATUS.complete);
  assert.deepEqual(idsOf(paged.rows), idsOf(allMatching.rows.slice(0, 5)));

  const incomplete = evaluateMeetingRecords(meetingRows, {
    expression: publicTerm,
    limit: 25,
    scanBudget: 3,
    clock: CLOCK,
  });
  assert.equal(incomplete.status, TEXT_QUERY_EVAL_STATUS.incomplete);
  assert.equal(incomplete.reason, "scan_budget");
  assert.ok(incomplete.continuation);
  assert.equal(incomplete.markSeenIds.length, incomplete.rows.length);
});

test("A3: translation matches the Board of Correction body, not its title; CART exclusion is lexical", async () => {
  const row = meetingRows.find((item) => item.request_id === TRANSLATION_ID);
  assert.ok(row);
  assert.equal(row.short_title, "Board of Correction Public Meeting");
  assert.doesNotMatch(row.short_title, /translation/i);
  assert.match(row.additional_description_1, /Communication Access Realtime Translation/i);

  const fields = projectMeetingNoticeFields(row);
  assert.equal(matchFields([fields[0].value], TRANSLATION), false);
  assert.equal(matchFields([fields[1].value], TRANSLATION), true);

  const evaluated = await evaluateMeetingTextQueryWatch({
    sub: watch({ text_query: TRANSLATION }),
    todayISO: CLOCK,
    clock: CLOCK,
    sourceRows: meetingRows,
  });
  assert.deepEqual(idsOf(evaluated.rows), [TRANSLATION_ID]);
  const evidence = evaluated.rows[0].text_query_evidence;
  assert.equal(evidence.groups[0].field, "description");
  assert.match(evidence.groups[0].passage, /Communication Access Realtime Translation/i);
  assert.doesNotMatch(JSON.stringify(evidence), /translation policy/i);

  const preview = await handleFollowing(
    new Request("https://cityscroll.org/following/?lens=meetings&tq_i0=translation&tq_i0p=1"),
    envForMeetings(meetingRows).env,
    {},
    { todayISO: CLOCK, sourceRows: meetingRows, fetchImpl: async () => { throw new Error("publisher fetch is forbidden"); } },
  );
  const html = await preview.text();
  assert.match(html, new RegExp(TRANSLATION_ID));
  assert.match(html, /Communication Access Realtime Translation/i);

  const removed = await evaluateMeetingTextQueryWatch({
    sub: watch({ text_query: expr([[term("translation")]], [phrase(CART_PHRASE)]) }),
    todayISO: CLOCK,
    clock: CLOCK,
    sourceRows: meetingRows,
  });
  assert.deepEqual(idsOf(removed.rows), []);
  assert.equal(removed.excludedRows.some((item) => noticeId(item) === TRANSLATION_ID), true);
  assert.match(removed.excludedRows[0].text_query_evidence.exclusion.passage, /Communication Access Realtime Translation/i);
});

test("A4: missing optional body and failed body acquisition stay distinct; identity is preserved", async () => {
  const titled = {
    meeting_id: "meeting:city_record:missing-body",
    request_id: "missing-body",
    notice_id: "missing-body",
    title: "Open data working group",
    short_title: "Open data working group",
    event_date: "2026-09-20T10:00:00.000",
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/missing-body",
    agency: "Citywide Administrative Services",
  };
  const failed = {
    ...titled,
    meeting_id: "meeting:city_record:failed-body",
    request_id: "failed-body",
    notice_id: "failed-body",
    event_date: "2026-09-21T10:00:00.000",
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/failed-body",
    body_acquisition: "failed",
    additional_description_1: "this retained text must not be read after a failed acquisition",
  };
  assert.equal(meetingBodyStatus(titled), MEETING_BODY_STATUS.missing);
  assert.equal(meetingBodyStatus(failed), MEETING_BODY_STATUS.failed);

  const missingEval = evaluateMeetingRecords([titled], { expression: TRANSLATION, clock: CLOCK });
  assert.equal(missingEval.status, TEXT_QUERY_EVAL_STATUS.complete);
  assert.deepEqual(missingEval.rows, []);

  const failedEval = evaluateMeetingRecords([failed], { expression: TRANSLATION, clock: CLOCK });
  assert.equal(failedEval.status, TEXT_QUERY_EVAL_STATUS.incomplete);
  assert.equal(failedEval.reason, "body_acquisition_failed");
  assert.equal(failedEval.unevaluated, 1);
  assert.deepEqual(failedEval.rows, []);

  const titleHit = evaluateMeetingRecords([failed], { expression: expr([[term("working")]]), clock: CLOCK });
  assert.equal(titleHit.status, TEXT_QUERY_EVAL_STATUS.complete);
  assert.equal(titleHit.rows[0].meeting_id, failed.meeting_id);
  assert.equal(titleHit.rows[0].event_date, failed.event_date);
  assert.equal(titleHit.rows[0].source_url, failed.source_url);

  const correction = meetingRows.find((row) => row.request_id === TRANSLATION_ID);
  const spanned = matchFields(
    ["Board of Correction Public Meeting", "The New York City Board of Correction will hold"],
    expr([[phrase("meeting the")]]),
  );
  assert.equal(spanned, false);
  const manufactured = matchFields(
    [correction.short_title, (correction.matter_subject?.subject_tokens || []).join(" ")],
    TRANSLATION,
  );
  assert.equal(manufactured, false);
  const real = matchFields(projectMeetingNoticeFields(correction).map((field) => field.value), TRANSLATION);
  assert.equal(real, true);
});

test("A5: board, agency, and date-window predicates still bound the watch; exact identities stay exact", async () => {
  const agencyRat = await evaluateMeetingTextQueryWatch({
    sub: watch({ text_query: RAT, agency: "Health and Mental Hygiene" }),
    todayISO: CLOCK,
    clock: CLOCK,
    sourceRows: meetingRows,
  });
  assert.deepEqual(idsOf(agencyRat.rows), [RAT_ID]);

  const wrongAgency = await evaluateMeetingTextQueryWatch({
    sub: watch({ text_query: RAT, agency: "Board of Correction" }),
    todayISO: CLOCK,
    clock: CLOCK,
    sourceRows: meetingRows,
  });
  assert.deepEqual(idsOf(wrongAgency.rows), []);

  const week = scopedMeetingWatchRows({ dateWindow: "week" }, CLOCK, meetingRows);
  assert.equal(week.some((row) => noticeId(row) === RAT_ID), false, "14 September is outside a one-week window from 1 September");

  const exact = prepareWatchFilter("meetings", {
    matter_ref: "legistar:nyc:matter:79200",
    text_query: RAT,
  });
  assert.equal(exact.ok, false);
  assert.equal(compileSub({ lens: "meetings", filter: sanitize("meetings", {
    matter_ref: "legistar:nyc:matter:79200",
    text_query: RAT,
  }) }, CLOCK), null);

  const legal = prepareWatchFilter("legal_code", { provision_id: "nyc-administrative-code:1-101", text_query: RAT });
  assert.equal(legal.ok, false);
  const award = prepareWatchFilter("award", { requestId: "20260803009", text_query: RAT });
  assert.equal(award.ok, false);
});

test("A6: query-revision fingerprint and owed payload use the meeting field contract", () => {
  const left = stampWatchQueryRevision({ lens: "meetings", filter: { text_query: EXCLUDE_CART } });
  const right = stampWatchQueryRevision({
    lens: "meetings",
    filter: { text_query: expr([[term("correction"), term("rat")]], [phrase(CART_PHRASE)]) },
  });
  assert.equal(left.query_revision, right.query_revision);
  assert.equal(left.query_revision, queryRevisionForFilter({ text_query: EXCLUDE_CART }));

  const row = meetingRows.find((item) => item.request_id === TRANSLATION_ID);
  assert.equal(owedPayloadMatchesExpression(row, TRANSLATION, { lens: "meetings" }), true);
  assert.equal(owedPayloadMatchesExpression(row, EXCLUDE_CART, { lens: "meetings" }), false);
  assert.equal(QUERY_REVISION_SUPPRESSION, "cancelled:query-revision");
});
