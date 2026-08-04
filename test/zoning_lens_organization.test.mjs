import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const landSource = readFileSync(new URL("../site/app/land.mjs", import.meta.url), "utf8");

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

const zoningSection = html.slice(
  html.indexOf('<section id="tab-land"'),
  html.indexOf("<!-- ============ PROPERTY"),
);

test("Zoning follows the shared lens hierarchy with the answer and review view first", () => {
  const intro = zoningSection.indexOf('id="land-domain-intro"');
  const toolbar = zoningSection.indexOf('id="land-toolbar"');
  const primary = zoningSection.indexOf('id="land-status-rail"');
  const resultbar = zoningSection.indexOf('id="land-resultbar"');
  const results = zoningSection.indexOf('id="land-results-grid"');
  assert.ok(intro >= 0 && intro < toolbar);
  assert.ok(toolbar < primary && primary < resultbar && resultbar < results);
  assert.match(zoningSection, /class="lens-method land-method"/);
});

test("Zoning keeps review view visible while place controls stay in one disclosure", () => {
  const disclosureStart = zoningSection.indexOf('id="land-more-filters"');
  const disclosureEnd = zoningSection.indexOf("</details>", disclosureStart);
  const disclosure = zoningSection.slice(disclosureStart, disclosureEnd);
  for (const id of ["lboro", "lhearingmode", "landlocation"]) {
    assert.match(disclosure, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(disclosure, /id="lkw"|id="land-status-rail"/);
  assert.match(zoningSection, /id="lkw"[\s\S]*?id="land-more-filters"/);
  assert.match(zoningSection, /id="lstatus" hidden aria-hidden="true"/);
});

test("Zoning paints an exact count and keeps absent list data unpainted", () => {
  const paint = extractFunction(landSource, "paintLandRows");
  const count = extractFunction(landSource, "setLandResultCount");
  const list = extractFunction(landSource, "landRenderList");
  const hearings = extractFunction(landSource, "landSearchHearings");
  assert.match(paint, /setLandResultCount\(lRows\.length\)/);
  assert.match(count, /results_count/);
  assert.doesNotMatch(paint, /40\+/);
  assert.doesNotMatch(list, /no_zap|zap_project_index_html|zap_explainer_html/);
  assert.match(list, /\.innerHTML="";/);
  assert.doesNotMatch(hearings, /land_hearings_empty|land_hearings_empty_next_steps_html/);
  assert.match(landSource, /if\(!view \|\| !view\.event_count\) return "";/);
  assert.match(landSource, /function landSpineGapsHTML\(_gaps\)\{[\s\S]*?return "";/);
  assert.doesNotMatch(landSource, /map_needs_connection/);
});

test("Zoning hides the detail surface until a published project is selected", () => {
  assert.match(zoningSection, /id="land-item-card"[^>]* hidden/);
  assert.match(zoningSection, /id="ldetail" translate="no"><\/div>/);
  const select = extractFunction(landSource, "landSelect");
  assert.match(select, /land-item-card/);
  assert.match(select, /\.hidden=false/);
});

test("Zoning lens chrome consumes the shared design-language tokens", () => {
  const start = html.indexOf("/* Zoning lens template */");
  const end = html.indexOf("/* Map exploration", start);
  const css = html.slice(start, end);
  assert.match(css, /var\(--color-action\)/);
  assert.match(css, /var\(--color-surface\)/);
  assert.match(css, /var\(--space-3\)/);
  assert.match(css, /var\(--radius-md\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});
