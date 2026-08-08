import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import test from "node:test";

import { alertsHref } from "../site/alerts_context_carry.mjs";
import {
  buildFollowingViewModel,
  canonicalFollowingLens,
  followingUrlFromWatch,
  renderFollowingDocument,
  watchFromFollowingParams,
} from "../site/following_view.mjs";

const templates = JSON.parse(readFileSync(new URL("../site/data/watch_templates.json", import.meta.url), "utf8"));

test("Following renders the public control center and a complete no-JavaScript form flow", () => {
  const view = buildFollowingViewModel({
    lens: "meetings",
    filter: {
      keywords: ["curb"],
      agency: "Transportation",
      borough: "Queens",
      dateWindow: "month",
    },
    frequency: "weekly",
    matchCount: 17,
    previewItems: [
      {
        id: "20260805001",
        title: "Queens curb redesign hearing",
        url: "https://cityscroll.org/#notice/20260805001",
        summary: "Transportation · event 2026-08-12",
      },
    ],
  }, templates);
  const html = renderFollowingDocument(view);
  const visible = html.replace(/<[^>]+>/g, " ");

  assert.match(html, /<h1[^>]*>Following<\/h1>/);
  assert.match(html, /Your watches/);
  assert.match(html, /Watch sets/);
  assert.match(html, /data-scope-axis="agency"[^>]*>Transportation/);
  assert.match(html, /data-scope-axis="borough"[^>]*>Queens/);
  assert.match(html, /data-scope-count="17"/);
  assert.match(html, /data-preview-id="20260805001"/);
  assert.match(html, /<form[^>]+method="get"[^>]+data-following-preview-form/);
  assert.match(html, /<form[^>]+method="post"[^>]+action="https:\/\/api\.cityscroll\.org\/subscribe"/);
  assert.match(html, /name="filter"[^>]+value="[^"]*curb/);
  assert.match(html, /name="freq"[^>]+value="weekly"/);
  assert.match(html, /Click it to start the watch/);
  assert.doesNotMatch(html, /href="https:\/\/cityscroll\.org\/prefs"/);
  assert.doesNotMatch(html, /Email and privacy|Confirm first|double opt-in/i);
  assert.doesNotMatch(html, /href="https:\/\/api\.cityscroll\.org\/following/);
  assert.doesNotMatch(visible, /\b(?:facet|scope)\b|without JavaScript|server-rendered|static-first/i);
  assert.doesNotMatch(visible, /sources and limits|materialization|bounded default|not yet shown|not available/i);
  assert.match(html, /type="module" src="\/app\/following\.mjs"/);
  assert.match(html, /rel="stylesheet" href="\/brand\.css"/);
  assert.match(html, /rel="stylesheet" href="\/civic-documents\.css"/);
  assert.doesNotMatch(html, /<style>/);
  assert.doesNotMatch(html, /#f5f0e6|#7a1f1f|Georgia/);
  assert.match(html, /class="document-brand brand-lockup home"/);
});

test("Following has a useful server-rendered empty state before personalization", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({}, templates));

  assert.match(html, /data-personal-watch-list/);
  assert.match(html, /Open a CityScroll email to see your watches/);
  assert.match(html, /Pick a topic or place to see matches|Pick a topic or place/);
  assert.doesNotMatch(html, /Choose a topic or place|Preview your filters first/);
});

test("Following leads with create flow; saved watches are secondary", () => {
  const empty = renderFollowingDocument(buildFollowingViewModel({}, templates));
  const createEmpty = empty.indexOf('id="create"');
  const personalEmpty = empty.indexOf('id="your-following"');
  const packsEmpty = empty.indexOf('id="packs"');
  assert.ok(
    createEmpty > 0 && personalEmpty > createEmpty && packsEmpty > personalEmpty,
    `empty order create=${createEmpty} personal=${personalEmpty} packs=${packsEmpty}`,
  );
  assert.match(empty, /data-following-layout="browse"/);
  assert.match(empty, /data-following-topic-scope/);
  assert.match(empty, /data-following-place-scope/);
  assert.doesNotMatch(empty, /<select name="lens"/);
  assert.doesNotMatch(empty, /<label>Borough<select name="boro"/);

  const createView = buildFollowingViewModel({
    lens: "mandates",
    filter: { agency_id: "parks-and-recreation", agency: "Parks and Recreation" },
    frequency: "weekly",
    requested: true,
    matchCount: 2,
    previewItems: [{ id: "m1", title: "Mandate row", url: "/agencies/parks-and-recreation/" }],
  }, templates);
  const midCreate = renderFollowingDocument(createView);
  const createMid = midCreate.indexOf('id="create"');
  const personalMid = midCreate.indexOf('id="your-following"');
  const workspace = midCreate.indexOf("data-following-workspace");
  assert.ok(
    createMid > 0 && workspace > createMid && personalMid > workspace,
    `mid-create order create=${createMid} workspace=${workspace} personal=${personalMid}`,
  );
  assert.match(midCreate, /data-following-layout="create-first"/);
  assert.match(midCreate, /data-following-personal-mode="demoted"/);
  assert.match(midCreate, /following-personal-details/);
  assert.match(midCreate, /name="lens"[^>]+value="mandates"/);
  assert.doesNotMatch(midCreate, /All your watches|Save a set of filters once|Monitor packs|District digests|One digest/);
  assert.doesNotMatch(midCreate, /Saved filters|What this watch follows|preview and each email use these same terms/i);
});

test("Following accepts legacy obligations lens and emits canonical mandates", () => {
  assert.equal(canonicalFollowingLens("obligations"), "mandates");
  assert.equal(canonicalFollowingLens("mandates"), "mandates");
  const parsed = watchFromFollowingParams(
    new URLSearchParams({
      lens: "obligations",
      filter: JSON.stringify({ agency_id: "parks-and-recreation", agency: "Parks and Recreation" }),
      freq: "weekly",
    }),
  );
  assert.equal(parsed.lens, "mandates");
  assert.equal(parsed.requested, true);
  const url = new URL(followingUrlFromWatch(parsed, { frequency: "weekly" }));
  assert.equal(url.searchParams.get("lens"), "mandates");
  assert.doesNotMatch(url.search, /lens=obligations/);
  const html = renderFollowingDocument(buildFollowingViewModel(parsed, templates));
  assert.match(html, /name="lens"[^>]+value="mandates"/);
  assert.match(html, /data-following-scope-value="mandates"[^>]*aria-current="page"|aria-current="page"[^>]*data-following-scope-value="mandates"/);
});

test("Following gives every visible heading a distinct navigation label", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({}, templates));
  const headings = [...html.matchAll(/<h[1-3](?:\s[^>]*)?>([^<]+)<\/h[1-3]>/g)]
    .map((match) => match[1].trim());
  const duplicates = [...new Set(headings.filter((heading, index) => headings.indexOf(heading) !== index))];

  assert.deepEqual(duplicates, []);
});

test("contextual watch links open the server-rendered Following preview with the source-list count", () => {
  const href = alertsHref({
    lens: "meetings",
    filter: { agency: "Transportation", borough: "Queens" },
  }, { matchCount: 17, freq: "weekly" });
  const url = new URL(href);

  assert.equal(url.origin, "https://cityscroll.org");
  assert.equal(url.pathname, "/following");
  assert.equal(url.searchParams.get("lens"), "meetings");
  assert.equal(url.searchParams.get("count"), "17");
  assert.equal(url.searchParams.get("freq"), "weekly");
});

test("Following owns its enhancement island and unrelated routes do not load alerts.mjs", () => {
  const loader = readFileSync(new URL("../site/app/main.mjs", import.meta.url), "utf8");
  const following = readFileSync(new URL("../site/following/index.html", import.meta.url), "utf8");
  const home = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const people = readFileSync(new URL("../site/app/people.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(loader, /import\("\.\/alerts\.mjs"\)/);
  assert.doesNotMatch(home, /app\/alerts\.mjs/);
  assert.match(following, /app\/following\.mjs/);
  assert.match(home, /href="\/following\/"[^>]*>[^<]*<strong[^>]*>Following/);
  assert.doesNotMatch(people, /location\.hash\s*=\s*carry\.alertsHref/);
});

test("Following cold transfer stays below the existing static-first ceiling", () => {
  const files = [
    "../site/following/index.html",
    "../site/app/following.mjs",
    "../site/scope_v0.mjs",
  ];
  const bytes = files.reduce((sum, path) => sum + gzipSync(readFileSync(new URL(path, import.meta.url))).length, 0);
  assert.ok(bytes <= 455_000, `Following cold transfer ${bytes} exceeds 455,000 bytes`);
});
