import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LAND_PREDICTION_ACTOR_RESOLUTION_SCHEMA,
  historicalCouncilActorResolver,
  resolveHistoricalCouncilMemberAt,
  resolveLandUseApplicationActors,
} from "../src/lib/land_prediction_actor_resolution.mjs";
import { buildLandPredictionSnapshot } from "../src/lib/land_prediction_snapshot.mjs";
import personHubArtifact from "../../site/data/person_hub_lookup.json" with { type: "json" };

const SOURCE = { source_contract: "test-council-terms", source_record_id: "fixture-1" };

function square(minLon, minLat, maxLon, maxLat) {
  return [[
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ]];
}

function layer(id, minLon, maxLon, sourceId = `boundary-${id}`) {
  return {
    id,
    schema: "cityscroll.district_boundaries.v0",
    layer: "council_district",
    boundary_vintage: id,
    dataset_id: "test-boundaries",
    districts: [{ id, label: `Council District ${id}`, polygons: [{ rings: square(minLon, 40, maxLon, 41) }] }],
    source: { source_contract: "test-boundaries", source_record_id: sourceId },
  };
}

function boundary(layerValue, effectiveAt, effectiveUntil = null, observedAt = "2019-01-01T00:00:00Z") {
  return {
    layer: layerValue,
    vintage: layerValue.boundary_vintage,
    effective_at: effectiveAt,
    effective_until: effectiveUntil,
    observed_at: observedAt,
    source: { ...SOURCE, source_record_id: `boundary:${layerValue.boundary_vintage}` },
  };
}

function term(personId, name, district, start, end, officeId) {
  return {
    person_id: personId,
    name,
    district,
    term_start: start,
    term_end: end,
    office_id: officeId,
    source: { ...SOURCE, source_record_id: `term:${personId}:${officeId}` },
  };
}

function hub(rows) {
  return { source_contract: "test-person-hub", rows };
}

test("resolves the officeholder from the term active at the cutoff, not current_term", () => {
  const result = resolveLandUseApplicationActors({
    application_id: "2020-HISTORIC",
    locations: [{ location_id: "lot-1", latitude: 40.5, longitude: -73.5 }],
  }, {
    prediction_as_of: "2021-06-01T00:00:00Z",
    boundaries: [boundary(layer("1", -74, -73), "2019-01-01")],
    personHub: hub([
      term("1001", "Former Member", "1", "2018-01-01", "2021-12-31", "old-office"),
      term("1002", "Current Member", "1", "2022-01-01", "2025-12-31", "new-office"),
    ]),
  });

  assert.equal(result.schema, LAND_PREDICTION_ACTOR_RESOLUTION_SCHEMA);
  assert.equal(result.resolution, "resolved");
  assert.equal(result.locations[0].district.district_id, "1");
  assert.equal(result.locations[0].officeholder.actor_id, "official:1001");
  assert.equal(result.locations[0].officeholder.person_name, "Former Member");
  assert.equal(result.locations[0].officeholder.term_start, "2018-01-01");
  assert.equal(result.provenance.current_officeholder_fallback, false);
  assert.ok(result.locations[0].provenance.every((item) => item.stage && item.resolution));
});

test("returns a known vacancy and never substitutes a later or unrelated member", () => {
  const result = resolveLandUseApplicationActors({
    application_id: "2022-VACANT",
    location: { location_id: "lot-v", latitude: 40.5, longitude: -73.5 },
  }, {
    predictionAsOf: "2022-06-01T00:00:00Z",
    boundaries: [boundary(layer("1", -74, -73), "2019-01-01")],
    personHub: hub([term("1003", "Later Member", "1", "2023-01-01", "2025-12-31", "later-office")]),
    vacancies: [{
      district: "1",
      start: "2022-01-01",
      end: "2022-12-31",
      observed_at: "2022-01-02",
      source: { ...SOURCE, source_record_id: "vacancy:1:2022" },
    }],
  });

  assert.equal(result.locations[0].officeholder.resolution, "vacant");
  assert.equal(result.locations[0].officeholder.actor_id, null);
  assert.equal(result.locations[0].officeholder.source.source_record_id, "vacancy:1:2022");
});

test("uses the boundary vintage valid at the cutoff and does not use a current boundary observed later", () => {
  const oldBoundary = boundary(layer("1", -74, -73, "old-boundary"), "2019-01-01", "2022-01-01");
  const newBoundary = boundary(layer("2", -74, -73, "new-boundary"), "2022-01-01", null);
  const terms = hub([
    term("1001", "Old District Member", "1", "2019-01-01", "2021-12-31", "old-office"),
    term("1002", "New District Member", "2", "2022-01-01", "2025-12-31", "new-office"),
  ]);
  const before = resolveLandUseApplicationActors({
    application_id: "2021-BOUNDARY",
    location: { location_id: "lot-b", latitude: 40.5, longitude: -73.5 },
  }, { predictionAsOf: "2021-12-31", boundaries: [oldBoundary, newBoundary], personHub: terms });
  assert.equal(before.locations[0].district.district_id, "1");
  assert.equal(before.locations[0].district.boundary_vintage, "1");
  assert.equal(before.locations[0].officeholder.actor_id, "official:1001");

  const after = resolveLandUseApplicationActors({
    application_id: "2022-BOUNDARY",
    location: { location_id: "lot-b", latitude: 40.5, longitude: -73.5 },
  }, { predictionAsOf: "2022-06-01", boundaries: [oldBoundary, newBoundary], personHub: terms });
  assert.equal(after.locations[0].district.district_id, "2");
  assert.equal(after.locations[0].officeholder.actor_id, "official:1002");

  const currentOnly = resolveLandUseApplicationActors({
    application_id: "2019-CURRENT-BOUNDARY",
    location: { location_id: "lot-b", latitude: 40.5, longitude: -73.5 },
  }, {
    predictionAsOf: "2019-06-01",
    boundaries: [boundary(layer("2", -74, -73, "current-boundary"), "2022-01-01")],
    personHub: terms,
  });
  assert.equal(currentOnly.locations[0].district.resolution, "unknown");
  assert.equal(currentOnly.locations[0].officeholder.resolution, "unknown");
});

test("preserves every location when an application spans two Council districts", () => {
  const districts = {
    layer: {
      schema: "cityscroll.district_boundaries.v0",
      layer: "council_district",
      boundary_vintage: "2024",
      dataset_id: "test-boundaries",
      districts: [
        { id: "1", polygons: [{ rings: square(-74, 40, -73.5, 41) }] },
        { id: "2", polygons: [{ rings: square(-73.5, 40, -73, 41) }] },
      ],
    },
    effective_at: "2019-01-01",
    observed_at: "2019-01-01",
    source: SOURCE,
    vintage: "2024",
  };
  const result = resolveLandUseApplicationActors({
    application_id: "2024-MULTI",
    locations: [
      { location_id: "west-lot", latitude: 40.5, longitude: -73.75 },
      { location_id: "east-lot", latitude: 40.5, longitude: -73.25 },
    ],
  }, {
    prediction_as_of: "2024-06-01",
    boundaries: [districts],
    personHub: hub([
      term("1001", "District One Member", "1", "2022-01-01", "2025-12-31", "one-office"),
      term("1002", "District Two Member", "2", "2022-01-01", "2025-12-31", "two-office"),
    ]),
  });

  assert.equal(result.resolution, "resolved");
  assert.deepEqual(result.council_district_ids, ["1", "2"]);
  assert.deepEqual(result.locations.map((item) => item.officeholder.actor_id), ["official:1001", "official:1002"]);
  assert.equal(result.historical_actors.length, 2);
  assert.deepEqual(result.officeholders.map((item) => item.actor_id), ["official:1001", "official:1002"]);
});

test("unknown is explicit when location, boundary, or historical term evidence is insufficient", () => {
  const result = resolveLandUseApplicationActors({
    application_id: "2024-UNKNOWN",
    locations: [{ location_id: "unlocated" }],
  }, {
    predictionAsOf: "2024-06-01",
    personHub: { source_contract: "test", by_person_id: {
      current: {
        person_id: "current",
        official_id: "official:current",
        person_name: "Current Only",
        district: "1",
        current_term: { term_start: "2022-01-01", term_end: "2025-12-31", district: "1" },
        terms: [],
      },
    } },
  });
  assert.equal(result.resolution, "unknown");
  assert.equal(result.locations[0].district.reason, "boundary_data_unavailable");
  assert.equal(result.locations[0].officeholder.actor_id, null);
  assert.equal(result.locations[0].officeholder.reason, "district_unresolved");
});

test("the c2 actor callback carries the cutoff and produces an exact official identity", () => {
  const resolver = historicalCouncilActorResolver({
    memberTerms: [term("123", "Historical Member", "7", "2020-01-01", "2023-12-31", "office-7")],
  });
  const snapshot = buildLandPredictionSnapshot({
    application_id: "2023-ACTOR",
    prediction_as_of: "2023-06-01",
    procedural_stage: "council",
    historical_actors: [{ role: "local_council_member", district: "7" }],
  }, { resolveHistoricalActor: resolver });
  assert.equal(snapshot.historical_actors[0].actor_id, "official:123");
  assert.equal(snapshot.historical_actors[0].as_of, "2023-06-01T00:00:00.000Z");
  assert.equal(snapshot.historical_actors[0].source.source_record_id, "123:office-7");
});

test("direct district resolution refuses a current-only person record", () => {
  const result = resolveHistoricalCouncilMemberAt({
    district: "1",
    predictionAsOf: "2020-01-01",
    personHub: { by_person_id: {
      "1": {
        person_id: "1",
        official_id: "official:1",
        person_name: "Current Member",
        district: "1",
        current_term: { term_start: "2020-01-01", term_end: "2023-12-31", district: "1" },
        terms: [],
      },
    } },
  });
  assert.equal(result.resolution, "unknown");
  assert.equal(result.reason, "no_term_at_cutoff");
});

test("resolves a historical term from the committed Council person hub", () => {
  const marte = personHubArtifact.by_person_id["7801"];
  assert.ok(marte?.terms?.some((item) => item.district === "1"));
  const result = resolveHistoricalCouncilMemberAt({
    district: "1",
    predictionAsOf: "2023-06-01",
    personHub: personHubArtifact,
  });
  assert.equal(result.resolution, "resolved");
  assert.equal(result.actor_id, "official:7801");
  assert.match(result.person_name, /Marte/i);
  assert.equal(result.source.source_contract, "uvw5-9znb");
  assert.equal(result.effective_at, "2022-01-01T00:00:00.000Z");
});
