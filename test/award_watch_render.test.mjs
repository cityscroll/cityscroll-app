// Pins the two pure award-arrival-alert render helpers extracted out of index.html
// (awardWatchOfferHTML/awardWatchPreviewHTML): the opt-in button only ever appears with a real
// notice id (never on the agency-level, notice-less call site), and the preview panel tells
// the reader plainly what's about to happen — or that nothing's watched yet.
//
//   node --test test/award_watch_render.test.mjs   (from the crol-list/ dir)

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
  const m = src.match(new RegExp(`^const ${name} = .*$`, "m"));
  assert.ok(m, `const ${name} not found`);
  return m[0];
}

const windowStub = { LANG: "en", LANG_META: { en: { intlDate: "en-US" } } };
const { t } = new Function("window", i18nSrc + "\nreturn { t: window.t };")(windowStub);

function build(target) {
  return new Function(
    "t", "window", "awardWatchTarget",
    extractConst("escUiHtml") +
    extractFn("awardWatchOfferHTML") +
    extractFn("awardWatchPreviewHTML") +
    "return { awardWatchOfferHTML, awardWatchPreviewHTML };"
  )(t, windowStub, target);
}

test("awardWatchOfferHTML: renders the offer button when a real notice is given", () => {
  const { awardWatchOfferHTML } = build(null);
  const html = awardWatchOfferHTML({ request_id: "20260701001" });
  assert.match(html, /data-award-watch-offer/);
  assert.match(html, />Email me when the award registers</);
});

test("awardWatchOfferHTML: renders nothing without a notice, or a notice with no request_id — the agency-profile call site (no single notice) must never grow this button", () => {
  const { awardWatchOfferHTML } = build(null);
  assert.equal(awardWatchOfferHTML(undefined), "");
  assert.equal(awardWatchOfferHTML(null), "");
  assert.equal(awardWatchOfferHTML({ agency_name: "Housing Authority" }), "");
});

test("awardWatchPreviewHTML: no target set — tells the reader to open a specific notice first, not a silent blank preview", () => {
  const { awardWatchPreviewHTML } = build(null);
  const html = awardWatchPreviewHTML();
  assert.match(html, /Open a specific notice/);
});

test("awardWatchPreviewHTML: a target is set — confirms what's being watched by label", () => {
  const { awardWatchPreviewHTML } = build({ requestId: "20260701001", agency: "Housing Authority", label: "ELEVATOR MODERNIZATION AT VARIOUS DEVELOPMENTS" });
  const html = awardWatchPreviewHTML();
  assert.match(html, /ELEVATOR MODERNIZATION AT VARIOUS DEVELOPMENTS/);
  assert.match(html, /No preview to show yet/);
});

test("awardWatchPreviewHTML: falls back to the agency name when no notice label was carried", () => {
  const { awardWatchPreviewHTML } = build({ requestId: "20260701001", agency: "Housing Authority", label: "" });
  const html = awardWatchPreviewHTML();
  assert.match(html, /Housing Authority/);
});
