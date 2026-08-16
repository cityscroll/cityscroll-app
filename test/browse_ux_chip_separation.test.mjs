/**
 * Browse-mode semantics: teaching examples, active facet state, and watch recipes
 * must advertise their different consequences instead of sharing one chip idiom.
 *
 *   node --test test/browse_ux_chip_separation.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { SITE_SOURCE } from "./helpers/site_source.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(ROOT, "site/index.html"), "utf8");
const i18n = readFileSync(join(ROOT, "site/i18n.js"), "utf8");
const core = readFileSync(join(ROOT, "site/app/core.mjs"), "utf8");
const boot = readFileSync(join(ROOT, "site/app/boot.mjs"), "utf8");

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\{([^}]*)\\}`, "m"));
  assert.ok(match, `${selector} CSS rule is present`);
  return match[1].replace(/\s+/g, "");
}

test("natural-language suggestions identify themselves as teaching examples", () => {
  assert.match(SITE_SOURCE, /class="teaching-examples-label"[^>]*data-i18n="try_asking_label"/);
  assert.match(SITE_SOURCE, /const cls = \["trychip", "teaching-example"\]/);
  assert.match(i18n, /try_asking_label:\s*"Try asking:"/);
});

test("teaching examples use quiet control styling instead of active-facet pills", () => {
  const example = cssRule(".teaching-example");
  const facet = cssRule(".chip");

  assert.match(example, /border-radius:var\(--radius-sm\)/);
  assert.match(example, /background:transparent/);
  assert.doesNotMatch(example, /radius-pill|999px/);

  assert.match(facet, /border-radius:999px/);
  assert.match(html, /\.chip\.on\{background:var\(--ink\);color:#fff;border-color:var\(--ink\)\}/);
  assert.match(html, /\.chip \.ct\{/);
});

test("interpreted scope remains inert data, not another teaching control", () => {
  const scope = cssRule(".qchip");
  assert.match(scope, /cursor:default/);
  assert.doesNotMatch(scope, /radius-pill|999px/);
  assert.match(SITE_SOURCE, /class="nlunderstood/);
});

test("each multi-watch preset card states how many watches it creates", () => {
  assert.match(SITE_SOURCE, /watch_tpl_creates_watches/);
  assert.match(SITE_SOURCE, /\(tpl\.watches\|\|\[\]\)\.length/);
  assert.match(SITE_SOURCE, /class="watch-tpl-consequence"/);
  assert.match(i18n, /watch_tpl_creates_watches:\s*"Creates \{n\} watches"/);
});

test("watch-preset code and data load only when Alerts is active", () => {
  assert.match(core, /name==="alerts" && typeof initWatchTemplates/);
  assert.doesNotMatch(boot, /^if\(typeof initWatchTemplates/m);
  assert.match(boot, /#tab-alerts\.active/);
});

test("Meetings Ask conflicts render two choices instead of replacing query state", () => {
  assert.match(SITE_SOURCE, /function queryConflictHTML/);
  assert.match(SITE_SOURCE, /data-query-conflict-choice="keep_current"/);
  assert.match(SITE_SOURCE, /data-query-conflict-choice="use_proposed"/);
  assert.match(SITE_SOURCE, /composeLensQueryState\("meetings"/);
});

test("Meetings standard search commits on submit, not an unlabeled live debounce", () => {
  assert.match(boot, /#meetingskw"\)\.addEventListener\("keydown"/);
  assert.doesNotMatch(boot, /#meetingskw"\)\.addEventListener\("input"\s*,\s*debounce/);
});
