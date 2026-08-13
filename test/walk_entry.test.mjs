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
      { id: "people", label: "People", count: null, href: "/browse/staffing/", status: "unknown" },
      { id: "rules", label: "Rules", count: 0, href: "/browse/rules/", status: "empty" },
    ],
  });
  assert.match(html, /data-walk-entry/);
  assert.match(html, /TEXT.*parks/);
  assert.match(html, /PLACE.*Manhattan · CD M03/);
  assert.match(html, /START.*Search/);
  assert.match(html, /data-walk-family-state="available"/);
  assert.match(html, /12 records in this family/);
  assert.match(html, /Coverage is unavailable for this view/);
  assert.match(html, /No records in this snapshot/);
});

test("Browse landing exposes all measured entry families, including Places", () => {
  const html = renderBrowseLanding({
    cards: [
      { id: "money", label: "Money", primaryFacet: "contracts", count: 4, description: "Awards", children: [{ id: "contracts", facet: "contracts", label: "Contracts", route: "/browse/contracts/" }] },
      { id: "places", label: "Places", primaryFacet: null, count: 1, description: "Places", children: [{ id: "near-you", label: "Near you", route: "/near-you/" }] },
    ],
  });
  assert.match(html, /Start a walk/);
  assert.match(html, /data-walk-family="money"/);
  assert.match(html, /data-walk-family="places"/);
  assert.match(html, /href="\/near-you\/"/);
});

test("place labels remain human-readable and coordinate-free", () => {
  assert.equal(
    walkEntryPlaceLabel({ place: { boroughs: ["Queens"], community_districts: ["Q04"] } }),
    "Queens · CD Q04",
  );
});
