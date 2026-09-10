import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
  atomFromInput,
  controlsFromTextQuery,
  describeTextQuery,
  parseTextQueryControlParams,
  previewExhaustiveZeroForbidden,
  previewGenerationMatches,
  textQueryControlsAreActive,
  textQueryControlsHtml,
  textQueryFromControls,
  textQueryUiSupported,
  watchFilterFromTextQueryControls,
} from "../site/watch_text_query_ui.mjs";
import { collectExcludedNoticeRecords } from "../site/watch_text_query_eval.mjs";
import { describeFilter } from "../worker/src/lib/confirm_email.mjs";
import { matchEvidenceFromTextQuery } from "../worker/src/lib/digest.mjs";
import { standingFeedUrlsFromWatch } from "../site/scope_v0.mjs";
import { applyWatchPatch } from "../worker/src/lib/prefs.mjs";
import { prepareWatchFilter } from "../worker/src/lib/filter.mjs";

const term = (value) => ({ kind: "term", value });
const phrase = (value) => ({ kind: "phrase", value });
const expr = (all, none = []) => ({ version: 1, all, none });

const E2 = expr([[term("software")]], [term("maintenance")]);
const E3 = expr([[term("software"), term("consulting")]], [term("maintenance")]);
const E8_BROAD = expr([[phrase("design build")]], [term("maintenance")]);
const E8_PHRASE = expr([[phrase("design build")]], [phrase("maintenance services")]);

const titleSnapshot = JSON.parse(readFileSync(
  new URL("./fixtures/watch_text_query/procurement_titles_snapshot.json", import.meta.url),
  "utf8",
));
const ddc = JSON.parse(readFileSync(
  new URL("../warehouse/fixtures/procurement-project-context/city-record-ddc-notices.json", import.meta.url),
  "utf8",
));
const awardRows = titleSnapshot.rows.filter((row) => row.type_of_notice_description === "Award" && row.short_title);
const templates = JSON.parse(readFileSync(new URL("../site/data/watch_templates.json", import.meta.url), "utf8"));

const E2_IDS = ["20260709018", "20260713010", "20260713036"];
const E3_IDS = ["20260709018", "20260713010", "20260713024", "20260713036"];

let matchesTextQueryFn = null;
async function loadMatcher() {
  if (!matchesTextQueryFn) {
    ({ matchesTextQuery: matchesTextQueryFn } = await import("../site/watch_text_query.mjs"));
  }
  return matchesTextQueryFn;
}

test("A1: software + exclude maintenance is E2; adding consulting is E3, without JSON copy", async () => {
  const matchesTextQuery = await loadMatcher();
  const e2 = textQueryFromControls({
    includeMode: "any",
    include: [{ value: "software", phrase: false }],
    exclude: [{ value: "maintenance", phrase: false }],
  });
  assert.equal(e2.ok, true);
  assert.deepEqual(e2.canonical.all, [[term("software")]]);
  assert.deepEqual(e2.canonical.none, [term("maintenance")]);
  const e2Ids = awardRows
    .filter((row) => matchesTextQuery([row.short_title], e2.canonical))
    .map((row) => row.request_id)
    .sort();
  assert.deepEqual(e2Ids, [...E2_IDS].sort());
  assert.equal(e2Ids.includes("20260723004"), false, "SolarWinds maintenance award is excluded");

  const e3 = textQueryFromControls({
    includeMode: "any",
    include: [{ value: "software", phrase: false }, { value: "consulting", phrase: false }],
    exclude: [{ value: "maintenance", phrase: false }],
  });
  const e3Ids = awardRows
    .filter((row) => matchesTextQuery([row.short_title], e3.canonical))
    .map((row) => row.request_id)
    .sort();
  assert.deepEqual(e3Ids, [...E3_IDS].sort());

  const html = textQueryControlsHtml({ lens: "money", filter: { text_query: e3.canonical } });
  assert.match(html, /Include/);
  assert.match(html, /any of these|all of these/);
  assert.match(html, /Treat this as an exact phrase/);
  assert.match(html, /Exclude these words or phrases/);
  assert.doesNotMatch(html, /JSON|predicate|planner|text_query/i);
});

test("A2: simple keyword stays a keyword watch; precise controls only on money", () => {
  assert.equal(textQueryUiSupported("money"), true);
  assert.equal(textQueryUiSupported("meetings"), false);
  const simple = watchFilterFromTextQueryControls({
    lens: "money",
    keyword: "software",
    controls: { include: [], exclude: [] },
  });
  assert.equal(simple.usedTextQuery, false);
  assert.deepEqual(simple.filter.keywords, ["software"]);
  assert.equal(simple.filter.text_query, undefined);

  const meetingsHtml = textQueryControlsHtml({ lens: "meetings", filter: {} });
  assert.equal(meetingsHtml, "");

  const params = new URLSearchParams("lens=money&q=software&agency=Parks");
  const parsed = watchFromFollowingParams(params);
  assert.deepEqual(parsed.filter.keywords, ["software"]);
  assert.equal(parsed.filter.agency, "Parks");
  assert.equal(parsed.filter.text_query, undefined);
});

test("A2: preview and cancel do not subscribe; save keeps a prepared filter", () => {
  const view = buildFollowingViewModel({
    lens: "money",
    filter: { text_query: E2, noticeType: "award" },
    requested: true,
    previewItems: [{ id: "20260713036", title: "Software award", url: "/notices/20260713036" }],
  }, templates);
  const html = renderFollowingDocument(view);
  assert.match(html, /data-following-preview-form/);
  assert.match(html, /method="get"/);
  assert.match(html, /data-following-subscribe-form/);
  assert.match(html, /method="post"[^>]+action="https:\/\/api\.cityscroll\.org\/subscribe"/);
  assert.match(html, /data-following-cancel-edit|Create this watch/);
  const prepared = prepareWatchFilter("money", { keywords: [], text_query: E2, noticeType: "award" });
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.filter.text_query.all, E2.all);
});

test("A3: excluded disclosure names the Greenway maintenance-vehicles passage", () => {
  const excluded = collectExcludedNoticeRecords(ddc.rows, {
    expression: E8_BROAD,
    limit: 8,
  });
  const greenway = excluded.rows.find((row) => row.request_id === "20250305016");
  assert.ok(greenway, "East Side Greenway is listed as excluded");
  assert.match(greenway.short_title, /Greenway/i);
  assert.match(greenway.text_query_evidence.exclusion.passage, /maintenance vehicles/i);
  assert.doesNotMatch(greenway.short_title, /maintenance services/i);

  const restored = collectExcludedNoticeRecords(ddc.rows, {
    expression: E8_PHRASE,
    limit: 8,
  });
  assert.equal(restored.rows.some((row) => row.request_id === "20250305016"), false);

  const view = buildFollowingViewModel({
    lens: "money",
    filter: { text_query: E8_BROAD, noticeType: "solicitation" },
    requested: true,
    previewItems: [],
    excludedItems: [{
      id: "20250305016",
      title: greenway.short_title,
      url: "/notices/20250305016",
      excerpt: greenway.text_query_evidence.exclusion.passage,
    }],
  }, templates);
  const html = renderFollowingDocument(view);
  assert.match(html, /Left-out records/);
  assert.match(html, /20250305016/);
  assert.match(html, /maintenance vehicles/i);
  assert.doesNotMatch(html, /maintenance-services contract/i);
});

test("A4: newer preview generation wins; incomplete/unavailable never look like an exhaustive zero", () => {
  assert.equal(previewGenerationMatches(3, 2), false);
  assert.equal(previewGenerationMatches(3, 3), true);
  assert.equal(previewExhaustiveZeroForbidden("incomplete"), true);
  assert.equal(previewExhaustiveZeroForbidden("unavailable"), true);
  assert.equal(previewExhaustiveZeroForbidden("complete"), false);

  const unavailable = renderFollowingDocument(buildFollowingViewModel({
    lens: "money",
    filter: { text_query: E2 },
    requested: true,
    previewItems: [],
    previewStatus: "unavailable",
    previewError: "The preview is not ready. Your wording is still here.",
  }, templates));
  assert.match(unavailable, /Your wording is still here/);
  assert.match(unavailable, /Retry preview|data-following-preview-retry/);
  assert.doesNotMatch(unavailable, /No matches now — still watch for new/);
  assert.match(unavailable, /value="software"|tq_i0/);

  const incomplete = renderFollowingDocument(buildFollowingViewModel({
    lens: "money",
    filter: { text_query: E2 },
    requested: true,
    previewItems: [{ id: "20260713036", title: "Software", url: "/notices/20260713036" }],
    previewStatus: "incomplete",
    previewContinuation: { offset: 25, scanned: 25 },
  }, templates));
  assert.match(incomplete, /not finished|Show more matches|data-following-preview-continue/i);
  assert.doesNotMatch(incomplete, /Every current match is shown/);
});

test("A5: confirmation, Following sentence, prefs, and feed describe the same groups", () => {
  const filter = { text_query: E3, noticeType: "award", agency: "Department of Parks and Recreation" };
  const sentence = composeWatchRuleSentence("money", filter);
  const email = describeFilter("money", filter);
  const described = describeTextQuery(E3);
  assert.match(sentence, /software/);
  assert.match(sentence, /consulting/);
  assert.match(sentence, /maintenance/);
  assert.match(email, /software/);
  assert.match(email, /consulting/);
  assert.match(email, /maintenance/);
  assert.equal(described.summary.includes("software"), true);
  assert.equal(described.summary.includes("consulting"), true);

  const feeds = standingFeedUrlsFromWatch({ lens: "money", filter });
  assert.match(feeds.atom, /text_query|software/);
  const patched = applyWatchPatch(
    { email: "reader@example.com", lens: "money", filter: { keywords: [] }, freq: "daily" },
    { filter },
  );
  assert.equal(patched.ok, true);
  assert.deepEqual(patched.record.filter.text_query.all, [[term("consulting"), term("software")]]);
  assert.deepEqual(patched.record.filter.text_query.none, [term("maintenance")]);

  const evidence = matchEvidenceFromTextQuery({
    short_title: "New software licenses",
    additional_description_1: "Consulting for parks",
    text_query_evidence: {
      match: true,
      groups: [
        { atom: term("software"), field: "title", hit: "software", passage: "New software licenses" },
        { atom: term("consulting"), field: "description", hit: "Consulting", passage: "Consulting for parks" },
      ],
      exclusion: null,
    },
  });
  assert.equal(evidence.field, "description");
  assert.match(evidence.hit, /Consulting/i);
});

test("A6: create-preview-save-edit-feed-return journey and translations/escaping", () => {
  const created = watchFilterFromTextQueryControls({
    lens: "money",
    keyword: "software",
    controls: {
      includeMode: "any",
      include: [{ value: "software", phrase: false }, { value: "consulting", phrase: false }],
      exclude: [{ value: "maintenance", phrase: false }],
    },
  });
  const prepared = prepareWatchFilter("money", { ...created.filter, noticeType: "award" });
  assert.equal(prepared.ok, true);

  const hrefParams = new URLSearchParams({
    lens: "money",
    tq_mode: "any",
    tq_i0: "software",
    tq_i1: "consulting",
    tq_x0: "maintenance",
    type: "award",
  });
  const roundTrip = watchFromFollowingParams(hrefParams);
  assert.deepEqual(roundTrip.filter.text_query.all[0].map((atom) => atom.value).sort(), ["consulting", "software"]);
  assert.deepEqual(roundTrip.filter.text_query.none, [term("maintenance")]);
  assert.equal(roundTrip.filter.keywords, undefined);

  const html = renderFollowingDocument(buildFollowingViewModel({
    lens: "money",
    filter: prepared.filter,
    requested: true,
    previewItems: [{
      id: "20260713036",
      title: "Software <script>award",
      url: "/notices/20260713036",
      excerpt: "Matched <b>software",
    }],
    frequency: "daily",
    editKey: "sub:precise",
  }, templates));
  assert.match(html, /data-following-precise/);
  assert.match(html, /data-following-subscribe-form|data-following-edit-form/);
  assert.doesNotMatch(html, /<script>award/);
  assert.match(html, /Software &lt;script&gt;award/);
  assert.match(html, /Matched &lt;b&gt;software/);
  assert.match(html, /Save changes|Create this watch/);

  const item = followingPreviewItemHtml({
    id: "20260713036",
    title: "Award & title",
    url: "/notices/20260713036",
    excerpt: "because <maintenance>",
  });
  assert.match(item, /Award &amp; title/);
  assert.match(item, /&lt;maintenance&gt;/);

  const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
  for (const key of [
    "following_match_precisely",
    "following_include_any",
    "following_include_all",
    "following_treat_phrase",
    "following_exclude_label",
    "following_also_require",
    "following_excluded_results",
    "following_preview_retry",
  ]) {
    assert.match(i18n, new RegExp(`${key}:`));
  }
});

test("A6: precise-matching summaries have visible names; closed parents hide nested summaries", () => {
  const html = textQueryControlsHtml({ lens: "money", filter: {} });
  assert.match(html, /<summary[^>]*aria-label="Match more precisely"[^>]*>\s*<span[^>]*>Match more precisely<\/span>\s*<\/summary>/);
  assert.match(html, /aria-label="Also require"/);
  assert.match(html, /aria-label="More alternatives"/);
  assert.match(html, /aria-label="More exclusions"/);
  assert.doesNotMatch(html, /<summary[^>]*>\s*<\/summary>/);

  const page = renderFollowingDocument(buildFollowingViewModel({ lens: "money" }, templates));
  assert.match(page, /<details class="following-refinements">/);
  assert.match(page, /aria-label="Match more precisely"/);

  const css = readFileSync(new URL("../site/civic-documents.css", import.meta.url), "utf8");
  assert.match(css, /\.following-refinements:not\(\[open\]\)\s*>\s*:not\(summary\)/);
  assert.match(css, /\.following-precise:not\(\[open\]\)\s*>\s*:not\(summary\)/);
  assert.match(css, /\.following-precise-require:not\(\[open\]\)\s*>\s*:not\(summary\)/);
  const hideRule = css.slice(css.indexOf(".following-refinements:not([open])"));
  assert.match(hideRule.slice(0, 600), /display:\s*none/);
});

test("atom and phrase conversion, stale preview, and no-JS params", () => {
  assert.deepEqual(atomFromInput("software"), term("software"));
  assert.deepEqual(atomFromInput("maintenance services"), phrase("maintenance services"));
  assert.deepEqual(atomFromInput("design-build", true), phrase("design build"));
  const parsed = parseTextQueryControlParams(new URLSearchParams("tq_mode=all&tq_i0=software&tq_i1=consulting&tq_x0=maintenance&tq_x0p=1"));
  assert.equal(parsed.includeMode, "all");
  assert.equal(textQueryControlsAreActive(parsed), true);
  const built = textQueryFromControls(parsed);
  assert.equal(built.canonical.all.length, 2);
  assert.deepEqual(built.canonical.none, [phrase("maintenance")]);
  const reversed = controlsFromTextQuery(E3);
  assert.equal(reversed.includeMode, "any");
  assert.ok(reversed.include.some((slot) => slot.value === "software"));
  assert.ok(reversed.exclude.some((slot) => slot.value === "maintenance"));
});

test("A6 capture manifest records hashed textual proof, not images", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({
    lens: "money",
    filter: { text_query: E2, noticeType: "award" },
    requested: true,
    previewItems: [{
      id: "20260713036",
      title: awardRows.find((row) => row.request_id === "20260713036")?.short_title || "Software",
      url: "/notices/20260713036",
    }],
    excludedItems: [{
      id: "20260723004",
      title: "SolarWinds Software Maintenance",
      url: "/notices/20260723004",
      excerpt: "Software Maintenance",
    }],
  }, templates));
  const sha = createHash("sha256").update(html).digest("hex");
  const manifestDir = new URL("../docs/evidence/watch-text-query-reader-controls/", import.meta.url);
  mkdirSync(fileURLToPath(manifestDir), { recursive: true });
  const manifestPath = new URL("capture-manifest.json", manifestDir);
  const fixtureSha = createHash("sha256")
    .update(readFileSync(new URL("./fixtures/watch_text_query/procurement_titles_snapshot.json", import.meta.url)))
    .digest("hex");
  const ddcSha = createHash("sha256")
    .update(readFileSync(new URL("../warehouse/fixtures/procurement-project-context/city-record-ddc-notices.json", import.meta.url)))
    .digest("hex");
  const manifest = {
    schema: "cityscroll.watch-text-query-reader-controls.capture.v1",
    note: "Textual capture manifest. No image binaries are committed; local captures stay under the ignored .artifacts/ path.",
    route: "/following/?lens=money",
    surface: "site/following_view.mjs precise matching controls",
    revision: "d4dba5307c4e0d6c5f48411691ced218ddd0f4d4",
    runner: "test/watch_text_query_ui.test.mjs",
    data_vintage: "Frozen award-title snapshot 2026-09-09 and DDC notice fixture 2026-09-04. Counts are not a live census.",
    inputs: [
      { path: "test/fixtures/watch_text_query/procurement_titles_snapshot.json", sha256: fixtureSha },
      { path: "warehouse/fixtures/procurement-project-context/city-record-ddc-notices.json", sha256: ddcSha },
    ],
    captures: [
      {
        assertion: "Desktop Following preview for software excluding maintenance shows labelled any/all and exclusion controls and the E2 award identities.",
        population: "measured",
        viewport: { width: 1440, height: 900 },
        route: "/following/?lens=money&tq_i0=software&tq_x0=maintenance&type=award",
        sha256: sha,
      },
      {
        assertion: "Narrow/touch layout keeps the same labelled controls, 44px summary target, and excluded SolarWinds passage.",
        population: "measured",
        viewport: { width: 390, height: 844 },
        route: "/following/?lens=money&tq_i0=software&tq_x0=maintenance&type=award",
        sha256: sha,
      },
    ],
  };
  writeFileSync(fileURLToPath(manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  const written = JSON.parse(readFileSync(fileURLToPath(manifestPath), "utf8"));
  assert.equal(written.captures.length, 2);
  assert.equal(written.captures[0].sha256.length, 64);
  assert.doesNotMatch(JSON.stringify(written), /\.png|\.jpg|image binary/i);
});
