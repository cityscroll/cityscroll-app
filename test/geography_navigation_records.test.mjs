import assert from "node:assert/strict";
import { test as runTest } from "node:test";

import {
  GEOGRAPHY_RECORD_LENSES,
  geographyRecordLenses,
  geographyRecordProjection,
  recordIdsForScope,
  scopeWithCanonicalGeography,
} from "../site/geography_navigation_records.mjs";
import {
  bindGeographyNavigationPopState,
  parseGeographyNavigationState,
  writeGeographyNavigationHistory,
} from "../site/geography_navigation_state.mjs";
import { classifyLocationEvidence } from "../site/location_evidence_tier.mjs";
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
import { testClockISOString, withPinnedClock } from "./helpers/test_clock.mjs";

// Record dates and the legacy view clock share one deterministic instant.
function test(name, body) {
  return runTest(name, () => withPinnedClock("2026-09-22T00:00:00.000Z", body));
}

const KEYS = Object.freeze({
  nta: "geography:nta2020:BK1503",
  community: "geography:community_district:K15",
  council: "geography:council_district:48",
  precinct: "geography:police_precinct:61",
});

test("unresolved place text never falls through to citywide membership", () => {
  const activity = { district_items: { by_level: { borough: { Manhattan: { meetings:["unrelated"] } } } } };
  const result = recordIdsForScope(activity, "meetings", {place:{neighborhood:"Unknown neighborhood"}});
  assert.equal(result.exact, false);
  assert.equal(result.count, null);
  assert.deepEqual(result.ids, []);
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
    date: testClockISOString(),
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
    built_at: testClockISOString(),
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

function navigationSession() {
  const entries = [{ url: "/near-you/", state: null }];
  let index = 0;
  const location = {
    pathname: "/near-you/",
    search: "",
    href: "https://cityscroll.invalid/near-you/",
  };
  const listeners = new Map();
  const syncLocation = (url) => {
    const next = new URL(url, location.href);
    location.pathname = next.pathname;
    location.search = next.search;
    location.href = next.toString();
  };
  const target = {
    location,
    addEventListener(type, handler) {
      listeners.set(type, [...(listeners.get(type) || []), handler]);
    },
    removeEventListener(type, handler) {
      listeners.set(type, (listeners.get(type) || []).filter((entry) => entry !== handler));
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) handler(event);
    },
  };
  const history = {
    get state() {
      return entries[index].state;
    },
    pushState(state, _title, url) {
      entries.splice(index + 1);
      entries.push({ state, url: String(url) });
      index = entries.length - 1;
      syncLocation(url);
    },
    replaceState(state, _title, url) {
      entries[index] = { state, url: String(url) };
      syncLocation(url);
    },
    back() {
      if (index === 0) return;
      index -= 1;
      syncLocation(entries[index].url);
      target.dispatchEvent({ type: "popstate", state: entries[index].state });
    },
  };
  target.history = history;
  return { history, location, target };
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

test("A2: the full count remains aligned with a paginated records surface and its more link", () => {
  const ids = Array.from({ length: 31 }, (_value, index) => `meeting-${index + 1}`);
  const base = activity();
  const source = activity({
    records: {
      ...base.records,
      meetings: Object.fromEntries(ids.map((id) => [id, record(id)])),
    },
    geography_items: {
      by_key: {
        [KEYS.nta]: { ...LENS_IDS, meetings: ids },
      },
    },
  });
  const projection = geographyRecordProjection(source, { key: KEYS.nta, lens: "meetings" });
  const view = buildNearYouViewModel(scopeFor(KEYS.nta, "meetings"), source, emptyBoundaries);
  const html = renderNearYouDeferredParts(view).resultsHtml;
  const orderedIds = [...ids].sort();

  assert.deepEqual(projection.ids, ids, "A2 projection proves the destination list contains every unique ID");
  assert.deepEqual(view.results.ids, orderedIds, "A2 view model proves the full list, not only the first page");
  assert.equal(view.results.count, ids.length, "A2 view model count proves the full list size");
  assert.match(html, new RegExp(`data-results-count="${ids.length}"`), "A2 markup proves the full count");
  assert.equal((html.match(/data-record-id=/g) || []).length, 30, "A2 markup proves the first page is bounded");
  assert.match(html, new RegExp(`Open all ${ids.length} matching records`), "A2 markup proves the more link uses the same count");
});

test("A9: Back from the records surface restores geography, comparison, surface, lens, drawer, and focus", () => {
  const session = navigationSession();
  const mapState = parseGeographyNavigationState({
    geo: "nta2020:BK1503",
    compare: "council_district",
    surface: "map",
    drawer: "open",
    focus: "feature:nta2020:BK1503",
    lens: "meetings",
  });
  writeGeographyNavigationHistory(session.history, session.location, mapState, { mode: "replace" });
  const recordsState = parseGeographyNavigationState({
    ...mapState,
    surface: "records",
    drawer: "closed",
    focus: "record-list:meeting-1",
  });
  writeGeographyNavigationHistory(session.history, session.location, recordsState, { mode: "push" });

  let restored = null;
  const stop = bindGeographyNavigationPopState(session.target, (state) => { restored = state; });
  session.history.back();
  stop();

  assert.deepEqual({
    geo: restored?.geo,
    compare: restored?.compare,
    surface: restored?.surface,
    lens: restored?.lens,
    drawer: restored?.drawer,
    focus: restored?.focus,
  }, {
    geo: "nta2020:BK1503",
    compare: "council_district",
    surface: "map",
    lens: "meetings",
    drawer: "open",
    focus: "feature:nta2020:BK1503",
  }, "A9 history proves Back from a record list restores all six named context fields");
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

test("A10: record inspection exercises strong, derived, and weak evidence tiers", () => {
  const fixtures = [
    ["strong", { method: "coordinates_pip", confidence: 0.95 }],
    ["derived", { method: "matter_title_place", confidence: 0.6 }],
    ["weak", { method: "agency_hq", confidence: 0.2 }],
  ];
  for (const [expectedTier, rawEvidence] of fixtures) {
    const tier = classifyLocationEvidence(rawEvidence);
    assert.equal(tier, expectedTier, `A10 classifier fixture proves the ${expectedTier} tier`);
    const facts = nearYouRecordInspectionFacts({
      ...record(`tier-${expectedTier}`),
      geography_evidence: {
        key: KEYS.nta,
        label: "Sheepshead Bay",
        location_role: "venue",
        basis: "Meeting venue",
        tier,
        source_id: `tier-${expectedTier}`,
        boundary_vintage: "26B",
      },
    });
    const html = renderNearYouRecordInspectionBody(facts);
    assert.equal(facts.geography.tier, expectedTier, `A10 inspection facts preserve the ${expectedTier} tier`);
    if (expectedTier === "weak") {
      assert.match(html, /Place match is approximate/, "A10 weak evidence is visibly qualified");
    } else {
      assert.doesNotMatch(html, /Place match is approximate/, `A10 ${expectedTier} evidence is not mislabeled approximate`);
    }
  }
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

const FIVE_BOROUGH = Object.freeze({
  MN0102: "geography:nta2020:MN0102",
  BK0101: "geography:nta2020:BK0101",
  QN0103: "geography:nta2020:QN0103",
  BX0101: "geography:nta2020:BX0101",
  SI0101: "geography:nta2020:SI0101",
});

function fiveBoroughActivity() {
  const readyId = "tribeca-meeting-1";
  const broaderId = "district-meeting-broader";
  const definitions = Object.fromEntries(Object.entries(FIVE_BOROUGH).map(([id, key]) => [key, {
    key,
    type: "nta2020",
    id,
    label: id,
    class: "statistical",
    subtype: "residential",
    source_id: "dcp-nta2020-boundaries",
    boundary_vintage: "2026-05-26",
  }]));
  return {
    schema: "cityscroll.district_activity.v1",
    built_at: testClockISOString(),
    boundary_vintage: "2026-05-26",
    lenses: [...GEOGRAPHY_RECORD_LENSES],
    records: {
      meetings: {
        [readyId]: {
          id: readyId,
          title: "Tribeca hearing",
          route: `/records/${readyId}`,
          date: testClockISOString(),
          basis: "Venue / logistics",
          source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/tribeca-meeting-1",
          meeting_origin: "city_record_notice",
          place: {
            geographies: [{
              key: FIVE_BOROUGH.MN0102,
              type: "nta2020",
              id: "MN0102",
              label: "Tribeca-Civic Center",
              location_role: "venue",
              basis: "Venue / logistics",
              confidence: "strong",
              method: "venue_line",
              source_id: "dcp-nta2020-boundaries",
              boundary_vintage: "2026-05-26",
              visibility: "public",
            }],
          },
        },
        [broaderId]: {
          id: broaderId,
          title: "Community district hearing",
          route: `/records/${broaderId}`,
          date: testClockISOString(),
          basis: "Community board district",
          source_url: "https://example.invalid/broader",
        },
      },
    },
    district_items: {
      by_level: {
        borough: {},
        community_district: { M01: { meetings: [broaderId] } },
        council_district: {},
      },
      citywide: {},
      virtual: {},
      unlocated: {},
    },
    by_level: { borough: {}, community_district: {}, council_district: {} },
    geography_items: {
      schema: "cityscroll.geography_items.v1",
      definitions,
      by_key: {
        [FIVE_BOROUGH.MN0102]: { meetings: [readyId], land: [], property: [], rules: [], money: [] },
        [FIVE_BOROUGH.BX0101]: { meetings: [], land: [], property: [], rules: [], money: [] },
        // BK0101 / QN0103 / SI0101 intentionally omitted → unavailable
      },
      coverage: { status: "ready" },
    },
  };
}

test("A1: five-borough neighborhood records expose place basis and source detail", () => {
  const source = fiveBoroughActivity();
  const expectations = [
    [FIVE_BOROUGH.MN0102, "ready"],
    [FIVE_BOROUGH.BK0101, "unavailable"],
    [FIVE_BOROUGH.QN0103, "unavailable"],
    [FIVE_BOROUGH.BX0101, "zero"],
    [FIVE_BOROUGH.SI0101, "unavailable"],
  ];
  for (const [key, state] of expectations) {
    const projection = geographyRecordProjection(source, { key, lens: "meetings" });
    assert.equal(projection.state, state, `${key} projection state`);
    assert.equal(projection.exact, state === "ready" || state === "zero", `${key} exact membership`);
  }

  const ready = buildNearYouViewModel(scopeFor(FIVE_BOROUGH.MN0102, "meetings"), source, emptyBoundaries);
  assert.equal(ready.results.count, 1);
  assert.equal(ready.results.records[0].basis, "Venue / logistics");
  assert.equal(ready.results.records[0].source_url, "https://a856-cityrecord.nyc.gov/RequestDetail/tribeca-meeting-1");
  const facts = nearYouRecordInspectionFacts(ready.results.records[0]);
  assert.equal(facts.basis, "Venue / logistics");
  assert.equal(facts.geography.source_id, "dcp-nta2020-boundaries");
  assert.equal(facts.source_url, "https://a856-cityrecord.nyc.gov/RequestDetail/tribeca-meeting-1");
  const html = renderNearYouRecordInspectionBody(facts);
  assert.match(html, /Place claim/);
  assert.match(html, /Venue \/ logistics/);
  assert.match(html, /Source/);
  assert.match(html, /Official source|a856-cityrecord/);

  const zero = buildNearYouViewModel(scopeFor(FIVE_BOROUGH.BX0101, "meetings"), source, emptyBoundaries);
  assert.equal(zero.results.count, 0);
  assert.doesNotMatch(renderNearYouDeferredParts(zero).resultsHtml, /Community district hearing/);
});

test("A1: broader district suggestions are labeled broader and stay outside exact neighborhood counts", () => {
  const source = fiveBoroughActivity();
  const exact = geographyRecordProjection(source, { key: FIVE_BOROUGH.MN0102, lens: "meetings" });
  assert.deepEqual(exact.ids, ["tribeca-meeting-1"]);
  assert.equal(exact.count, 1);
  assert.equal(exact.ids.includes("district-meeting-broader"), false);

  const model = buildSelectedGeographyOverlapViewModel({
    selected: {
      type: "nta2020",
      id: "MN0102",
      key: FIVE_BOROUGH.MN0102,
      label: "Tribeca-Civic Center",
      selection_noun: "neighborhood",
      type_explanation: "A residential neighborhood tabulation area.",
      boundary_vintage: "2026-05-26",
    },
    recordLenses: { meetings: exact },
    relatedDistricts: [{
      key: "geography:community_district:M01",
      id: "M01",
      label: "Manhattan Community District 1",
      href: "/near-you/?geo=community_district%3AM01&surface=records",
    }],
  });
  assert.equal(model.related_districts.length, 1);
  assert.equal(model.related_districts[0].scope, "broader");
  assert.equal(model.related_districts[0].count, null);
  assert.equal(model.record_lenses[0].count, 1);
  const html = renderSelectedGeographyOverlapDrawerHtml(model);
  assert.match(html, /data-geography-broader-suggestions/);
  assert.match(html, /data-geography-related-scope="broader"/);
  assert.match(html, /class="near-geo-broader-label">broader</);
  assert.match(html, /not counted as exact neighborhood records/);
  assert.doesNotMatch(html, /data-geography-record-lens="meetings"[^>]*>[\s\S]*broader/);
  // Empty-case smoke reads href from [data-geography-related-district] itself.
  assert.match(
    html,
    /<a[^>]*data-geography-related-district[^>]*href="\/near-you\/\?geo=community_district%3AM01&amp;surface=records"/,
  );
  assert.doesNotMatch(html, /<li[^>]*data-geography-related-district[^>]*>/);
});
