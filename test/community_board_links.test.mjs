import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  communityBoardIdFromEvidence,
  communityBoardPageHref,
  communityDistrictDisplayName,
  communityBoardPlaceHref,
} from "../site/community_board_links.mjs";
import { scopeFromNearYouUrl } from "../site/near_you_scope_runtime.mjs";

const sourceRegistry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url)));

test("community-board references resolve only from explicit board evidence", () => {
  assert.equal(
    communityBoardIdFromEvidence("2022M0258_HA_MN CB11"),
    "manhattan-cb-11",
  );
  assert.equal(
    communityBoardPageHref("Community Board 11, Manhattan"),
    "/community-boards/manhattan-cb-11/",
  );
  assert.equal(
    communityBoardPageHref("CB11", { borough: "Manhattan" }),
    "/community-boards/manhattan-cb-11/",
  );
});

test("unresolved board references remain unlinked", () => {
  assert.equal(communityBoardIdFromEvidence("Conditional Favorable"), null);
  assert.equal(communityBoardPageHref("CB11"), null);
  assert.equal(communityBoardPageHref("Community Board 11", { borough: "Unknown" }), null);
});

test("community-district display names keep machine codes out of resident copy", () => {
  assert.equal(
    communityDistrictDisplayName({ borough: "Bronx", district: 1, id: "X01" }),
    "Bronx Community District 1",
  );
  assert.equal(
    communityDistrictDisplayName({ borough: "Bronx", id: "X01" }),
    "Bronx Community District 1",
  );
  assert.equal(communityDistrictDisplayName({ borough: "Bronx", id: "Q01" }), null);
});

test("board place links are canonical server-readable scopes", () => {
  const href = communityBoardPlaceHref("brooklyn-cb-15");
  assert.equal(href, "/near-you/?v=0&lens=meetings&boro=Brooklyn&cd=K15&level=community_district&id=K15&parent=Brooklyn");
  const scope = scopeFromNearYouUrl(href);
  assert.deepEqual(scope.place.boroughs, ["Brooklyn"]);
  assert.deepEqual(scope.place.community_districts, ["K15"]);
  assert.deepEqual(scope.place.council_districts, []);
  assert.equal(scope.facets.domains[0], "meetings");
});

test("every registry board maps to its exact borough and community district", () => {
  const boards = sourceRegistry.sources.filter((row) => row.body_type === "community_board");
  assert.equal(boards.length, 59);
  for (const board of boards) {
    const scope = scopeFromNearYouUrl(communityBoardPlaceHref(board.body_id));
    assert.deepEqual(scope.place.boroughs, [board.borough], board.body_id);
    assert.deepEqual(scope.place.community_districts, [`${{ Bronx: "X", Brooklyn: "K", Manhattan: "M", Queens: "Q", "Staten Island": "R" }[board.borough]}${String(board.district).padStart(2, "0")}`], board.body_id);
    assert.deepEqual(scope.place.council_districts, [], board.body_id);
    assert.deepEqual(scope.facets.domains, ["meetings"], board.body_id);
  }
});
