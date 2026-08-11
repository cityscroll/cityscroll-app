import { SITE_SOURCE } from "./helpers/site_source.mjs";
// Homepage noise-reduction + primary email CTA (site owner priority change).
// Masthead → email CTA → category tabs → content. No edition strip, no scenario grid.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const index = SITE_SOURCE;
const i18n = readFileSync(join(ROOT, "site/i18n.js"), "utf8");

test("edition strip and scenario grid are gone", () => {
  assert.doesNotMatch(index, /id="todaystrip"/);
  assert.doesNotMatch(index, /id="tdate"/);
  assert.doesNotMatch(index, /id="tbig"/);
  assert.doesNotMatch(index, /id="tcounts"/);
  assert.doesNotMatch(index, /id="tcards"/);
  assert.doesNotMatch(index, /function loadToday/);
  assert.doesNotMatch(index, /function renderToday/);
  assert.doesNotMatch(index, /scenario-nav/);
  assert.doesNotMatch(index, /scenario-route/);
  assert.doesNotMatch(index, /data-i18n="scenario_heading"/);
});

test("page order is masthead CTA then Browse domain shortcuts", () => {
  const cta = index.indexOf('id="homeCta"');
  const tabs = index.indexOf('class="browse-child-nav"');
  const money = index.indexOf('id="tab-money"');
  assert.ok(cta > 0 && tabs > cta && money > tabs, `order cta=${cta} tabs=${tabs} money=${money}`);
});

test("language control is a top-right labelled select with all shipping locales", () => {
  assert.match(index, /id="langSelect"/);
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
  assert.match(index, /href="\/following\/"/);
  assert.match(index, /data-i18n="home_cta_topics"/);
  assert.match(index, /homeCtaSubscribeStatic[\s\S]*workerFetch\("\/subscribe"/);
  assert.match(index, /lens:\s*"money"/);
  assert.match(index, /filter:\s*\{\}/);
  assert.match(index, /freq:\s*"weekly"/);
  assert.match(index, /id="homeCtaManage"/);
  assert.doesNotMatch(index, /We'll email a link to confirm\./);
  assert.doesNotMatch(index, /data-i18n="subscribe_confirm_note"/);
  assert.match(index, /sessionShowBanner[\s\S]*homeCtaManage/);
});

test("signup surfaces have no Turnstile widget or client token gate", () => {
  // Homepage CTA + Alerts post to /subscribe without a CAPTCHA.
  assert.doesNotMatch(index, /class="cf-turnstile"/);
  assert.doesNotMatch(index, /challenges\.cloudflare\.com\/turnstile/);
  assert.doesNotMatch(index, /turnstileToken/);
  assert.doesNotMatch(index, /complete_human_check/);
  assert.match(index, /workerFetch\("\/subscribe"/);
});

test("about feedback form has no Turnstile and exposes public feedback inbox", () => {
  const about = readFileSync(join(ROOT, "site/about.html"), "utf8");
  assert.doesNotMatch(about, /class="cf-turnstile"/);
  assert.doesNotMatch(about, /challenges\.cloudflare\.com\/turnstile/);
  assert.doesNotMatch(about, /turnstileToken/);
  assert.doesNotMatch(about, /turnstile\.(getResponse|reset)/);
  assert.match(about, /mailto:feedback%40cityscroll\.org/);
  assert.match(about, /workerFetch\("\/feedback"/);
  assert.match(index, /mailto:feedback%40cityscroll\.org/);
  assert.match(index, /data-i18n="footer_feedback"/);
});

test("subscribe confirmation copy is short (no double-opt-in ceremony on the form)", () => {
  assert.doesNotMatch(i18n, /subscribe_confirm_note:/);
  assert.doesNotMatch(index, /We'll email a link to confirm\./);
  assert.match(i18n, /check_inbox:\s*"Check your inbox to confirm\."/);
  assert.match(i18n, /sent_confirm_to:\s*"Sent to \{email\}\."/);
  assert.doesNotMatch(i18n, /no one can sign you up but you/);
  assert.doesNotMatch(index, /no one can sign you up but you/);
});

test("i18n carries homepage CTA keys in English", () => {
  for (const key of ["home_cta_prompt", "home_cta_submit", "home_cta_topics", "lang_switcher_label"]) {
    assert.match(i18n, new RegExp(`${key}\\s*:`));
  }
  assert.match(i18n, /home_cta_prompt:\s*"Want email updates on this\?"/);
  assert.match(i18n, /home_cta_submit:\s*"Sign up"/);
  assert.match(i18n, /home_cta_topics:\s*"or pick topics"/);
});
