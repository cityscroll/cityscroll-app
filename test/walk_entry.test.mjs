import assert from "node:assert/strict";
import test from "node:test";

import {
  renderWalkEntry,
  walkEntryHref,
  walkEntryPlaceLabel,
} from "../site/walk_entry.mjs";
import { renderBrowseLanding } from "../site/browse_view.mjs";

test("walk entry URLs carry source, query, and explicit place fields only", () => {
  const href = walkEntryHref("/browse/?latitude=40.7&longitude=-73.9&council=C01", {
    source: "search",
    query: "parks",
    place: {
      borough: "Manhattan",
      community_district: "M03",
      latitude: "40.7",
      longitude: "-73.9",
    },
  });
  const url = new URL(href, "https://cityscroll.org");
  assert.equal(url.pathname, "/browse/");
  assert.equal(url.searchParams.get("walk_source"), "search");
  assert.equal(url.searchParams.get("walk_query"), "parks");
  assert.equal(url.searchParams.get("boro"), "Manhattan");
  assert.equal(url.searchParams.get("cd"), "M03");
  assert.equal(url.searchParams.has("council"), false);
  assert.equal(url.searchParams.has("latitude"), false);
  assert.equal(url.searchParams.has("longitude"), false);
});

test("walk entry renders an origin chip and measured family states", () => {
  const html = renderWalkEntry({
    source: "search",
    query: "parks",
    placeLabel: "Manhattan · CD M03",
    families: [
      { id: "land", label: "Land", count: 12, href: "/browse/zoning/", status: "available" },
      { id: "people", label: "People", count: null, href: "/browse/people/", status: "unknown" },
      { id: "rules", label: "Rules", count: 0, href: "/browse/rules/", status: "empty" },
    ],
  });
  assert.match(html, /data-walk-entry/);
  assert.match(html, /TEXT.*parks/);
  assert.match(html, /PLACE.*Manhattan · CD M03/);
  assert.match(html, /START.*Search/);
  assert.match(html, /data-walk-family-state="available"/);
  assert.match(html, /12 records in this family/);
  assert.match(html, /Records not shown/);
  assert.doesNotMatch(html, /No records in this snapshot/);
});

test("Browse landing exposes all measured entry families, including Places", () => {
  const html = renderBrowseLanding({
    cards: [
      { id: "money", label: "Money", primaryFacet: "contracts", count: 4, description: "Awards", children: [{ id: "contracts", facet: "contracts", label: "Contracts", route: "/browse/contracts/" }] },
      { id: "places", label: "Places", primaryFacet: null, count: 1, description: "Places", children: [{ id: "near-you", label: "Near you", route: "/near-you/" }] },
    ],
  });
  assert.match(html, /data-walk-family="money"/);
  assert.match(html, /data-walk-family="places"/);
  assert.match(html, /href="\/near-you\/"/);
});

test("the Browse record-search control submits canonical Search state, not traversal metadata", () => {
  const html = renderWalkEntry({ source: "browse", recordSearch: true, actionLabel: "Search records" });
  assert.match(html, /<form[^>]*action="\/search\/"[^>]*data-walk-record-search="true"/);
  assert.match(html, /<input id="walk-entry-query" name="q"/);
  assert.match(html, /<button type="submit">Search records<\/button>/);
  assert.doesNotMatch(html, /name="walk_query"/);
  assert.doesNotMatch(html, /name="walk_source"/);
  // The control is record search, so it no longer announces itself as a walk.
  assert.doesNotMatch(html, /Start a walk/);
});

test("a record-search control carries explicit place context into canonical Search", () => {
  const html = renderWalkEntry({
    source: "browse",
    recordSearch: true,
    place: { borough: "Queens", community_district: "Q04", latitude: "40.7" },
  });
  assert.match(html, /<input type="hidden" name="boro" value="Queens">/);
  assert.match(html, /<input type="hidden" name="cd" value="Q04">/);
  assert.doesNotMatch(html, /name="latitude"/);
});

test("an explicit walk control keeps its own traversal fields", () => {
  const html = renderWalkEntry({
    source: "near_you",
    query: "rats",
    actionHref: "/near-you/?v=0&q=rats&walk_source=near_you&walk_query=rats",
    actionLabel: "Walk this place",
  });
  assert.match(html, /Start a walk/);
  assert.match(html, /<input id="walk-entry-query" name="walk_query" value="rats"/);
  assert.match(html, /<input type="hidden" name="walk_source" value="near_you">/);
  assert.doesNotMatch(html, /data-walk-record-search/);
});

test("a query-bearing walk hands the topic to a typed destination as canonical q", () => {
  for (const [route, expected] of [
    ["/browse/contracts/", "/browse/contracts/?q=rats"],
    ["/browse/meetings/", "/browse/meetings/?q=rats"],
  ]) {
    const href = walkEntryHref(route, { source: "search", query: "rats" });
    assert.ok(href.includes(expected), `${href} carries ${expected}`);
    const url = new URL(href, "https://cityscroll.org");
    assert.equal(url.searchParams.get("q"), "rats");
    // T7 traversal context survives beside the canonical topic.
    assert.equal(url.searchParams.get("walk_source"), "search");
    assert.equal(url.searchParams.get("walk_query"), "rats");
  }
});

test("the Browse landing itself stays a walk address rather than a record-search address", () => {
  const href = walkEntryHref("/browse/", { source: "search", query: "rats" });
  const url = new URL(href, "https://cityscroll.org");
  assert.equal(url.searchParams.has("q"), false);
  assert.equal(url.searchParams.get("walk_query"), "rats");
});

test("a typed destination receives a normalized topic and escapes it in rendered markup", () => {
  const malicious = '<script>alert("x")</script>';
  const href = walkEntryHref("/browse/meetings/", { source: "object", query: `  ${malicious}  ` });
  const url = new URL(href, "https://cityscroll.org");
  assert.equal(url.searchParams.get("q"), malicious);
  assert.ok(!href.includes("<script>"), "the topic is percent-encoded in the address");
  const html = renderWalkEntry({ source: "browse", recordSearch: true, query: malicious });
  assert.match(html, /value="&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;"/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("place labels remain human-readable and coordinate-free", () => {
  assert.equal(
    walkEntryPlaceLabel({ place: { boroughs: ["Queens"], community_districts: ["Q04"] } }),
    "Queens · CD Q04",
  );
});
