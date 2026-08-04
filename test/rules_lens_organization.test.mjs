import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const rulesSource = readFileSync(new URL("../site/app/rules.mjs", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  let depth = 0;
  let opened = false;
  for (let index = source.indexOf("{", start); index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
      opened = true;
    } else if (source[index] === "}" && opened && --depth === 0) {
      return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

const rulesSection = html.slice(
  html.indexOf('<section id="tab-rules"'),
  html.indexOf('<section id="tab-meetings"'),
);

test("Rules follows the shared lens hierarchy with rulemaking stage as the primary answer", () => {
  const intro = rulesSection.indexOf('id="rules-domain-intro"');
  const toolbar = rulesSection.indexOf('id="rules-toolbar"');
  const primary = rulesSection.indexOf('id="rulesprocessrail"');
  const resultbar = rulesSection.indexOf('id="rules-resultbar"');
  const results = rulesSection.indexOf('id="rulesfeed"');
  assert.ok(intro >= 0 && intro < toolbar);
  assert.ok(toolbar < primary && primary < resultbar && resultbar < results);
  assert.match(rulesSection, /class="lens-method rules-method"/);
});

test("Rules keeps search and stage visible while secondary controls stay in one disclosure", () => {
  const disclosureStart = rulesSection.indexOf('id="rules-more-filters"');
  const disclosureEnd = rulesSection.indexOf("</details>", disclosureStart);
  const disclosure = rulesSection.slice(disclosureStart, disclosureEnd);
  assert.ok(rulesSection.indexOf('id="ruleskw"') < disclosureStart);
  for (const id of ["rulesagency", "rulesboro"]) {
    assert.match(disclosure, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(disclosure, /id="rulesprocessrail"/);
  assert.match(rulesSection, /id="rules-filter-badge" hidden/);
});

test("Rules paints an exact count and keeps absent results unpainted", () => {
  const render = extractFunction(rulesSource, "renderRulesExplorer");
  const count = extractFunction(rulesSource, "setRulesResultCount");
  const filters = extractFunction(rulesSource, "updateRulesMoreFiltersState");
  assert.match(render, /setRulesResultCount\(entries\.length\)/);
  assert.match(count, /results_count/);
  assert.match(render, /if\(!entries\.length\)\{[\s\S]*?feedEl\.innerHTML="";/);
  assert.match(filters, /rulesagency/);
  assert.match(filters, /rulesboro/);
  assert.match(filters, /property_filters_active/);
});

test("Rules lifecycle paints only published events", () => {
  const eventCard = extractFunction(rulesSource, "ruleEventCardHTML");
  const phasePanel = extractFunction(rulesSource, "rulePhasePanelHTML");
  const flat = extractFunction(rulesSource, "ruleEventSpineHTMLFlat");
  assert.match(eventCard, /if\(!event\) return "";/);
  assert.doesNotMatch(phasePanel, /missing_types|rule_phase_empty/);
  assert.match(flat, /\.filter\(Boolean\)/);
  assert.match(flat, /if\(!cards\.length\) return "";/);
  assert.doesNotMatch(rulesSource, /rule_event_not_published_html|rule_event_not_yet_ingested_html/);
  assert.doesNotMatch(rulesSource, /rules_list_no_agency/);
});

test("Rules lens chrome consumes the shared design-language tokens", () => {
  const start = html.indexOf("/* Rules lens template */");
  const end = html.indexOf("/* Map exploration", start);
  const css = html.slice(start, end);
  assert.match(css, /var\(--color-action\)/);
  assert.match(css, /var\(--color-surface\)/);
  assert.match(css, /var\(--space-3\)/);
  assert.match(css, /var\(--radius-md\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});

test("Hidden rail controls retain localized programmatic names", () => {
  assert.match(html, /<select id="career-format"[^>]*aria-label="Exam format"[^>]*data-i18n-aria="career_format_label"/);
  assert.match(html, /<select id="lstatus"[^>]*aria-label="Status"[^>]*data-i18n-aria="status_label"/);
});
