import { SITE_SOURCE } from "./helpers/site_source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chooseHearingScope } = require("../site/hearing_location.js");
const indexSource = SITE_SOURCE;
const i18nSource = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
const TODAY = "2026-07-29";

function hearing(id, date, title = "Public hearing") {
  return {
    request_id: id,
    event_date: `${date}T10:00:00.000`,
    agency: "Industrial Development Agency",
    title,
    decides: title,
    description: title,
    affects: [],
    affected_area: { scope: "unlocated", boroughs: [], neighborhoods: [], addresses: [] },
  };
}

test("zero results this week widen to this month and preserve the subject filter", () => {
  const records = [
    hearing("other", "2026-08-10", "Parks hearing"),
    hearing("ida-month", "2026-08-10", "IDA public hearing"),
  ];
  const result = chooseHearingScope(records, { when: "week", keyword: "IDA" }, TODAY);
  assert.equal(result.requested, "week");
  assert.equal(result.scope, "month");
  assert.equal(result.widened, true);
  assert.deepEqual(result.rows.map((row) => row.request_id), ["ida-month"]);
  assert.match(indexSource, /meetings_widened_notice/);
  assert.match(indexSource, /data-remove-widening/);
  assert.match(i18nSource, /meetings_widened_notice: "Showing \{shown\} for \{query\} \(\{none\}\)\."/);
  assert.doesNotMatch(i18nSource, /meetings_widened_notice: "No results/);
});

test("zero results in every upcoming scope show a labeled recent-past result", () => {
  const records = [hearing("ida-past", "2025-03-20", "IDA public hearing")];
  const result = chooseHearingScope(records, { when: "week", keyword: "IDA" }, TODAY);
  assert.equal(result.scope, "past");
  assert.equal(result.widened, true);
  assert.deepEqual(result.rows.map((row) => row.request_id), ["ida-past"]);
  assert.match(indexSource, /class="tag closed">\$\{t\("past_tag"\)\}/);
  assert.match(indexSource, /selection\.scope==="past"\?"upcoming":selection\.requested/);
});

test("true empty states lead with a recovery action instead of the absence", () => {
  assert.match(i18nSource, /no_hearings_after_widening: "Try a broader search\./);
  assert.match(i18nSource, /no_hearings_window: "Try the next 30 days or Citywide \/ unlocated\./);
});

test("removing automatic widening restores the exact empty search", () => {
  const records = [hearing("ida-month", "2026-08-10", "IDA public hearing")];
  const result = chooseHearingScope(records, { when: "week", keyword: "IDA" }, TODAY, false);
  assert.equal(result.scope, "week");
  assert.equal(result.widened, false);
  assert.deepEqual(result.rows, []);
});
