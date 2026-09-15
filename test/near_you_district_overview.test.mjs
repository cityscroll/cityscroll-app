import assert from "node:assert/strict";
import test from "node:test";

import { buildNearYouViewModel, renderNearYouDocument } from "../site/near_you_view.mjs";
import { nearYouUrlFromScope, routeHashFromScope, scopeFromLensState } from "../site/scope_v0.mjs";
import { scopeWithPlace } from "../site/near_you_scope_runtime.mjs";
import { MILLISECONDS_PER_DAY, withPinnedClock } from "./helpers/test_clock.mjs";

const FIXTURE_CLOCK = "2026-09-01T00:00:00.000Z";
const fixtureDate = (days) => new Date(Date.parse(FIXTURE_CLOCK) + days * MILLISECONDS_PER_DAY).toISOString();
const scope = scopeWithPlace(scopeFromLensState(null, {}), { communityDistrict: "Q04", borough: "Queens" });
const record = (id, title, days, route = `/notices/${id}`) => ({
  id, title, date: fixtureDate(days), agency: "City agency", type: "Notice", basis: "Affected area", route,
});
const activity = {
  schema: "cityscroll.district_activity.v1",
  built_at: FIXTURE_CLOCK,
  boundary_vintage: "2026-05-26",
  district_items: {
    by_level: { community_district: { Q04: { meetings: ["meeting-1", "meeting-2", "meeting-3", "meeting-4"], land: ["project-1", "project-2", "project-3", "project-4"], property: [], rules: [], money: [] } } },
    citywide: {}, virtual: {}, unlocated: {},
  },
  records: {
    meetings: Object.fromEntries([1, 2, 3, 4].map((n) => [`meeting-${n}`, record(`meeting-${n}`, `Upcoming meeting ${n}`, n + 1)])),
    land: Object.fromEntries([1, 2, 3, 4].map((n) => [`project-${n}`, record(`project-${n}`, `Rezoning project ${n}`, -n)])),
    property: {}, rules: {}, money: {},
  },
  by_level: { community_district: { Q04: {} }, borough: {}, council_district: {} },
  geography_items: { definitions: {} },
};
const boundaries = { community_districts: [], council_districts: [] };
const geography = {
  gate: { publication_allowed: true },
  public_edges: [
    { type: "covers", from: "community-board:queens-cb-04", to: "community-district:Q04" },
    { type: "intersects", from: "community-district:Q04", to: "council-district:26" },
  ],
  nodes: [{ id: "community-board:queens-cb-04", name: "Queens Community Board 4", properties: { body_id: "queens-cb-04" } }],
};

test("district overview gives bounded resident sections and readable place labels", () => {
  const view = buildNearYouViewModel(scope, activity, boundaries, {
    canonicalBase: "https://cityscroll.org/near-you",
    communityGeography: geography,
  });
  assert.equal(view.isOverview, true);
  assert.deepEqual(view.overview.sections.map((section) => section.title), [
    "Upcoming", "Recent changes", "Board activity", "Projects", "District priorities",
  ]);
  const html = renderNearYouDocument(view);
  for (const heading of ["Upcoming", "Recent changes", "Board activity", "Projects", "District priorities"]) {
    assert.match(html, new RegExp(`>${heading}`));
  }
  assert.match(html, /Queens Community District 4/);
  assert.match(html, /Queens Community Board 4/);
  assert.match(html, /City Council District 26/);
  assert.match(html, /href="\/community-boards\/queens-cb-04\//);
  assert.match(html, /href="https:\/\/cityscroll\.org\/near-you\?.*lens=land/);
  assert.match(html, /district membership does not imply board action/i);
  assert.match(html, /<script type="module"/);
});

test("A1: overview previews are bounded even when the fixture exceeds the cap", async () => {
  await withPinnedClock(FIXTURE_CLOCK, () => {
    const view = buildNearYouViewModel(scope, activity, boundaries);
    assert.ok(view.overview.sections.every((section) => section.records.length <= 3));
    assert.equal(view.overview.sections.find((section) => section.key === "upcoming").count, 4);
  });
});

test("A2: every section gives a count or consequential coverage, including empty sections", () => {
  const view = buildNearYouViewModel(scope, activity, boundaries, { communityGeography: geography });
  const html = renderNearYouDocument(view);
  for (const section of view.overview.sections) {
    assert.ok(Number.isFinite(section.count) || section.coverage, `${section.key} lacks count or coverage`);
    if (!section.records.length) assert.match(html, new RegExp(section.coverage));
  }
});

test("A3: the primary place label omits raw codes while retaining readable geography", () => {
  const view = buildNearYouViewModel(scope, activity, boundaries, { communityGeography: geography });
  const html = renderNearYouDocument(view);
  const placeLine = html.match(/<p class="near-overview-place">([^<]*)<\/p>/)?.[1] || "";
  assert.match(placeLine, /Queens Community District 4/);
  assert.doesNotMatch(placeLine, /Q04|council-district:26/);
});

test("A4: explicit lens, place, role, time, list, map, share, and watch URLs retain their semantics", () => {
  const explicit = scopeWithPlace(scopeFromLensState("meetings", {
    communityDistrict: "Q04", when: "month", place_role: "venue",
  }, { language: "es" }), { communityDistrict: "Q04", borough: "Queens" });
  const view = buildNearYouViewModel(explicit, activity, boundaries);
  const share = new URL(view.shareHref);
  const councilScope = scopeWithPlace(scopeFromLensState("meetings", { councilDistrict: "26" }), { councilDistrict: "26" });
  const councilShare = new URL(nearYouUrlFromScope(councilScope, { base: "https://cityscroll.org/near-you" }));
  assert.equal(view.isOverview, false);
  assert.equal(view.lens, "meetings");
  assert.equal(share.searchParams.get("lens"), "meetings");
  assert.equal(share.searchParams.get("cd"), "Q04");
  assert.equal(councilShare.searchParams.get("council"), "26");
  assert.equal(share.searchParams.get("when"), "month");
  assert.equal(share.searchParams.get("placeRole"), "venue");
  assert.equal(share.searchParams.get("lang"), "es");
  assert.match(view.browseHref, /^\/browse\/meetings\//);
  assert.match(routeHashFromScope(explicit, { surface: "map" }), /^#map\?/);
  assert.equal(new URL(view.watchHref).searchParams.get("lens"), "meetings");
  assert.equal(nearYouUrlFromScope(explicit, { base: "https://cityscroll.org/near-you" }).includes("cd=Q04"), true);
});

test("A5: overview previews link to records, and board membership is not board action", () => {
  const view = buildNearYouViewModel(scope, activity, boundaries, { communityGeography: geography });
  const html = renderNearYouDocument(view);
  const overview = html.match(/<section class="near-overview"[\s\S]*?<\/section>\s*<details/)?.[0] || "";
  assert.doesNotMatch(overview, /href="\/projects\//);
  assert.match(overview, /Open the named Community Board/);
  assert.match(overview, /District membership does not imply board action/);
});

test("A6: desktop, 390px, keyboard, focus, no-JavaScript, and translated fixtures keep both destinations", () => {
  const fixtures = [
    ["desktop", 1440, "en"], ["390px", 390, "en"], ["keyboard", 390, "en"],
    ["focus", 390, "en"], ["no-JavaScript", 390, "en"], ["translated", 390, "es"],
  ];
  for (const [name, width, language] of fixtures) {
    const fixtureScope = scopeWithPlace(scopeFromLensState(null, {}, { language }), { communityDistrict: "Q04", borough: "Queens" });
    const view = buildNearYouViewModel(fixtureScope, activity, boundaries, { communityGeography: geography });
    const rendered = renderNearYouDocument(view);
    const html = name === "no-JavaScript" ? rendered.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<script\b[^>]*\/>/gi, "") : rendered;
    assert.ok(width === 390 || width === 1440, `${name} fixture has an unrecognized viewport`);
    assert.match(html, /href="\/community-boards\/queens-cb-04\//, `${name} loses board navigation`);
    assert.match(html, /href="https:\/\/cityscroll\.org\/near-you\?.*lens=land/, `${name} loses lens navigation`);
    if (name === "no-JavaScript") assert.doesNotMatch(html, /<script\b/i, "no-JavaScript fixture still executes scripts");
    if (name === "translated") assert.match(view.shareHref, /lang=es/);
  }
});
