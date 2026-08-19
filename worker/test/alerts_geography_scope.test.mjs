import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { compileSub } from "../src/lib/compile.mjs";
import { sanitize } from "../src/lib/filter.mjs";

const ROOT = new URL("../../", import.meta.url);
const activity = JSON.parse(readFileSync(new URL("site/data/district_activity.json", ROOT), "utf8"));

function populatedKey(type, lens) {
  return Object.values(activity.geography_items.definitions)
    .find((definition) => definition.type === type
      && activity.geography_items.by_key[definition.key]?.[lens]?.length)?.key;
}

test("geography watches replay the exact materialized Near You membership", () => {
  const key = populatedKey("police_precinct", "property");
  const filter = sanitize("property", {
    geographies: [key, "geography:sanitation_district:404"],
  });
  assert.deepEqual(filter.geographies, [key]);

  const query = compileSub({ lens: "property", filter }, "2026-08-19");
  assert.equal(query.url, "https://cityscroll.org/data/district_activity.json");
  assert.equal(query.idField, "geography_item_id");
  assert.equal(query.kind, "property");

  const rows = query.transformRows(activity);
  assert.deepEqual(
    rows.map((row) => row.id),
    activity.geography_items.by_key[key].property,
  );
  assert.ok(rows.every((row) => row.geography_item_id === `property:${row.id}`));
  assert.ok(rows.every((row) => row.place.geographies.some((match) =>
    match.key === key && match.visibility === "public")));
});

test("the D1 notice mirror is bypassed for materialized geography watches", () => {
  const source = readFileSync(new URL("worker/src/alerts.mjs", ROOT), "utf8");
  assert.equal(
    (source.match(/!s\.filter\?\.geographies\?\.length/g) || []).length,
    3,
    "single, rollup, and queued alert evaluators must all use the geography artifact",
  );
});
