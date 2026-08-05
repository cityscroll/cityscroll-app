import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import test from "node:test";

import { alertsHref } from "../site/alerts_context_carry.mjs";
import {
  buildFollowingViewModel,
  renderFollowingDocument,
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

  assert.match(html, /<h1[^>]*>Following<\/h1>/);
  assert.match(html, /Watches/);
  assert.match(html, /Monitor packs/);
  assert.match(html, /District digests/);
  assert.match(html, /One digest/);
  assert.match(html, /data-scope-axis="agency"[^>]*>Transportation/);
  assert.match(html, /data-scope-axis="borough"[^>]*>Queens/);
  assert.match(html, /data-scope-count="17"/);
  assert.match(html, /data-preview-id="20260805001"/);
  assert.match(html, /<form[^>]+method="get"[^>]+data-following-preview-form/);
  assert.match(html, /<form[^>]+method="post"[^>]+action="https:\/\/api\.cityscroll\.org\/subscribe"/);
  assert.match(html, /name="filter"[^>]+value="[^"]*curb/);
  assert.match(html, /name="freq"[^>]+value="weekly"/);
  assert.match(html, /double opt-in/i);
  assert.match(html, /Click it to start the watch/);
  assert.match(html, /privacy/i);
  assert.match(html, /href="https:\/\/api\.cityscroll\.org\/prefs"/);
  assert.match(html, /type="module" src="\/app\/following\.mjs"/);
  assert.match(html, /rel="stylesheet" href="\/brand\.css"/);
  assert.match(html, /rel="stylesheet" href="\/civic-documents\.css"/);
  assert.doesNotMatch(html, /<style>/);
  assert.doesNotMatch(html, /#f5f0e6|#7a1f1f|Georgia/);
  assert.match(html, /class="document-brand brand-lockup home"/);
});

test("Following has a useful server-rendered empty state before personalization", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({}, templates));

  assert.match(html, /data-following-empty/);
  assert.match(html, /Choose a topic or place/);
  assert.match(html, /data-personal-watch-list/);
  assert.match(html, /Manage from a CityScroll email/);
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

  assert.equal(url.origin, "https://api.cityscroll.org");
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
