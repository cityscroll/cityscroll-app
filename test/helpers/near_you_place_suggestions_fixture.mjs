// Compact frozen fixture for the Near You neighborhood suggestion tests.
//
// A reduction of site/data/district_activity.json and the NTA 2020 layer at a
// pinned repository revision: every neighborhood with a published Meetings
// list (the whole positive Meetings population), Sheepshead Bay's published
// shape without a Meetings list and Mott Haven's explicit empty list. Their
// Meetings and Land lists are verbatim; record bodies keep the fields the
// record filters read, with place memberships limited to the retained keys;
// borough lists keep the retained IDs so the Worker's borough slices carry
// them; layer features keep their directory fields without geometry.
// `reducePlaceSuggestionActivity` and `reducePlaceSuggestionLayer` are the
// only way the committed fixture is produced, so a test can re-derive it from
// the pinned blobs and prove the retained rows are exactly the published ones.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LOCAL_ESCAPE_SOURCE, readPinnedDistrictActivity } from "./near_you_local_escape_fixture.mjs";

export const PLACE_SUGGESTIONS_FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/near_you_place_suggestions/place_suggestions.reduced.json", import.meta.url),
);
/** Same pinned snapshot as the local recovery fixture, plus its NTA layer. */
export const PLACE_SUGGESTIONS_SOURCE = Object.freeze({
  activity: LOCAL_ESCAPE_SOURCE,
  layer: Object.freeze({
    path: "site/data/geography/layers/nta2020/26B.json",
    revision: LOCAL_ESCAPE_SOURCE.revision,
    blob: "d1adafa84a543842ec28d8c79f3c96afa33b86c0",
  }),
});
export const SHEEPSHEAD_BAY = "geography:nta2020:BK1503";
export const MOTT_HAVEN = "geography:nta2020:BX0101";
export const DYKER_BEACH_PARK = "geography:nta2020:BK1091";
export const TRIBECA = "geography:nta2020:MN0102";
export const HELLS_KITCHEN = "geography:nta2020:MN0402";
export const FINANCIAL_DISTRICT = "geography:nta2020:MN0101";
/** Published limits kept beside the positive population. */
export const PLACE_SUGGESTION_CONTROL_KEYS = Object.freeze([SHEEPSHEAD_BAY, MOTT_HAVEN]);
export const PLACE_SUGGESTION_LENSES = Object.freeze(["meetings", "land"]);
const RECORD_FIELDS = Object.freeze(["id", "title", "agency", "type", "date", "status", "basis", "basis_method", "route"]);
const LAYER_FIELDS = Object.freeze(["key", "type", "id", "label", "subtype"]);

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => source && key in source).map((key) => [key, source[key]]));
}

/** Every neighborhood with a nonempty published Meetings list, plus the controls. */
export function placeSuggestionKeys(full) {
  const byKey = full.geography_items.by_key;
  const positive = Object.keys(byKey).filter((key) => key.startsWith("geography:nta2020:")
    && Array.isArray(byKey[key]?.meetings) && byKey[key].meetings.length > 0);
  return [...new Set([...positive, ...PLACE_SUGGESTION_CONTROL_KEYS])].sort();
}

function reduceRecord(record, keys) {
  const out = pick(record, RECORD_FIELDS);
  const geographies = record?.place?.geographies;
  if (Array.isArray(geographies)) {
    out.place = { geographies: geographies.filter((row) => keys.includes(row?.key)) };
  }
  return out;
}

/** Reduce the full published activity to the rows these tests read. */
export function reducePlaceSuggestionActivity(full) {
  const geography = full.geography_items;
  const keys = placeSuggestionKeys(full);
  const byKey = Object.fromEntries(keys.map((key) => [key, pick(geography.by_key[key], PLACE_SUGGESTION_LENSES)]));
  const idsFor = (lens) => [...new Set(Object.values(byKey)
    .flatMap((row) => (Array.isArray(row?.[lens]) ? row[lens] : []))
    .map(String))].sort();
  const retained = Object.fromEntries(PLACE_SUGGESTION_LENSES.map((lens) => [lens, new Set(idsFor(lens))]));
  const boroughs = Object.fromEntries(Object.entries(full.district_items.by_level.borough).map(([name, row]) => [
    name,
    Object.fromEntries(PLACE_SUGGESTION_LENSES.map((lens) => [
      lens,
      (row?.[lens] || []).filter((id) => retained[lens].has(String(id))),
    ])),
  ]));
  return {
    schema: full.schema,
    boundary_vintage: full.boundary_vintage,
    built_at: full.built_at,
    lenses: full.lenses,
    district_items: {
      ...pick(full.district_items, ["schema", "boundary_vintage", "built_at", "lenses"]),
      by_level: { borough: boroughs, community_district: {}, council_district: {} },
      citywide: {},
      virtual: {},
      unlocated: {},
    },
    geography_items: {
      ...pick(geography, ["schema", "built_at", "lenses", "public_types", "coverage"]),
      definitions: pick(geography.definitions, keys),
      by_key: byKey,
    },
    records: Object.fromEntries(PLACE_SUGGESTION_LENSES.map((lens) => [
      lens,
      Object.fromEntries(Object.entries(pick(full.records[lens], idsFor(lens)))
        .map(([id, record]) => [id, reduceRecord(record, keys)])),
    ])),
  };
}

/** The layer's directory fields for the retained keys, in published order. */
export function reducePlaceSuggestionLayer(layer, keys) {
  return {
    ...pick(layer, ["schema", "type", "class", "vintage"]),
    features: layer.features.filter((feature) => keys.includes(feature.key))
      .map((feature) => pick(feature, LAYER_FIELDS)),
  };
}

export function readPlaceSuggestionsFixture() {
  return JSON.parse(readFileSync(PLACE_SUGGESTIONS_FIXTURE_PATH, "utf8"));
}

/** The pinned NTA layer, or null when this checkout lacks that object. */
export function readPinnedNtaLayer(cwd = fileURLToPath(new URL("../..", import.meta.url))) {
  try {
    execFileSync("git", ["cat-file", "-e", PLACE_SUGGESTIONS_SOURCE.layer.blob], { cwd, stdio: "ignore" });
  } catch {
    return null;
  }
  const bytes = execFileSync("git", ["cat-file", "blob", PLACE_SUGGESTIONS_SOURCE.layer.blob], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(bytes.toString("utf8"));
}

export { readPinnedDistrictActivity };
