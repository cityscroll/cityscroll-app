/**
 * Discovery money watches keep a rolling minimum lead-time preference
 * (`minRemainingDays`) through editor, save, admission, and preview.
 *
 *   node --test test/friction_t2_capability.test.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  matchProcurementDigestRows,
  mergeProcurementDigestMatches,
  procurementDigestRow,
} from "../site/procurement_digest_compile.mjs";
import {
  DEADLINE_TRANSPORT_STATUS,
  projectDeadlinesFromNoticeRow,
} from "../site/procurement_deadline_projection.mjs";
import {
  admitMinRemainingDays,
  applyMinRemainingDaysPreference,
  minRemainingDaysCalendarUnavailableMessage,
  minRemainingDaysControlCopy,
  nycCivicDayISO,
  responseDeadlineRemainingDays,
  rowMeetsMinRemainingDays,
  validateMinRemainingDays,
} from "../site/money_watch_min_remaining_days.mjs";
import {
  calendarFeedUnsupportedFilterFields,
  standingFeedUrlsFromWatch,
  subscriptionParamsFromWatch,
  subscriptionWatchFromScope,
} from "../site/scope_v0.mjs";
import {
  composeWatchRuleSentence,
  followingUrlFromWatch,
  moneyLeadTimeControlsHtml,
  watchFromFollowingParams,
} from "../site/following_view.mjs";
import { prepareWatchFilter, sanitize } from "../worker/src/lib/filter.mjs";
import {
  DEADLINE_RESOLUTION_STATUS,
  resolveTypedSourceDeadlines,
} from "../warehouse/lib/typed_source_deadline.mjs";
import { recordsFromMtaOpportunityFixtures } from "../warehouse/lib/mta_opportunities.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { withPinnedClock, testClockISOString } from "./helpers/test_clock.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE_DIR = join(ROOT, "docs/evidence/minimum-lead-time");
const read = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const MTA_FIXTURES = read("warehouse/fixtures/authority-native-procurement/mta-opportunities.v1.json");
const DEADLINE_FIXTURES = read("warehouse/fixtures/authority-native-procurement/typed-source-deadlines.v1.json");
const DIGEST = read("site/data/procurement_digest_snapshot.json");

const NATIVE_MODEL = buildSharedProcurementReadModel({
  sourceRecords: recordsFromMtaOpportunityFixtures(MTA_FIXTURES),
  generatedAt: MTA_FIXTURES.retrieved_at,
});

const OBJ_2138505 = NATIVE_MODEL.rows.find((row) => (
  row.procurement_id === "procurement:contract_reporter_number:2138505"
));
const OBJ_S48020 = NATIVE_MODEL.rows.find((row) => (
  row.procurement_id === "procurement:solicitation:S48020"
));
const DOB_FIXTURE = DEADLINE_FIXTURES.fixtures.find((row) => row.id === "dob-20260707026-current");

function dobNoticeRow() {
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
  return {
    request_id: "20260707026",
    agency_name: "Buildings",
    short_title: DOB_FIXTURE.short_title,
    type_of_notice_description: "Solicitation",
    due_date: "8/25/2026 1:00 PM",
    start_date: "2026-07-28",
    response_deadline: projected.response_deadline,
    bid_opening: projected.bid_opening,
  };
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
  return {
    request_id: "20260727019",
    agency_name: "Trust for Governors Island",
    short_title: "Governors Island Building 324 construction services",
    type_of_notice_description: "Solicitation",
    due_date: "8/28/2026 5:00 PM",
    start_date: "2026-07-31",
    response_deadline: projected.response_deadline,
    bid_opening: projected.bid_opening,
  };
}

function writeEvidence(name, payload) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, name);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

function discoveryFilter(extra = {}) {
  return sanitize("money", { noticeType: "solicitation", ...extra });
}

test("A1 21-day watch includes 2138505 / DOB / Governors Island on threshold days and drops the next day", async () => {
  assert.ok(OBJ_2138505);
  assert.ok(DOB_FIXTURE);
  assert.match(testClockISOString(), /^\d{4}-\d{2}-\d{2}T/);

  const digest2138505 = procurementDigestRow(OBJ_2138505, NATIVE_MODEL);
  const dob = dobNoticeRow();
  const gi = governorsIslandNoticeRow();
  assert.equal(digest2138505.response_deadline.status, DEADLINE_TRANSPORT_STATUS.RESOLVED);
  assert.equal(dob.response_deadline.status, DEADLINE_TRANSPORT_STATUS.RESOLVED);
  assert.equal(gi.response_deadline.status, DEADLINE_TRANSPORT_STATUS.RESOLVED);

  const cases = [
    { label: "2138505", row: digest2138505, passAt: "2026-09-11T16:00:00.000Z", failAt: "2026-09-12T16:00:00.000Z" },
    { label: "dob", row: dob, passAt: "2026-08-04T16:00:00.000Z", failAt: "2026-08-05T16:00:00.000Z" },
    { label: "governors-island", row: gi, passAt: "2026-08-07T16:00:00.000Z", failAt: "2026-08-08T16:00:00.000Z" },
  ];

  for (const entry of cases) {
    await withPinnedClock(entry.passAt, () => {
      assert.equal(rowMeetsMinRemainingDays(entry.row, 21, entry.passAt), true, `${entry.label} passes on threshold day`);
      assert.equal(responseDeadlineRemainingDays(entry.row.response_deadline, entry.passAt), 21);
    });
    await withPinnedClock(entry.failAt, () => {
      assert.equal(rowMeetsMinRemainingDays(entry.row, 21, entry.failAt), false, `${entry.label} fails the next day`);
      assert.equal(responseDeadlineRemainingDays(entry.row.response_deadline, entry.failAt), 20);
    });
  }

  const filter = discoveryFilter({ minRemainingDays: 21 });
  await withPinnedClock("2026-09-11T16:00:00.000Z", () => {
    const matched = matchProcurementDigestRows(DIGEST, filter, {
      lens: "money",
      todayISO: "2026-09-11",
      clock: "2026-09-11T16:00:00.000Z",
    });
    assert.ok(
      matched.some((row) => row.procurement_id === "procurement:contract_reporter_number:2138505"),
      "digest match keeps 2138505 on Sep 11",
    );
  });
  await withPinnedClock("2026-09-12T16:00:00.000Z", () => {
    const matched = matchProcurementDigestRows(DIGEST, filter, {
      lens: "money",
      todayISO: "2026-09-12",
      clock: "2026-09-12T16:00:00.000Z",
    });
    assert.equal(
      matched.some((row) => row.procurement_id === "procurement:contract_reporter_number:2138505"),
      false,
      "digest match drops 2138505 on Sep 12",
    );
  });
});

test("A2 editor → save → stored filter → reload → edit → preview retains minRemainingDays and watch identity", () => {
  const prepared = prepareWatchFilter("money", {
    noticeType: "solicitation",
    agency: "MTA - NYC Transit (NYCT)",
    minRemainingDays: 21,
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.filter.minRemainingDays, 21);
  assert.equal(prepared.filter.noticeType, "solicitation");
  assert.equal(prepared.filter.agency, "MTA - NYC Transit (NYCT)");

  const sanitized = sanitize("money", prepared.filter);
  assert.equal(sanitized.minRemainingDays, 21);

  const scoped = subscriptionWatchFromScope({ lens: "money", filter: prepared.filter });
  assert.equal(scoped.filter.minRemainingDays, 21);
  assert.equal(scoped.filter.agency, prepared.filter.agency);

  const params = subscriptionParamsFromWatch(scoped);
  assert.match(String(params), /minRemainingDays/);
  const reloaded = watchFromFollowingParams(`https://cityscroll.org/following?${params}&freq=daily`);
  assert.equal(reloaded.filter.minRemainingDays, 21);
  assert.equal(reloaded.filter.agency, prepared.filter.agency);
  assert.equal(reloaded.lens, "money");

  const edited = prepareWatchFilter("money", {
    ...reloaded.filter,
    minRemainingDays: 30,
  });
  assert.equal(edited.ok, true);
  assert.equal(edited.filter.minRemainingDays, 30);
  assert.equal(edited.filter.agency, prepared.filter.agency);

  const sentence = composeWatchRuleSentence("money", edited.filter);
  assert.match(sentence, /30 calendar days remaining/i);

  const href = followingUrlFromWatch({ lens: "money", filter: edited.filter, frequency: "daily" });
  assert.match(href, /minRemainingDays%22%3A30|minRemainingDays":30|minRemainingDays%22%3A%2030/);

  const controls = moneyLeadTimeControlsHtml({
    lens: "money",
    filter: edited.filter,
    requested: true,
  });
  assert.match(controls, /minRemainingDays|min-remaining|At least/);
  assert.match(controls, /confirmed deadline/i);
  assert.match(controls, /value="30"/);
});

test("A3 unset watches keep behavior; invalid values and exact follows refuse explicitly", () => {
  const unset = prepareWatchFilter("money", { noticeType: "solicitation" });
  assert.equal(unset.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(unset.filter, "minRemainingDays"), false);

  const open = matchProcurementDigestRows(DIGEST, unset.filter, {
    lens: "money",
    todayISO: "2026-09-11",
  });
  assert.ok(open.some((row) => row.procurement_id === "procurement:contract_reporter_number:2138505"));
  assert.ok(open.some((row) => row.procurement_id === "procurement:solicitation:S48020"));

  for (const bad of [-1, 1.5, "21.0", "abc", 366, true, { days: 21 }]) {
    const validation = validateMinRemainingDays(bad);
    assert.equal(validation.ok, false, `rejects ${JSON.stringify(bad)}`);
    const prepared = prepareWatchFilter("money", { noticeType: "solicitation", minRemainingDays: bad });
    assert.equal(prepared.ok, false);
    assert.match(prepared.reason, /min-remaining-days-/);
    assert.equal(Object.keys(prepared.filter || {}).length, 0);
  }

  const exact = prepareWatchFilter("money", {
    procurement_id: "procurement:solicitation:S48020",
    minRemainingDays: 21,
  });
  assert.equal(exact.ok, false);
  assert.equal(exact.reason, "min-remaining-days-incompatible-exact-follow");

  const admitExact = admitMinRemainingDays("money", {
    procurement_id: "procurement:contract_reporter_number:2138505",
    minRemainingDays: 21,
  });
  assert.equal(admitExact.ok, false);

  // sanitize alone still omits an invalid value; admission is the save gate.
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      sanitize("money", { noticeType: "solicitation", minRemainingDays: -3 }),
      "minRemainingDays",
    ),
    false,
  );
  assert.equal(
    sanitize("money", { noticeType: "solicitation", minRemainingDays: 21 }).minRemainingDays,
    21,
  );

  const copy = minRemainingDaysControlCopy();
  assert.match(copy.help, /confirmed deadline/i);
});

test("A4 S48020 fails without a response deadline; calendar days ignore 24h buckets and DST", async () => {
  assert.ok(OBJ_S48020);
  const digestS48020 = procurementDigestRow(OBJ_S48020, NATIVE_MODEL);
  assert.equal(digestS48020.response_deadline || null, null);
  assert.ok(digestS48020.bid_opening);

  await withPinnedClock("2026-05-21T16:00:00.000Z", () => {
    assert.equal(
      rowMeetsMinRemainingDays(digestS48020, 0, "2026-05-21T16:00:00.000Z"),
      false,
      "opening-date S48020 cannot pass without a response deadline",
    );
  });

  const filter = discoveryFilter({ minRemainingDays: 21 });
  const matched = matchProcurementDigestRows(DIGEST, filter, {
    lens: "money",
    todayISO: "2026-09-11",
    clock: "2026-09-11T16:00:00.000Z",
  });
  assert.equal(
    matched.some((row) => row.procurement_id === "procurement:solicitation:S48020"),
    false,
  );

  const dateOnly = projectDeadlinesFromNoticeRow({ due_date: "2026-10-02" }).response_deadline;
  // Local midnight on the due day still counts as 0 calendar days remaining.
  assert.equal(
    responseDeadlineRemainingDays(dateOnly, "2026-10-02T04:00:00.000Z"),
    0,
  );
  assert.equal(rowMeetsMinRemainingDays({ response_deadline: dateOnly }, 0, "2026-10-02T04:00:00.000Z"), true);
  assert.equal(rowMeetsMinRemainingDays({ response_deadline: dateOnly }, 1, "2026-10-02T04:00:00.000Z"), false);

  const dob = dobNoticeRow();
  // After the exact timestamp, the opportunity is closed even on the due calendar day.
  assert.equal(
    rowMeetsMinRemainingDays(dob, 0, "2026-08-25T18:00:00.000Z"),
    false,
  );
  assert.equal(
    rowMeetsMinRemainingDays(dob, 0, "2026-08-25T16:00:00.000Z"),
    true,
  );

  // Synthetic spring-forward: calendar-day math stays stable across the DST seam.
  const beforeDst = "2026-03-07T17:00:00.000Z"; // NYC still EST
  const afterDst = "2026-03-09T16:00:00.000Z"; // NYC EDT
  assert.equal(nycCivicDayISO(beforeDst), "2026-03-07");
  assert.equal(nycCivicDayISO(afterDst), "2026-03-09");
  const springDeadline = projectDeadlinesFromNoticeRow({ due_date: "2026-03-28" }).response_deadline;
  assert.equal(responseDeadlineRemainingDays(springDeadline, beforeDst), 21);
  assert.equal(responseDeadlineRemainingDays(springDeadline, afterDst), 19);
});

test("A5 production editor + server admission with the three positive records; calendar stays disabled", async () => {
  const digest2138505 = procurementDigestRow(OBJ_2138505, NATIVE_MODEL);
  const dob = dobNoticeRow();
  const gi = governorsIslandNoticeRow();
  const positives = [digest2138505, dob, gi];

  const prepared = prepareWatchFilter("money", {
    noticeType: "solicitation",
    minRemainingDays: 21,
  });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.filter.minRemainingDays, 21);

  const controls = moneyLeadTimeControlsHtml({
    lens: "money",
    filter: prepared.filter,
    requested: true,
  });
  assert.match(controls, /Only opportunities with a confirmed deadline/);
  assert.doesNotMatch(
    moneyLeadTimeControlsHtml({
      lens: "money",
      filter: { procurement_id: "procurement:solicitation:S48020" },
      requested: true,
    }),
    /minRemainingDays|At least N calendar/,
  );

  await withPinnedClock("2026-09-11T16:00:00.000Z", () => {
    const preview = applyMinRemainingDaysPreference(positives, prepared.filter, "2026-09-11T16:00:00.000Z");
    assert.deepEqual(
      preview.map((row) => row.procurement_id || row.request_id),
      ["procurement:contract_reporter_number:2138505"],
      "Sep 11 preview keeps only the still-open native control",
    );
  });

  await withPinnedClock("2026-08-04T16:00:00.000Z", () => {
    assert.equal(rowMeetsMinRemainingDays(dob, 21, "2026-08-04T16:00:00.000Z"), true);
    const preview = applyMinRemainingDaysPreference([dob, gi, digest2138505], prepared.filter, "2026-08-04T16:00:00.000Z");
    assert.ok(preview.some((row) => row.request_id === "20260707026"));
  });
  await withPinnedClock("2026-08-07T16:00:00.000Z", () => {
    assert.equal(rowMeetsMinRemainingDays(gi, 21, "2026-08-07T16:00:00.000Z"), true);
    const preview = applyMinRemainingDaysPreference([dob, gi, digest2138505], prepared.filter, "2026-08-07T16:00:00.000Z");
    assert.ok(preview.some((row) => row.request_id === "20260727019"));
  });

  const merged = mergeProcurementDigestMatches(
    { lens: "money", filter: prepared.filter },
    [],
    DIGEST,
    "2026-09-11",
  );
  assert.ok(merged.some((row) => row.procurement_id === "procurement:contract_reporter_number:2138505"));
  assert.equal(merged.some((row) => row.procurement_id === "procurement:solicitation:S48020"), false);

  const unsupported = calendarFeedUnsupportedFilterFields({
    lens: "money",
    filter: prepared.filter,
  });
  assert.ok(unsupported.includes("minRemainingDays"));
  const feeds = standingFeedUrlsFromWatch({ lens: "money", filter: prepared.filter });
  assert.equal(feeds.ics, null);
  assert.ok(feeds.atom);
  assert.ok(feeds.json);
  assert.match(minRemainingDaysCalendarUnavailableMessage(), /lead time|calendar parity/i);

  writeEvidence("example-21-day-watch-round-trip.json", {
    schema: "cityscroll.minimum_lead_time_example.v1",
    grounded_records: [
      "procurement:contract_reporter_number:2138505",
      "20260707026",
      "20260727019",
    ],
    filter: prepared.filter,
    calendar: {
      unsupported_fields: unsupported,
      ics: feeds.ics,
      message: minRemainingDaysCalendarUnavailableMessage(),
    },
    clocks: {
      native_pass: "2026-09-11",
      dob_pass: "2026-08-04",
      governors_island_pass: "2026-08-07",
    },
  });
});
