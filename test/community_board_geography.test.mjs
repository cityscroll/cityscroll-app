import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildCommunityBoardGeography,
  buildPlaceLocalConstellation,
  COMMUNITY_BOARD_ORGANIZATION_RELATION_FAMILIES,
  communityDistrictIdForBoard,
  polygonsIntersect,
} from "../site/community_board_geography.mjs";

const registry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url)));
const boundaries = JSON.parse(readFileSync(new URL("../site/data/district_boundaries.json", import.meta.url)));
const agencyCrosswalk = JSON.parse(readFileSync(new URL("../worker/src/data/agency_crosswalk.json", import.meta.url)));

test("board registry maps all 59 boards to regular community districts", () => {
  const boards = registry.sources.filter((row) => row.body_type === "community_board");
  assert.equal(boards.length, 59);
  assert.equal(new Set(boards.map(communityDistrictIdForBoard)).size, 59);
  assert.equal(boards.some((row) => communityDistrictIdForBoard(row) === null), false);
});

test("each board body shares one stable identity across place and organization projections", () => {
  const doc = buildCommunityBoardGeography({
    sourceRegistry: registry,
    boundaries,
    observedAt: "2026-08-12T00:00:00.000Z",
  });
  const boardNodes = doc.nodes.filter((node) => node.type === "community-board");
  assert.equal(boardNodes.length, 59);
  assert.ok(boardNodes.every((node) => {
    const identity = node.properties?.identity;
    return identity?.body_id
      && identity.boundary === node.id
      && identity.projections.place.key === node.id
      && identity.projections.organization.key === node.id
      && identity.projections.place.family === "er:location"
      && identity.projections.place.relation_families.includes("covers")
      && JSON.stringify(identity.projections.organization.relation_families)
        === JSON.stringify(COMMUNITY_BOARD_ORGANIZATION_RELATION_FAMILIES);
  }));
  assert.deepEqual(
    doc.edge_observations.filter((edge) => edge.from.startsWith("community-board:")).map((edge) => edge.type),
    Array(59).fill("covers"),
  );
  assert.equal(doc.edge_observations.some((edge) => [
    "has_member", "member_of", "hosts_meeting", "issues_recommendation",
  ].includes(edge.type)), false);
  assert.equal(agencyCrosswalk.entries?.["community-boards"]?.canonical_name, "Community Boards");
  assert.equal(boardNodes.some((node) => node.id === "agency:community-boards"), false);
});

test("overlay reproduces the 237-pair many-to-many census and rejects centroid semantics", () => {
  const doc = buildCommunityBoardGeography({
    sourceRegistry: registry,
    boundaries,
    observedAt: "2026-08-12T00:00:00.000Z",
  });
  assert.equal(doc.gate.observed_pair_count, 237);
  assert.equal(doc.gate.regular_community_districts, 59);
  assert.equal(doc.gate.council_districts, 51);
  assert.equal(doc.receipt.average_council_districts_per_community_district, 4.02);
  assert.equal(doc.receipt.centroid_proxy, "rejected");
  assert.equal(doc.gate.publication_allowed, true);
  assert.equal(doc.public_edges.filter((edge) => edge.type === "intersects").length, 237);
  assert.ok(doc.public_edges.every((edge) => edge.boundary_vintage === "2026-05-26"));
  assert.ok(doc.public_edges.filter((edge) => edge.type === "intersects")
    .every((edge) => edge.intersection_method === "polygon_segment_crossing_or_containment"));
});

test("community-board place neighbors route through the scoped Near you view", () => {
  const doc = buildCommunityBoardGeography({
    sourceRegistry: registry,
    boundaries,
    observedAt: "2026-08-12T00:00:00.000Z",
  });
  const place = buildPlaceLocalConstellation(doc, "community-district:X01");
  const board = place.nodes.find((node) => node.target_id === "community-board:bronx-cb-01");
  assert.equal(
    board?.href,
    "/near-you/#map?level=community_district&parent=Bronx&id=X01&lens=meetings",
  );
});

test("polygon overlay detects containment and boundary crossing without a centroid", () => {
  const square = (x1, y1, x2, y2) => ({
    bbox: [x1, y1, x2, y2],
    polygons: [{ rings: [[[x1, y1], [x2, y1], [x2, y2], [x1, y2]]] }],
  });
  assert.equal(polygonsIntersect(square(0, 0, 10, 10), square(2, 2, 3, 3)), true);
  assert.equal(polygonsIntersect(square(0, 0, 2, 2), square(1, -1, 3, 1)), true);
  assert.equal(polygonsIntersect(square(0, 0, 1, 1), square(2, 2, 3, 3)), false);
});
