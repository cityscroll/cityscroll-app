// Pins forecastItemHTML()'s output shape (badge/title/subtitle/subscribe-button structure,
// data-watch-* attributes, escaping) so the wave-10 move — deduplicating the two hand-copied
// showAgency()/showVendor() forecast blocks into one shared builder, and routing every string
// through t() — is provably a MOVE, not a rewrite of what a forecast timeline item renders.
//
//   node --test test/forecast_render.test.mjs   (from the crol-list/ dir)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "index.html"), "utf8");
const i18nSrc = readFileSync(join(ROOT, "i18n.js"), "utf8");

function extractFn(name) {
  let start = src.indexOf("async function " + name + "(");
  if (start === -1) start = src.indexOf("function " + name + "(");
  assert.notEqual(start, -1, `function ${name} not found in index.html`);
  let depth = 0, seen = false;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") { depth++; seen = true; }
    else if (src[j] === "}" && --depth === 0 && seen) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}
function extractConst(name) {
  // Not extractFn's [^;]* variant: escUiHtml's own value contains HTML-entity string literals
  // ("&lt;", "&amp;", …) that each end in a literal ";", which a semicolon-stops-the-match
  // regex would truncate on. The declaration is a single physical line, so match to end-of-line
  // instead — safe here because the const is never split across lines.
  const m = src.match(new RegExp(`^const ${name} = .*$`, "m"));
  assert.ok(m, `const ${name} not found`);
  return m[0];
}

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t, tn } = new Function("window", i18nSrc + "\nreturn { t: window.t, tn: window.tn };")(windowStub);

const { forecastItemHTML, forecastItemsHTML, forecastPaneHTML } = new Function(
  "t", "tn", "window",
  extractFn("money") +
  extractConst("escUiHtml") +
  extractFn("forecastItemHTML") +
  extractFn("forecastItemsHTML") +
  extractFn("forecastPaneHTML") +
  "return { forecastItemHTML, forecastItemsHTML, forecastPaneHTML };"
)(t, tn, windowStub);

const checkbookItem = {
  source: "checkbook",
  vendor_name: "Acme Snow & Ice LLC",
  agency_name: "Sanitation",
  amount: 250000,
  expiration_date: "2026-11-30",
};

const mocsItem = {
  source: "mocs",
  agency: "Parks and Recreation",
  description: "Playground equipment maintenance",
  value_band: "$1M-$5M",
  release_quarter: "Q3 2027",
};

test("forecastItemHTML: checkbook item — badge, title, subtitle, subscribe button, watch-kind vendor", () => {
  const html = forecastItemHTML(checkbookItem);
  assert.match(html, /class="tl"/);
  assert.match(html, /class="badge"[^>]*>Estimated renewal<\/span>/);
  assert.match(html, /Predicted expiration: 2026-11-30/);
  assert.match(html, /Acme Snow &amp; Ice LLC/, "title is HTML-escaped");
  assert.match(html, /Sanitation · Amount \$250K/);
  assert.match(html, /data-watch-kind="vendor"/);
  assert.match(html, /data-watch-name="Acme Snow &amp; Ice LLC"/);
  assert.match(html, /class="act mini-sub-btn"[^>]*>Subscribe to Alert<\/button>/);
});

test("forecastItemHTML: MOCS-plan item — badge, title, subtitle, watch-kind agency", () => {
  const html = forecastItemHTML(mocsItem);
  assert.match(html, /class="badge"[^>]*>Agency plan<\/span>/);
  assert.match(html, /Expected RFP quarter: Q3 2027/);
  assert.match(html, /Playground equipment maintenance/);
  assert.match(html, /Parks and Recreation · Value band \$1M-\$5M/);
  assert.match(html, /data-watch-kind="agency"/);
  assert.match(html, /data-watch-name="Parks and Recreation"/);
});

test("forecastItemHTML: falls back to generic title when the record names no vendor/description", () => {
  const noVendor = { ...checkbookItem, vendor_name: null };
  assert.match(forecastItemHTML(noVendor), />Vendor contract expiration</);
  const noDescription = { ...mocsItem, description: null };
  assert.match(forecastItemHTML(noDescription), />Planned solicitation</);
});

test("forecastItemsHTML: joins one <div class=\"tl\"> per forecast, in order", () => {
  const html = forecastItemsHTML([checkbookItem, mocsItem]);
  const count = (html.match(/class="tl"/g) || []).length;
  assert.equal(count, 2);
  assert.ok(html.indexOf("Estimated renewal") < html.indexOf("Agency plan"), "checkbook item renders before the MOCS item, unreordered");
});

test("forecastPaneHTML: wraps the timeline in the section heading and honesty note", () => {
  const html = forecastPaneHTML([checkbookItem]);
  assert.match(html, /class="chain-h">Predicted expirations and planned schedules</);
  assert.match(html, /class="timeline"/);
  assert.match(html, /class="note">These are estimates built from past award durations/);
});
