import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { communityGeographySlice } from "../tools/build_worker_route_read_models.mjs";

const geography = JSON.parse(readFileSync(new URL("../site/data/community_board_geography_lookup.json", import.meta.url)));
const nodeIds = new Set(geography.nodes.map((node) => node.id));
const communityIds = geography.nodes
  .filter((node) => node.type === "community-district")
  .map((node) => node.id.replace("community-district:", ""));

test("every published community-district slice closes all 59 board and 237 Council endpoints", () => {
  assert.equal(geography.gate.publication_allowed, true);
  assert.equal(geography.public_edges.filter((edge) => edge.type === "covers").length, 59);
  assert.equal(geography.public_edges.filter((edge) => edge.type === "intersects").length, 237);

  let covers = 0;
  let intersects = 0;
  for (const district of communityIds) {
    const slice = communityGeographySlice(geography, `community-district:${district}`);
    const edges = slice.public_edges;
    covers += edges.filter((edge) => edge.type === "covers").length;
    intersects += edges.filter((edge) => edge.type === "intersects").length;
    assert.ok(edges.length > 0, `published slice must retain edges for ${district}`);
    assert.ok(edges.every((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)), district);
    assert.deepEqual(
      slice.nodes.map((node) => node.id).sort(),
      [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))].sort(),
      `slice endpoints must be exact node ids for ${district}`,
    );
  }
  assert.equal(communityIds.length, 59);
  assert.equal(covers, 59);
  assert.equal(intersects, 237);

  const k15 = communityGeographySlice(geography, "community-district:K15");
  assert.ok(k15.nodes.some((node) => node.id === "community-board:brooklyn-cb-15"));
  assert.deepEqual(
    k15.nodes.filter((node) => node.type === "council-district").map((node) => node.id),
    k15.public_edges.filter((edge) => edge.type === "intersects").map((edge) => edge.to),
  );
});
