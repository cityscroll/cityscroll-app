// Exam application-bundle calendar (CBICS-08). This suite pins: the
// qualifying open + close + actual published exam date bundle; truthful
// non-render for the ordinary two-date range (the common case, including the
// entire committed staffing corpus); predicted eligible-list windows never
// becoming occurrences; continuous/rolling filing never implied by a grid;
// cancelled and postponed schedule states carried truthfully; stable
// source/link identity; partial and malformed date handling; and the reader
// hierarchy that keeps official application actions primary above the
// calendar.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { detectNodePageCruft } from "../site/civic_document_chrome.mjs";
import { buildExamPhaseView } from "../site/exam_phase_spine.mjs";
import { buildExamProcessSpine } from "../site/exam_process_spine.mjs";
import {
  EXAM_NON_RENDER_CONTINUOUS_FILING,
  EXAM_NON_RENDER_NO_EXAM_DATE,
  buildExamCalendarView,
  examApplicationBundle,
  renderExamApplicationCalendar,
} from "../site/exam_calendar.mjs";
import { renderExamDocument } from "../site/exam_document.mjs";
import { FIXTURE_TODAY, fixtureExam } from "./fixtures/exam_calendar_fixtures.mjs";

const artifact = JSON.parse(readFileSync(new URL("../site/data/staffing_exams.json", import.meta.url)));

const GRID = /class="compact-month-grid"/;
const CALENDAR_SECTION = /id="exam-calendar-heading"/;
const STYLESHEET = /rel="stylesheet" href="\/compact_calendar\.css"/;

function documentHtml(exam, today = FIXTURE_TODAY) {
  return renderExamDocument(exam, {
    today,
    feeSalary: {},
    phaseView: buildExamPhaseView(buildExamProcessSpine(exam)),
  });
}

/* ---------- A1: the qualifying bundle ---------- */

test("A1: application open, close, and an actual published exam date qualify and render", () => {
  const view = buildExamCalendarView(fixtureExam("qualifying-three-date"), { today: FIXTURE_TODAY });
  assert.equal(view.render, true);
  assert.equal(view.month, "2026-03");

  const byDate = new Map(view.weeks.flat().map((day) => [day.date, day]));
  const open = byDate.get("2026-03-02").visible_occurrences[0];
  const close = byDate.get("2026-03-23").visible_occurrences[0];
  const examDay = byDate.get("2026-04-06").visible_occurrences[0];
  assert.equal(open.kind, "window_open");
  assert.equal(close.kind, "deadline");
  assert.equal(examDay.kind, "event");
  // The published exam date may sit in the following month's spillover cells.
  assert.equal(byDate.get("2026-04-06").in_month, false);

  const html = renderExamApplicationCalendar(view);
  assert.match(html, GRID);
  assert.match(html, /compact-month-occ-kind">Opens</);
  assert.match(html, /compact-month-occ-kind">Deadline</);
  assert.match(html, /compact-month-occ-kind">Event</);
  assert.match(html, /Applications open — Fixture Qualifying Exam/);
  assert.match(html, /Applications close — Fixture Qualifying Exam/);
  assert.match(html, /Exam date — Fixture Qualifying Exam/);
});

test("A1: the qualifying document mounts the shared component above the process section", () => {
  const html = documentHtml(fixtureExam("qualifying-three-date"));
  assert.match(html, GRID);
  assert.match(html, CALENDAR_SECTION);
  assert.match(html, STYLESHEET);
  // The one shared renderer is consumed, never forked.
  assert.match(html, /data-compact-month-schema="cityscroll\.compact_month_view\.v1"/);
  // Reader hierarchy: calendar sits below the actions and directly above the
  // application-to-appointment process it summarizes.
  const calendarAt = html.search(CALENDAR_SECTION);
  assert.ok(html.indexOf("Exam actions") < calendarAt, "actions stay above the calendar");
  assert.ok(calendarAt < html.indexOf("Application to appointment"), "calendar sits above the process section");
  // The retained full process stays reachable from the calendar.
  assert.match(html, /compact-month-full-list/);
  assert.match(html, /href="#exam-process-heading"/);
  assert.deepEqual(detectNodePageCruft(html), []);
});

test("A1: a published exam date outside the rolling 42-day window stays non-render", () => {
  const exam = { ...fixtureExam("qualifying-three-date"), exam_date: "2026-06-01" };
  const view = buildExamCalendarView(exam, { today: FIXTURE_TODAY });
  assert.equal(view.render, false);
  assert.equal(view.reason, "sparse-no-dense-window");
  assert.equal(renderExamApplicationCalendar(view), "");
  assert.doesNotMatch(documentHtml(exam), GRID);
});

test("A1: an exam date without a closing date is not a qualifying bundle", () => {
  const exam = fixtureExam("qualifying-three-date");
  delete exam.application_end;
  const view = buildExamCalendarView(exam, { today: FIXTURE_TODAY });
  assert.equal(view.render, false);
  assert.equal(view.reason, "sparse-too-few-occurrences");
});

/* ---------- A2: the ordinary two-date range stays compact ---------- */

test("A2: an ordinary two-date application range never renders a grid", () => {
  const view = buildExamCalendarView(fixtureExam("ordinary-two-date"), { today: FIXTURE_TODAY });
  assert.equal(view.render, false);
  assert.equal(view.reason, EXAM_NON_RENDER_NO_EXAM_DATE);
  assert.equal(renderExamApplicationCalendar(view), "");

  const html = documentHtml(fixtureExam("ordinary-two-date"));
  assert.doesNotMatch(html, GRID);
  assert.doesNotMatch(html, CALENDAR_SECTION);
  assert.doesNotMatch(html, STYLESHEET);
  // The existing compact application range is preserved untouched.
  assert.match(html, /Application window: 03\/02\/2026–03\/23\/2026/);
  assert.deepEqual(detectNodePageCruft(html), []);
});

test("A2: the committed staffing corpus stays calendar-free — non-render is the common case", () => {
  assert.ok(artifact.exams.length > 200, "corpus fixture must cover the real exam population");
  for (const exam of artifact.exams) {
    const view = buildExamCalendarView(exam, { today: FIXTURE_TODAY });
    assert.equal(view.render, false, `exam ${exam.exam_number} must not calendarize`);
    assert.equal(view.reason, EXAM_NON_RENDER_NO_EXAM_DATE, `exam ${exam.exam_number} reason`);
  }
});

/* ---------- A3: predicted eligible-list ranges never become occurrences ---------- */

test("A3: a predicted eligible-list window never becomes a calendar occurrence", () => {
  const exam = fixtureExam("predicted-exclusion");
  const bundle = examApplicationBundle(exam);
  assert.equal(bundle.occurrences.length, 2, "only the two publisher dates are projected");
  const days = bundle.occurrences.map((occurrence) => occurrence.date);
  const predicted = exam.list_establishment_forecast.prediction.predicted_window;
  for (const day of [predicted.p10, predicted.p50, predicted.p90]) {
    assert.ok(!days.includes(day), `predicted ${day} must never be an occurrence`);
  }

  const view = buildExamCalendarView(exam, { today: FIXTURE_TODAY });
  assert.equal(view.render, false);
  assert.equal(view.reason, EXAM_NON_RENDER_NO_EXAM_DATE);
  assert.doesNotMatch(documentHtml(exam), GRID);
});

test("A3: a prediction basis is excluded at the eligibility boundary even when projected", () => {
  const exam = {
    ...fixtureExam("predicted-exclusion"),
    exam_date: "2026-04-06",
    predicted: true,
  };
  const bundle = examApplicationBundle(exam);
  assert.equal(bundle.occurrences.length, 0);
  assert.ok(bundle.excluded.some((entry) => entry.reason === "predicted-date"));
  assert.equal(buildExamCalendarView(exam, { today: FIXTURE_TODAY }).render, false);
});

test("A3: a qualifying exam carrying a forecast still calendarizes only observed dates", () => {
  const exam = {
    ...fixtureExam("qualifying-three-date"),
    list_establishment_forecast: fixtureExam("predicted-exclusion").list_establishment_forecast,
  };
  const view = buildExamCalendarView(exam, { today: FIXTURE_TODAY });
  assert.equal(view.render, true);
  assert.deepEqual(view.occurrence_days, ["2026-03-02", "2026-03-23", "2026-04-06"]);
  // The prediction remains explicit prose, not a calendar cell.
  const html = documentHtml(exam);
  assert.match(html, /Expect the eligible list about/);
  assert.match(html, /data-prediction-subject="eligible-list-establishment"/);
});

/* ---------- A4: continuous/rolling filing stays explicit, never a grid ---------- */

test("A4: continuous filing never renders a grid even with a dense date bundle", () => {
  const exam = fixtureExam("rolling-continuous");
  const bundle = examApplicationBundle(exam);
  assert.equal(bundle.continuous_filing, true);
  assert.equal(bundle.occurrences.length, 3, "the dates exist; filing semantics withhold the grid");

  const view = buildExamCalendarView(exam, { today: FIXTURE_TODAY });
  assert.equal(view.render, false);
  assert.equal(view.reason, EXAM_NON_RENDER_CONTINUOUS_FILING);

  const html = documentHtml(exam);
  assert.doesNotMatch(html, GRID);
  assert.doesNotMatch(html, CALENDAR_SECTION);
  // The explicit application range remains as the only presentation.
  assert.match(html, /Application window: 03\/02\/2026–03\/23\/2026/);
});

test("A4: rolling and until-expended filing labels are equally withheld", () => {
  for (const label of ["Rolling", "open-ended", "until expended", "walk-in"]) {
    const exam = { ...fixtureExam("rolling-continuous"), filing_mode: label };
    const view = buildExamCalendarView(exam, { today: FIXTURE_TODAY });
    assert.equal(view.render, false, label);
    assert.equal(view.reason, EXAM_NON_RENDER_CONTINUOUS_FILING, label);
  }
});

/* ---------- lifecycle: cancellation and reschedule ---------- */

test("a canceled exam keeps occurrence identity with an explicit cancelled state", () => {
  const exam = { ...fixtureExam("qualifying-three-date"), schedule_status: "canceled" };
  const view = buildExamCalendarView(exam, { today: FIXTURE_TODAY });
  assert.equal(view.render, true);
  for (const day of view.weeks.flat()) {
    for (const occurrence of day.visible_occurrences) {
      assert.equal(occurrence.lifecycle, "cancelled");
      assert.equal(occurrence.status, "cancelled");
    }
  }
  const html = renderExamApplicationCalendar(view);
  assert.match(html, /compact-month-occ-flag-cancelled">Cancelled/);
  // Identity survives the cancellation: links still resolve to the document.
  assert.match(html, /https:\/\/cityscroll\.org\/exams\/9001\//);
});

test("a postponed exam presents its published dates as rescheduled, never plainly scheduled", () => {
  const exam = { ...fixtureExam("qualifying-three-date"), schedule_status: "postponed" };
  const view = buildExamCalendarView(exam, { today: FIXTURE_TODAY });
  assert.equal(view.render, true);
  for (const day of view.weeks.flat()) {
    for (const occurrence of day.visible_occurrences) {
      assert.equal(occurrence.lifecycle, "rescheduled");
    }
  }
  assert.match(renderExamApplicationCalendar(view), /compact-month-occ-flag-rescheduled">Rescheduled/);
});

/* ---------- source and link identity ---------- */

test("occurrences carry stable identity, the canonical document, and the notice source", () => {
  const bundle = examApplicationBundle(fixtureExam("qualifying-three-date"));
  const byKind = new Map(bundle.occurrences.map((occurrence) => [occurrence.kind, occurrence]));
  assert.equal(byKind.get("window_open").uid, "exam:9001:window_open");
  assert.equal(byKind.get("deadline").uid, "exam:9001:deadline");
  assert.equal(byKind.get("event").uid, "exam:9001:event");
  for (const occurrence of bundle.occurrences) {
    assert.equal(occurrence.object_ref, "exam:9001");
    assert.equal(occurrence.canonical_url, "https://cityscroll.org/exams/9001/");
    assert.equal(occurrence.source.url, fixtureExam("qualifying-three-date").notice_url);
    assert.equal(occurrence.provenance.basis, "publisher_record");
  }
  const html = renderExamApplicationCalendar(buildExamCalendarView(fixtureExam("qualifying-three-date"), { today: FIXTURE_TODAY }));
  assert.match(html, /class="compact-month-occ-source" href="https:\/\/www\.nyc\.gov\/assets\/dcas\/downloads\/exams\/example-noe\.pdf"/);
});

/* ---------- partial, unavailable, and malformed input ---------- */

test("partial and unavailable exams non-render with explicit reasons", () => {
  const openOnly = fixtureExam("ordinary-two-date");
  delete openOnly.application_end;
  assert.equal(buildExamCalendarView(openOnly, { today: FIXTURE_TODAY }).reason, EXAM_NON_RENDER_NO_EXAM_DATE);

  const undated = { exam_number: "9005", title: "Undated fixture exam" };
  const view = buildExamCalendarView(undated, { today: FIXTURE_TODAY });
  assert.equal(view.render, false);
  assert.equal(view.reason, "unavailable-no-occurrences");
  assert.doesNotMatch(documentHtml(undated), GRID);
});

test("malformed dates are withheld, never rendered into a broken cell", () => {
  const badExamDate = { ...fixtureExam("ordinary-two-date"), exam_date: "mid-April" };
  const view = buildExamCalendarView(badExamDate, { today: FIXTURE_TODAY });
  assert.equal(view.render, false);
  assert.equal(view.reason, EXAM_NON_RENDER_NO_EXAM_DATE);

  const badClose = { ...fixtureExam("qualifying-three-date"), application_end: "TBD" };
  assert.equal(buildExamCalendarView(badClose, { today: FIXTURE_TODAY }).reason, "sparse-too-few-occurrences");
});

/* ---------- A5: official actions remain primary ---------- */

test("A5: official application and notice actions stay primary above the calendar", () => {
  const html = documentHtml(fixtureExam("qualifying-three-date"));
  const calendarAt = html.search(CALENDAR_SECTION);
  const applyAt = html.indexOf('data-exam-action="apply"');
  const noticeAt = html.indexOf('data-exam-action="source"');
  assert.ok(applyAt > 0 && applyAt < calendarAt, "apply action precedes the calendar");
  assert.ok(noticeAt > 0 && noticeAt < calendarAt, "notice action precedes the calendar");
  assert.match(html, /class="[^"]*\bprimary\b[^"]*"[^>]*data-exam-action="apply"/);
  // Reader-facing order: apply first inside the action row.
  assert.ok(applyAt < noticeAt, "apply remains the first action");
});

/* ---------- contract hygiene ---------- */

test("today is required and the view build is a pure function of its arguments", () => {
  const exam = fixtureExam("qualifying-three-date");
  assert.throws(() => buildExamCalendarView(exam, {}), TypeError);
  assert.throws(() => buildExamCalendarView(exam, { today: "March" }), TypeError);
  assert.deepEqual(
    buildExamCalendarView(exam, { today: FIXTURE_TODAY }),
    buildExamCalendarView(exam, { today: FIXTURE_TODAY }),
  );
});

test("rendered calendar copy carries no schema, join, or workstream vocabulary", () => {
  const html = documentHtml(fixtureExam("qualifying-three-date"));
  const section = html.slice(html.search(CALENDAR_SECTION));
  const forbidden = /\b(cbics|release-control|workstream|control[- ]plane|object_ref|scope_ref|qualifying bundle|density rule)\b/i;
  assert.doesNotMatch(section, forbidden);
});
