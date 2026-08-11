import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const rulesSource = readFileSync(new URL("../site/app/rules.mjs", import.meta.url), "utf8");

const rulesSection = html.slice(
  html.indexOf('<section id="tab-rules"'),
  html.indexOf('<section id="tab-meetings"'),
);

test("Rules follows the shared lens hierarchy with phase as the primary facet", () => {
  const intro = rulesSection.indexOf('id="rules-domain-intro"');
  const toolbar = rulesSection.indexOf('id="rules-toolbar"');
  const primary = rulesSection.indexOf('id="rulesprocessrail"');
  const resultbar = rulesSection.indexOf('id="rules-resultbar"');
  const results = rulesSection.indexOf('id="rulesfeed"');
  assert.ok(intro >= 0 && intro < toolbar);
  assert.ok(toolbar < primary && primary < resultbar && resultbar < results);
  assert.match(rulesSection, /class="lens-method rules-method"/);
});

test("Rules keeps search and phase visible while secondary controls stay in one disclosure", () => {
  const disclosureStart = rulesSection.indexOf('id="rules-more-filters"');
  const disclosureEnd = rulesSection.indexOf("</details>", disclosureStart);
  const disclosure = rulesSection.slice(disclosureStart, disclosureEnd);
  assert.ok(rulesSection.indexOf('id="ruleskw"') < disclosureStart);
  assert.match(disclosure, /id="rules-agency-rail"/);
  assert.match(disclosure, /id="rules-borough-rail"/);
  assert.doesNotMatch(disclosure, /id="rulesprocessrail"/);
  assert.match(rulesSection, /id="rules-filter-badge" hidden/);
  assert.match(rulesSection, /data-search-state="rules"/);
});

test("Rules methodology is collapsed by default and does not lead the fold", () => {
  assert.match(rulesSection, /class="lens-method rules-method"/);
  assert.match(rulesSection, /data-i18n="property_how_it_works"/);
  assert.doesNotMatch(rulesSection, /rules-domain-deck"[^>]*>[\s\S]*id="rulesprocessrail"/);
  assert.ok(
    rulesSection.indexOf("rules-method") < rulesSection.indexOf('id="rulesprocessrail"'),
  );
});

test("Rules more-filters badge tracks agency and borough state", () => {
  assert.match(rulesSource, /function updateRulesMoreFiltersState/);
  assert.match(rulesSource, /rules-filter-badge/);
  assert.match(rulesSource, /property_filters_active/);
});
