// Discovery parity: NL parse + deep links reach current product surfaces (districts,
// closing-week deadlines, process rails, agency forecast, exam guide, action-week
// meetings) — not only legacy keyword lists.
//
//   node --test test/discovery_parity_nl.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseNL,
  extractCouncilDistrict,
  extractRulesProcess,
  extractPropertyProcess,
  extractMeetingWhen,
  extractStaffingGuide,
  extractClosingWeek,
} from "../site/nl_parse.js";
import {
  buildMoneyDeepLink,
  buildSearchDeepLink,
  composeLensQueryState,
  lensQueryStateFilter,
} from "../site/nl_deeplink.js";
import { SUGGESTION_POOL, FALLBACK_INDICES } from "../worker/src/lib/suggestions.mjs";

test("money: closing this week routes to open RFPs with closing=week", () => {
  const f = parseNL("contracts closing this week");
  assert.equal(f.closingWeek, true);
  assert.equal(f.noticeType, "solicitation");
  assert.equal(buildMoneyDeepLink(f), "#money?mode=open&closing=week");
});

test("money: Parks contract forecast routes to agency forecast tab", () => {
  const f = parseNL("Parks contract forecast");
  assert.equal(f.route, "agency");
  assert.equal(f.name, "Parks and Recreation");
  assert.equal(f.tab, "forecast");
  assert.equal(
    buildMoneyDeepLink(f),
    "/agencies/parks-and-recreation/?tab=forecast",
  );
});

test("land: council district extracts and deep-links", () => {
  assert.equal(extractCouncilDistrict(" rezonings in council district 33 "), "33");
  assert.equal(
    buildSearchDeepLink("land", { councilDistrict: "33", keywords: [] }),
    "#land?council=33",
  );
});

test("rules: open for comment maps to public_process deep link", () => {
  assert.equal(extractRulesProcess(" rules open for comment "), "public_process");
  assert.equal(
    buildSearchDeepLink("rules", { process: "public_process", keywords: [] }),
    "#rules?process=public_process",
  );
});

test("property: disposition hearings map to process=hearing", () => {
  assert.equal(extractPropertyProcess(" property disposition hearings "), "hearing");
  assert.equal(
    buildSearchDeepLink("property", { process: "hearing", keywords: [] }),
    "#property?process=hearing",
  );
});

test("meetings: this week and action phrasing map to when=week", () => {
  assert.equal(extractMeetingWhen(" hearings this week "), "week");
  assert.equal(extractMeetingWhen(" what can i comment on this week "), "week");
  assert.equal(
    buildSearchDeepLink("meetings", { when: "week", keywords: [] }),
    "#meetings?when=week",
  );
});

test("meetings: Ask adds time to the standard text clause and carried M03 place", () => {
  const composed = composeLensQueryState("meetings", {
    keywords: ["community board 3"],
    borough: "Manhattan",
    communityDistrict: "M03",
  }, {
    when: "upcoming",
    keywords: [],
  });

  assert.deepEqual(composed.conflicts, []);
  assert.equal(composed.state.text, "community board 3");
  assert.deepEqual(composed.state.place, {
    borough: "Manhattan",
    communityDistrict: "M03",
    councilDistrict: null,
    neighborhood: null,
    locationScope: null,
  });
  assert.equal(composed.state.facets.when, "upcoming");
  assert.equal(
    buildSearchDeepLink("meetings", lensQueryStateFilter(composed.state)),
    "#meetings?q=community+board+3&when=upcoming&boro=Manhattan&cd=M03",
  );
});

test("meetings: a conflicting Ask place produces explicit keep/use choices", () => {
  const composed = composeLensQueryState("meetings", {
    keywords: ["Manhattan"],
  }, {
    borough: "Bronx",
    when: "upcoming",
    keywords: [],
  });

  assert.deepEqual(composed.conflicts.map((conflict) => conflict.field), ["place"]);
  assert.equal(composed.conflicts[0].current, "Manhattan");
  assert.equal(composed.conflicts[0].proposed, "Bronx");
  assert.equal(composed.choices.keep_current.text, "Manhattan");
  assert.equal(composed.choices.keep_current.place.borough, null);
  assert.equal(composed.choices.use_proposed.text, "");
  assert.equal(composed.choices.use_proposed.place.borough, "Bronx");
});

test("people: open competitive exams maps to career guide deep link", () => {
  assert.equal(extractStaffingGuide(" open competitive exams "), true);
  assert.equal(
    buildSearchDeepLink("people", { view: "guide", keywords: [] }),
    "#people?view=guide",
  );
});

test("closing-week extractor is high-precision (not every week mention)", () => {
  assert.equal(extractClosingWeek(" education contracts due in 3 weeks "), false);
  assert.equal(extractClosingWeek(" contracts closing this week "), true);
});

test("suggestion pool includes discovery-parity showcase chips", () => {
  const texts = new Set(SUGGESTION_POOL.map((c) => c.text));
  for (const need of [
    "contracts closing this week",
    "Parks contract forecast",
    "rezonings in council district 33",
    "rules open for comment",
    "hearings this week",
    "what can I comment on this week",
    "open competitive exams",
    "property disposition hearings",
  ]) {
    assert.ok(texts.has(need), `missing showcase suggestion: ${need}`);
  }
});

test("fallback indices include discovery showcase chips", () => {
  for (const [lens, indices] of Object.entries(FALLBACK_INDICES)) {
    assert.ok(indices.length >= 1, `${lens} fallback empty`);
    for (const idx of indices) {
      assert.ok(
        SUGGESTION_POOL.some((candidate) => candidate.lens === lens && candidate.idx === idx),
        `${lens}:${idx} has no matching SUGGESTION_POOL candidate`,
      );
    }
  }
  assert.ok(FALLBACK_INDICES.money.includes(6), "closing-this-week on money fallback");
  assert.ok(!FALLBACK_INDICES.money.includes(7), "proxy-only agency forecast stays out until its destination is certifiable");
  assert.ok(FALLBACK_INDICES.land.includes(4), "council district on land fallback");
  assert.ok(FALLBACK_INDICES.rules.includes(4), "open for comment on rules fallback");
  assert.ok(FALLBACK_INDICES.meetings.includes(4), "hearings this week on meetings fallback");
  assert.ok(FALLBACK_INDICES.people.includes(3), "exam guide on people fallback");
});

test("showcase chip texts resolve to expected structured fields", () => {
  assert.equal(parseNL("contracts closing this week").closingWeek, true);
  const parks = parseNL("Parks contract forecast");
  assert.equal(parks.route, "agency");
  assert.equal(parks.tab, "forecast");
  assert.equal(extractCouncilDistrict("rezonings in council district 33"), "33");
  assert.equal(extractRulesProcess("rules open for comment"), "public_process");
  assert.equal(extractMeetingWhen("hearings this week"), "week");
  assert.equal(extractMeetingWhen("what can I comment on this week"), "week");
  assert.equal(extractStaffingGuide("open competitive exams"), true);
  assert.equal(extractPropertyProcess("property disposition hearings"), "hearing");
});
