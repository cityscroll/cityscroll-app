import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildDistrictActivity } from "../tools/lib/district_activity.mjs";
import { buildCommunityDistrictDigests } from "../tools/lib/community_district_digest.mjs";
import {
  GEOGRAPHY_COMMUNITY_DISTRICT_IDS,
  GEOGRAPHY_COUNCIL_DISTRICT_IDS,
} from "../worker/src/lib/subject_registry.mjs";

const boundaries = JSON.parse(
  readFileSync(new URL("../site/data/district_boundaries.json", import.meta.url), "utf8"),
);

test("empty corpora still emit all 59 regular community districts in district_items", () => {
  const activity = buildDistrictActivity({
    boundaries,
    zapRows: [],
    propertyRows: [],
    meetingsRows: [],
    rulesRows: [],
    moneyRows: [],
    contractActionRows: [],
    builtAt: "2026-09-16T00:00:00.000Z",
  });

  const itemIds = Object.keys(activity.district_items.by_level.community_district).sort();
  const countIds = Object.keys(activity.by_level.community_district)
    .filter((id) => GEOGRAPHY_COMMUNITY_DISTRICT_IDS.includes(id))
    .sort();

  assert.deepEqual(itemIds, [...GEOGRAPHY_COMMUNITY_DISTRICT_IDS].sort());
  assert.deepEqual(countIds, [...GEOGRAPHY_COMMUNITY_DISTRICT_IDS].sort());
  assert.equal(itemIds.length, 59);

  for (const id of GEOGRAPHY_COMMUNITY_DISTRICT_IDS) {
    const lenses = activity.district_items.by_level.community_district[id];
    assert.deepEqual(lenses.land, []);
    assert.deepEqual(lenses.meetings, []);
    assert.deepEqual(lenses.property, []);
    assert.deepEqual(lenses.rules, []);
    assert.deepEqual(lenses.money, []);
  }

  assert.equal(
    Object.keys(activity.district_items.by_level.council_district).length,
    GEOGRAPHY_COUNCIL_DISTRICT_IDS.length,
  );

  const digest = buildCommunityDistrictDigests({ activity, builtAt: activity.built_at });
  assert.deepEqual(
    Object.keys(digest.by_community_district).sort(),
    [...GEOGRAPHY_COMMUNITY_DISTRICT_IDS].sort(),
  );
});
