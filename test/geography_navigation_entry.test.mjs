// Unified resident entry resolution for addresses, places, clicks, and location.
//
//   node --test test/geography_navigation_entry.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  GEOGRAPHY_NAVIGATION_LAYER_TYPES,
  GEOGRAPHY_NAVIGATION_POINT_BUNDLES,
  isResidentialNeighborhoodSubtype,
} from "../site/geography_navigation_capability.mjs";
import {
  BOUNDARIES_AT_LOCATION_HEADING,
  GEOGRAPHY_ENTRY_RECOVERY,
  GEOGRAPHY_ENTRY_RECOVERY_COPY,
  GEOGRAPHY_ENTRY_SOURCES,
  RESIDENT_GEOGRAPHY_ENTRY_SCHEMA,
  geographyEntryPayloadLeaksEphemeral,
  geographyEntryPublicProjection,
  geographyEntryRecoveryCopy,
  geographyEntryUnavailableApiResult,
  geographyPlaceAliasIndexFromGazetteer,
  matchGeographyPlaceLabels,
  omitGeographyEntryEphemeral,
  projectCompatibilityDistricts,
  resolveGeographyEntryFromAddress,
  resolveGeographyEntryFromGeolocation,
  resolveGeographyEntryFromGeolocationError,
  resolveGeographyEntryFromMapClick,
  resolveGeographyEntryFromPlaceLabel,
  resolveGeographyEntryFromPoint,
  sameGeographyEntrySchema,
} from "../site/geography_navigation_entry.mjs";
import neighborhoodGazetteer from "../site/data/neighborhood_gazetteer.json" with { type: "json" };

const DIRECTORY_ACCEPTANCE_CASES = Object.freeze([
  Object.freeze({ id: "BK0101", label: "Greenpoint" }),
  Object.freeze({ id: "MN0102", label: "Tribeca-Civic Center" }),
  Object.freeze({ id: "QN0103", label: "Astoria (Central)" }),
  Object.freeze({ id: "BX0101", label: "Mott Haven-Port Morris" }),
  Object.freeze({ id: "SI0101", label: "St. George-New Brighton" }),
  Object.freeze({ id: "QN8381", label: "John F. Kennedy International Airport" }),
  Object.freeze({ id: "BK0771", label: "Green-Wood Cemetery" }),
]);
import {
  loadCivicGeographyLayer,
  pointRelationToCivicFeature,
  civicFeaturePolygons,
} from "../site/civic_geography.mjs";
import {
  GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS,
  serializeGeographyNavigationState,
} from "../site/geography_navigation_state.mjs";

const ROOT = process.cwd();
const MODULE_SOURCE = readFileSync(join(ROOT, "site/geography_navigation_entry.mjs"), "utf8");
const MAP_SOURCE = readFileSync(join(ROOT, "site/app/map.mjs"), "utf8");
const registry = JSON.parse(
  readFileSync(join(ROOT, "site/data/geography/layer_registry.json"), "utf8"),
);

function loadNavigationLayers({ fidelity = "full" } = {}) {
  return GEOGRAPHY_NAVIGATION_LAYER_TYPES.map((type) => {
    const row = registry.layers.find((entry) => entry.type === type);
    assert.ok(row, type);
    const path = fidelity === "full"
      ? row.artifacts.full.path
      : row.artifacts.simplified.site_path;
    return loadCivicGeographyLayer(JSON.parse(readFileSync(join(ROOT, path), "utf8")));
  });
}

const LAYER_DATA = loadNavigationLayers({ fidelity: "full" });

function assertFixtureMembership(result, fixture) {
  assert.equal(result.ok, true);
  assert.equal(result.schema, RESIDENT_GEOGRAPHY_ENTRY_SCHEMA);
  assert.equal(result.boundaries_heading, BOUNDARIES_AT_LOCATION_HEADING);
  assert.equal(result.selected.type, "nta2020");
  assert.equal(result.selected.id, fixture.membership.nta2020.id);
  assert.equal(result.selected.label, fixture.membership.nta2020.label);
  assert.equal(result.selected.boundary_vintage, fixture.membership.nta2020.boundary_vintage);
  assert.equal(result.selected.subtype, fixture.membership.nta2020.subtype);
  assert.equal(result.selection_policy, "residential_nta");
  assert.equal(result.selection.geo, `nta2020:${fixture.membership.nta2020.id}`);
  assert.equal(result.selection.key, `geography:nta2020:${fixture.membership.nta2020.id}`);

  for (const type of GEOGRAPHY_NAVIGATION_LAYER_TYPES) {
    const expected = fixture.membership[type];
    const matches = result.bundle.by_type[type];
    assert.equal(matches.length, 1, type);
    assert.equal(matches[0].id, expected.id, type);
    assert.equal(matches[0].label, expected.label, type);
    assert.equal(matches[0].boundary_vintage, expected.boundary_vintage, type);
  }

  assert.equal(result.summary.heading, BOUNDARIES_AT_LOCATION_HEADING);
  assert.ok(result.summary.lines.includes(fixture.membership.nta2020.label));
  assert.ok(result.summary.details.every((row) => row.boundary_vintage));
  assert.equal(geographyEntryPayloadLeaksEphemeral(result), false);
  assert.equal(geographyEntryPayloadLeaksEphemeral(geographyEntryPublicProjection(result)), false);
}

test("A1: Sheepshead Bay station point resolves to the pinned four-layer bundle", () => {
  const fixture = GEOGRAPHY_NAVIGATION_POINT_BUNDLES.find((row) => row.id === "sheepshead-bay-station");
  const [lon, lat] = fixture.coordinates;
  const result = resolveGeographyEntryFromPoint(lon, lat, { layerData: LAYER_DATA });
  assertFixtureMembership(result, fixture);
});

test("A2: City Hall point resolves to the pinned four-layer bundle", () => {
  const fixture = GEOGRAPHY_NAVIGATION_POINT_BUNDLES.find((row) => row.id === "new-york-city-hall");
  const [lon, lat] = fixture.coordinates;
  const result = resolveGeographyEntryFromPoint(lon, lat, { layerData: LAYER_DATA });
  assertFixtureMembership(result, fixture);
});

test("A3: each layer is independently point-tested; removing one cannot manufacture another", () => {
  const fixture = GEOGRAPHY_NAVIGATION_POINT_BUNDLES[0];
  const [lon, lat] = fixture.coordinates;
  const withoutCouncil = LAYER_DATA.filter((layer) => layer.type !== "council_district");
  const result = resolveGeographyEntryFromPoint(lon, lat, { layerData: withoutCouncil });
  assert.equal(result.ok, true);
  assert.equal(result.bundle.by_type.council_district.length, 0);
  assert.equal(
    result.bundle.layers.find((row) => row.type === "council_district")?.status,
    "source_unavailable",
  );
  assert.equal(result.bundle.by_type.nta2020[0].id, fixture.membership.nta2020.id);
  assert.equal(result.bundle.by_type.community_district[0].id, fixture.membership.community_district.id);
  assert.equal(result.bundle.by_type.police_precinct[0].id, fixture.membership.police_precinct.id);

  const onlyPrecinct = LAYER_DATA.filter((layer) => layer.type === "police_precinct");
  const precinctOnly = resolveGeographyEntryFromPoint(lon, lat, { layerData: onlyPrecinct });
  assert.equal(precinctOnly.ok, true);
  assert.equal(precinctOnly.selected.type, "police_precinct");
  assert.equal(precinctOnly.bundle.by_type.nta2020.length, 0);
  assert.equal(precinctOnly.bundle.by_type.community_district.length, 0);
  assert.equal(precinctOnly.bundle.by_type.council_district.length, 0);
});

test("A4: address, place-label, map click, and geolocation share one result schema", () => {
  const fixture = GEOGRAPHY_NAVIGATION_POINT_BUNDLES[1];
  const [lon, lat] = fixture.coordinates;
  const geocode = () => ({ lat, lon });

  const fromPoint = resolveGeographyEntryFromPoint(lon, lat, { layerData: LAYER_DATA });
  const fromAddress = resolveGeographyEntryFromAddress("City Hall Park", {
    layerData: LAYER_DATA,
    geocode,
  });
  const fromClick = resolveGeographyEntryFromMapClick(lon, lat, { layerData: LAYER_DATA });
  const fromGeo = resolveGeographyEntryFromGeolocation(lon, lat, { layerData: LAYER_DATA });
  const fromLabel = resolveGeographyEntryFromPlaceLabel(fixture.membership.nta2020.label, {
    layerData: LAYER_DATA,
  });

  for (const result of [fromPoint, fromAddress, fromClick, fromGeo, fromLabel]) {
    assert.equal(result.ok, true);
    assert.equal(result.schema, RESIDENT_GEOGRAPHY_ENTRY_SCHEMA);
    assert.equal(result.selected.id, fixture.membership.nta2020.id);
    assert.equal(result.selection.geo, `nta2020:${fixture.membership.nta2020.id}`);
    assert.equal(result.boundaries_heading, BOUNDARIES_AT_LOCATION_HEADING);
  }

  assert.equal(fromAddress.source, GEOGRAPHY_ENTRY_SOURCES.ADDRESS);
  assert.equal(fromClick.source, GEOGRAPHY_ENTRY_SOURCES.MAP_CLICK);
  assert.equal(fromGeo.source, GEOGRAPHY_ENTRY_SOURCES.GEOLOCATION);
  assert.equal(fromLabel.source, GEOGRAPHY_ENTRY_SOURCES.PLACE_LABEL);
  assert.equal(sameGeographyEntrySchema(fromPoint, fromAddress), true);
  assert.equal(sameGeographyEntrySchema(fromPoint, fromClick), true);
  assert.equal(sameGeographyEntrySchema(fromPoint, fromGeo), true);

  const caseInsensitive = resolveGeographyEntryFromPlaceLabel(
    fixture.membership.nta2020.label.toUpperCase(),
    { layerData: LAYER_DATA },
  );
  assert.equal(caseInsensitive.ok, true);
  assert.equal(caseInsensitive.selected.id, fixture.membership.nta2020.id);

  const numbered = resolveGeographyEntryFromPlaceLabel("Council District 1", {
    layerData: LAYER_DATA,
  });
  assert.equal(numbered.ok, true);
  assert.equal(numbered.selected.type, "council_district");
  assert.equal(numbered.selected.id, "1");
});

test("A5: geolocation recovery reasons stay distinct and plain", () => {
  assert.equal(
    geographyEntryUnavailableApiResult().recovery.reason,
    GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_UNAVAILABLE,
  );
  assert.equal(
    resolveGeographyEntryFromGeolocationError({ code: 1 }).recovery.reason,
    GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_DENIED,
  );
  assert.equal(
    resolveGeographyEntryFromGeolocationError({ code: 3 }).recovery.reason,
    GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_TIMEOUT,
  );
  assert.equal(
    resolveGeographyEntryFromGeolocationError({ code: 2 }).recovery.reason,
    GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE,
  );
  assert.equal(
    resolveGeographyEntryFromPoint(-74.5, 40.0, { layerData: LAYER_DATA }).recovery.reason,
    GEOGRAPHY_ENTRY_RECOVERY.OUTSIDE_COVERED_LAND,
  );

  const reasons = [
    GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_UNAVAILABLE,
    GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_DENIED,
    GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_TIMEOUT,
    GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE,
    GEOGRAPHY_ENTRY_RECOVERY.OUTSIDE_COVERED_LAND,
  ];
  const messages = reasons.map((reason) => geographyEntryRecoveryCopy(reason));
  assert.equal(new Set(messages).size, messages.length);
  for (const message of messages) {
    assert.match(message, /choose an area from the list/i);
  }

  // Gesture gate: map island still requests geolocation only inside the click handler.
  assert.match(MAP_SOURCE, /function wireGeolocation\(/);
  assert.match(MAP_SOURCE, /addEventListener\("click"/);
  assert.match(MAP_SOURCE, /navigator\.geolocation\.getCurrentPosition/);
  const start = MAP_SOURCE.indexOf("function wireGeolocation(");
  const bodyStart = MAP_SOURCE.indexOf("{", start);
  let depth = 0;
  let end = bodyStart;
  for (; end < MAP_SOURCE.length; end += 1) {
    if (MAP_SOURCE[end] === "{") depth += 1;
    if (MAP_SOURCE[end] === "}" && --depth === 0) break;
  }
  const wireBody = MAP_SOURCE.slice(start, end + 1);
  assert.match(wireBody, /addEventListener\("click"/);
  assert.match(wireBody, /getCurrentPosition/);
  assert.ok(wireBody.indexOf("addEventListener(\"click\"") < wireBody.indexOf("getCurrentPosition"));
});

test("A6: raw coordinates and address query text never persist, serialize, or report", () => {
  const fixture = GEOGRAPHY_NAVIGATION_POINT_BUNDLES[0];
  const [lon, lat] = fixture.coordinates;
  const result = resolveGeographyEntryFromAddress("1508 Sheepshead Bay Road Brooklyn", {
    layerData: LAYER_DATA,
    geocode: () => ({ lat, lon }),
  });
  assert.equal(result.ok, true);

  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /1508 Sheepshead Bay Road/i);
  assert.doesNotMatch(serialized, new RegExp(String(lon).replace(".", "\\.")));
  assert.doesNotMatch(serialized, new RegExp(String(lat).replace(".", "\\.")));
  for (const key of ["lat", "lng", "lon", "latitude", "longitude", "coords", "coordinates", "address", "address_text", "query_address"]) {
    assert.equal(Object.hasOwn(result, key), false, key);
  }

  const projection = geographyEntryPublicProjection(result);
  assert.equal(geographyEntryPayloadLeaksEphemeral(projection), false);
  assert.deepEqual(
    Object.keys(omitGeographyEntryEphemeral({
      geo: result.selection.geo,
      lat,
      lon,
      address: "secret",
      coords: [lon, lat],
    })).sort(),
    ["geo"],
  );

  const historyBag = serializeGeographyNavigationState({
    ok: true,
    geo: result.selection.geo,
    key: result.selection.key,
    type: result.selection.type,
    id: result.selection.id,
    surface: "map",
  });
  assert.equal(historyBag.has("geo"), true);
  for (const key of GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS) {
    assert.equal(historyBag.has(key), false);
  }

  const failed = resolveGeographyEntryFromAddress("nope", {
    layerData: LAYER_DATA,
    geocode: () => {
      throw new Error("provider down for 1508 Sheepshead Bay Road");
    },
  });
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed), /1508 Sheepshead Bay Road/);
  assert.doesNotMatch(JSON.stringify(geographyEntryPublicProjection(failed)), /1508|provider down/);
});

test("A7: boundary points retain multiple matches; special-use NTAs keep subtype language", () => {
  const nta = LAYER_DATA.find((layer) => layer.type === "nta2020");
  const sheep = nta.features.find((feature) => feature.id === "BK1503");
  const ring = civicFeaturePolygons(sheep)[0].rings[0];
  const mid = [
    (Number(ring[0][0]) + Number(ring[1][0])) / 2,
    (Number(ring[0][1]) + Number(ring[1][1])) / 2,
  ];
  assert.equal(pointRelationToCivicFeature(mid[0], mid[1], sheep), "boundary");

  const ambiguous = resolveGeographyEntryFromPoint(mid[0], mid[1], { layerData: LAYER_DATA });
  assert.equal(ambiguous.ok, true);
  assert.equal(ambiguous.ambiguity.present, true);
  assert.ok(ambiguous.bundle.by_type.nta2020.length >= 2);
  assert.ok(ambiguous.bundle.ambiguous_types.includes("nta2020"));
  assert.match(ambiguous.summary.ambiguity_note, /boundary/i);
  assert.match(ambiguous.summary.ambiguity_note, /list order/i);

  const park = nta.features.find((feature) => feature.id === "BK0891");
  assert.ok(park);
  assert.equal(isResidentialNeighborhoodSubtype(park.subtype), false);
  const [minLon, minLat, maxLon, maxLat] = park.bbox;
  const special = resolveGeographyEntryFromPoint(
    (minLon + maxLon) / 2,
    (minLat + maxLat) / 2,
    { layerData: LAYER_DATA },
  );
  assert.equal(special.ok, true);
  assert.equal(special.selected.id, "BK0891");
  assert.equal(special.selected.is_special_use, true);
  assert.equal(special.selected.may_label_as_neighborhood, false);
  assert.equal(special.selection_policy, "special_use_nta_with_alternatives");
  assert.match(special.summary.special_use_note, /special statistical area/i);
  assert.doesNotMatch(special.summary.special_use_note, /home neighborhood of/i);
  assert.ok(special.alternatives.some((row) => row.type === "community_district"));
  assert.ok(special.alternatives.some((row) => row.type === "council_district"));
});

test("A8: residential NTA is the initial selected area; full bundle stays under Boundaries at this location", () => {
  const fixture = GEOGRAPHY_NAVIGATION_POINT_BUNDLES[0];
  const [lon, lat] = fixture.coordinates;
  const result = resolveGeographyEntryFromPoint(lon, lat, { layerData: LAYER_DATA });
  assert.equal(result.selected.type, "nta2020");
  assert.equal(result.selected.id, "BK1503");
  assert.equal(result.boundaries_heading, BOUNDARIES_AT_LOCATION_HEADING);
  assert.equal(result.summary.heading, BOUNDARIES_AT_LOCATION_HEADING);
  assert.deepEqual(
    GEOGRAPHY_NAVIGATION_LAYER_TYPES.map((type) => result.bundle.by_type[type][0].id),
    [
      fixture.membership.nta2020.id,
      fixture.membership.community_district.id,
      fixture.membership.council_district.id,
      fixture.membership.police_precinct.id,
    ],
  );
  const compatibility = projectCompatibilityDistricts(result);
  assert.equal(compatibility.community_district, "K15");
  assert.equal(compatibility.council_district, "48");
  assert.equal(compatibility.borough, "Brooklyn");
});

test("A3: directory fixtures resolve through retained labels and aliases without inventing geography", () => {
  const aliasIndex = geographyPlaceAliasIndexFromGazetteer(neighborhoodGazetteer);
  const nta = LAYER_DATA.find((layer) => layer.type === "nta2020");

  const greenpoint = resolveGeographyEntryFromPlaceLabel("Greenpoint", { layerData: LAYER_DATA, aliasIndex });
  assert.equal(greenpoint.ok, true);
  assert.equal(greenpoint.selected.id, "BK0101");
  assert.equal(greenpoint.selection_policy, "residential_nta");

  const tribeca = resolveGeographyEntryFromPlaceLabel("Tribeca-Civic Center", {
    layerData: LAYER_DATA,
    aliasIndex,
  });
  assert.equal(tribeca.ok, true);
  assert.equal(tribeca.selected.id, "MN0102");

  const astoria = resolveGeographyEntryFromPlaceLabel("Astoria Central", {
    layerData: LAYER_DATA,
    aliasIndex,
  });
  assert.equal(astoria.ok, true);
  assert.equal(astoria.selected.id, "QN0103");

  const mott = resolveGeographyEntryFromPlaceLabel("Mott Haven", { layerData: LAYER_DATA, aliasIndex });
  assert.equal(mott.ok, true);
  assert.equal(mott.selected.id, "BX0101");
  assert.equal(mott.selected.label, "Mott Haven-Port Morris");

  const stGeorge = resolveGeographyEntryFromPlaceLabel("St George", { layerData: LAYER_DATA, aliasIndex });
  assert.equal(stGeorge.ok, true);
  assert.equal(stGeorge.selected.id, "SI0101");

  const jfk = resolveGeographyEntryFromPlaceLabel("John F. Kennedy International Airport", {
    layerData: LAYER_DATA,
    aliasIndex,
  });
  assert.equal(jfk.ok, true);
  assert.equal(jfk.selected.id, "QN8381");
  assert.equal(jfk.selection_policy, "special_use_nta_with_alternatives");

  const cemetery = resolveGeographyEntryFromPlaceLabel("Green-Wood Cemetery", {
    layerData: LAYER_DATA,
    aliasIndex,
  });
  assert.equal(cemetery.ok, true);
  assert.equal(cemetery.selected.id, "BK0771");
  assert.equal(cemetery.selection_policy, "special_use_nta_with_alternatives");

  // Ambiguous retained alias must not collapse multiple NTAs into one place.
  const bedStuy = resolveGeographyEntryFromPlaceLabel("Bed-Stuy", { layerData: LAYER_DATA, aliasIndex });
  assert.equal(bedStuy.ok, false);
  assert.equal(bedStuy.recovery.reason, GEOGRAPHY_ENTRY_RECOVERY.AMBIGUOUS_PLACE_LABEL);

  const noMatch = resolveGeographyEntryFromPlaceLabel("zzz-no-such-place", {
    layerData: LAYER_DATA,
    aliasIndex,
  });
  assert.equal(noMatch.ok, false);
  assert.equal(noMatch.recovery.reason, GEOGRAPHY_ENTRY_RECOVERY.NO_RESULT);

  for (const expected of DIRECTORY_ACCEPTANCE_CASES) {
    const feature = nta.features.find((row) => row.id === expected.id);
    assert.ok(feature, expected.label);
    assert.equal(feature.label, expected.label);
  }
});

test("A9: suite covers seeded fixtures, ambiguity, special-use, outside-city, provider failure, and privacy negatives", () => {
  assert.equal(GEOGRAPHY_NAVIGATION_POINT_BUNDLES.length, 2);
  assert.match(MODULE_SOURCE, /sheepshead|POINT_BUNDLES|resolveGeographyEntryFromPoint/);
  assert.match(MODULE_SOURCE, /special_use_nta_with_alternatives/);
  assert.match(MODULE_SOURCE, /outside_covered_land/);
  assert.match(MODULE_SOURCE, /GEOLOCATION_DENIED/);
  assert.match(MODULE_SOURCE, /omitGeographyEntryEphemeral|geographyEntryPayloadLeaksEphemeral/);

  const outside = resolveGeographyEntryFromPoint(-74.5, 40.0, { layerData: LAYER_DATA });
  assert.equal(outside.recovery.reason, GEOGRAPHY_ENTRY_RECOVERY.OUTSIDE_COVERED_LAND);

  const providerFailure = resolveGeographyEntryFromAddress("an address", {
    layerData: LAYER_DATA,
    geocode: () => {
      throw new Error("upstream");
    },
  });
  assert.equal(providerFailure.recovery.reason, GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE);

  const noHit = resolveGeographyEntryFromPlaceLabel("Not A Real Neighborhood Name", {
    layerData: LAYER_DATA,
  });
  assert.equal(noHit.recovery.reason, GEOGRAPHY_ENTRY_RECOVERY.NO_RESULT);

  assert.equal(
    matchGeographyPlaceLabels("Sheepshead Bay-Manhattan Beach-Gerritsen Beach", {
      layerData: LAYER_DATA,
    })[0]?.id,
    "BK1503",
  );

  for (const reason of Object.values(GEOGRAPHY_ENTRY_RECOVERY)) {
    assert.equal(typeof GEOGRAPHY_ENTRY_RECOVERY_COPY[reason], "string");
  }
});
