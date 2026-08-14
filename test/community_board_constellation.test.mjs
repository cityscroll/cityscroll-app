import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildCommunityBoardConstellationView,
  buildCommunityBoardEdgeSummary,
  communityBoardInstitutionHref,
  communityBoardOutputHref,
  communityBoardPath,
  communityBoardPlaceHref,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import { entityPivotRouteStatus } from "../site/edge_summary.mjs";

const sourceRegistry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url)));
const sourceInventory = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/board_source_inventory.json", import.meta.url)));
const scorecard = JSON.parse(readFileSync(new URL("../site/data/community_board_minutes_scorecard.json", import.meta.url)));
const geography = JSON.parse(readFileSync(new URL("../site/data/community_board_geography_lookup.json", import.meta.url)));

const sources = { sourceRegistry, sourceInventory, scorecard, geography };

test("board routes preserve the separate place, institution, and output projections", () => {
  assert.equal(communityBoardPath("bronx-cb-02"), "/community-boards/bronx-cb-02/");
  assert.equal(communityBoardPlaceHref({ borough: "Bronx", community_district_id: "X02" }), "/near-you/#map?level=community_district&parent=Bronx&id=X02&lens=meetings");
  assert.equal(communityBoardInstitutionHref("bronx-cb-02"), "/browse/people/?board=bronx-cb-02#community-boards");
  assert.equal(communityBoardOutputHref("bronx-cb-02"), "/community-boards/#board-bronx-cb-02");
});
test("board constellation uses typed summaries and holds unjoined institutional edges", () => {
  const view = buildCommunityBoardConstellationView("bronx-cb-02", sources);
  assert.equal(view.kind, "community-board-constellation");
  assert.equal(view.summary.matched_categories, 2);
  assert.deepEqual(view.categories.map((category) => category.status), ["matched", "matched", "unknown", "unknown"]);
  const matched = buildCommunityBoardEdgeSummary(view).filter((edge) => edge.state === "matched");
  assert.ok(matched.every((edge) => edge.source && edge.source.name && entityPivotRouteStatus(edge.href).verified));
  assert.equal(view.edge_summary.find((edge) => edge.edge_type === "hosts_meeting")?.href, null);
  assert.equal(view.local_constellation.kind, "community-board");
});

test("board document keeps empty or unknown categories honest and resident-readable", () => {
  const html = renderCommunityBoardConstellationDocument(buildCommunityBoardConstellationView("bronx-cb-02", sources));
  assert.match(html, /Connected board records/);
  assert.match(html, /District coverage/);
  assert.match(html, /Official source inventory/);
  assert.match(html, /Meetings and hearings \(Unknown \/ not indexed\)/);
  assert.match(html, /Board institution \(Unknown \/ not indexed\)/);
  assert.match(html, /Open official calendar/);
  assert.doesNotMatch(html, /matter_title_place|venue_line|boro_cd|Source: Unavailable|Join method: Unavailable/);
  assert.doesNotMatch(html, /No meetings exist/);
});
