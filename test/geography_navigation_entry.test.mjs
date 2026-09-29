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
  GEOGRAPHY_ENTRY_ADOPTION_FAILURE,
  GEOGRAPHY_ENTRY_LOCATION_ASKED_KEY,
  GEOGRAPHY_ENTRY_RECOVERY,
  GEOGRAPHY_ENTRY_RECOVERY_ACTIONS,
  GEOGRAPHY_ENTRY_RECOVERY_COPY,
  GEOGRAPHY_ENTRY_SOURCES,
  RESIDENT_GEOGRAPHY_ENTRY_SCHEMA,
  geographyEntryBlockedLocationResult,
  geographyEntryDestinationSurface,
  geographyEntryPayloadLeaksEphemeral,
  geographyEntryPublicProjection,
  geographyEntryRecoveryActions,
  geographyEntryRecoveryCopy,
  geographyEntryRecoveryResult,
  geographyEntrySelectionState,
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
  shouldRequestGeographyEntryLocationOnLoad,
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
  geographyNavigationUrlWithFilters,
  parseGeographyNavigationState,
  serializeGeographyNavigationState,
  writeGeographyNavigationHistory,
} from "../site/geography_navigation_state.mjs";
import {
  GEOGRAPHY_SHELL_BROWSE_ALL_LABEL,
  GEOGRAPHY_SHELL_BROWSE_ALL_ROUTE,
  GEOGRAPHY_SHELL_ENTER_ADDRESS_LABEL,
  GEOGRAPHY_SHELL_ENTRY_RETRY_LABEL,
  geographyShellEntryRecoveryHtml,
} from "../site/geography_navigation_shell.mjs";
import { rememberDocumentRouteScroll } from "../site/document_route_scroll.mjs";

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
    GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_BLOCKED,
    GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_TIMEOUT,
    GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE,
    GEOGRAPHY_ENTRY_RECOVERY.OUTSIDE_COVERED_LAND,
  ];
  const messages = reasons.map((reason) => geographyEntryRecoveryCopy(reason));
  assert.equal(new Set(messages).size, messages.length);
  for (const message of messages) {
    assert.match(message, /choose an area from the list/i);
  }

  // Gesture gate: the map island requests location from the button's click
  // handler, or once on load through the site owner's load-time policy
  // (observed at runtime in test/functional/59_near_you_location_permission.py).
  const start = MAP_SOURCE.indexOf("function wireGeolocation(");
  assert.ok(start >= 0);
  const wireBody = MAP_SOURCE.slice(start, MAP_SOURCE.indexOf("\n}\n", start) + 2);
  const handler = wireBody.indexOf('button.addEventListener("click", () => {');
  assert.ok(handler >= 0);
  assert.ok(wireBody.indexOf("requestGeographyEntryLocation(button)") > handler);
  assert.ok(wireBody.indexOf("button.hidden = false") > wireBody.indexOf("requestGeographyEntryLocation(button)"));
  const requestStart = MAP_SOURCE.indexOf("async function requestGeographyEntryLocation(");
  assert.ok(requestStart >= 0);
  const requestBody = MAP_SOURCE.slice(requestStart, start);
  assert.equal((MAP_SOURCE.match(/getCurrentPosition/g) || []).length, 1);
  assert.ok(requestBody.includes("navigator.geolocation.getCurrentPosition("));
  // Retry repeats the request only by pressing the same button.
  assert.match(requestBody, /const retry = \(\) => button\.click\(\);/);
  // The existing low-accuracy request, 10-second timeout and cached-position window.
  assert.match(requestBody, /\{ enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 \}/);
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

test("entry action: search and location open Records; a map click keeps the Map and its drawer", () => {
  assert.equal(geographyEntryDestinationSurface(GEOGRAPHY_ENTRY_SOURCES.ADDRESS), "records");
  assert.equal(geographyEntryDestinationSurface(GEOGRAPHY_ENTRY_SOURCES.PLACE_LABEL), "records");
  assert.equal(geographyEntryDestinationSurface(GEOGRAPHY_ENTRY_SOURCES.GEOLOCATION), "records");
  assert.equal(geographyEntryDestinationSurface(GEOGRAPHY_ENTRY_SOURCES.MAP_CLICK), "map");
  assert.equal(geographyEntryDestinationSurface(GEOGRAPHY_ENTRY_SOURCES.POINT), "map");
  assert.equal(geographyEntryDestinationSurface(undefined), "map");

  // Current state from a shared comparison URL with filters.
  const current = parseGeographyNavigationState(
    "?geo=nta2020%3ABK0101&compare=council_district&surface=map&drawer=closed&lens=land",
  );
  const [lon, lat] = [-73.9235, 40.7644];
  const located = resolveGeographyEntryFromGeolocation(lon, lat, { layerData: LAYER_DATA });
  assert.equal(located.ok, true);
  const records = geographyEntrySelectionState(current, located);
  assert.equal(records.surface, "records");
  assert.equal(records.drawer, null);
  assert.equal(records.focus, null);
  assert.equal(records.geo, "nta2020:QN0103");
  assert.equal(records.compare, "council_district", "comparison layer is untouched");
  assert.equal(records.lens, "land", "category is untouched");

  const clicked = resolveGeographyEntryFromMapClick(lon, lat, { layerData: LAYER_DATA });
  const map = geographyEntrySelectionState(current, clicked);
  assert.equal(map.surface, "map");
  assert.equal(map.drawer, "open");
  assert.equal(map.focus, clicked.selection.key);
  assert.equal(map.compare, "council_district");

  const url = new URL(geographyNavigationUrlWithFilters(records, { base: "https://cityscroll.org/near-you/" }));
  assert.equal(url.searchParams.get("surface"), "records");
  assert.equal(url.searchParams.get("geo"), "nta2020:QN0103");
  assert.equal(url.searchParams.has("drawer"), false);
  // A failed entry has no destination state.
  assert.equal(geographyEntrySelectionState(current, resolveGeographyEntryFromGeolocationError({ code: 1 })), null);
});

test("entry recovery: at most two working next steps, Retry only when trying again can help", () => {
  const { RETRY, ENTER_ADDRESS, BROWSE_ALL } = GEOGRAPHY_ENTRY_RECOVERY_ACTIONS;
  const plan = (reason, options) => [...geographyEntryRecoveryActions(reason, options)];
  const location = { source: GEOGRAPHY_ENTRY_SOURCES.GEOLOCATION };
  const typed = { source: GEOGRAPHY_ENTRY_SOURCES.ADDRESS };
  for (const reason of [
    GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_DENIED,
    GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_UNAVAILABLE,
    GEOGRAPHY_ENTRY_RECOVERY.OUTSIDE_COVERED_LAND,
  ]) {
    assert.deepEqual(plan(reason, location), [ENTER_ADDRESS, BROWSE_ALL], reason);
  }
  assert.deepEqual(plan(GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_TIMEOUT, location), [RETRY, ENTER_ADDRESS]);
  assert.deepEqual(plan(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE, location), [RETRY, ENTER_ADDRESS]);
  assert.deepEqual(plan(GEOGRAPHY_ENTRY_ADOPTION_FAILURE, location), [RETRY, ENTER_ADDRESS]);
  // A typed search keeps its text in the input, so its second step is every NYC record.
  assert.deepEqual(plan(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE, typed), [RETRY, BROWSE_ALL]);
  assert.deepEqual(plan(GEOGRAPHY_ENTRY_ADOPTION_FAILURE, typed), [RETRY, BROWSE_ALL]);
  for (const reason of [
    GEOGRAPHY_ENTRY_RECOVERY.NO_RESULT,
    GEOGRAPHY_ENTRY_RECOVERY.AMBIGUOUS_ADDRESS,
    GEOGRAPHY_ENTRY_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE,
  ]) {
    assert.deepEqual(plan(reason, typed), [ENTER_ADDRESS, BROWSE_ALL], reason);
  }
  // Without a retry path or an address field the plan never offers a dead control.
  assert.deepEqual(plan(GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_TIMEOUT, { ...location, canRetry: false }), [ENTER_ADDRESS, BROWSE_ALL]);
  assert.deepEqual(plan(GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_DENIED, { ...location, hasAddressInput: false }), [BROWSE_ALL]);
  assert.deepEqual(plan(GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_TIMEOUT, { ...location, hasAddressInput: false }), [RETRY, BROWSE_ALL]);
  for (const reason of [...Object.values(GEOGRAPHY_ENTRY_RECOVERY), GEOGRAPHY_ENTRY_ADOPTION_FAILURE]) {
    for (const options of [location, typed, { hasAddressInput: false }, { canRetry: false }]) {
      const actions = plan(reason, options);
      assert.ok(actions.length >= 1 && actions.length <= 2, `${reason} ${JSON.stringify(options)}`);
      assert.equal(new Set(actions).size, actions.length);
    }
  }

  // The shell renders every planned action: buttons for in-page steps, a link for Browse.
  const html = geographyShellEntryRecoveryHtml(Object.values(GEOGRAPHY_ENTRY_RECOVERY_ACTIONS));
  assert.match(html, /^<div class="near-place-actions near-entry-recovery" role="group" aria-label="[^"]+" data-near-entry-recovery>/);
  assert.ok(html.includes(`<button type="button" data-near-entry-recovery-action="${RETRY}">${GEOGRAPHY_SHELL_ENTRY_RETRY_LABEL}</button>`));
  assert.ok(html.includes(`<button type="button" data-near-entry-recovery-action="${ENTER_ADDRESS}">${GEOGRAPHY_SHELL_ENTER_ADDRESS_LABEL}</button>`));
  assert.ok(html.includes(`<a href="${GEOGRAPHY_SHELL_BROWSE_ALL_ROUTE}" data-near-entry-recovery-action="${BROWSE_ALL}">${GEOGRAPHY_SHELL_BROWSE_ALL_LABEL}</a>`));
  assert.equal(GEOGRAPHY_SHELL_ENTER_ADDRESS_LABEL, "Enter an address");
  assert.equal(GEOGRAPHY_SHELL_BROWSE_ALL_LABEL, "Browse all NYC records");
  assert.equal(geographyShellEntryRecoveryHtml([]), "");
  assert.equal(geographyShellEntryRecoveryHtml(["unknown"]), "");
  assert.equal(
    geographyEntryRecoveryResult(GEOGRAPHY_ENTRY_RECOVERY.LOOKUP_FAILURE, { source: GEOGRAPHY_ENTRY_SOURCES.ADDRESS }).source,
    GEOGRAPHY_ENTRY_SOURCES.ADDRESS,
  );
});

test("entry no-leak: the location an entry resolves never reaches its URL, history, storage or analytics", () => {
  const [lon, lat] = [-73.9235, 40.7644];
  const needles = [String(lon), String(lat), "73.9235", "40.7644"];
  const leaks = (text) => needles.filter((needle) => String(text).includes(needle));
  // Positive control: the checker catches a coordinate in any of these payloads.
  assert.deepEqual(leaks(`?lat=${lat}&lon=${lon}`).length > 0, true);

  const entry = resolveGeographyEntryFromGeolocation(lon, lat, { layerData: LAYER_DATA });
  const state = geographyEntrySelectionState(parseGeographyNavigationState(""), entry);
  const url = geographyNavigationUrlWithFilters(state, { base: "https://cityscroll.org/near-you/" });
  assert.deepEqual(leaks(url), []);

  const pushed = [];
  const historyLike = { pushState: (data, _title, href) => pushed.push({ data, href }) };
  assert.equal(writeGeographyNavigationHistory(historyLike, new URL(url), state), true);
  assert.equal(pushed.length, 1);
  assert.deepEqual(leaks(JSON.stringify(pushed)), []);
  assert.equal(geographyEntryPayloadLeaksEphemeral(pushed[0].data), false);

  const analytics = geographyEntryPublicProjection(entry);
  assert.deepEqual(leaks(JSON.stringify(analytics)), []);
  assert.equal(analytics.selected_key, "geography:nta2020:QN0103");

  const stored = new Map();
  const win = {
    location: new URL(url),
    scrollX: 0,
    scrollY: 812,
    sessionStorage: { setItem: (key, value) => stored.set(key, value) },
  };
  assert.equal(rememberDocumentRouteScroll(win, {
    focus: JSON.stringify({ record: "meeting:1", control: ".near-record-full-record" }),
  }), true);
  assert.deepEqual(leaks(JSON.stringify([...stored])), []);
  // A failed entry keeps nothing but its reason.
  const failed = geographyEntryPublicProjection(resolveGeographyEntryFromPoint(0, 0, { layerData: LAYER_DATA }));
  assert.equal(failed.recovery_reason, GEOGRAPHY_ENTRY_RECOVERY.OUTSIDE_COVERED_LAND);
  assert.deepEqual(leaks(JSON.stringify(failed)), []);
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

test("a refusal while the browser reports a block is its own recovery, naming how to allow it", () => {
  const blocked = resolveGeographyEntryFromGeolocationError({ code: 1 }, { permission: "denied" });
  assert.equal(blocked.recovery.reason, GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_BLOCKED);
  assert.equal(geographyEntryBlockedLocationResult().recovery.reason, GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_BLOCKED);
  // A refusal answered at a prompt, or with no readable permission state, stays a denial.
  for (const permission of ["prompt", "granted", null]) {
    assert.equal(
      resolveGeographyEntryFromGeolocationError({ code: 1 }, { permission }).recovery.reason,
      GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_DENIED,
      String(permission),
    );
  }
  // A block never turns a timeout or position failure into a permission message.
  assert.equal(
    resolveGeographyEntryFromGeolocationError({ code: 3 }, { permission: "denied" }).recovery.reason,
    GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_TIMEOUT,
  );
  const copy = geographyEntryRecoveryCopy(GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_BLOCKED);
  assert.match(copy, /blocked/i);
  assert.match(copy, /set Location to Allow/);
  assert.match(copy, /choose an area from the list/i);
  // Only the button retries a block, once the resident has lifted it.
  assert.deepEqual(
    geographyEntryRecoveryActions(GEOGRAPHY_ENTRY_RECOVERY.GEOLOCATION_BLOCKED, { source: "geolocation" }),
    [GEOGRAPHY_ENTRY_RECOVERY_ACTIONS.ENTER_ADDRESS, GEOGRAPHY_ENTRY_RECOVERY_ACTIONS.BROWSE_ALL],
  );
});

test("Near You asks for location on load only with no place chosen, once per session", () => {
  const fresh = { search: "", hash: "", hasLocationControl: true };
  assert.equal(GEOGRAPHY_ENTRY_LOCATION_ASKED_KEY, "near-you:location-asked");
  assert.equal(shouldRequestGeographyEntryLocationOnLoad(fresh), true);
  assert.equal(shouldRequestGeographyEntryLocationOnLoad({ ...fresh, search: "?surface=map&lens=meetings" }), true);
  const declined = {
    "no control": { hasLocationControl: false },
    "already asked this session": { askedThisSession: true },
    "Back or Forward restore": { historyTraversal: true },
    "server-rendered selection": { selectedKey: "geography:nta2020:QN0103" },
    "place in the URL": { search: "?geo=nta2020%3AQN0103&surface=records" },
    "unrecognized place in the URL": { search: "?geo=nonsense" },
    "comparison in the URL": { search: "?compare=council_district" },
    "focus in the URL": { search: "?focus=geography%3Anta2020%3AQN0103" },
    "typed place without JavaScript": { search: "?neighborhood=Astoria" },
    "map hash route": { hash: "#map/cd/QN01" },
  };
  for (const [label, override] of Object.entries(declined)) {
    assert.equal(shouldRequestGeographyEntryLocationOnLoad({ ...fresh, ...override }), false, label);
  }
  assert.equal(shouldRequestGeographyEntryLocationOnLoad(), false);
});
