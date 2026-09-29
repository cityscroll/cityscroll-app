// Compact frozen district-activity fixture for the Near You section isolation tests.
//
// The fixture is a reduction of site/data/district_activity.json at a pinned
// repository revision: Midwood's two venue meetings, Sheepshead Bay's published
// shape (no Meetings list) and the complete citywide, virtual and unlocated
// Meetings buckets with their record bodies. `reduceSectionIsolationActivity`
// is the only way the committed fixture is produced, so a test can re-derive it
// from the pinned blob and prove the retained rows are exactly the published ones.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LOCAL_ESCAPE_SOURCE, readPinnedDistrictActivity } from "./near_you_local_escape_fixture.mjs";

export const SECTION_ISOLATION_FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/near_you_section_isolation/district_activity.reduced.json", import.meta.url),
);
/** Same pinned snapshot as the local recovery fixture. */
export const SECTION_ISOLATION_SOURCE = LOCAL_ESCAPE_SOURCE;
export const MIDWOOD = "geography:nta2020:BK1403";
export const SHEEPSHEAD_BAY = "geography:nta2020:BK1503";
export const SECTION_ISOLATION_KEYS = Object.freeze([MIDWOOD, SHEEPSHEAD_BAY]);
export const SPECIAL_BUCKETS = Object.freeze(["citywide", "virtual", "unlocated"]);
const LENS = "meetings";

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => source && key in source).map((key) => [key, source[key]]));
}

/** Reduce the full published activity to the Meetings rows these tests read. */
export function reduceSectionIsolationActivity(full) {
  const geography = full.geography_items;
  const byKey = pick(geography.by_key, SECTION_ISOLATION_KEYS);
  const buckets = Object.fromEntries(SPECIAL_BUCKETS.map((bucket) => [
    bucket,
    { [LENS]: full.district_items[bucket][LENS] },
  ]));
  const ids = [...new Set([
    ...Object.values(byKey).flatMap((row) => (Array.isArray(row?.[LENS]) ? row[LENS] : [])),
    ...Object.values(buckets).flatMap((row) => row[LENS]),
  ].map(String))].sort();
  return {
    schema: full.schema,
    boundary_vintage: full.boundary_vintage,
    built_at: full.built_at,
    lenses: full.lenses,
    district_items: {
      ...pick(full.district_items, ["schema", "boundary_vintage", "built_at", "lenses"]),
      by_level: { borough: {}, community_district: {}, council_district: {} },
      ...buckets,
    },
    geography_items: {
      ...pick(geography, ["schema", "built_at", "lenses", "public_types", "coverage"]),
      definitions: pick(geography.definitions, SECTION_ISOLATION_KEYS),
      by_key: byKey,
    },
    records: { [LENS]: pick(full.records[LENS], ids) },
  };
}

export function readSectionIsolationFixture() {
  return JSON.parse(readFileSync(SECTION_ISOLATION_FIXTURE_PATH, "utf8"));
}

export { readPinnedDistrictActivity };

/**
 * An in-memory KV over materialized slices with per-key fault controls:
 * "reject" (the read throws), "timeout" (the read never settles), "corrupt"
 * (malformed JSON), "missing" (no value), "no-records" (valid JSON without
 * records) and { failTimes: n } (rejects n reads, then succeeds). Every read is
 * counted per key so a test can prove no read was repeated or added.
 */
export function faultKv(values, controls = new Map()) {
  const reads = new Map();
  const failures = new Map();
  return {
    reads,
    readCount: () => [...reads.values()].reduce((sum, count) => sum + count, 0),
    async get(key) {
      reads.set(key, (reads.get(key) || 0) + 1);
      const control = controls.get(key);
      if (control === "reject") throw new Error("injected KV rejection");
      if (control === "timeout") return new Promise(() => {});
      if (control === "corrupt") return "{not-json";
      if (control === "missing") return null;
      if (control === "no-records") return JSON.stringify({ schema_version: 1, activity: { schema: "partial" } });
      if (control?.failTimes) {
        const failed = failures.get(key) || 0;
        if (failed < control.failTimes) {
          failures.set(key, failed + 1);
          throw new Error("injected transient KV rejection");
        }
      }
      return values.get(key) ?? null;
    },
  };
}
