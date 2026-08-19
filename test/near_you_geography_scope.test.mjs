import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildNearYouViewModel,
  renderNearYouBody,
} from "../site/near_you_view.mjs";
import {
  scopeFromRouteHash,
  scopeWithGeographies,
} from "../site/scope_v0.mjs";

const ROOT = new URL("../", import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, ROOT), "utf8"));
const activity = readJson("site/data/district_activity.json");
const boundaries = readJson("site/data/district_boundaries.json");

function populatedKey(type, lens) {
  return Object.values(activity.geography_items.definitions)
    .find((definition) => definition.type === type
      && activity.geography_items.by_key[definition.key]?.[lens]?.length)?.key;
}

test("all five Near You lenses carry role- and provenance-preserving generic geography matches", () => {
  assert.deepEqual(activity.geography_items.public_types, [
    "borough",
    "community_district",
    "council_district",
    "nta2020",
    "police_precinct",
  ]);
  assert.ok(!activity.geography_items.public_types.includes("sanitation_district"));
  assert.ok(!activity.geography_items.public_types.includes("business_improvement_district"));

  for (const lens of ["land", "property", "rules", "meetings", "money"]) {
    const records = Object.values(activity.records[lens]);
    assert.ok(records.length > 0, lens);
    assert.ok(records.every((record) => record.place), `${lens}: missing place envelope`);
    assert.ok(records.some((record) => record.place.geographies.length), `${lens}: no geography matches`);
    for (const match of records.flatMap((record) => record.place.geographies)) {
      assert.ok(match.key.startsWith("geography:"), `${lens}:${match.key}`);
      assert.equal(match.relation, "located_in");
      assert.ok(match.location_role, `${lens}:${match.key}:role`);
      assert.ok(match.basis, `${lens}:${match.key}:basis`);
      assert.ok(match.method, `${lens}:${match.key}:method`);
      assert.ok(match.source_id, `${lens}:${match.key}:source`);
      assert.ok(match.boundary_vintage, `${lens}:${match.key}:vintage`);
    }
  }
});

test("NTA and Police Precinct scopes drive the same Near You membership index and explanation evidence", () => {
  for (const type of ["nta2020", "police_precinct"]) {
    const key = populatedKey(type, "property");
    assert.ok(key, type);
    const scope = scopeWithGeographies(scopeFromRouteHash("#property"), [key]);
    const view = buildNearYouViewModel(scope, activity, boundaries);
    const indexed = activity.geography_items.by_key[key].property;

    assert.deepEqual(view.results.ids, indexed);
    assert.equal(view.results.count, indexed.length);
    assert.ok(view.results.records.every((record) => record.geography_evidence?.key === key));
    assert.ok(view.geographyOptions.some((option) => option.key === key));

    const html = renderNearYouBody(view);
    assert.match(html, new RegExp(`data-geography-key="${key}"`));
    assert.match(html, /data-geography-evidence="1"/);
    assert.match(html, /Why this place matched/);
    assert.match(html, new RegExp(`<option value="${key}" selected>`));
  }
});
