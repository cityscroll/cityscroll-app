// Compact frozen district-activity fixture for the Near You local recovery tests.
//
// The fixture is a reduction of site/data/district_activity.json at a pinned
// repository revision. `reduceDistrictActivity` is the only way the committed
// fixture is produced, so a test can re-derive it from the pinned blob and prove
// the retained rows are exactly the published ones.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LOCAL_ESCAPE_FIXTURE_PATH = fileURLToPath(
  new URL("../fixtures/near_you_local_escape/district_activity.reduced.json", import.meta.url),
);
export const LOCAL_ESCAPE_SOURCE = Object.freeze({
  path: "site/data/district_activity.json",
  revision: "d886b385d647f4534df985f5922749a9414fab26",
  blob: "5deaa202fe578e09b58380d43755419dbb85ec60",
});

/** Neighborhoods whose published state each test exercises. */
export const LOCAL_ESCAPE_KEYS = Object.freeze([
  "geography:nta2020:BK1503",
  "geography:nta2020:MN0102",
  "geography:nta2020:BX0101",
]);
/** Community districts overlapping Kensington (BK1203), kept for wider-district previews. */
export const LOCAL_ESCAPE_DISTRICTS = Object.freeze(["K12", "K14"]);

function pick(source, keys) {
  return Object.fromEntries(keys.filter((key) => source && key in source).map((key) => [key, source[key]]));
}

/** Reduce the full published activity to the rows these tests read. */
export function reduceDistrictActivity(full) {
  const geography = full.geography_items;
  const byKey = pick(geography.by_key, LOCAL_ESCAPE_KEYS);
  const districts = pick(full.district_items.by_level.community_district, LOCAL_ESCAPE_DISTRICTS);
  const idsFor = (lens) => [...new Set([
    ...Object.values(byKey).flatMap((row) => row?.[lens] || []),
    ...Object.values(districts).flatMap((row) => row?.[lens] || []),
  ].map(String))].sort();
  // Meetings is the lens under test; Sheepshead Bay's one Land project proves
  // that other-lens membership never becomes Meetings membership.
  const records = {
    meetings: pick(full.records.meetings, idsFor("meetings")),
    land: pick(full.records.land, byKey["geography:nta2020:BK1503"]?.land || []),
  };
  return {
    schema: full.schema,
    boundary_vintage: full.boundary_vintage,
    built_at: full.built_at,
    lenses: full.lenses,
    district_items: {
      ...pick(full.district_items, ["schema", "boundary_vintage", "built_at", "lenses"]),
      by_level: { borough: {}, community_district: districts, council_district: {} },
      citywide: {},
      virtual: {},
      unlocated: {},
    },
    geography_items: {
      ...pick(geography, ["schema", "built_at", "lenses", "public_types", "coverage"]),
      definitions: pick(geography.definitions, LOCAL_ESCAPE_KEYS),
      by_key: byKey,
    },
    records,
  };
}

export function readLocalEscapeFixture() {
  return JSON.parse(readFileSync(LOCAL_ESCAPE_FIXTURE_PATH, "utf8"));
}

/** The pinned full snapshot, or null when this checkout lacks that history. */
export function readPinnedDistrictActivity(cwd = fileURLToPath(new URL("../..", import.meta.url))) {
  try {
    execFileSync("git", ["cat-file", "-e", LOCAL_ESCAPE_SOURCE.blob], { cwd, stdio: "ignore" });
  } catch {
    return null;
  }
  const bytes = execFileSync("git", ["cat-file", "blob", LOCAL_ESCAPE_SOURCE.blob], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(bytes.toString("utf8"));
}
