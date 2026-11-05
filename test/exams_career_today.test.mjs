/**
 * Exams actionable first-page depends on the civic day.
 *
 *   node --test test/exams_career_today.test.mjs
 *
 * The Exams browser check asserts an upcoming card on the first paint. The guide
 * paints `initialPageSize` actionable rows (open before upcoming). When enough
 * application windows open on the real calendar, that first page fills with open
 * cards and the upcoming assertion fails even though upcoming exams still exist.
 *
 * The harness therefore pins `CROL_PINNED_TODAY`, and `careerToday` must honor it.
 * This file locks both the pin seam and the committed-snapshot first-page property
 * that makes the pin load-bearing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const examsSource = read("site/app/exams.mjs");
const staffingExams = JSON.parse(read("site/data/staffing_exams.json"));

const INITIAL_PAGE_SIZE = Number(
  (examsSource.match(/initialPageSize:\s*(\d+)/) || [])[1] || 0,
);

function loadCareerToday(scope) {
  const match = examsSource.match(/function careerToday\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match, "exams.mjs no longer defines careerToday");
  return new Function("globalThis", `${match[0]}; return careerToday;`)(scope);
}

function fixturePinDay() {
  // open_window_as_of/generated_at are always the refresh's own build day, so on a
  // day the refresh opens a dense batch of exams they are the day most likely to
  // fail the property below. data_current_as_of/list_current_as_of are the slower
  // DCAS Open Data vintages and do not move with every refresh, so they make a
  // more stable anchor; fall back to the build day only when neither is present.
  for (const key of ["data_current_as_of", "list_current_as_of", "open_window_as_of", "generated_at"]) {
    const value = String(staffingExams[key] || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  }
  throw new Error("staffing_exams.json declares no vintage for a fixture pin");
}

function firstPageStatuses(today) {
  // Match the Exams guide default: open-competitive + actionable window.
  const filtered = Staffing.filterExams(
    staffingExams.exams,
    { window: "actionable", eligibility: "open_competitive", interest: "all", query: "" },
    today,
  );
  return filtered.slice(0, INITIAL_PAGE_SIZE).map((exam) => {
    if (Staffing.isContinuousExam(exam)) return "continuous";
    return Staffing.statusFor(exam, today);
  });
}

// Count against the same open-competitive + actionable filter firstPageStatuses
// uses, not every exam's raw status; a row the guide's own filter excludes can
// never occupy a page slot, so counting it would report a day as hostile when
// the rendered first page would not actually be saturated.
function filteredOpenCount(day) {
  return Staffing.filterExams(
    staffingExams.exams,
    { window: "actionable", eligibility: "open_competitive", interest: "all", query: "" },
    day,
  ).filter((exam) => !Staffing.isContinuousExam(exam) && Staffing.statusFor(exam, day) === "open").length;
}

/** A day on which open exams alone fill the first actionable page. */
function hostileWallClockDay(pinDay) {
  const openByEnd = new Map();
  for (const exam of staffingExams.exams) {
    const start = String(exam.application_start || "").slice(0, 10);
    const end = String(exam.application_end || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) continue;
    if (end < pinDay) continue;
    const bucket = openByEnd.get(end) || [];
    bucket.push(exam);
    openByEnd.set(end, bucket);
  }
  const ends = [...openByEnd.keys()].sort();
  for (const end of ends) {
    const day = end < pinDay ? pinDay : end;
    if (filteredOpenCount(day) >= INITIAL_PAGE_SIZE) return day;
  }
  // Fall back to the latest application_start among exams that open after the pin:
  // walking forward one day at a time from the pin until the open count fills the page.
  let day = pinDay;
  for (let step = 0; step < 120; step += 1) {
    if (filteredOpenCount(day) >= INITIAL_PAGE_SIZE) return day;
    const [y, m, d] = day.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    day = next.toISOString().slice(0, 10);
  }
  throw new Error(
    `committed staffing_exams.json never fills the first ${INITIAL_PAGE_SIZE} rows with open exams; the calendar regression needs a denser snapshot`,
  );
}

test("careerToday returns a harness pin before the real day", () => {
  const careerToday = loadCareerToday({ CROL_PINNED_TODAY: "2026-11-04" });
  assert.equal(careerToday(), "2026-11-04");
});

test("careerToday ignores a malformed pin and keeps a YYYY-MM-DD shape", () => {
  const careerToday = loadCareerToday({ CROL_PINNED_TODAY: "yesterday" });
  assert.match(careerToday(), /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(careerToday(), "yesterday");
});

test("exams careerToday reads the harness pin before falling back to the real day", () => {
  assert.match(
    examsSource,
    /function careerToday\(\)\s*\{[\s\S]*?CROL_PINNED_TODAY[\s\S]*?new Date\(\)/,
    "careerToday must read CROL_PINNED_TODAY before falling back to the real day",
  );
  assert.doesNotMatch(
    examsSource,
    /CROL_PINNED_TODAY\s*=/,
    "exams.mjs must not assign the harness pin",
  );
});

test("the Exams route browser check pins the fixture civic day", () => {
  const source = read("test/functional/29_exams_route.py");
  assert.match(source, /from fixture_clock import pin_fixture_clock/);
  assert.match(source, /pin_fixture_clock\(/);
});

test("the exams guide declares an initial page size the calendar check depends on", () => {
  assert.equal(INITIAL_PAGE_SIZE, 16);
});

test("the fixture pin day keeps an upcoming card on the first actionable page", () => {
  const pinDay = fixturePinDay();
  const statuses = firstPageStatuses(pinDay);
  assert.ok(
    statuses.includes("upcoming"),
    `pinned day ${pinDay} must keep an upcoming card in the first ${INITIAL_PAGE_SIZE} actionable rows; got ${statuses.join(",")}`,
  );
  assert.ok(
    statuses.includes("open"),
    `pinned day ${pinDay} must also keep an open card so Apply contrast stays covered`,
  );
});

test("a denser open calendar can hide upcoming from the first page without the pin", () => {
  // This is the failure mode the routes-focus exams check hits when careerToday
  // follows wall-clock: open windows fill initialPageSize and upcoming falls off.
  const pinDay = fixturePinDay();
  const hostileDay = hostileWallClockDay(pinDay);
  assert.notEqual(hostileDay, pinDay, "hostile day must differ from the fixture pin");
  const statuses = firstPageStatuses(hostileDay);
  assert.equal(
    statuses.includes("upcoming"),
    false,
    `hostile day ${hostileDay} should hide upcoming from the first page so the pin stays load-bearing; got ${statuses.join(",")}`,
  );
});
