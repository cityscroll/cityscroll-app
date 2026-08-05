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
import { buildMoneyDeepLink, buildSearchDeepLink } from "../site/nl_deeplink.js";
import { SUGGESTION_POOL, FALLBACK_INDICES } from "../worker/src/lib/suggestions.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const receipt = JSON.parse(
  readFileSync(join(ROOT, "site", "data", "preset-validation.json"), "utf8"),
);

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

test("fallback indices match the receipt fruitful set and include discovery showcase chips", () => {
  const counts = new Map(
    (receipt.suggestions.candidates || []).map((c) => [`${c.lens}:${c.idx}`, Number(c.count) || 0]),
  );
  // validate_presets --check requires FALLBACK === all live-fruitful idxs (display still
  // shows only three chips via day-seeded pickSuggestions).
  assert.deepEqual(FALLBACK_INDICES, receipt.suggestions.byLens);
  for (const [lens, indices] of Object.entries(FALLBACK_INDICES)) {
    assert.ok(indices.length >= 1, `${lens} fallback empty`);
    for (const idx of indices) {
      assert.ok(
        (counts.get(`${lens}:${idx}`) || 0) >= 1,
        `${lens}:${idx} in fallback but count ${counts.get(`${lens}:${idx}`)}`,
      );
    }
  }
  // Discovery surfaces must appear in the rotating fallback shop window.
  assert.ok(FALLBACK_INDICES.money.includes(6), "closing-this-week on money fallback");
  assert.ok(FALLBACK_INDICES.money.includes(7), "agency forecast on money fallback");
  assert.ok(FALLBACK_INDICES.land.includes(4), "council district on land fallback");
  assert.ok(FALLBACK_INDICES.rules.includes(4), "open for comment on rules fallback");
  assert.ok(FALLBACK_INDICES.meetings.includes(4), "hearings this week on meetings fallback");
  assert.ok(FALLBACK_INDICES.people.includes(3), "exam guide on people fallback");
});

test("receipt filters for showcase chips resolve to expected structured fields", () => {
  const byKey = Object.fromEntries(
    (receipt.suggestions.candidates || []).map((c) => [`${c.lens}:${c.idx}`, c]),
  );
  assert.equal(byKey["money:6"].filter.closingWeek, true);
  assert.equal(byKey["money:7"].filter.route, "agency");
  assert.equal(byKey["money:7"].filter.tab, "forecast");
  assert.equal(byKey["land:4"].filter.councilDistrict, "33");
  assert.equal(byKey["rules:4"].filter.process, "public_process");
  assert.equal(byKey["meetings:4"].filter.when, "week");
  assert.equal(byKey["meetings:5"].filter.when, "week");
  assert.equal(byKey["people:3"].filter.view, "guide");
  assert.equal(byKey["property:4"].filter.process, "hearing");
});
