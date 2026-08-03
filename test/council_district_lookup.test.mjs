import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  attachCouncilDistrict,
  loadCouncilDistrictLayer,
  normalizeCouncilDistrictId,
  pointInRing,
  resolveCouncilDistrict,
  zapCouncilDistrictWhere,
} from "../site/council_district_lookup.mjs";

const layer = loadCouncilDistrictLayer(
  JSON.parse(readFileSync(new URL("../site/data/council_district_boundaries.json", import.meta.url), "utf8")),
);

test("committed council boundary layer carries vintage and 51 districts", () => {
  assert.ok(layer);
  assert.equal(layer.layer, "council_district");
  assert.equal(layer.dataset_id, "872g-cjhh");
  assert.ok(layer.boundary_vintage);
  assert.ok(layer.district_count >= 51);
  assert.equal(layer.districts.length, layer.district_count);
  assert.ok(layer.districts.every((d) => d.id && d.polygons?.length && d.bbox?.length === 4));
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

test("point-in-ring ray cast handles a unit square", () => {
  const ring = [[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]];
  assert.equal(pointInRing(1, 1, ring), true);
  assert.equal(pointInRing(3, 1, ring), false);
});

test("resolveCouncilDistrict maps golden points and leaves ocean null", () => {
  // Elmhurst / location-awareness golden coords → District 25
  assert.equal(resolveCouncilDistrict(40.7473, -73.8832, layer), "25");
  // City Hall area → District 1
  assert.equal(resolveCouncilDistrict(40.7128, -74.0060, layer), "1");
  // 96 Avenue A (civic-scope fixture council_district 2)
  assert.equal(resolveCouncilDistrict(40.7255, -73.9835, layer), "2");
  assert.equal(resolveCouncilDistrict(40.5, -73.0, layer), null);
  assert.equal(resolveCouncilDistrict(null, null, layer), null);
});

test("attachCouncilDistrict never invents a district without coordinates", () => {
  assert.equal(attachCouncilDistrict({ label: "x" }, layer).council_district, null);
  assert.equal(
    attachCouncilDistrict({ latitude: 40.7473, longitude: -73.8832 }, layer).council_district,
    "25",
  );
  assert.equal(
    attachCouncilDistrict({ latitude: 40.7473, longitude: -73.8832, council_district: "25" }, layer)
      .council_district,
    "25",
  );
});

test("zapCouncilDistrictWhere uses exact single and padded multi-token match", () => {
  assert.equal(zapCouncilDistrictWhere("36"), " AND (cc_district='36' OR cc_district like '%36%')");
  assert.equal(zapCouncilDistrictWhere("5"), " AND (cc_district='5' OR cc_district like '%05%')");
  assert.equal(zapCouncilDistrictWhere("99"), "");
  assert.equal(zapCouncilDistrictWhere(""), "");
});
