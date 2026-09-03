/**
 * Committed fixtures for the exam application-bundle calendar (CBICS-08).
 *
 * Shared by test/exam_calendar.test.mjs and the headless evidence capture in
 * tools/capture_exam_calendar_evidence.py so the unit assertions and the
 * visual evidence exercise exactly the same records. Fixture exam numbers are
 * outside the committed staffing corpus, so a fixture can never collide with
 * a real published exam document.
 *
 * Every date is publisher-observed on the record except where a fixture
 * deliberately carries a predicted eligible-list window to prove it is never
 * calendarized.
 */

export const FIXTURE_TODAY = "2026-02-15";

const NOTICE_URL = "https://www.nyc.gov/assets/dcas/downloads/exams/example-noe.pdf";
const APPLY_URL = "https://www.nyc.gov/examsforjobs";

// A1: application open, application close, and an actual published exam date
// inside one rolling 42-day window — the genuinely qualifying bundle.
const QUALIFYING_THREE_DATE = {
  exam_number: "9001",
  title: "Fixture Qualifying Exam",
  title_code: "90010",
  eligibility: "open_competitive",
  schedule_status: "scheduled",
  application_start: "2026-03-02",
  application_end: "2026-03-23",
  exam_date: "2026-04-06",
  notice_url: NOTICE_URL,
  official_application_url: APPLY_URL,
};

// A2: the ordinary application range — open and close only, no published exam
// date. This is the common case and must keep its compact form with no grid.
const ORDINARY_TWO_DATE = {
  exam_number: "9002",
  title: "Fixture Two-Date Exam",
  title_code: "90020",
  eligibility: "open_competitive",
  schedule_status: "scheduled",
  application_start: "2026-03-02",
  application_end: "2026-03-23",
  notice_url: NOTICE_URL,
  official_application_url: APPLY_URL,
};

// A4: continuous filing with dates that would otherwise qualify. Rolling
// filing never becomes a grid; the explicit application range stays.
const ROLLING_CONTINUOUS = {
  ...QUALIFYING_THREE_DATE,
  exam_number: "9003",
  title: "Fixture Continuous Filing Exam",
  filing_mode: "Continuous filing",
};

// A3: a predicted eligible-list establishment window whose median lands on
// the same day as the qualifying fixture's published exam date. The same
// calendar day qualifies only when actually published — a prediction never
// becomes an occurrence.
const PREDICTED_EXCLUSION = {
  ...ORDINARY_TWO_DATE,
  exam_number: "9004",
  title: "Fixture Predicted-Range Exam",
  list_establishment_forecast: {
    median_months: 14,
    n: 40,
    since_year: 2018,
    prediction: {
      predicted_window: { p10: "2026-03-20", p50: "2026-04-06", p90: "2026-05-01" },
    },
  },
};

export const EXAM_CALENDAR_FIXTURES = Object.freeze({
  "qualifying-three-date": QUALIFYING_THREE_DATE,
  "ordinary-two-date": ORDINARY_TWO_DATE,
  "rolling-continuous": ROLLING_CONTINUOUS,
  "predicted-exclusion": PREDICTED_EXCLUSION,
});

export function fixtureExam(name) {
  const exam = EXAM_CALENDAR_FIXTURES[name];
  if (!exam) throw new Error(`unknown exam calendar fixture: ${name}`);
  return JSON.parse(JSON.stringify(exam));
}
