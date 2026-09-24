/**
 * Address entry → one parcel-geography shard → shared resident selection.
 *
 *   node --test test/address_entry_parcel_geography.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { geocodeAddressText } from "../site/address_geocoder.mjs";
import {
  createGeographyAddressEntryResolver,
  createParcelGeographyShardLoader,
  resolveGeographyAddressEntry,
} from "../site/geography_address_entry.mjs";
import {
  GEOGRAPHY_ENTRY_RECOVERY,
  GEOGRAPHY_ENTRY_SOURCES,
  RESIDENT_GEOGRAPHY_ENTRY_SCHEMA,
  geographyEntryPayloadLeaksEphemeral,
  geographyEntryPublicProjection,
  resolveGeographyEntryFromPlaceLabel,
  sameGeographyEntrySchema,
} from "../site/geography_navigation_entry.mjs";
import {
  GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS,
  serializeGeographyNavigationState,
} from "../site/geography_navigation_state.mjs";
import { GEOGRAPHY_NAVIGATION_LAYER_TYPES } from "../site/geography_navigation_capability.mjs";
import { loadCivicGeographyLayer } from "../site/civic_geography.mjs";
import {
  createPrecomputedAddressGeocoder,
} from "../site/precomputed_address_geocoder.mjs";
import {
  PARCEL_GEOGRAPHY_POINT_METHOD,
  parcelShardKey,
} from "../site/parcel_geography.mjs";
import {
  NEAR_YOU_RECORD_FULL_RECORD_CLASS,
  NEAR_YOU_RECORD_INSPECT_CLASS,
  nearYouRecordFullRecordLabel,
  renderNearYouRecordFullRecordLink,
  renderNearYouRecordInspectButton,
  renderNearYouRecordInspectionBody,
} from "../site/near_you_record_inspection.mjs";

const ROOT = process.cwd();
const MAP_SOURCE = readFileSync(join(ROOT, "site/app/map.mjs"), "utf8");
const ADDRESS_GEOCODER_SOURCE = readFileSync(join(ROOT, "site/address_geocoder.mjs"), "utf8");
const ADAPTER_SOURCE = readFileSync(join(ROOT, "site/geography_address_entry.mjs"), "utf8");
const ENTRY_SOURCE = readFileSync(join(ROOT, "site/geography_navigation_entry.mjs"), "utf8");
const INSPECTION_SOURCE = readFileSync(join(ROOT, "site/near_you_record_inspection.mjs"), "utf8");

const registry = JSON.parse(
  readFileSync(join(ROOT, "site/data/geography/layer_registry.json"), "utf8"),
);

function loadNavigationLayers() {
  return GEOGRAPHY_NAVIGATION_LAYER_TYPES.map((type) => {
    const row = registry.layers.find((entry) => entry.type === type);
    assert.ok(row, type);
    return loadCivicGeographyLayer(
      JSON.parse(readFileSync(join(ROOT, row.artifacts.full.path), "utf8")),
    );
  });
}

const LAYER_DATA = loadNavigationLayers();

function localDataFetch(rootDir, urlPrefix) {
  const requested = [];
  async function fetchImpl(url) {
    const href = String(url);
    requested.push(href);
    assert.equal(/^https?:\/\//i.test(href), false, `external egress forbidden: ${href}`);
    let relative = href;
    if (relative.startsWith(urlPrefix)) relative = relative.slice(urlPrefix.length);
    relative = relative.replace(/^\.\//, "");
    const body = await readFileAsync(join(ROOT, rootDir, relative), "utf8");
    return {
      ok: true,
      json: async () => JSON.parse(body),
    };
  }
  return { fetchImpl, requested };
}

function productionHelpers() {
  const pad = localDataFetch("site/data/address-index", "/data/address-index/");
  const parcel = localDataFetch("site/data/parcel-geography", "/data/parcel-geography/");
  const geocode = createPrecomputedAddressGeocoder({
    fetchImpl: pad.fetchImpl,
    manifestUrl: "/data/address-index/manifest.json",
  });
  const resolve = createGeographyAddressEntryResolver({
    geocode,
    fetchImpl: parcel.fetchImpl,
    parcelManifestUrl: "/data/parcel-geography/manifest.json",
  });
  return { resolve, geocode, pad, parcel };
}

function assertNoEphemeralLeak(entry, queryText) {
  const serialized = JSON.stringify(entry);
  assert.doesNotMatch(serialized, new RegExp(queryText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  for (const key of GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS) {
    assert.equal(Object.hasOwn(entry, key), false, key);
  }
  assert.equal(Object.hasOwn(entry, "ephemeral_point"), false);
  assert.equal(Object.hasOwn(entry, "bbl"), false);
  const projection = geographyEntryPublicProjection(entry);
  assert.equal(geographyEntryPayloadLeaksEphemeral(projection), false);
  const historyBag = serializeGeographyNavigationState({
    ok: true,
    geo: entry.selection?.geo,
    key: entry.selection?.key,
    type: entry.selection?.type,
    id: entry.selection?.id,
    surface: "map",
  });
  for (const key of GEOGRAPHY_NAVIGATION_EPHEMERAL_KEYS) {
    assert.equal(historyBag.has(key), false, key);
  }
  assert.equal(historyBag.has("address"), false);
  assert.equal(historyBag.has("bbl"), false);
}

test("A1: production helper pair selects Midwood and Sheepshead Bay districts from retained shards", async () => {
  const { resolve, geocode, pad, parcel } = productionHelpers();

  // Preserve the existing BBL contract for parcel callers.
  const padMidwood = await geocode("810 East 16th Street Brooklyn");
  assert.equal(padMidwood.status, "matched");
  assert.equal(padMidwood.bbl, "3066990010");
  assert.equal(Object.hasOwn(padMidwood, "lat"), false);
  assert.equal(Object.hasOwn(padMidwood, "lon"), false);

  const midwood = await resolve("810 East 16th Street Brooklyn", { layerData: LAYER_DATA });
  assert.equal(midwood.entry.ok, true);
  assert.equal(midwood.entry.schema, RESIDENT_GEOGRAPHY_ENTRY_SCHEMA);
  assert.equal(midwood.entry.source, GEOGRAPHY_ENTRY_SOURCES.ADDRESS);
  assert.equal(midwood.entry.selected.type, "nta2020");
  assert.equal(midwood.entry.selected.id, "BK1403");
  assert.equal(midwood.entry.selected.label, "Midwood");
  assert.equal(midwood.entry.selection.geo, "nta2020:BK1403");
  assert.equal(midwood.entry.bundle.by_type.community_district[0].id, "K14");
  assert.equal(midwood.entry.bundle.by_type.council_district[0].id, "45");
  assert.equal(midwood.entry.bundle.by_type.police_precinct[0].id, "70");
  assert.equal(midwood.entry.bundle.by_type.nta2020[0].method, "parcel_membership");
  assert.ok(Number.isFinite(midwood.ephemeralPoint?.lat));
  assert.ok(Number.isFinite(midwood.ephemeralPoint?.lon));
  assertNoEphemeralLeak(midwood.entry, "810 East 16th Street");

  const emmons = await resolve("3218 Emmons", { layerData: LAYER_DATA });
  assert.equal(emmons.entry.ok, true);
  assert.equal(emmons.entry.selected.id, "BK1503");
  assert.match(emmons.entry.selected.label, /Sheepshead Bay/i);
  assert.equal(emmons.entry.bundle.by_type.community_district[0].id, "K15");
  assert.equal(emmons.entry.bundle.by_type.council_district[0].id, "48");
  assert.equal(emmons.entry.selection.geo, "nta2020:BK1503");
  assertNoEphemeralLeak(emmons.entry, "3218 Emmons");

  // Same selection state as typing the neighborhood place label.
  const place = resolveGeographyEntryFromPlaceLabel("Midwood", { layerData: LAYER_DATA });
  assert.equal(sameGeographyEntrySchema(midwood.entry, place), true);

  // Cold cache: PAD manifest + one street shard; parcel manifest + one parcel shard.
  // Street-type completion for Emmons may touch additional PAD shards, but never a citywide dump.
  assert.ok(pad.requested.some((url) => url.includes("/data/address-index/manifest.json")));
  assert.ok(parcel.requested.some((url) => url.includes("/data/parcel-geography/manifest.json")));
  assert.ok(parcel.requested.every((url) => url.startsWith("/data/parcel-geography/")));
  assert.ok(!parcel.requested.some((url) => /citywide|all-parcels|full-corpus/i.test(url)));
  const parcelShardFiles = parcel.requested.filter((url) => /\/[0-9a-f]{2}\.json$/.test(url));
  assert.ok(parcelShardFiles.length >= 1);
  assert.ok(parcelShardFiles.length <= 2, `expected one shard per resolved BBL, got ${parcelShardFiles}`);
});

test("A2: parcel aliases select BK1402 and keep published street identity; inspect keeps place with an explicit full-record link", async () => {
  const { resolve, geocode } = productionHelpers();

  const coney = await geocode("461 Coney Island Avenue Brooklyn");
  const church = await geocode("901 Church Avenue Brooklyn");
  assert.equal(coney.bbl, "3050700035");
  assert.equal(church.bbl, "3050700035");
  assert.match(coney.label, /Coney Island/i);
  assert.match(church.label, /Church/i);
  assert.doesNotMatch(coney.label, /Church/i);

  const fromConey = await resolve("461 Coney Island Avenue Brooklyn", { layerData: LAYER_DATA });
  const fromChurch = await resolve("901 Church Avenue Brooklyn", { layerData: LAYER_DATA });
  assert.equal(fromConey.entry.ok, true);
  assert.equal(fromChurch.entry.ok, true);
  assert.equal(fromConey.entry.selected.id, "BK1402");
  assert.equal(fromChurch.entry.selected.id, "BK1402");
  assert.match(fromConey.entry.selected.label, /Flatbush/i);

  // Selection is geography identity, never the parcel source's alternate street.
  assert.doesNotMatch(JSON.stringify(fromConey.entry), /Church/i);
  assert.doesNotMatch(JSON.stringify(fromChurch.entry), /Coney Island/i);
  assertNoEphemeralLeak(fromConey.entry, "461 Coney Island Avenue");

  // Disclosure: Inspect preserves the selected place; open-full-detail is an
  // explicit navigational link with optional source/point-method detail.
  const facts = {
    schema: "cityscroll.near_you_record_inspection.v1",
    version: 1,
    uid: "meeting:example",
    title: "Community board hearing",
    href: "/meetings/example/",
    agency: "Community Board 14",
    type: "Meeting",
    date_label: "Sep 23, 2026",
    place_role: "venue",
    place_role_label: "Happening here",
    basis: "Local activity",
    source_url: "https://www.nyc.gov/site/brooklyncb14/index.page",
    source_label: "Official source",
    timing: { state: "upcoming", label: "Upcoming", action_open: true, kind: "event", event_at: "2026-09-23" },
    geography: {
      tier: "strong",
      resident_label: "Exact place match",
      place_role_label: "Meeting venue",
      label: "Flatbush (West)-Ditmas Park-Parkville",
      basis: "Parcel membership",
      key: "geography:nta2020:BK1402",
      source_id: "mappluto",
      boundary_vintage: "26B",
    },
    why_here: null,
    uncertainty: null,
  };
  const inspectButton = renderNearYouRecordInspectButton(facts);
  const fullLink = renderNearYouRecordFullRecordLink(facts);
  const body = renderNearYouRecordInspectionBody(facts);
  assert.match(inspectButton, new RegExp(NEAR_YOU_RECORD_INSPECT_CLASS));
  assert.match(fullLink, new RegExp(NEAR_YOU_RECORD_FULL_RECORD_CLASS));
  assert.match(fullLink, /href="\/meetings\/example\/"/);
  assert.equal(nearYouRecordFullRecordLabel(), "Open the full record");
  assert.match(body, /Flatbush \(West\)-Ditmas Park-Parkville/);
  assert.match(body, /Publisher boundary 26B|Source mappluto|Geography key/);
  assert.match(INSPECTION_SOURCE, /Open the full record/);
  assert.match(INSPECTION_SOURCE, /NEAR_YOU_RECORD_FULL_RECORD_CLASS/);
  // Missing optional enrichment creates no empty card shell.
  assert.equal(renderNearYouRecordInspectionBody(null), "");
  assert.equal(renderNearYouRecordFullRecordLink(null), "");
});

test("A3: ambiguous Broadway asks for refinement; missing parcel memberships offer place selection", async () => {
  const { resolve, geocode } = productionHelpers();

  const broadway = await geocode("250 Broadway");
  assert.equal(broadway.status, "unknown");
  assert.equal(broadway.reason, "ambiguous");

  const refined = await resolve("250 Broadway", { layerData: LAYER_DATA });
  assert.equal(refined.entry.ok, false);
  assert.equal(refined.entry.recovery.reason, GEOGRAPHY_ENTRY_RECOVERY.AMBIGUOUS_ADDRESS);
  assert.match(refined.entry.recovery.message, /borough or ZIP|choose an area from the list/i);
  assert.equal(refined.entry.selected, null);
  assert.equal(refined.ephemeralPoint, null);
  assertNoEphemeralLeak(refined.entry, "250 Broadway");

  // Missing parcel coordinate/membership data must not invent a neighborhood.
  const fakeGeocode = async () => ({
    status: "matched",
    bbl: "3066990010",
    borough: "Brooklyn",
    zip: "11230",
    label: "810 E 16 St, Brooklyn 11230",
    method: "nyc_dcp_pad_snapshot",
  });
  const emptyShardLoader = async () => ({
    schema: "cityscroll.parcel-geography-shard.v1",
    key: parcelShardKey("3066990010"),
    parcels: {
      "3066990010": { lat: 40.6297346, lon: -73.9615272 },
    },
  });
  const missingMemberships = createGeographyAddressEntryResolver({
    geocode: fakeGeocode,
    loadParcelShard: emptyShardLoader,
  });
  const missing = await missingMemberships("810 East 16th Street Brooklyn", { layerData: LAYER_DATA });
  assert.equal(missing.entry.ok, false);
  assert.equal(missing.entry.recovery.reason, GEOGRAPHY_ENTRY_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE);
  assert.match(missing.entry.recovery.message, /choose an area from the list/i);
  assert.equal(missing.entry.selected, null);
  assert.equal(missing.ephemeralPoint, null);

  const absentShard = createGeographyAddressEntryResolver({
    geocode: fakeGeocode,
    loadParcelShard: async () => null,
  });
  const absent = await absentShard("810 East 16th Street Brooklyn", { layerData: LAYER_DATA });
  assert.equal(absent.entry.ok, false);
  assert.equal(absent.entry.recovery.reason, GEOGRAPHY_ENTRY_RECOVERY.PARCEL_GEOGRAPHY_UNAVAILABLE);
});

test("A4: map island wires the geography address adapter; reads stay shard-scoped; PAD BBL contract unchanged", async () => {
  assert.match(MAP_SOURCE, /resolveGeographyAddressEntry/);
  assert.match(MAP_SOURCE, /geography_address_entry\.mjs/);
  assert.doesNotMatch(MAP_SOURCE, /geocode:\s*geocodeAddressText/);
  assert.doesNotMatch(MAP_SOURCE, /resolveGeographyEntryFromAddressAsync/);

  // address_geocoder keeps the BBL-only export for parcel callers.
  assert.match(ADDRESS_GEOCODER_SOURCE, /export function geocodeAddressText/);
  assert.match(ADAPTER_SOURCE, /geocodeAddressText/);
  assert.match(ADAPTER_SOURCE, /lookupParcelMemberships/);
  assert.match(ADAPTER_SOURCE, /createParcelGeographyShardLoader/);
  assert.match(ENTRY_SOURCE, /resolveGeographyEntryFromParcelMemberships/);
  assert.match(ENTRY_SOURCE, /parcel_membership/);
  assert.doesNotMatch(ADAPTER_SOURCE, /resolveCivicGeographies/);
  assert.doesNotMatch(ADAPTER_SOURCE, /point_in_polygon|pointInPolygon/i);

  const { resolve, parcel } = productionHelpers();
  await resolve("810 East 16th Street Brooklyn", { layerData: LAYER_DATA });
  const shardUrls = parcel.requested.filter((url) => /\/[0-9a-f]{2}\.json$/.test(url));
  assert.deepEqual(
    [...new Set(shardUrls)],
    [`/data/parcel-geography/${parcelShardKey("3066990010")}.json`],
  );

  // Production singleton path is importable (lazy) and shares the adapter contract.
  assert.equal(typeof resolveGeographyAddressEntry, "function");
  assert.equal(typeof createParcelGeographyShardLoader, "function");
  assert.equal(PARCEL_GEOGRAPHY_POINT_METHOD, "mappluto_published_latitude_longitude");

  // geocodeAddressText remains the shared browser helper; Node without fetch stays unavailable.
  const bare = await geocodeAddressText("810 East 16th Street Brooklyn");
  assert.equal(bare.status, "unknown");
});
