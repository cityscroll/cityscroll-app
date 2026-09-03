import { SITE_SOURCE } from "./helpers/site_source.mjs";
// Homepage noise-reduction + Following entry (site owner priority change).
// Masthead → Following entry → category tabs → content. No edition strip, no scenario grid.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOME_FOLLOWING_ONBOARDING_HREF,
  homeFollowingEntryHref,
} from "../site/home_following_entry.mjs";
import { canonicalFollowingScope, watchFromFollowingParams } from "../site/following_view.mjs";

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

test("homepage CTA discloses the exact weekly default before asking for an email", () => {
  assert.match(index, /id="homeCta"/);
  assert.match(index, /data-i18n="home_cta_prompt"/);
  const prompt = index.indexOf('data-i18n="home_cta_prompt"');
  const form = index.indexOf('id="homeCtaForm"');
  assert.ok(prompt > 0 && form > prompt, "the disclosed promise precedes the email field");
  assert.match(index, /id="homeCtaForm"[^>]*method="post"[^>]*action="https:\/\/api\.cityscroll\.org\/subscribe"/);
  assert.match(index, /name="no_topic" value="true"/);
  assert.match(index, /name="source" value="top-of-site"/);
  assert.match(index, /id="homeCtaEmail"[^>]*name="email"[^>]*required/);
  assert.match(index, /id="homeCtaSubmit"[^>]*data-i18n="home_cta_submit"/);
  // Secondary link stays a plain Following handoff — the default form never overwrites it.
  assert.match(index, /href="\/following\/\?onboarding=1"[^>]*id="homeCtaTopics"/);
  assert.match(index, /data-i18n="home_cta_topics"/);
  // What the enhanced submit posts and reports is covered behaviourally in
  // test/home_default_watch_submit.test.mjs, which runs site/home_entry.mjs itself.
  const boot = readFileSync(join(ROOT, "site/app/boot.mjs"), "utf8");
  assert.match(boot, /homeFollowingEntryHref/);
  assert.match(boot, /\/following\/\?onboarding=1/);
  assert.doesNotMatch(boot, /homeCtaEmail|homeCtaForm|homeCtaSubmit/);
  assert.match(index, /id="homeCtaManage"[^>]*data-i18n="home_cta_open_watches"[^>]*hidden/);
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

test("signup copy describes immediate enrollment without confirmation language", () => {
  assert.doesNotMatch(i18n, /subscribe_confirm_note:/);
  assert.doesNotMatch(index, /We'll email a link to confirm\./);
  assert.match(i18n, /subscribed_now:\s*"You're subscribed — we'll email you\."/);
  assert.match(i18n, /welcome_sent_to:\s*"Welcome sent to \{email\}\."/);
  assert.doesNotMatch(i18n, /check_inbox:/);
  assert.doesNotMatch(i18n, /sent_confirm_to:/);
  assert.doesNotMatch(i18n, /no one can sign you up but you/);
  assert.doesNotMatch(index, /no one can sign you up but you/);
});

test("i18n carries homepage CTA keys in English", () => {
  for (const key of [
    "home_cta_prompt", "home_cta_submit", "home_cta_topics", "home_cta_open_watches",
    "home_cta_active_now", "lang_switcher_label",
  ]) {
    assert.match(i18n, new RegExp(`${key}\\s*:`));
  }
  assert.match(i18n, /home_cta_prompt:\s*"New NYC contracts and RFPs by email every Monday\."/);
  assert.match(i18n, /home_cta_submit:\s*"Get weekly updates"/);
  assert.match(i18n, /home_cta_topics:\s*"Choose what to follow"/);
  assert.match(i18n, /home_cta_open_watches:\s*"Open your watches"/);
});

test("homepage Following entry is generic onboarding without an email", () => {
  assert.equal(homeFollowingEntryHref(), HOME_FOLLOWING_ONBOARDING_HREF);
  assert.equal(homeFollowingEntryHref({}), HOME_FOLLOWING_ONBOARDING_HREF);
  assert.equal(homeFollowingEntryHref({ email: "reader@example.com" }), HOME_FOLLOWING_ONBOARDING_HREF);
  assert.equal(homeFollowingEntryHref({ lens: "money", filter: {} }), HOME_FOLLOWING_ONBOARDING_HREF);
  assert.doesNotMatch(HOME_FOLLOWING_ONBOARDING_HREF, /email=/);
  const watch = watchFromFollowingParams(new URL(HOME_FOLLOWING_ONBOARDING_HREF, "https://cityscroll.org").searchParams);
  assert.equal(watch.onboarding, true);
  assert.equal(watch.requested, false);
});

test("validated homepage context deep-links into the canonical Following scope", () => {
  const topic = homeFollowingEntryHref({ lens: "money", filter: { keywords: ["elevator"] } });
  const place = homeFollowingEntryHref({
    lens: "meetings",
    filter: { keywords: ["curb"], borough: "Queens" },
  });
  const agency = homeFollowingEntryHref({
    lens: "rules",
    filter: { agency: "Housing Preservation and Development" },
  });
  const record = homeFollowingEntryHref({
    lens: "meetings",
    filter: { agency: "Transportation" },
    noticeId: "20260716009",
  });
  const topicWatch = watchFromFollowingParams(new URL(topic, "https://cityscroll.org").searchParams);
  assert.deepEqual(
    canonicalFollowingScope(topicWatch),
    canonicalFollowingScope({ lens: "money", filter: { keywords: ["elevator"] } }),
  );
  const placeWatch = watchFromFollowingParams(new URL(place, "https://cityscroll.org").searchParams);
  assert.deepEqual(
    canonicalFollowingScope(placeWatch),
    canonicalFollowingScope({ lens: "meetings", filter: { keywords: ["curb"], borough: "Queens" } }),
  );
  const agencyWatch = watchFromFollowingParams(new URL(agency, "https://cityscroll.org").searchParams);
  assert.equal(agencyWatch.lens, "rules");
  assert.equal(agencyWatch.filter.agency, "Housing Preservation and Development");
  const recordWatch = watchFromFollowingParams(new URL(record, "https://cityscroll.org").searchParams);
  assert.equal(recordWatch.noticeId, "20260716009");
  assert.match(record, /notice=20260716009/);
  assert.doesNotMatch(record, /email=/);
});

test("invalid homepage context falls back to generic Following onboarding", () => {
  assert.equal(homeFollowingEntryHref({ lens: "not-a-lens", filter: { keywords: ["housing"] } }), HOME_FOLLOWING_ONBOARDING_HREF);
  assert.equal(homeFollowingEntryHref({ utm: "ad", foo: "bar" }), HOME_FOLLOWING_ONBOARDING_HREF);
  assert.equal(homeFollowingEntryHref({ lens: "money", noticeId: "!!" }), HOME_FOLLOWING_ONBOARDING_HREF);
  const scoped = homeFollowingEntryHref({
    lens: "money",
    filter: { keywords: ["elevator"] },
    email: "reader@example.com",
  });
  assert.doesNotMatch(scoped, /email=/);
  assert.notEqual(scoped, HOME_FOLLOWING_ONBOARDING_HREF);
});
