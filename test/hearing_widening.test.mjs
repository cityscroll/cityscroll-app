import { SITE_SOURCE } from "./helpers/site_source.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  parseCommunityBoardQuery,
  rankCommunityBoardRows,
} from "../site/community_board_search.mjs";

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

test("all-date map drills retain undated members from the stamped corpus", () => {
  const records = [
    hearing("dated", "2026-08-20", "Queens"),
    { ...hearing("undated", null, "Queens"), event_date: null },
  ];
  const result = chooseHearingScope(records, { when: "all" }, TODAY);
  assert.equal(result.scope, "all");
  assert.deepEqual(result.rows.map((row) => row.request_id), ["dated", "undated"]);
});

test("CB3 ranking keeps every borough while putting context-matching upcoming rows first", () => {
  const rows = [
    {
      request_id: "bronx-archived",
      board_id: "bronx-cb-03",
      board_name: "Bronx Community Board 3",
      event_date: "2025-11-12",
    },
    {
      request_id: "manhattan-upcoming",
      board_id: "manhattan-cb-03",
      board_name: "Manhattan Community Board 3",
      event_date: "2026-09-29",
    },
    {
      request_id: "queens-upcoming",
      board_id: "queens-cb-03",
      board_name: "Queens Community Board 3",
      event_date: "2026-09-21",
    },
  ];
  const result = rankCommunityBoardRows(rows, {
    query: parseCommunityBoardQuery("community board 3"),
    context: { communityDistrict: "M03", source: "route" },
    today: "2026-08-16",
  });

  assert.deepEqual(result.rows.map((row) => row.request_id), [
    "manhattan-upcoming",
    "queens-upcoming",
    "bronx-archived",
  ]);
  assert.deepEqual(result.groups.map((group) => group.label), [
    "Manhattan CB3",
    "Queens CB3",
    "Bronx CB3",
  ]);
  assert.equal(result.rows.length, rows.length, "ranking must not hide alternate boroughs");
  assert.match(indexSource, /data-community-board-group/);
  assert.match(indexSource, /meetings_board_default_heading/);
});
