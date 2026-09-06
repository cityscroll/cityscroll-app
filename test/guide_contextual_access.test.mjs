/**
 * The published guide is reachable from shared chrome and from the product
 * surfaces where a reader is most likely to need it, without a second help
 * system or private credentials in the URL.
 *
 *   node --test test/guide_contextual_access.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GUIDE_HELP,
  GUIDE_HOME_HREF,
  renderGuideHelpLink,
} from "../site/guide_contextual_links.mjs";
import { renderCivicDocumentMast, renderNodeFooter } from "../site/civic_document_chrome.mjs";
import { scopeFromRouteHash } from "../site/scope_v0.mjs";
import { renderFollowingDocument, buildFollowingViewModel } from "../site/following_view.mjs";
import { renderCalendarSubscriptionHandoff } from "../site/calendar_subscription.mjs";
import { renderEdgeProvenanceInspector } from "../site/graph_edge_provenance.mjs";
import { renderCivicTimeLedgerPanel } from "../site/civic_time_ledger.mjs";
import { renderGuideHome } from "../site/guide_view.mjs";
import { loadGuide } from "../tools/build_guide_documents.mjs";

const about = readFileSync(new URL("../site/about.html", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const home = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const search = readFileSync(new URL("../site/search/index.html", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../site/app/workspace.mjs", import.meta.url), "utf8");

const ABOUT_ANCHORS = [
  "context",
  "past-patterns",
  "staffing-list-establishment-formula",
  "property-disposition-timing-formula",
  "tax-lien-sale-predictions",
  "zoning-base-rates",
  "applicant-conditioned-ulurp",
];

function helpCount(html, topic) {
  const { href } = GUIDE_HELP[topic];
  return [...html.matchAll(new RegExp(href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].length;
}

function primaryNavHrefs(html) {
  const nav = html.match(/<nav class="document-nav" aria-label="Primary">([\s\S]*?)<\/nav>/)?.[1] || "";
  return [...nav.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
}

test("each named control group has exactly one static guide article", () => {
  assert.deepEqual(Object.keys(GUIDE_HELP), [
    "following",
    "calendar",
    "connection",
    "asOf",
    "emptyCollection",
  ]);
  for (const item of Object.values(GUIDE_HELP)) {
    assert.equal(new URL(item.href, "https://cityscroll.org").pathname, item.href);
    assert.equal(item.href.includes("?"), false);
    assert.doesNotMatch(item.href, /token|session|watch_id|email=/i);
  }
});

test("an unknown help topic fails closed rather than inventing a destination", () => {
  assert.throws(() => renderGuideHelpLink("not-a-topic"), /unknown guide help topic/);
});

test("shared document mast and footer offer Guide next to the existing product routes", () => {
  const mast = renderCivicDocumentMast({ current: "browse" });
  assert.deepEqual(primaryNavHrefs(mast), [
    "/now/",
    "/near-you/",
    "/following/",
    "/browse/",
    GUIDE_HOME_HREF,
  ]);
  assert.match(mast, /<a aria-current="page" href="\/browse\/">Browse<\/a>/);
  assert.match(mast, /<a href="\/guide\/">Guide<\/a>/);

  const onGuide = renderCivicDocumentMast({ current: "guide" });
  assert.match(onGuide, /<a aria-current="page" href="\/guide\/">Guide<\/a>/);

  const footer = renderNodeFooter();
  assert.match(footer, /<a href="\/guide\/">Guide<\/a>/);
  assert.match(footer, /<a href="\/about.html">About the data<\/a>/);
  assert.doesNotMatch(footer, /changelog/i);
});

test("Guide in the mast does not inherit a Near You place query", () => {
  const mast = renderCivicDocumentMast({
    current: "near-you",
    scope: scopeFromRouteHash("#map?level=community_district&id=M03&parent=Manhattan&lens=meetings"),
  });
  assert.match(mast, /href="\/browse\/\?boro=Manhattan&amp;cd=M03"/);
  assert.match(mast, /href="\/guide\/"/);
  assert.doesNotMatch(mast, /href="\/guide\/\?/);
});

test("the homepage and search document expose Guide in primary navigation and the footer", () => {
  for (const [name, html] of [["home", home], ["search", search]]) {
    assert.match(html, /<nav class="now-entry-row" aria-label="Primary">[\s\S]*href="\/guide\/"/, name);
    assert.match(html, /href="\/guide\/"[^>]*data-i18n="footer_guide">Guide<\/a>/, `${name} footer`);
    assert.doesNotMatch(html, /footer_changelog">Changelog/, `${name} does not revive the changelog`);
  }
  assert.match(i18n, /footer_guide:\s*"Guide"/);
  assert.match(i18n, /nav_guide:\s*"Guide"/);
});

test("Following offers one help link for creating a watch, with no watch credentials in it", () => {
  const html = renderFollowingDocument(buildFollowingViewModel({}));
  assert.equal(helpCount(html, "following"), 1);
  assert.match(html, /How to follow a search/);
  assert.ok(primaryNavHrefs(html).includes(GUIDE_HOME_HREF));
  assert.match(html, /<a href="\/guide\/">Guide<\/a>/);
  assert.doesNotMatch(html, /\/guide\/[^"]*\?(?:[^"]*(?:token|session|email)=)/i);
});

test("calendar handoff, connection evidence, as-of, and empty collections each get one help link", () => {
  const calendar = renderCalendarSubscriptionHandoff({
    feedUrl: "https://api.cityscroll.org/calendar.ics?lens=meetings",
    webcalUrl: "webcal://api.cityscroll.org/calendar.ics?lens=meetings",
    scopeLabel: "Hearings and meetings",
  });
  assert.equal(helpCount(calendar, "calendar"), 1);
  assert.match(calendar, /How to put dates in your calendar/);
  assert.doesNotMatch(calendar, /persistent overlay|tooltip/i);

  const inspector = renderEdgeProvenanceInspector({
    claim_id: "claim-1",
    label: "Related record",
    how: { warrant_class: "exact" },
    confidence: { identity_stance: "same" },
  }, { open: true });
  assert.equal(helpCount(inspector, "connection"), 1);

  const asOf = renderCivicTimeLedgerPanel({ path: "/agencies/parks-and-recreation/" });
  assert.equal(helpCount(asOf, "asOf"), 1);
  assert.match(asOf, /How as-of works/);

  assert.match(workspace, /invEmptyGuideHtml/);
  assert.match(workspace, /href="\/guide\/how-to\/collect-records-and-export-them\/"/);
});

test("guide documents mark Guide current and still link About", () => {
  const { home: homeSource, articles } = loadGuide();
  const html = renderGuideHome(homeSource, articles);
  assert.match(html, /<a aria-current="page" href="\/guide\/">Guide<\/a>/);
  assert.match(html, /<a href="\/about.html">About the data<\/a>/);
  assert.match(html, /<a href="\/guide\/">Guide<\/a>/);
});

test("About keeps identity, independence, team, accessibility, feedback, and the cited anchors", () => {
  assert.match(about, /CityScroll is independent/);
  assert.match(about, /id="maintainers"/);
  assert.match(about, /id="accessibility"/);
  assert.match(about, /id="explore"/);
  assert.match(about, /href="\/guide\/"/);
  assert.match(about, /Send feedback/);
  for (const id of ABOUT_ANCHORS) {
    assert.match(about, new RegExp(`id="${id}"`));
  }
  assert.match(about, /href="\/guide\/understand\/flags-and-historical-patterns\/"/);
  assert.match(about, /10 days or fewer/);
  assert.doesNotMatch(about, /changelog\.html/i);
});

test("README stays an entry point and sends walkthroughs to the guide", () => {
  assert.match(readme, /https:\/\/cityscroll\.org\//);
  assert.match(readme, /https:\/\/cityscroll\.org\/guide\//);
  assert.match(readme, /https:\/\/cityscroll\.org\/about\.html/);
  assert.match(readme, /github\.com\/cityscroll\/cityscroll-app/);
  assert.match(readme, /AGENTS\.md/);
  assert.doesNotMatch(readme, /ontology\/registry\.v0\.json/);
  assert.doesNotMatch(readme, /changelog\.html/);
});
