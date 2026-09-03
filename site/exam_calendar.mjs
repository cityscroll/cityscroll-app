/**
 * Exam application-bundle calendar wiring (CBICS-08).
 *
 * The exam surface consumer of the shared compact month component. It decides
 * which exams genuinely qualify for a month view and hands every render to the
 * one shared view model and renderer in `compact_calendar.mjs` — this module
 * never draws a grid itself.
 *
 * The qualifying bundle is deliberately narrow: the publisher-observed
 * application opening, the application closing, and an actual published
 * examination date, admitted through the bounded display-occurrence contract
 * (CBICS-01 eligibility) and the commissioned density rule (three eligible
 * occurrences on at least two distinct dates inside a rolling 42-day window).
 * An ordinary two-date application range keeps its existing compact form with
 * no calendar at all — truthful non-render is this surface's most common and
 * correct outcome.
 *
 * Hard exclusions, decided here before any grid is considered:
 *
 *   - Continuous / rolling / walk-in filing never gets a grid. A month view of
 *     open and close cells would imply a fixed filing window that rolling
 *     filing does not have; the existing explicit application-range copy stays
 *     exactly as it is.
 *   - Predicted eligible-list establishment ranges (the statistical
 *     `list_establishment_forecast` window) are never projected into
 *     occurrences: the CAL-C7 exam projection reads only publisher date
 *     fields, and the CBICS-01 eligibility boundary would exclude a
 *     prediction-basis date even if one were handed to it.
 *   - A canceled exam keeps its occurrence identity with an explicit cancelled
 *     lifecycle; a postponed exam's currently published dates carry the
 *     rescheduled lifecycle rather than presenting as plainly scheduled.
 *
 * Occurrence identity, canonical destination, and source basis come from the
 * CAL-C7 exam projection (`calendar_occurrence.mjs`): stable UIDs of the form
 * `exam:<number>:window_open|deadline|event`, the exam's canonical document as
 * the destination, and the notice/schedule source retained on each occurrence.
 *
 * An exam bundle carries at most three occurrences on at least two distinct
 * dates, so a day cell can never exceed the shared crowded-day limit; the
 * print-disclosure companion binder is therefore not mounted on this surface.
 *
 * Pure: no clock, no I/O. `today` is a required explicit argument.
 */

import { classifyDisplayRecord } from "./calendar_display.mjs";
import { COMPACT_MONTH_NON_RENDER_SCHEMA, buildCompactMonthView, renderCompactMonth } from "./compact_calendar.mjs";
import { isContinuousFilingExam } from "./exam_process_spine.mjs";

// Exam-surface non-render reasons, added to the shared cluster vocabulary
// (unavailable-*/sparse-*) so a reader of the result can tell "nothing to
// plan around" apart from "filing never closes into a fixed grid".
export const EXAM_NON_RENDER_CONTINUOUS_FILING = "continuous-rolling-filing";
export const EXAM_NON_RENDER_NO_EXAM_DATE = "no-published-exam-date";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isDateOnly(value) {
  return typeof value === "string" && ISO_DATE.test(value);
}

// Map the exam's published schedule state onto occurrence lifecycle so a
// canceled exam keeps explicit cancelled occurrences and a postponed exam's
// dates never present as plainly scheduled. The generic projection only reads
// `status`/`lifecycle`, which exam records do not carry.
function occurrenceRecordView(exam) {
  const status = clean(exam?.schedule_status).toLowerCase();
  if (status === "canceled" || status === "cancelled") {
    return { ...exam, status: "cancelled", lifecycle: "cancelled" };
  }
  if (status === "postponed") {
    return { ...exam, lifecycle: "rescheduled" };
  }
  return exam;
}

/**
 * The exam's eligible display occurrences and every excluded candidate, via
 * the CAL-C7 exam projection and the CBICS-01 eligibility boundary. The
 * predicted eligible-list forecast is never projected: it is not a publisher
 * date field, and a prediction basis is excluded at the eligibility boundary.
 */
export function examApplicationBundle(exam = {}, options = {}) {
  const classified = classifyDisplayRecord(occurrenceRecordView(exam), { ...options, kind: "exam" });
  const occurrences = classified.eligible_occurrences;
  return {
    exam_number: clean(exam?.exam_number) || null,
    continuous_filing: isContinuousFilingExam(exam),
    has_published_exam_date: occurrences.some((occurrence) => occurrence.kind === "event"),
    occurrences,
    excluded: classified.excluded,
  };
}

/**
 * Build the exam document's calendar view. Returns the shared compact month
 * view (`render: true`) only for a genuinely qualifying bundle; otherwise an
 * explicit non-render result whose reason names the boundary that stopped it.
 * `today` is required so the result never depends on a hidden clock.
 */
export function buildExamCalendarView(exam = {}, options = {}) {
  if (!isDateOnly(options.today)) {
    throw new TypeError("buildExamCalendarView requires an explicit YYYY-MM-DD `today`");
  }
  const bundle = examApplicationBundle(exam, options);
  const examState = {
    exam_number: bundle.exam_number,
    continuous_filing: bundle.continuous_filing,
    excluded: bundle.excluded,
  };

  // Rolling filing stays explicit copy; a grid would imply a fixed window.
  if (bundle.continuous_filing) {
    return {
      schema: COMPACT_MONTH_NON_RENDER_SCHEMA,
      render: false,
      reason: EXAM_NON_RENDER_CONTINUOUS_FILING,
      candidate_occurrences: bundle.occurrences.length,
      ...examState,
    };
  }

  // Without an actual published exam date there is nothing to plan around
  // that the compact application range does not already say.
  if (!bundle.has_published_exam_date) {
    return {
      schema: COMPACT_MONTH_NON_RENDER_SCHEMA,
      render: false,
      reason: bundle.occurrences.length === 0 ? "unavailable-no-occurrences" : EXAM_NON_RENDER_NO_EXAM_DATE,
      candidate_occurrences: bundle.occurrences.length,
      ...examState,
    };
  }

  // The full observed bundle still has to meet the commissioned density rule.
  const view = buildCompactMonthView(bundle.occurrences, { today: options.today });
  if (!view.render) return { ...view, ...examState };
  return { ...view, exam_number: bundle.exam_number };
}

/**
 * Render the exam document's calendar fragment. A non-render view produces no
 * markup at all — no empty calendar chrome, no placeholder. The full
 * application-to-appointment process stays reachable through an in-page link
 * to the retained spine section.
 */
export function renderExamApplicationCalendar(view, options = {}) {
  if (!view || view.render !== true) return "";
  const fullListHref = options.fullListHref === undefined ? "#exam-process-heading" : options.fullListHref;
  return renderCompactMonth(view, {
    esc: options.esc,
    fullListHref,
    fullListLabel: "See the full application-to-appointment process",
  });
}
