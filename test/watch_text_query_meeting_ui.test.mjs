import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildFollowingViewModel,
  composeWatchRuleSentence,
  followingPreviewItemHtml,
  renderFollowingDocument,
  watchFromFollowingParams,
} from "../site/following_view.mjs";
import {
  textQueryControlsHtml,
  textQueryUiSupported,
  watchFilterFromTextQueryControls,
} from "../site/watch_text_query_ui.mjs";
import { describeFilter } from "../worker/src/lib/confirm_email.mjs";
import { applyWatchPatch } from "../worker/src/lib/prefs.mjs";
import { prepareWatchFilter } from "../worker/src/lib/filter.mjs";
import { standingFeedUrlsFromWatch } from "../site/scope_v0.mjs";
import { lensFamilyAdmitsPreciseMatching } from "../site/watch_family_capabilities.mjs";

const term = (value) => ({ kind: "term", value });
const phrase = (value) => ({ kind: "phrase", value });
const expr = (all, none = []) => ({ version: 1, all, none });

const RAT = expr([[term("rat")]]);
const TRANSLATION_EXCLUDE_CART = expr(
  [[term("translation")]],
  [phrase("communication access realtime translation")],
);
const templates = JSON.parse(readFileSync(new URL("../site/data/watch_templates.json", import.meta.url), "utf8"));
const materialization = JSON.parse(readFileSync(
  new URL("../site/data/meeting_notice_materialization.json", import.meta.url),
  "utf8",
));

test("A1/A5: meetings offer labelled precise controls; exact-matter and other families do not", () => {
  assert.equal(textQueryUiSupported("meetings"), true);
  assert.equal(lensFamilyAdmitsPreciseMatching("meetings"), true);
  assert.equal(lensFamilyAdmitsPreciseMatching("meetings", { matter_ref: "legistar:nyc:matter:79200" }), false);
  const html = textQueryControlsHtml({ lens: "meetings", filter: {} });
  assert.match(html, /Match more precisely/);
  assert.match(html, /any of these|all of these/);
  assert.match(html, /Treat this as an exact phrase/);
  assert.match(html, /Exclude these words or phrases/);
  assert.match(html, /aria-label="Match more precisely"/);
  assert.match(html, /<label class="following-precise-term" for="following-precise-tq-i0"/);
  assert.doesNotMatch(html, /JSON|predicate|planner|text_query/i);
  assert.equal(textQueryControlsHtml({ lens: "meetings", filter: { matter_ref: "legistar:nyc:matter:79200" } }), "");
  assert.equal(textQueryControlsHtml({ lens: "land", filter: {} }), "");
  assert.equal(textQueryControlsHtml({ lens: "legal_code", filter: { provision_id: "nyc-administrative-code:1-101" } }), "");
});

test("A2: meeting create-preview-save-edit-feed journey keeps the same groups", () => {
  const created = watchFilterFromTextQueryControls({
    lens: "meetings",
    keyword: "rat",
    controls: {
      includeMode: "any",
      include: [{ value: "rat", phrase: false }, { value: "correction", phrase: false }],
      exclude: [{ value: "communication access realtime translation", phrase: true }],
    },
  });
  const prepared = prepareWatchFilter("meetings", created.filter);
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.filter.text_query.all[0].map((atom) => atom.value).sort(), ["correction", "rat"]);

  const params = new URLSearchParams({
    lens: "meetings",
    tq_mode: "any",
    tq_i0: "rat",
    tq_i1: "correction",
    tq_x0: "communication access realtime translation",
    tq_x0p: "1",
  });
  const roundTrip = watchFromFollowingParams(params);
  assert.deepEqual(roundTrip.filter.text_query.none, [phrase("communication access realtime translation")]);
  assert.equal(roundTrip.filter.keywords, undefined);

  const html = renderFollowingDocument(buildFollowingViewModel({
    lens: "meetings",
    filter: prepared.filter,
    requested: true,
    previewItems: [{
      id: "meeting:city_record:20260803009",
      title: "New Rules Relating to Rat Inspections",
      url: "/meetings/meeting%3Acity_record%3A20260803009/",
      excerpt: "Rat Inspections",
    }],
    frequency: "daily",
    editKey: "sub:meetings-precise",
  }, templates));
  assert.match(html, /data-following-precise/);
  assert.match(html, /data-following-subscribe-form|data-following-edit-form/);
  assert.match(html, /Save changes|Create this watch/);
  assert.match(html, /New Rules Relating to Rat Inspections/);
  assert.match(html, /following-precise-tq-i0/);

  const patched = applyWatchPatch(
    { email: "reader@example.com", lens: "meetings", filter: { keywords: [] }, freq: "daily" },
    { filter: prepared.filter },
  );
  assert.equal(patched.ok, true);
  const sentence = composeWatchRuleSentence("meetings", prepared.filter);
  const email = describeFilter("meetings", prepared.filter);
  assert.match(sentence, /rat/);
  assert.match(email, /rat/);
  const feeds = standingFeedUrlsFromWatch({ lens: "meetings", filter: prepared.filter });
  assert.match(feeds.atom, /text_query|rat/);
  assert.equal(feeds.ics, null);
});

test("A3: translation preview names the CART passage and does not claim translation policy", () => {
  const row = materialization.rows.find((item) => item.request_id === "20260106034");
  assert.ok(row);
  const html = renderFollowingDocument(buildFollowingViewModel({
    lens: "meetings",
    filter: { text_query: TRANSLATION_EXCLUDE_CART },
    requested: true,
    previewItems: [],
    excludedItems: [{
      id: "meeting:city_record:20260106034",
      title: row.short_title,
      url: "/meetings/meeting%3Acity_record%3A20260106034/",
      excerpt: "Communication Access Realtime Translation (CART). CART is not currently available.",
    }],
  }, templates));
  assert.match(html, /Left-out records/);
  assert.match(html, /Communication Access Realtime Translation/);
  assert.doesNotMatch(html, /translation policy/i);
  assert.match(html, /20260106034/);
});

test("A4/A6: failed load, keyboard recovery, translations, and hashed capture", () => {
  const unavailable = renderFollowingDocument(buildFollowingViewModel({
    lens: "meetings",
    filter: { text_query: RAT },
    requested: true,
    previewItems: [],
    previewStatus: "unavailable",
    previewError: "The preview is not ready. Your wording is still here.",
  }, templates));
  assert.match(unavailable, /Your wording is still here/);
  assert.match(unavailable, /Retry preview|data-following-preview-retry/);
  assert.match(unavailable, /tq_i0" value="rat"|name="tq_i0" value="rat"/);
  assert.doesNotMatch(unavailable, /No matches now — still watch for new/);
  assert.match(unavailable, /<button[^>]*type="submit"[^>]*form="following-preview-form"[^>]*data-following-preview-retry/);
  assert.match(unavailable, /<label class="following-precise-term" for="following-precise-tq-i0"/);
  assert.match(unavailable, /aria-label="Match more precisely"/);

  const item = followingPreviewItemHtml({
    id: "meeting:city_record:20260803009",
    title: "Rules & inspections",
    url: "/meetings/meeting%3Acity_record%3A20260803009/",
    excerpt: "because <rat>",
  });
  assert.match(item, /Rules &amp; inspections/);
  assert.match(item, /&lt;rat&gt;/);

  const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
  for (const key of [
    "following_match_precisely",
    "following_include_any",
    "following_include_all",
    "following_treat_phrase",
    "following_term_label",
    "following_exclude_label",
    "following_also_require",
    "following_excluded_results",
    "following_preview_retry",
  ]) {
    assert.match(i18n, new RegExp(`${key}:`));
  }
  for (const lang of ["es", "zh-Hans", "bn", "ur", "ht", "ar", "ko", "ru", "fr", "pl"]) {
    const source = readFileSync(new URL(`../site/i18n/lang/${lang}.js`, import.meta.url), "utf8");
    assert.match(source, /following_match_precisely:/);
  }

  const html = renderFollowingDocument(buildFollowingViewModel({
    lens: "meetings",
    filter: { text_query: RAT },
    requested: true,
    previewItems: [{
      id: "meeting:city_record:20260803009",
      title: "New Rules Relating to Rat Inspections",
      url: "/meetings/meeting%3Acity_record%3A20260803009/",
      excerpt: "Rat Inspections",
    }],
  }, templates));
  const sha = createHash("sha256").update(html).digest("hex");
  const manifestDir = new URL("../docs/evidence/watch-text-query-meeting-controls/", import.meta.url);
  mkdirSync(fileURLToPath(manifestDir), { recursive: true });
  const fixtureSha = createHash("sha256")
    .update(readFileSync(new URL("../site/data/meeting_notice_materialization.json", import.meta.url)))
    .digest("hex");
  const manifest = {
    schema: "cityscroll.watch-text-query-meeting-controls.capture.v1",
    note: "Textual capture manifest. No image binaries are committed; local captures stay under the ignored .artifacts/ path.",
    route: "/following/?lens=meetings",
    surface: "site/following_view.mjs meeting precise matching controls",
    revision: "f1482be8dd8620ca796449a60bae30d7ce3aa8fb",
    runner: "test/watch_text_query_meeting_ui.test.mjs",
    data_vintage: "Frozen meeting-notice materialization generated_at 2026-09-09T06:52:08.255Z. Counts are not a live census.",
    inputs: [
      { path: "site/data/meeting_notice_materialization.json", sha256: fixtureSha },
    ],
    captures: [
      {
        assertion: "Desktop Following meeting preview for whole-token rat shows labelled any/all controls and 20260803009.",
        population: "measured",
        viewport: { width: 1440, height: 900 },
        route: "/following/?lens=meetings&tq_i0=rat",
        sha256: sha,
      },
      {
        assertion: "Narrow/touch layout keeps labelled controls, 44px summary target, and keyboard-recoverable failed-load retry.",
        population: "measured",
        viewport: { width: 390, height: 844 },
        route: "/following/?lens=meetings&tq_i0=rat",
        sha256: sha,
      },
    ],
  };
  writeFileSync(fileURLToPath(new URL("capture-manifest.json", manifestDir)), `${JSON.stringify(manifest, null, 2)}\n`);
  const written = JSON.parse(readFileSync(new URL("capture-manifest.json", manifestDir), "utf8"));
  assert.equal(written.captures.length, 2);
  assert.equal(written.captures[0].sha256.length, 64);
  assert.doesNotMatch(JSON.stringify(written), /\.png|\.jpg|image binary/i);
});
