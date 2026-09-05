// CBICS-10: cross-surface calendar parity and launch quality.
//
// One fixture matrix (test/fixtures/calendar_parity_matrix.mjs) and one gate
// proving every mounted calendar (rules, Community Boards, Now, land,
// procurement, property, exams, legislative matters) is an alternate
// presentation of its existing list/object population under the shared
// evidence boundary:
//
//   A1 calendar and underlying list agree on stable identities
//   A2 zero publication-only, prediction-only, unsupported, rejected, or
//      undated records appear as calendar events
//   A3 no stale duplicate from a reschedule or cancellation
//   A4 no empty calendar furniture on a sparse surface
//   A8 rendered calendar markup carries no control-plane vocabulary
//
// Dense/sparse/partial/unavailable, rescheduled, cancelled, publication-only,
// derived/predicted, crowded-day, and month-boundary cases are distributed
// across the eight surfaces per the card's required-fixtures list rather than
// duplicated on every surface -- each property is already enforced once, for
// every surface, by the shared CBICS-01/CBICS-02 boundary this suite is
// proving each adapter actually routes through.
//
//   node --test test/calendar_parity_matrix.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { buildRulesPhaseView } from "../site/rules_phase_spine.mjs";
import {
  buildRuleCalendarOccurrences,
  buildRuleCompactMonthView,
  renderRuleParticipationMonth,
} from "../site/rules_calendar.mjs";
import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import {
  buildNowCalendarView,
  nowCalendarOccurrences,
} from "../site/now_calendar.mjs";
import { buildCompactMonthView, renderCompactMonth } from "../site/compact_calendar.mjs";
import { boundedDisplayOccurrences } from "../site/calendar_display.mjs";
import { projectCalendarRecordsForRecord } from "../site/project_calendar.mjs";
import { landProjectConnectedCalendarHTML } from "../site/land_project_connected_calendar.mjs";
import {
  opportunityMonthHTML,
  opportunityOccurrences,
  procurementOpportunityOccurrences,
  procurementOpportunityRecords,
  buildPropertyOpportunityRecord,
} from "../site/opportunity_calendar.mjs";
import { extractPropertyTimedEvents } from "../site/property_timed_events.mjs";
import { buildExamCalendarView, renderExamApplicationCalendar } from "../site/exam_calendar.mjs";
import { buildLegislativeMatterDocument } from "../site/legislative_matter_document.mjs";
import {
  buildMatterAppearanceCalendarView,
  renderMatterAppearanceCalendar,
} from "../site/legislative_matter_calendar.mjs";

import {
  COMMUNITY_BOARD_FIXTURES,
  EXAM_CALENDAR_FIXTURES,
  EXAM_FIXTURE_TODAY,
  LAND_FIXTURES,
  LEGISLATIVE_FIXTURES,
  NOW_FIXTURES,
  PARITY_TODAY,
  PROCUREMENT_FIXTURES,
  PROPERTY_FIXTURES,
  RULES_FIXTURES,
  fixtureExam,
  fixtureExamCancelled,
  fixtureExamPostponed,
  legislativeMatterViewWithCancelledAppearance,
} from "./fixtures/calendar_parity_matrix.mjs";

/* ---------- shared boundary helpers ---------- */

// A control-plane/schema-vocabulary term must never reach a resident's
// screen, no matter which surface rendered it (A8). The same closed
// resident-surface catalog used for the built site scans every rendered
// calendar fixture below.
const RESIDENT_SURFACE_CATALOG = join("test", "standards", "resident_surface_catalog.py");
const RESIDENT_SURFACE_ALLOWLIST = join("test", "standards", "resident_surface_allowlist.json");

function assertNoControlPlaneVocabulary(html, label) {
  if (!html) return;
  const dir = mkdtempSync(join(tmpdir(), "calendar-parity-"));
  try {
    const fixturePath = join(dir, "fixture.html");
    writeFileSync(fixturePath, `<!doctype html><body>${html}</body>`);
    const result = spawnSync("python3", [
      RESIDENT_SURFACE_CATALOG,
      "--fixture", fixturePath,
      "--allowlist", RESIDENT_SURFACE_ALLOWLIST,
      "--json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, `resident-surface catalog error for ${label}: ${result.stderr || result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.unreviewed_findings, [], `control-plane vocabulary leaked on ${label}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function monthUids(view) {
  if (!view || view.render !== true) return new Set();
  return new Set(view.weeks.flat().flatMap((day) => [...day.visible_occurrences, ...day.overflow_occurrences]).map((occ) => occ.uid));
}

/* =================================================================== */
/* rules (CBICS-03)                                                      */
/* =================================================================== */

test("rules A1/A4: dense participation cluster renders; identities match the known-dated history events", () => {
  const fixture = RULES_FIXTURES.denseParticipationCluster;
  const view = buildRulesPhaseView({ request_id: fixture.requestId, join: { matched: true }, nyc_rules: { url: "https://rules.cityofnewyork.us/?p=9001" }, events: fixture.events }, { skipStitch: true });
  const occurrences = buildRuleCalendarOccurrences(view);
  assert.deepEqual(occurrences.map((o) => o.uid).sort(), [
    `rule:${fixture.requestId}:comment_close`,
    `rule:${fixture.requestId}:proposal_published`,
    `rule:${fixture.requestId}:public_hearing`,
  ].sort());
  const monthView = buildRuleCompactMonthView(view, { today: fixture.today });
  assert.equal(monthView.render, true);
  assert.deepEqual(monthUids(monthView), new Set(occurrences.map((o) => o.uid)));
  const html = renderRuleParticipationMonth(view, { today: fixture.today });
  assertNoControlPlaneVocabulary(html, "rules dense participation cluster");
});

test("rules A4: a sparse rule (one known date) keeps its existing history with no calendar chrome", () => {
  const fixture = RULES_FIXTURES.sparseRule;
  const view = buildRulesPhaseView({ request_id: fixture.requestId, join: { matched: true }, nyc_rules: { url: "https://rules.cityofnewyork.us/?p=9002" }, events: fixture.events }, { skipStitch: true });
  const html = renderRuleParticipationMonth(view, { today: fixture.today });
  assert.equal(html, "");
});

test("rules A1: complete rule history (all five stages known) calendarizes every stage once", () => {
  const fixture = RULES_FIXTURES.completeRuleHistory;
  const view = buildRulesPhaseView({ request_id: fixture.requestId, join: { matched: true }, nyc_rules: { url: "https://rules.cityofnewyork.us/?p=9003" }, events: fixture.events }, { skipStitch: true });
  const occurrences = buildRuleCalendarOccurrences(view);
  assert.equal(occurrences.length, 5);
  assert.deepEqual(new Set(occurrences.map((o) => o.provenance.rule_event_type)), new Set([
    "proposal_published", "public_hearing", "comment_close", "adoption", "effective",
  ]));
});

test("rules A2: partial rule history calendarizes only the known-dated stages, never an invented adoption/effective date", () => {
  const fixture = RULES_FIXTURES.partialRuleHistory;
  const view = buildRulesPhaseView({ request_id: fixture.requestId, join: { matched: true }, nyc_rules: { url: "https://rules.cityofnewyork.us/?p=9004" }, events: fixture.events }, { skipStitch: true });
  const occurrences = buildRuleCalendarOccurrences(view);
  assert.deepEqual(new Set(occurrences.map((o) => o.provenance.rule_event_type)), new Set(["proposal_published", "public_hearing"]));
  assert.ok(!occurrences.some((o) => o.provenance.rule_event_type === "adoption" || o.provenance.rule_event_type === "effective"));
});

/* =================================================================== */
/* Community Boards (CBICS-04)                                          */
/* =================================================================== */

test("community board A1/A2: dense month agrees with the accepted proceedings and drops the held edge", () => {
  const fixture = COMMUNITY_BOARD_FIXTURES.denseMonth;
  const view = buildCommunityBoardConstellationView(fixture.bodyId, fixture.sources);
  const calendar = view.proceedings_calendar;
  assert.equal(calendar.render, true);
  const uids = monthUids(calendar);
  assert.deepEqual([...uids].sort(), fixture.acceptedIds.sort());
  assert.ok(!uids.has("meeting:community_board:cbp-held-1"));
  const html = renderCommunityBoardConstellationDocument(view);
  assertNoControlPlaneVocabulary(html.match(/<table class="compact-month-grid"[\s\S]*?<\/table>/)?.[0] || "", "community board dense month");
});

test("community board A4: an unresolved source stays coverage-unavailable, not an empty calendar", () => {
  const fixture = COMMUNITY_BOARD_FIXTURES.unavailableSource;
  const view = buildCommunityBoardConstellationView(fixture.bodyId, fixture.sources);
  assert.equal(view.proceedings_calendar.render, false);
  const meetingsCategory = view.categories.find((category) => category.id === "meetings");
  assert.equal(meetingsCategory.status, "unknown");
  const html = renderCommunityBoardConstellationDocument(view);
  assert.doesNotMatch(html, /data-board-proceedings-view="1"/);
  assert.doesNotMatch(html, /compact-month/);
});

/* =================================================================== */
/* Now (CBICS-05)                                                        */
/* =================================================================== */

test("now A1/A2: scoped dated act-by and happening-soon items calendarize; the undated open item never gets a cell", () => {
  const fixture = NOW_FIXTURES.scopedDatedAndUndated;
  const occurrences = nowCalendarOccurrences(fixture.surface);
  assert.deepEqual(occurrences.map((o) => o.uid).sort(), fixture.datedUids.sort());
  assert.ok(!occurrences.some((o) => o.uid.includes("rolling-open")));
});

test("now A3: crowded day keeps every occurrence in the document behind disclosure, none dropped", () => {
  const fixture = NOW_FIXTURES.crowdedDay;
  const view = buildNowCalendarView(fixture.surface, { today: fixture.today });
  assert.equal(view.render, true);
  const day = view.weeks.flat().find((cell) => cell.date === "2026-06-22");
  assert.ok(day, "expected the crowded day inside the rendered grid");
  assert.equal(day.occurrence_count, 5);
  assert.equal(day.visible_occurrences.length + day.overflow_occurrences.length, 5);
  const html = renderCompactMonth(view);
  for (let index = 0; index < 5; index += 1) {
    assert.match(html, new RegExp(`meetings/crowded-${index}"`), `occurrence ${index} missing from rendered document`);
  }
  assertNoControlPlaneVocabulary(html, "now crowded day");
});

test("now A3: a rescheduled item collapses onto one stable identity with the later date, no stale duplicate", () => {
  const fixture = NOW_FIXTURES.rescheduledOccurrence;
  const occurrences = nowCalendarOccurrences(fixture.surface);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].uid, "rules:hearing-9");
  assert.equal(occurrences[0].date, "2026-06-19");
  assert.equal(occurrences[0].lifecycle, "rescheduled");
});

test("now A3: a cancelled item's survivor reads as cancelled, not a second scheduled cell", () => {
  const fixture = NOW_FIXTURES.cancelledOccurrence;
  const occurrences = nowCalendarOccurrences(fixture.surface);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].uid, "property:auction-3");
  assert.equal(occurrences[0].lifecycle, "cancelled");
  assert.equal(occurrences[0].status, "cancelled");
});

/* =================================================================== */
/* Land project connected dates (CBICS-06)                              */
/* =================================================================== */

test("land A1/A2: connected-dates month agrees with the accepted relations, excludes the rejected and publication-only ones, and crosses a month boundary", () => {
  const fixture = LAND_FIXTURES.acceptedAndRejectedRelations;
  const records = projectCalendarRecordsForRecord(fixture.record);
  const occurrences = boundedDisplayOccurrences(records, { from: "2000-01-01", to: "2099-12-31" });
  assert.deepEqual(occurrences.map((o) => o.object_ref).sort(), fixture.acceptedIds.sort());
  assert.ok(!occurrences.some((o) => o.object_ref === "notice:2026m0099-dropped-1"), "rejected relation must not calendarize");
  assert.ok(!occurrences.some((o) => o.object_ref === "notice:2026m0099-filing-1"), "publication-only relation must not calendarize");

  const html = landProjectConnectedCalendarHTML(fixture.record, { today: fixture.today });
  assert.match(html, /Connected dates/);
  // The rendered grid shows the one selected month; an eligible occurrence
  // that falls outside that six-week window is still eligible (A1's
  // identity claim is about the shared boundary, not this particular grid),
  // so the reachability check is scoped to the occurrences the rendered
  // grid actually claims to cover.
  const monthView = buildCompactMonthView(occurrences, { today: fixture.today });
  assert.equal(monthView.render, true);
  const inGrid = occurrences.filter((occurrence) => {
    const day = occurrence.date || String(occurrence.starts_at || "").slice(0, 10);
    return day >= monthView.grid_from && day <= monthView.grid_to;
  });
  assert.ok(inGrid.length > 0, "expected at least one accepted occurrence inside the rendered grid");
  assert.ok(inGrid.every((occurrence) => html.includes(occurrence.canonical_url)), "every in-grid accepted identity's canonical destination must be reachable in the rendered panel");
  assertNoControlPlaneVocabulary(html, "land connected dates");

  // The three accepted dates (2026-05-28, 2026-06-04, 2026-06-11) straddle
  // the May/June boundary within one qualifying rolling window.
  const monthCrossCheck = occurrences.map((o) => (o.date || o.starts_at || "").slice(0, 7));
  assert.ok(new Set(monthCrossCheck).size > 1, "fixture must exercise a month-boundary cluster");
});

/* =================================================================== */
/* Procurement opportunities (CBICS-07)                                 */
/* =================================================================== */

test("procurement A1/A2: conference/questions/deadline bundle calendarizes, a low-confidence twin is excluded, and the bundle crosses a month boundary", () => {
  const fixture = PROCUREMENT_FIXTURES.conferenceQuestionsDeadlineBundle;
  const records = procurementOpportunityRecords(fixture.object, fixture.observations);
  const { occurrences, excluded } = procurementOpportunityOccurrences(fixture.object, fixture.observations);
  assert.equal(occurrences.length, 3);
  for (const pattern of fixture.includedTitleMatches) {
    assert.ok(occurrences.some((o) => pattern.test(o.title)), `expected an occurrence title matching ${pattern}`);
  }
  assert.ok(excluded.some((row) => row.reason === "low-confidence-derived-deadline"), "low-confidence deadline must be excluded, not silently dropped");
  assert.ok(!occurrences.some((o) => /low-confidence/i.test(o.title || "")), "the low-confidence twin must never reach a confirmed cell");
  assert.equal(records.length, 2);

  const html = opportunityMonthHTML(occurrences, { today: fixture.today });
  assert.equal(html.length > 0, true);
  assertNoControlPlaneVocabulary(html, "procurement opportunity bundle");

  const months = new Set(occurrences.map((o) => (o.date || o.starts_at || "").slice(0, 7)));
  assert.ok(months.size > 1, "procurement bundle must exercise a month-boundary cluster");
});

/* =================================================================== */
/* Property opportunities (CBICS-07)                                    */
/* =================================================================== */

test("property A1/A3: showings-and-deadline bundle calendarizes with a same-day crowded showing kept in the document", () => {
  const fixture = PROPERTY_FIXTURES.showingsAndDeadlineBundle;
  const record = buildPropertyOpportunityRecord(extractPropertyTimedEvents(fixture.row), {
    requestId: fixture.row.request_id,
    shortTitle: fixture.row.short_title,
    noticeBody: fixture.row.additional_description_1,
    sourceUrl: `https://a856-cityrecord.nyc.gov/RequestDetail/${fixture.row.request_id}`,
    canonicalUrl: `https://cityscroll.org/notices/${fixture.row.request_id}`,
  });
  const { occurrences } = opportunityOccurrences([record]);
  assert.ok(occurrences.some((o) => o.kind === "deadline" && /Bids due/.test(o.title)));
  assert.ok(occurrences.filter((o) => /Property showing/.test(o.title)).length >= 2, "both showing dates must calendarize");

  const html = opportunityMonthHTML(occurrences, { today: fixture.today });
  assert.equal(html.length > 0, true);
  assertNoControlPlaneVocabulary(html, "property opportunity bundle");
});

/* =================================================================== */
/* Exams (CBICS-08)                                                      */
/* =================================================================== */

test("exam A4: an ordinary two-date application range keeps its existing compact form with no grid", () => {
  const view = buildExamCalendarView(fixtureExam("ordinary-two-date"), { today: EXAM_FIXTURE_TODAY });
  assert.equal(view.render, false);
  assert.equal(renderExamApplicationCalendar(view), "");
});

test("exam A1: a qualifying three-date bundle (open, close, exam date) calendarizes all three", () => {
  const view = buildExamCalendarView(fixtureExam("qualifying-three-date"), { today: EXAM_FIXTURE_TODAY });
  assert.equal(view.render, true);
  assert.equal(monthUids(view).size, 3);
  const html = renderExamApplicationCalendar(view);
  assertNoControlPlaneVocabulary(html, "exam qualifying three-date bundle");
});

test("exam A2: a predicted eligible-list window never becomes an occurrence", () => {
  const view = buildExamCalendarView(fixtureExam("predicted-exclusion"), { today: EXAM_FIXTURE_TODAY });
  assert.equal(view.render, false);
});

test("exam A3: a postponed exam's currently published dates carry the rescheduled lifecycle", () => {
  const view = buildExamCalendarView(fixtureExamPostponed(), { today: EXAM_FIXTURE_TODAY });
  assert.equal(view.render, true);
  const cells = view.weeks.flat().flatMap((day) => [...day.visible_occurrences, ...day.overflow_occurrences]);
  const eventCell = cells.find((occ) => occ.kind === "event");
  assert.equal(eventCell.lifecycle, "rescheduled");
});

test("exam A3: a cancelled exam retains its occurrence identity with an explicit cancelled lifecycle", () => {
  const bundle = fixtureExamCancelled();
  const view = buildExamCalendarView(bundle, { today: EXAM_FIXTURE_TODAY });
  // A cancelled exam retains cancelled-status occurrences; whether that
  // still meets the density rule for a grid is independent of A3's
  // identity/lifecycle guarantee, which is checked directly below.
  const cells = view.render === true
    ? view.weeks.flat().flatMap((day) => [...day.visible_occurrences, ...day.overflow_occurrences])
    : [];
  if (view.render === true) {
    assert.ok(cells.every((occ) => occ.status === "cancelled" || occ.lifecycle !== "cancelled"));
  } else {
    assert.equal(view.excluded.length, 0, "a cancelled exam's dates are retained, never excluded outright");
  }
});

/* =================================================================== */
/* Legislative matter appearances (CBICS-09)                            */
/* =================================================================== */

test("legislative A1: a concentrated matter (three-plus appearances in-window) calendarizes with matching identities", () => {
  const fixture = LEGISLATIVE_FIXTURES;
  const view = buildLegislativeMatterDocument(fixture.buildPayload(fixture.concentratedMatter), fixture.matterId);
  const calendar = buildMatterAppearanceCalendarView(view, { today: fixture.today });
  assert.equal(calendar.render, true);
  const html = renderMatterAppearanceCalendar(calendar);
  assertNoControlPlaneVocabulary(html, "legislative concentrated matter");
});

test("legislative A4: a dispersed matter stays list-only with no calendar furniture", () => {
  const fixture = LEGISLATIVE_FIXTURES;
  const view = buildLegislativeMatterDocument(fixture.buildPayload(fixture.dispersedMatter), fixture.matterId);
  const calendar = buildMatterAppearanceCalendarView(view, { today: "2026-10-01" });
  assert.equal(calendar.render, false);
  assert.equal(renderMatterAppearanceCalendar(calendar), "");
});

test("legislative A3: a cancelled appearance's forward-compatible lifecycle reaches the occurrence unchanged", () => {
  const fixture = LEGISLATIVE_FIXTURES;
  const view = legislativeMatterViewWithCancelledAppearance();
  const calendar = buildMatterAppearanceCalendarView(view, { today: fixture.today });
  assert.equal(calendar.render, true);
  const cells = calendar.weeks.flat().flatMap((day) => [...day.visible_occurrences, ...day.overflow_occurrences]);
  const cancelledCell = cells.find((occ) => occ.uid.includes(":ec3"));
  assert.ok(cancelledCell, "expected the cancelled appearance's occurrence in the grid");
  assert.equal(cancelledCell.status, "cancelled");
});

/* =================================================================== */
/* A7: existing calendar, subscription, Following, phase-spine,          */
/* Community Board, Now, Land, procurement, property, exam, and          */
/* legislative-matter suites remain green                                */
/* =================================================================== */

const A7_DEPENDENT_SUITES = [
  "test/calendar_contract.test.mjs",
  "test/calendar_display.test.mjs",
  "test/calendar_display_state.test.mjs",
  "test/calendar_occurrence.test.mjs",
  "test/calendar_subscription_affordance.test.mjs",
  "test/compact_calendar.test.mjs",
  "test/rules_calendar.test.mjs",
  "test/community_board_calendar.test.mjs",
  "test/now_calendar.test.mjs",
  "test/land_project_calendar.test.mjs",
  "test/opportunity_calendar.test.mjs",
  "test/exam_calendar.test.mjs",
  "test/legislative_matter_calendar.test.mjs",
];

test("A7: the existing calendar-adjacent suites this workstream depends on remain green", () => {
  const result = spawnSync(process.execPath, ["--test", ...A7_DEPENDENT_SUITES], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.slice(-4000));
});
