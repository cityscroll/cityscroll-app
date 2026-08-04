import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const peopleSource = readFileSync(new URL("../site/app/people.mjs", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let opened = false;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") {
      depth += 1;
      opened = true;
    } else if (source[i] === "}" && opened && --depth === 0) {
      return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

const staffingSection = html.slice(
  html.indexOf('<section id="tab-people"'),
  html.indexOf("<!-- ============ LAND"),
);

test("Staffing follows the shared lens hierarchy with the answer and exam format first", () => {
  const intro = staffingSection.indexOf('class="career-browser-head lens-intro"');
  const toolbar = staffingSection.indexOf('class="lens-toolbar career-toolbar"');
  const primary = staffingSection.indexOf('id="career-format-rail"');
  const resultbar = staffingSection.indexOf('id="career-resultbar"');
  const results = staffingSection.indexOf('id="career-results"');
  const ledger = staffingSection.indexOf('id="staffing-ledger"');
  assert.ok(intro >= 0 && intro < toolbar);
  assert.ok(toolbar < primary && primary < resultbar);
  assert.ok(resultbar < results && results < ledger);
  assert.match(staffingSection, /class="lens-method career-how"/);
});

test("Staffing keeps exam format visible while secondary controls stay in one disclosure", () => {
  const disclosureStart = staffingSection.indexOf('id="staffing-more-filters"');
  const disclosureEnd = staffingSection.indexOf("</details>", disclosureStart);
  const disclosure = staffingSection.slice(disclosureStart, disclosureEnd);
  for (const id of [
    "career-query",
    "career-interest",
    "career-eligibility",
    "career-window",
    "career-salary-band",
    "career-fee-level",
    "career-no-experience",
  ]) {
    assert.match(disclosure, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(disclosure, /id="career-format-rail"|id="career-sort"/);
  assert.ok(staffingSection.indexOf('id="career-format-rail"') > disclosureEnd);
  assert.match(staffingSection, /id="career-result-count"[\s\S]*?id="career-sort"/);
});

test("Staffing renders one count for the exact exam list and a positive active-filter badge", () => {
  const render = extractFunction(peopleSource, "renderCareerGuide");
  const badge = extractFunction(peopleSource, "updateCareerMoreFiltersState");
  assert.match(render, /career-result-count/);
  assert.match(render, /sortCareerExams/);
  assert.match(render, /renderCareerFormatRail/);
  assert.match(badge, /property_filters_active/);
  assert.match(badge, /badge\.hidden=active===0/);
});

test("Staffing publishes one load status instead of stacked apology panels", () => {
  const failure = extractFunction(peopleSource, "showCareerLoadFailure");
  assert.match(failure, /#career-source/);
  assert.match(failure, /#career-results/);
  assert.doesNotMatch(failure, /career-empty/);
  assert.match(failure, /\.innerHTML=""/);
  const spine = extractFunction(peopleSource, "examProcessSpineHTML");
  const outcomes = extractFunction(peopleSource, "careerOutcomeHTML");
  assert.doesNotMatch(spine, /lc-norecord|exam_stage_not_yet_ingested_html/);
  assert.doesNotMatch(outcomes, /career_outcomes_not_yet_ingested_html/);
});

test("Staffing lens chrome consumes the shared design-language tokens", () => {
  const start = html.indexOf(".staffing-ledger{");
  const end = html.indexOf("/* land stub */", start);
  const css = html.slice(start, end);
  assert.match(css, /var\(--color-action\)/);
  assert.match(css, /var\(--color-surface\)/);
  assert.match(css, /var\(--space-3\)/);
  assert.match(css, /var\(--radius-md\)/);
  assert.match(css, /#career-format-rail \.chip\[aria-pressed="true"\] \.ct\{color:var\(--color-surface\)\}/);
  assert.match(css, /\.career-source-detail\{flex:0 0 min\(42%,320px\)\}/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});
