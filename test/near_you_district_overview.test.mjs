import assert from "node:assert/strict";
import test from "node:test";

import { buildNearYouViewModel, renderNearYouDocument } from "../site/near_you_view.mjs";
import { scopeFromLensState } from "../site/scope_v0.mjs";
import { scopeWithPlace } from "../site/near_you_scope_runtime.mjs";

const scope = scopeWithPlace(scopeFromLensState(null, {}), { communityDistrict: "Q04", borough: "Queens" });
const record = (id, title, date, route = `/notices/${id}`) => ({ id, title, date, agency: "City agency", type: "Notice", basis: "Affected area", route });
const activity = {
  schema: "cityscroll.district_activity.v1",
  built_at: "2026-09-01T00:00:00.000Z",
  boundary_vintage: "2026-05-26",
  district_items: {
    by_level: { community_district: { Q04: { meetings: ["meeting-1"], land: ["project-1"], property: [], rules: [], money: [] } } },
    citywide: {}, virtual: {}, unlocated: {},
  },
  records: {
    meetings: { "meeting-1": record("meeting-1", "Upcoming meeting", "2026-09-12") },
    land: { "project-1": record("project-1", "Rezoning project", "2026-08-15") },
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
  assert.match(html, /<script type="module"/); // the same document remains useful without running it
});

test("explicit lens scope remains a lens view, not an overview", () => {
  const explicit = buildNearYouViewModel(scopeWithPlace(scopeFromLensState("meetings", {}), { communityDistrict: "Q04" }), activity, boundaries);
  assert.equal(explicit.isOverview, false);
  assert.equal(explicit.lens, "meetings");
});
