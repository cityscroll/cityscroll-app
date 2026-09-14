import test from "node:test";
import assert from "node:assert/strict";
import { buildCommunityDistrictDigests } from "../tools/lib/community_district_digest.mjs";
import { COMMUNITY_DISTRICT_DIGEST_SCHEMA } from "../site/community_district_digest.mjs";

const districts = [
  ...Array.from({ length: 12 }, (_, i) => `M${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, i) => `X${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 18 }, (_, i) => `K${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 14 }, (_, i) => `Q${String(i + 1).padStart(2, "0")}`),
  "R01", "R02", "R03",
];
const lenses = ["meetings", "land", "property", "rules", "money"];

function fixtureActivity() {
  const records = Object.fromEntries(lenses.map((lens) => [lens, {}]));
  const byLevel = Object.fromEntries(districts.map((district) => [district, Object.fromEntries(lenses.map((lens) => [lens, []]))]));
  for (const district of districts) {
    for (const lens of lenses) {
      const id = `${lens}:${district}`;
      records[lens][id] = { id, title: `${lens} ${district}`, route: `/notices/${id}`, date: "2026-09-01" };
      byLevel[district][lens].push(id);
    }
  }
  return {
    schema: "cityscroll.district_activity.v1", boundary_vintage: "2026-05-26", built_at: "2026-09-14T00:00:00.000Z",
    district_items: { by_level: { community_district: byLevel }, corpora: Object.fromEntries(lenses.map((lens) => [lens, { stamp_value: "2026-09-01" }])) },
    records, sources: Object.fromEntries(lenses.map((lens) => [lens, { counted: 59 }])),
  };
}

test("materializes one bounded, five-section slice for every regular community district", () => {
  const digest = buildCommunityDistrictDigests({ activity: fixtureActivity(), builtAt: "2026-09-14T00:00:00.000Z" });
  assert.equal(digest.schema, COMMUNITY_DISTRICT_DIGEST_SCHEMA);
  assert.equal(Object.keys(digest.by_community_district).length, 59);
  assert.equal(digest.by_community_district.K15.sections.land.items[0].id, "land:K15");
  assert.equal(digest.by_community_district.K15.sections.money.coverage.state, "supported");
  assert.ok(digest.performance.measured_bytes < digest.performance.ceiling_bytes);
});

test("keeps board identity, overlaps, vintages, and explicit unavailable coverage", () => {
  const geography = {
    gate: { publication_allowed: true },
    nodes: [{ id: "community-board:brooklyn-cb-15", name: "Brooklyn Community Board 15" }],
    public_edges: [
      { type: "covers", from: "community-board:brooklyn-cb-15", to: "community-district:K15" },
      { type: "intersects", from: "community-district:K15", to: "council-district:44" },
    ],
  };
  const digest = buildCommunityDistrictDigests({ activity: fixtureActivity(), communityBoardGeography: geography, coverage: { K15: { money: { state: "unavailable", reason: "fixture" } } } });
  const row = digest.by_community_district.K15;
  assert.equal(row.community_board, "brooklyn-cb-15");
  assert.deepEqual(row.council_districts, ["44"]);
  assert.equal(row.source_vintages.money, "2026-09-01");
  assert.equal(row.sections.money.coverage.state, "unavailable");
});
