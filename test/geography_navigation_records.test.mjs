import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GEOGRAPHY_RECORD_LENSES,
  geographyRecordLenses,
  geographyRecordProjection,
  recordIdsForScope,
  scopeWithCanonicalGeography,
} from "../site/geography_navigation_records.mjs";
import {
  buildSelectedGeographyOverlapViewModel,
  renderSelectedGeographyOverlapDrawerHtml,
} from "../site/geography_navigation_overlap_ui.mjs";
import {
  buildNearYouViewModel,
  renderNearYouDeferredParts,
} from "../site/near_you_view.mjs";
import { nearYouRecordInspectionFacts, renderNearYouRecordInspectionBody } from "../site/near_you_record_inspection.mjs";
import { scopeFromLensState, scopeWithGeographies } from "../site/scope_v0.mjs";

const KEYS = Object.freeze({
  nta: "geography:nta2020:BK1503",
  community: "geography:community_district:K15",
  council: "geography:council_district:48",
  precinct: "geography:police_precinct:61",
});

const LENS_IDS = Object.freeze({
  land: ["land-1", "land-1"],
  property: ["property-1"],
  rules: [],
  meetings: ["meeting-1"],
  money: ["money-1"],
});

function record(id, geography = {}) {
  return {
    id,
    title: id,
    route: `/records/${id}`,
    date: "2026-09-01T00:00:00.000Z",
    place: { geographies: Object.values(geography) },
    geography_evidence: null,
  };
}

function activity(overrides = {}) {
  const records = Object.fromEntries(GEOGRAPHY_RECORD_LENSES.map((lens) => [
    lens,
    Object.fromEntries([...new Set(LENS_IDS[lens])].map((id) => [id, record(id)])),
  ]));
  const byKey = Object.fromEntries(Object.values(KEYS).map((key) => [key, { ...LENS_IDS }]));
  const baseGeographyItems = {
    schema: "cityscroll.geography_items.v1",
    definitions: Object.fromEntries(Object.entries(KEYS).map(([type, key]) => [key, {
      key,
      type: type === "nta" ? "nta2020" : type === "community" ? "community_district" : type === "council" ? "council_district" : "police_precinct",
      id: key.split(":").at(-1),
      label: type,
      boundary_vintage: "2026-05-26",
    }])),
    by_key: byKey,
  };
  const geographyOverrides = overrides.geography_items || {};
  const { geography_items: _ignoredGeographyItems, ...activityOverrides } = overrides;
  return {
    schema: "cityscroll.district_activity.v1",
    built_at: "2026-09-10T00:00:00.000Z",
    boundary_vintage: "2026-05-26",
    lenses: [...GEOGRAPHY_RECORD_LENSES],
    records,
    district_items: {
      by_level: { borough: {}, community_district: {}, council_district: {} },
      citywide: {},
      virtual: {},
      unlocated: {},
    },
    by_level: { borough: {}, community_district: {}, council_district: {} },
    geography_items: {
      ...baseGeographyItems,
      ...geographyOverrides,
      by_key: { ...baseGeographyItems.by_key, ...geographyOverrides.by_key },
    },
    ...activityOverrides,
  };
}

function scopeFor(key, lens = "meetings") {
  return scopeWithGeographies(scopeFromLensState(lens), [key]);
}

const emptyBoundaries = {
  schema: "cityscroll.district_boundaries.v1",
  boundary_vintage: "2026-05-26",
  community_districts: [],
  council_districts: [],
};

test("all four public geography layers use the exact generic index for every lens", () => {
  const source = activity();
  for (const key of Object.values(KEYS)) {
    for (const lens of GEOGRAPHY_RECORD_LENSES) {
      const projection = geographyRecordProjection(source, { key, lens });
      assert.equal(projection.exact, true, `${key}:${lens}`);
      assert.deepEqual(projection.ids, [...new Set(LENS_IDS[lens])], `${key}:${lens}`);
      const view = buildNearYouViewModel(scopeFor(key, lens), source, emptyBoundaries);
      assert.equal(view.results.count, projection.count, `${key}:${lens} count`);
      assert.deepEqual(view.results.ids, projection.ids, `${key}:${lens} IDs`);
      assert.match(renderNearYouDeferredParts(view).resultsHtml, new RegExp(`data-results-count="${projection.count}"`));
    }
  }
});

test("legacy community and Council selections acquire the same canonical key and exact destination", () => {
  const source = activity();
  for (const [place, key] of [
    [{ communityDistrict: "K15" }, KEYS.community],
    [{ councilDistrict: "48" }, KEYS.council],
  ]) {
    const scope = scopeWithCanonicalGeography(scopeFromLensState("meetings", place));
    assert.deepEqual(scope.place.geographies, [key]);
    const projection = recordIdsForScope(source, "meetings", scope);
    assert.deepEqual(projection.ids, ["meeting-1"]);
  }
});

test("duplicate IDs are collapsed, zero is not unknown, and an unfilterable lens emits no local positive link", () => {
  const source = activity({
    geography_items: {
      by_key: {
        [KEYS.nta]: {
          land: ["land-1", "land-1"],
          property: ["property-1"],
          rules: [],
          meetings: ["meeting-1"],
          money: undefined,
        },
      },
    },
  });
  assert.equal(geographyRecordProjection(source, { key: KEYS.nta, lens: "rules" }).state, "zero");
  assert.equal(geographyRecordProjection(source, { key: KEYS.nta, lens: "money" }).state, "incomplete");
  const view = buildNearYouViewModel(scopeFor(KEYS.nta, "money"), source, emptyBoundaries);
  assert.equal(view.results.count, null);
  const html = renderNearYouDeferredParts(view).resultsHtml;
  assert.match(html, /exact area yet|materialized records are incomplete/);
  assert.doesNotMatch(html, /Open all .*matching records/);
  assert.doesNotMatch(html, /citywide/);
});

test("missing data states stay distinct from an honest zero", () => {
  const zero = buildNearYouViewModel(scopeFor(KEYS.nta, "rules"), activity(), emptyBoundaries);
  assert.equal(zero.results.count, 0);
  assert.match(renderNearYouDeferredParts(zero).resultsHtml, /data-results-count="0"/);

  const unavailable = buildNearYouViewModel(scopeFor(KEYS.nta, "meetings"), null, emptyBoundaries);
  assert.equal(unavailable.dataState, "error");
  assert.equal(unavailable.results.count, null);
  assert.match(renderNearYouDeferredParts(unavailable).resultsHtml, /not available right now/);

  const incomplete = buildNearYouViewModel(scopeFor(KEYS.nta, "meetings"), activity({
    geography_items: { coverage: { status: "incomplete" } },
  }), emptyBoundaries);
  assert.equal(incomplete.results.count, null);
  assert.match(renderNearYouDeferredParts(incomplete).resultsHtml, /materialized records are incomplete/);
});

test("record inspection preserves the selected key, role, evidence tier, source, and vintage", () => {
  const evidence = {
    key: KEYS.nta,
    label: "Sheepshead Bay",
    location_role: "subject_affected_area",
    basis: "Affected area",
    tier: "derived",
    source_id: "nta-26B",
    method: "matter_title_place",
    boundary_vintage: "26B",
  };
  const facts = nearYouRecordInspectionFacts({
    id: "meeting-1",
    title: "Meeting",
    route: "/records/meeting-1",
    geography_evidence: evidence,
  });
  assert.equal(facts.geography.key, KEYS.nta);
  assert.equal(facts.geography.source_id, "nta-26B");
  assert.equal(facts.geography.resident_label, "About or affecting this area");
  const html = renderNearYouRecordInspectionBody(facts);
  assert.match(html, /About or affecting this area/);
  assert.match(html, /Geography key/);
  assert.match(html, /Source nta-26B/);
  assert.match(html, /Publisher boundary 26B/);
});

test("selected record lenses expose named, ordered, touch-sized links", () => {
  const model = buildSelectedGeographyOverlapViewModel({
    selected: {
      type: "community_district",
      id: "K15",
      key: KEYS.community,
      label: "Brooklyn Community District 15",
      selection_noun: "community district",
      type_explanation: "A local community district.",
    },
    recordLenses: {
      meetings: { exact: true, count: 2 },
      land: { exact: true, count: 0 },
    },
  });
  const html = renderSelectedGeographyOverlapDrawerHtml(model);
  assert.match(html, /aria-labelledby="near-geo-record-lenses-heading"/);
  assert.match(html, /aria-label="Available record lenses"/);
  assert.match(html, /aria-label="Meetings: 2 records in this community district"/);
  assert.match(html, /aria-label="Zoning: 0 records in this community district"/);
  assert.match(html, /class="near-geo-record-lens-count" aria-hidden="true">2<\/span>/);
  assert.doesNotMatch(html, /data-geography-record-lens="meetings"[^>]*tabindex/);
  assert.ok(html.indexOf('data-geography-record-lens="meetings"') < html.indexOf('data-geography-record-lens="land"'));
});
