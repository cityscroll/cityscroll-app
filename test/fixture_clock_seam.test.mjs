/**
 * The civic day the app reasons about, and the seam a harness uses to pin it.
 *
 *   node --test test/fixture_clock_seam.test.mjs
 *
 * The outage this pins: `site/data/money_default_open.json` was taken on 2026-08-15 and its
 * newest response deadline is 2026-09-02. The Contracts list keeps solicitations whose deadline
 * is later than the current day, so from 00:00 UTC on 2026-09-02 it correctly contained nothing
 * — and every browser check that waits for a result row timed out. Three accessibility shards
 * turned red on pull requests that had touched no procurement code.
 *
 * The fix is not to loosen what "still open" means. A resident must keep being told the truth
 * about the real day. The suite instead states the day it is testing, so committed fixtures are
 * judged against a day on which they were true.
 *
 * Two properties matter and both are pinned here: a harness can set the day, and the shipped
 * product cannot be talked into a different one by anything a resident's browser does not
 * already control.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const coreSource = read("site/app/core.mjs");
const helperSource = read("test/functional/assets/fixture_clock.py");
const openSnapshot = JSON.parse(read("site/data/money_default_open.json"));

/** The seam, lifted out of `core.mjs` so its behaviour is exercised rather than described. */
function loadTodayISO(scope) {
  const match = coreSource.match(
    /const CROL_PINNED_DAY[\s\S]*?const todayISO = [^\n]*\n/);
  assert.ok(match, "core.mjs no longer defines the pinned-day seam");
  return new Function("globalThis", `${match[0]}; return todayISO;`)(scope);
}

test("a harness can pin the civic day", () => {
  const todayISO = loadTodayISO({ CROL_PINNED_TODAY: "2026-08-15" });
  assert.equal(todayISO(), "2026-08-15T00:00:00");
});

const CIVIC_DAY = /^\d{4}-\d{2}-\d{2}T00:00:00$/;

test("nothing pinned means the real day, so the product never lies about it", () => {
  // Deliberately no wall-clock read here: the assertion is the shape and the absence of a pin,
  // which is deterministic. Reading the clock to compare against would make this test straddle
  // midnight — the very failure mode under repair.
  for (const scope of [{}, { CROL_PINNED_TODAY: undefined }, { CROL_PINNED_TODAY: null }]) {
    assert.match(loadTodayISO(scope)(), CIVIC_DAY);
  }
  assert.notEqual(loadTodayISO({})(), "2026-08-15T00:00:00",
    "an unpinned clock must not return the fixture vintage");
});

test("a malformed pin is ignored rather than trusted", () => {
  for (const bad of ["", "yesterday", "2026-8-15", "2026-08-15T10:00:00Z", 20260815, {}, ["2026-08-15"]]) {
    const day = loadTodayISO({ CROL_PINNED_TODAY: bad })();
    assert.match(day, CIVIC_DAY, `a ${typeof bad} pin left the civic day malformed`);
    assert.equal(day.includes(String(bad)) && String(bad).length > 0, false,
      `a ${typeof bad} pin (${JSON.stringify(bad)}) must not become the civic day`);
  }
});

test("the shipped product sets no pin of its own", () => {
  // The seam is for harnesses. If any shipped module assigned it, the product could ship a day
  // that is not the resident's day, which is the failure this whole change exists to avoid.
  for (const path of ["site/app/core.mjs", "site/app/money-list.mjs", "site/app/land.mjs"]) {
    assert.doesNotMatch(read(path), /CROL_PINNED_TODAY\s*=/,
      `${path} assigns the fixture clock; only a harness may set it`);
  }
});

test("the harness derives its day from the fixture's own vintage", () => {
  // A refreshed snapshot must move the pinned day with it, so no date is maintained by hand.
  assert.match(helperSource, /open_as_of/);
  assert.match(helperSource, /generated_at/);
  assert.match(helperSource, /retrieved_at/);
  assert.doesNotMatch(helperSource, /\d{4}-\d{2}-\d{2}"/, "the helper hard-codes a day");

  const vintage = String(openSnapshot.open_as_of || "").slice(0, 10);
  assert.match(vintage, /^\d{4}-\d{2}-\d{2}$/, "the committed snapshot declares no vintage");
  // The day the harness will pin must actually make the snapshot non-empty, or the browser
  // checks are back to waiting for a row that never comes.
  const open = (openSnapshot.notices || [])
    .filter((row) => String(row?.due_date || "").slice(0, 10) > vintage);
  assert.ok(open.length > 0,
    `no notice in the committed snapshot is open on its own as-of (${vintage})`);
});

test("the browser checks that need result rows pin the clock", () => {
  for (const name of ["23_mobile_viewport", "15_rtl", "30_browse_interaction_grammar",
    "11_accessibility", "16_forecast_discoverability", "29_snapshot_only_resident_reads"]) {
    const source = read(`test/functional/${name}.py`);
    assert.match(source, /from fixture_clock import pin_fixture_clock/, `${name} does not import the pin`);
    assert.match(source, /pin_fixture_clock\(/, `${name} never pins the clock`);
  }
});
