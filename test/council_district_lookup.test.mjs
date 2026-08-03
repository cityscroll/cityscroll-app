import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import {
  attachCouncilDistrict,
  attachDistricts,
  loadCouncilDistrictLayer,
  loadDistrictBoundariesLayer,
  normalizeCommunityDistrictId,
  normalizeCouncilDistrictId,
  pointInRing,
  resolveCommunityDistrict,
  resolveCouncilDistrict,
  resolveDistricts,
  zapCommunityDistrictWhere,
  zapCouncilDistrictWhere,
} from "../site/council_district_lookup.mjs";

const unifiedPath = new URL("../site/data/district_boundaries.json", import.meta.url);
const councilPath = new URL("../site/data/council_district_boundaries.json", import.meta.url);

const unified = loadDistrictBoundariesLayer(
  JSON.parse(readFileSync(unifiedPath, "utf8")),
);
const councilLayer = loadCouncilDistrictLayer(
  JSON.parse(readFileSync(councilPath, "utf8")),
);

test("committed unified boundary layer carries vintage and both district kinds", () => {
  assert.ok(unified);
  assert.equal(unified.schema, "cityscroll.district_boundaries.v1");
  assert.ok(unified.boundary_vintage);
  assert.ok(unified.sources?.community_district?.boundary_vintage);
  assert.ok(unified.sources?.council_district?.boundary_vintage);
  assert.ok(unified.community_district_count >= 59);
  assert.ok(unified.council_district_count >= 51);
  assert.equal(unified.community_districts.length, unified.community_district_count);
  assert.equal(unified.council_districts.length, unified.council_district_count);
  assert.ok(unified.community_districts.every((d) => d.id && d.polygons?.length && d.bbox?.length === 4));
  assert.ok(unified.council_districts.every((d) => d.id && d.polygons?.length && d.bbox?.length === 4));
});

test("council-only twin still exposes boundary_vintage and 51 districts", () => {
  assert.ok(councilLayer);
  assert.equal(councilLayer.layer, "council_district");
  assert.equal(councilLayer.dataset_id, "872g-cjhh");
  assert.ok(councilLayer.boundary_vintage);
  assert.ok(councilLayer.district_count >= 51);
});

test("normalizeCouncilDistrictId accepts bare, padded, and labeled forms", () => {
  assert.equal(normalizeCouncilDistrictId("36"), "36");
  assert.equal(normalizeCouncilDistrictId(5), "5");
  assert.equal(normalizeCouncilDistrictId("05"), "5");
  assert.equal(normalizeCouncilDistrictId("Council District 12"), "12");
  assert.equal(normalizeCouncilDistrictId("0"), null);
  assert.equal(normalizeCouncilDistrictId("99"), null);
  assert.equal(normalizeCouncilDistrictId(""), null);
});

test("normalizeCommunityDistrictId accepts product form and boro_cd", () => {
  assert.equal(normalizeCommunityDistrictId("Q04"), "Q04");
  assert.equal(normalizeCommunityDistrictId("m03"), "M03");
  assert.equal(normalizeCommunityDistrictId("404"), "Q04");
  assert.equal(normalizeCommunityDistrictId(103), "M03");
  assert.equal(normalizeCommunityDistrictId("99"), null);
  assert.equal(normalizeCommunityDistrictId(""), null);
});

test("point-in-ring ray cast handles a unit square", () => {
  const ring = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]];
  assert.equal(pointInRing(1, 1, ring), true);
  assert.equal(pointInRing(3, 1, ring), false);
});

test("resolveCouncilDistrict maps golden points and leaves ocean null", () => {
  // Elmhurst / location-awareness golden coords → District 25
  assert.equal(resolveCouncilDistrict(40.7473, -73.8832, unified), "25");
  assert.equal(resolveCouncilDistrict(40.7473, -73.8832, councilLayer), "25");
  // City Hall area → District 1
  assert.equal(resolveCouncilDistrict(40.7128, -74.0060, unified), "1");
  // 96 Avenue A (civic-scope fixture council_district 2)
  assert.equal(resolveCouncilDistrict(40.7255, -73.9835, unified), "2");
  assert.equal(resolveCouncilDistrict(40.5, -73.0, unified), null);
  assert.equal(resolveCouncilDistrict(null, null, unified), null);
});

test("resolveCommunityDistrict maps golden points from the shared layer", () => {
  // Elmhurst → Queens CD 4
  assert.equal(resolveCommunityDistrict(40.7473, -73.8832, unified), "Q04");
  // City Hall → Manhattan CD 1
  assert.equal(resolveCommunityDistrict(40.7128, -74.0060, unified), "M01");
  // 96 Avenue A → Manhattan CD 3
  assert.equal(resolveCommunityDistrict(40.7255, -73.9835, unified), "M03");
  assert.equal(resolveCommunityDistrict(40.5, -73.0, unified), null);
});

test("resolveDistricts returns both kinds plus boundary_vintage", () => {
  const hit = resolveDistricts(40.7473, -73.8832, unified);
  assert.equal(hit.community_district, "Q04");
  assert.equal(hit.council_district, "25");
  assert.equal(hit.boundary_vintage, unified.boundary_vintage);
});

test("attachCouncilDistrict never invents a district without coordinates", () => {
  assert.equal(attachCouncilDistrict({ label: "x" }, unified).council_district, null);
  assert.equal(
    attachCouncilDistrict({ latitude: 40.7473, longitude: -73.8832 }, unified).council_district,
    "25",
  );
  assert.equal(
    attachCouncilDistrict({ latitude: 40.7473, longitude: -73.8832, council_district: "25" }, unified)
      .council_district,
    "25",
  );
});

test("attachDistricts stamps community + council + vintage", () => {
  const out = attachDistricts({ latitude: 40.7473, longitude: -73.8832 }, unified);
  assert.equal(out.community_district, "Q04");
  assert.equal(out.council_district, "25");
  assert.equal(out.boundary_vintage, unified.boundary_vintage);
});

test("zap where helpers stay SoQL-safe", () => {
  assert.equal(zapCouncilDistrictWhere("36"), " AND (cc_district='36' OR cc_district LIKE '%36%')");
  assert.equal(zapCouncilDistrictWhere("5"), " AND (cc_district='5' OR cc_district LIKE '%05%')");
  assert.equal(zapCouncilDistrictWhere("99"), "");
  assert.equal(zapCommunityDistrictWhere("Q04"), " AND community_district like '%Q04%'");
  assert.equal(zapCommunityDistrictWhere("404"), " AND community_district like '%Q04%'");
  assert.equal(zapCommunityDistrictWhere(""), "");
});

test("worker twin exists beside the site unified layer", () => {
  assert.ok(existsSync(new URL("../worker/src/data/district_boundaries.json", import.meta.url)));
});
