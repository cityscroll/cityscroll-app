import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import {
  MAP_EXPLORATION_SCHEMA,
  DISTRICT_ACTIVITY_SCHEMA,
  areaFeedLinks,
  boroughFromCommunityId,
  choroplethFill,
  citywideTotals,
  defaultViewBox,
  drillInto,
  loadDistrictActivity,
  mapFeatures,
  parseMapHashQuery,
  polygonsToSvgPath,
  projectLonLat,
  serializeMapHash,
  totalForLens,
  zoomViewBox,
  panViewBox,
} from "../site/map_exploration.mjs";
import {
  buildDistrictActivity,
  communityDistrictFromAgencyName,
  parseZapCommunityDistricts,
} from "../tools/lib/district_activity.mjs";

const boundaries = JSON.parse(
  readFileSync(new URL("../site/data/district_boundaries.json", import.meta.url), "utf8"),
);

test("map helpers project lon/lat and emit SVG paths", () => {
  const [x, y] = projectLonLat(-74.006, 40.7128);
  assert.ok(Number.isFinite(x) && Number.isFinite(y));
  const path = polygonsToSvgPath(boundaries.council_districts[0].polygons);
  assert.match(path, /^M/);
  assert.match(path, /Z/);
});

test("choroplethFill is paper for zero and deeper for higher density", () => {
  assert.equal(choroplethFill(0, 10), "#f4efe6");
  assert.notEqual(choroplethFill(10, 10), choroplethFill(1, 10));
  assert.ok(totalForLens({ land: 2, property: 3 }, "all") === 5);
  assert.ok(totalForLens({ land: 2, property: 3 }, "land") === 2);
});

test("viewBox zoom/pan stay numeric", () => {
  const base = defaultViewBox();
  const z = zoomViewBox(base, 0.5);
  assert.equal(z.split(/\s+/).length, 4);
  const p = panViewBox(base, 0.1, -0.1);
  assert.equal(p.split(/\s+/).length, 4);
});

test("areaFeedLinks uses existing list filter grammar", () => {
  const boro = areaFeedLinks("borough", "Queens");
  assert.ok(boro.some((l) => l.hash === "#land?boro=Queens"));
  assert.ok(boro.some((l) => l.hash === "#property?boro=Queens"));
  const cd = areaFeedLinks("community_district", "Q04");
  assert.ok(cd.some((l) => l.hash.includes("cd=Q04")));
  const council = areaFeedLinks("council_district", "25");
  assert.ok(council.some((l) => l.hash === "#land?council=25"));
});

test("serialize/parse map hash round-trips", () => {
  const hash = serializeMapHash({
    level: "community_district",
    parent: "Queens",
    id: "Q04",
    lens: "land",
  });
  assert.equal(hash.startsWith("#map?"), true);
  const q = new URLSearchParams(hash.slice(hash.indexOf("?") + 1));
  const parsed = parseMapHashQuery(q);
  assert.equal(parsed.level, "community_district");
  assert.equal(parsed.parent, "Queens");
  assert.equal(parsed.id, "Q04");
  assert.equal(parsed.lens, "land");
});

test("drillInto expands borough to community districts", () => {
  const next = drillInto({ level: "borough", id: "Brooklyn" }, { lens: "all" });
  assert.equal(next.level, "community_district");
  assert.equal(next.parent, "Brooklyn");
  assert.equal(boroughFromCommunityId("K01"), "Brooklyn");
});

test("mapFeatures borough level paints five boroughs with activity", () => {
  const activity = buildDistrictActivity({
    boundaries,
    zapRows: [
      { project_id: "1", borough: "Queens", community_district: "Q04" },
      { project_id: "2", borough: "Queens", community_district: "Q04" },
      { project_id: "3", borough: "Brooklyn", community_district: "K01" },
    ],
    propertyRows: [],
    meetingsRows: [],
    rulesRows: [],
    moneyRows: [],
  });
  const { features, max } = mapFeatures(boundaries, activity, { level: "borough", lens: "land" });
  assert.equal(features.length, 5);
  assert.ok(max >= 2);
  const queens = features.find((f) => f.id === "Queens");
  assert.equal(queens.counts.land, 2);
  assert.ok(queens.path.startsWith("M"));
});

test("mapFeatures community_district filters by parent borough", () => {
  const activity = buildDistrictActivity({
    boundaries,
    zapRows: [{ project_id: "1", borough: "Queens", community_district: "Q04" }],
    propertyRows: [],
  });
  const { features } = mapFeatures(boundaries, activity, {
    level: "community_district",
    parent: "Queens",
    lens: "all",
  });
  assert.ok(features.length >= 10);
  assert.ok(features.every((f) => f.id.startsWith("Q")));
  const q04 = features.find((f) => f.id === "Q04");
  assert.ok(q04);
  assert.equal(q04.counts.land, 1);
});

test("buildDistrictActivity resolves property geometry to districts", () => {
  const activity = buildDistrictActivity({
    boundaries,
    zapRows: [],
    propertyRows: [{
      request_id: "t1",
      property_location: {
        boroughs: ["Queens"],
        geometry: { latitude: 40.7473, longitude: -73.8832 },
      },
    }],
  });
  assert.equal(activity.schema, DISTRICT_ACTIVITY_SCHEMA);
  assert.equal(activity.boundary_vintage, boundaries.boundary_vintage);
  assert.equal(activity.by_level.community_district.Q04.property, 1);
  assert.equal(activity.by_level.council_district["25"].property, 1);
  assert.equal(activity.by_level.borough.Queens.property, 1);
});

test("community board agency names map to product CD ids", () => {
  assert.equal(
    communityDistrictFromAgencyName("Brooklyn Community Board 1"),
    "K01",
  );
  assert.deepEqual(parseZapCommunityDistricts("Q04"), ["Q04"]);
  assert.deepEqual(parseZapCommunityDistricts("Q01, Q02"), ["Q01", "Q02"]);
});

test("committed district_activity artifact is present and loadable", () => {
  const path = new URL("../site/data/district_activity.json", import.meta.url);
  if (!existsSync(path)) {
    assert.fail("run: node tools/build_district_activity.mjs");
  }
  const doc = loadDistrictActivity(JSON.parse(readFileSync(path, "utf8")));
  assert.ok(doc);
  assert.equal(doc.schema, DISTRICT_ACTIVITY_SCHEMA);
  assert.ok(doc.boundary_vintage);
  assert.ok(Object.keys(doc.by_level.borough).length >= 5);
  assert.ok(Object.keys(doc.by_level.council_district).length >= 51);
  const totals = citywideTotals(doc);
  assert.ok(totals.land + totals.property + totals.meetings + totals.rules + totals.money >= 1);
  // Schema constant is exported for surface verification.
  assert.equal(typeof MAP_EXPLORATION_SCHEMA, "string");
});
