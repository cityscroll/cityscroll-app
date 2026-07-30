// Homepage noise-reduction + primary email CTA (site owner priority change).
// Characterization: no edition cards; language is a labelled dropdown; general-interest
// CTA posts to the existing /subscribe double-opt-in path with an empty money filter.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const index = readFileSync(join(ROOT, "site/index.html"), "utf8");
const i18n = readFileSync(join(ROOT, "site/i18n.js"), "utf8");

test("edition highlight cards are gone from the homepage markup and paint path", () => {
  assert.doesNotMatch(index, /id="tcards"/);
  assert.doesNotMatch(index, /class="t-cards"/);
  assert.doesNotMatch(index, /class="t-card"/);
  assert.doesNotMatch(index, /today-skeleton-cards/);
  // renderToday no longer builds closing/award/hearing cards
  assert.doesNotMatch(index, /\$\("#tcards"\)/);
  assert.doesNotMatch(index, /closing_soon_lbl/);
});

test("language control is a top-right labelled select with all shipping locales", () => {
  assert.match(index, /id="langSelect"/);
  // Accessible name via aria-label + data-i18n-aria (no extra visible/sr-only English word for the ratchet)
  assert.match(index, /data-i18n-aria="lang_switcher_label"/);
  assert.match(index, /aria-label="Language"/);
  assert.doesNotMatch(index, /class="lang-btn"/);
  for (const code of ["en", "es", "zh-Hans", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur"]) {
    assert.match(index, new RegExp(`value="${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  }
  assert.match(index, /\.lang-switcher\{[^}]*position:\s*absolute/);
  assert.match(index, /inset-inline-end/);
});

test("homepage CTA wires into /subscribe with empty money filter + weekly cadence", () => {
  assert.match(index, /id="homeCta"/);
  assert.match(index, /data-i18n="home_cta_prompt"/);
  assert.match(index, /id="homeCtaEmail"/);
  assert.match(index, /id="homeCtaForm"/);
  assert.match(index, /href="#alerts"/);
  assert.match(index, /data-i18n="home_cta_topics"/);
  // Same worker endpoint as the Alerts builder
  assert.match(index, /homeCtaSubscribe[\s\S]*workerFetch\("\/subscribe"/);
  assert.match(index, /lens:\s*"money"/);
  assert.match(index, /filter:\s*\{\}/);
  assert.match(index, /freq:\s*"weekly"/);
  // Double-opt-in copy reused from the existing subscribe pattern
  assert.match(index, /data-i18n="subscribe_confirm_note"/);
});

test("section counts that lack a lens are plain static text, not fake links", () => {
  assert.match(index, /t-count-static/);
  assert.match(index, /SECTION_LENS/);
});

test("i18n carries homepage CTA keys in English", () => {
  for (const key of ["home_cta_prompt", "home_cta_submit", "home_cta_topics", "lang_switcher_label"]) {
    assert.match(i18n, new RegExp(`${key}\\s*:`));
  }
  assert.match(i18n, /home_cta_prompt:\s*"Want email updates\?"/);
  assert.match(i18n, /home_cta_submit:\s*"Sign up"/);
  assert.match(i18n, /home_cta_topics:\s*"or pick topics"/);
});
