/**
 * Every Land filter reaches both renderers, or this fails.
 *
 *   node --test test/land_filter_parity.test.mjs
 *
 * LM-06 made Map a projection of the filtered rows and LM-07 gave it a selection. Both rest on
 * one premise: List and Map are two renderings of a single canonical query. This suite makes that
 * premise executable across every filter dimension the query actually has, so a later renderer
 * change cannot omit `regulatoryEffect`, normalize a keyword differently, apply a limit after the
 * join, or treat a viewport as membership without a named failure.
 *
 * The equality under test is a set equality with an ordering and an arithmetic:
 *
 *     set(List ids) === set(marker ids) ∪ set(unmapped ids)
 *     total === List length,  mapped + unmapped === total
 *
 * Coverage is table-driven from the live option constants rather than a hand-copied list, so a
 * new facet option that nobody wires into Map fails here the day it is added.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import {
  LAND_DEFAULT_RESULT_LIMIT,
  LAND_FILTER_DIMENSIONS,
  LAND_FILTER_DIMENSIONS_BY_QUERY_KEY,
  LAND_FILTER_PARITY_SCHEMA,
  LAND_HEARING_ROW_SELECTORS,
  buildLandParityReceipt,
  landCanonicalIds,
  landFilterStateFromRouteParams,
  landParityDivergence,
  landParityViolations,
  landSemanticScopeFromState,
  landSnapshotQueryFromState,
} from "../site/land_filter_parity.mjs";
import { buildLandMapModel } from "../site/land_map_model.mjs";
import { nextLandMapSelection } from "../site/land_map_selection.mjs";
import { filterLandSnapshot } from "../site/resident_snapshot_queries.mjs";
import {
  LAND_FAMILY_OPTIONS,
  LAND_FUTURE_ACTION_OPTIONS,
  LAND_STAGE_OPTIONS,
} from "../site/land_status_facets.mjs";
import { LAND_PROCEDURE_OPTIONS } from "../site/land_procedure_facet.mjs";
import { LAND_REGULATORY_EFFECT_OPTIONS } from "../site/land_regulatory_effect.mjs";
import { LAND_VIEWS } from "../site/land_view_state.mjs";
import { routeHashFromScope, scopeFromRouteHash, watchFromScope } from "../site/scope_v0.mjs";
import { buildParityEvidence } from "../tools/land_filter_parity_receipt.mjs";

const landDefault = JSON.parse(
  readFileSync(new URL("../site/data/land_default_ulurp.json", import.meta.url), "utf8"),
);
const pointArtifact = JSON.parse(
  readFileSync(new URL("../site/data/land_project_map_points.json", import.meta.url), "utf8"),
);
const hearings = JSON.parse(
  readFileSync(new URL("../site/data/land_upcoming_hearings.json", import.meta.url), "utf8"),
);
const runtimeSrc = readFileSync(new URL("../site/app/map_runtime.mjs", import.meta.url), "utf8");
const modelSrc = readFileSync(new URL("../site/land_map_model.mjs", import.meta.url), "utf8");
const paritySrc = readFileSync(new URL("../site/land_filter_parity.mjs", import.meta.url), "utf8");

const ACTION_ROWS = Array.isArray(hearings.hearings) ? hearings.hearings : [];
const TODAY = "2026-08-31";

/** The committed baseline this card may not move without proving the source data moved. */
const BASELINE = Object.freeze({ total: 40, mapped: 33, unmapped: 7 });
/** A 25-lot rezoning that is on the map. */
const MAPPED_SPECIMEN = "2025K0305";
/** A filtered project with no published point. It stays in the List and in the total. */
const UNMAPPED_SPECIMEN = "2025M0252";
/** A point key the filtered rows never produce. It may never mint a marker. */
const POINT_ONLY_ID = "2099Z9999";

function pointLookup() {
  return {
    schema: pointArtifact.schema,
    points: {
      ...pointArtifact.points,
      [POINT_ONLY_ID]: { lat: 40.71, lon: -74.0, method: "publisher_point", precision: "exact", bbl_count: 0 },
    },
  };
}

const LOOKUP = pointLookup();

/**
 * Run one route the way the product runs it: parse it once, build one query from that parse, and
 * hand the single filtered result to both renderings.
 *
 * `listIds` is derived from the rows here because node has no DOM; the browser proof reads the
 * same field back out of the painted List, which is what makes the receipt able to catch a List
 * that drifted rather than assume it did not.
 */
function runRoute(route, { limit, selectedProjectId = null } = {}) {
  const state = landFilterStateFromRouteParams(route);
  const query = landSnapshotQueryFromState(state, { actionRows: ACTION_ROWS, today: TODAY, limit });
  const rows = filterLandSnapshot(landDefault.projects, query);
  const model = buildLandMapModel({
    rows,
    pointLookup: LOOKUP,
    selectedProjectId,
    filters: query,
  });
  const scope = scopeFromRouteHash(route);
  const receipt = buildLandParityReceipt({
    route,
    state,
    query,
    rows,
    listIds: landCanonicalIds(rows),
    model,
    view: state.view,
    watch: watchFromScope(scope, { lens: "land" }),
    revision: "test-fixture",
  });
  return { state, query, rows, model, scope, receipt };
}

function landRoute(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return `#land${query ? `?${query}` : ""}`;
}

function facetRoute(params, facet) {
  return landRoute({ ...params, facet: JSON.stringify(facet) });
}

/** The one assertion every fixture makes. Named so a failure says which fixture broke it. */
function assertParity(label, receipt) {
  assert.deepEqual(receipt.violations, [], `${label}: ${receipt.violations.join(", ")}`);
  assert.equal(receipt.parity, true, label);
  assert.equal(receipt.schema, LAND_FILTER_PARITY_SCHEMA, label);
  // Restated explicitly rather than trusting the violation list to have checked them.
  const union = [...receipt.marker_ids, ...receipt.unmapped_ids].sort();
  assert.deepEqual(union, [...receipt.canonical_ids].sort(), `${label} union`);
  assert.deepEqual(receipt.list_ids, receipt.canonical_ids, `${label} order`);
  const markerSet = new Set(receipt.marker_ids);
  for (const id of receipt.unmapped_ids) assert.equal(markerSet.has(id), false, `${label} disjoint`);
  assert.equal(receipt.counts.total, receipt.list_ids.length, `${label} total`);
  assert.equal(receipt.counts.mapped + receipt.counts.unmapped, receipt.counts.total, `${label} sum`);
  assert.equal(receipt.marker_ids.includes(POINT_ONLY_ID), false, `${label} point-only`);
}

/* ------------------------------------------------------------------ A1: every dimension ---- */

test("A1 the inventory names every argument the canonical Land query accepts", () => {
  // Read the real signature rather than a copy of it: a dimension the query grew and the
  // inventory never learned about is a parity hole by construction.
  const source = readFileSync(new URL("../site/resident_snapshot_queries.mjs", import.meta.url), "utf8");
  const signature = source.slice(source.indexOf("export function filterLandSnapshot"));
  const body = signature.slice(signature.indexOf("{") + 1, signature.indexOf("} = {}"));
  const accepted = [...body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\s*=/gm)].map((match) => match[1]);
  // `actionRows` and `today` are the query's evidence inputs, not resident-chosen filters.
  const dimensions = accepted.filter((key) => !["actionRows", "today"].includes(key));
  assert.equal(dimensions.length > 0, true);
  for (const key of dimensions) {
    assert.ok(
      LAND_FILTER_DIMENSIONS_BY_QUERY_KEY[key],
      `filterLandSnapshot accepts "${key}" but the parity inventory does not name it`,
    );
  }
  // And nothing in the inventory is invented.
  for (const dimension of LAND_FILTER_DIMENSIONS) {
    assert.ok(dimensions.includes(dimension.queryKey), `inventory names unsupported "${dimension.queryKey}"`);
  }
});

test("A1 the commissioned names map onto the canonical query keys they actually have", () => {
  const byId = Object.fromEntries(LAND_FILTER_DIMENSIONS.map((d) => [d.id, d]));
  assert.equal(byId.future.queryKey, "futureAction");
  assert.equal(byId.future.routeKey, "future");
  assert.equal(byId.borough.routeKey, "boro");
  assert.equal(byId.communityDistrict.routeKey, "cd");
  assert.equal(byId.councilDistrict.routeKey, "council");
  assert.equal(byId.keyword.routeKey, "q");
  // The recorded discrepancy: this dimension has no route key of its own and travels in `facet`.
  assert.equal(byId.regulatoryEffect.routeKey, null);
  assert.equal(byId.regulatoryEffect.facetKey, "regulatoryEffect");
  assert.equal(byId.limit.routeKey, null);
  assert.equal(byId.limit.defaultValue, LAND_DEFAULT_RESULT_LIMIT);
  // Attendance and closing-week are hearing-row selectors, not project-query dimensions: they
  // narrow which hearings a `future=hearing` search reads, never which projects exist.
  assert.equal("attendance" in byId, false);
  assert.deepEqual(LAND_HEARING_ROW_SELECTORS.map((item) => item.id), ["attendance", "closingWeek"]);
});

test("A1 every single-dimension value keeps List and Map the same population", () => {
  const boroughs = [...new Set(landDefault.projects.map((row) => row.borough).filter(Boolean))];
  const districts = [...new Set(landDefault.projects.map((row) => row.community_district).filter(Boolean))]
    .flatMap((value) => String(value).split(",").map((part) => part.trim()))
    .filter((value) => /^(?:M|X|K|Q|R)\d{2}$/.test(value));
  const councils = [...new Set(landDefault.projects
    .flatMap((row) => String(row.cc_district || "").split(",").map((part) => part.trim()))
    .filter((value) => /^\d{1,2}$/.test(value))
    .map((value) => String(Number(value))))];

  const cases = [
    ...LAND_STAGE_OPTIONS.map((option) => ({ label: `stage=${option.id}`, route: landRoute({ status: "all", stage: option.id }) })),
    ...LAND_FUTURE_ACTION_OPTIONS.map((option) => ({ label: `future=${option.id}`, route: landRoute({ status: "all", stage: "any", future: option.id }) })),
    ...LAND_PROCEDURE_OPTIONS.map((option) => ({ label: `procedure=${option.id}`, route: landRoute({ status: "all", stage: "any", procedure: option.id }) })),
    ...LAND_FAMILY_OPTIONS.map((option) => ({ label: `family=${option.id}`, route: landRoute({ status: "all", stage: "any", family: option.id }) })),
    ...LAND_REGULATORY_EFFECT_OPTIONS.map((option) => ({
      label: `regulatoryEffect=${option.id}`,
      route: facetRoute({ status: "all", stage: "any" }, { regulatoryEffect: option.id }),
    })),
    ...boroughs.map((borough) => ({ label: `boro=${borough}`, route: landRoute({ status: "all", stage: "any", boro: borough }) })),
    ...districts.map((cd) => ({ label: `cd=${cd}`, route: landRoute({ status: "all", stage: "any", cd }) })),
    ...councils.map((council) => ({ label: `council=${council}`, route: landRoute({ status: "all", stage: "any", council }) })),
    { label: "status default", route: landRoute({}) },
    { label: "status=all", route: landRoute({ status: "all" }) },
    { label: "status=hearings", route: landRoute({ status: "hearings" }) },
    { label: "status legacy project:Active", route: landRoute({ status: "project:Active" }) },
    { label: "status legacy public:In Public Review", route: landRoute({ status: "public:In Public Review" }) },
    { label: "status exact project:On-Hold", route: landRoute({ status: "project:On-Hold" }) },
    { label: "keyword", route: landRoute({ status: "all", stage: "any", q: "Rezoning" }) },
  ];

  // Every enumerated option of every enumerated dimension, plus every geography value present in
  // the corpus. If this stops being a large table, coverage silently shrank.
  assert.equal(cases.length >= 60, true, `only ${cases.length} single-dimension cases`);
  for (const item of cases) assertParity(item.label, runRoute(item.route).receipt);
});

test("A1 representative and generated combinations keep the same population", () => {
  const combinations = [
    { status: "all", stage: "any", boro: "Brooklyn", family: "rezoning" },
    { status: "all", stage: "city_council", boro: "Queens" },
    { status: "all", stage: "public_review", procedure: "ulurp", family: "special_permit" },
    { status: "all", stage: "any", cd: "M05", q: "concession" },
    { status: "all", stage: "completed", boro: "Manhattan" },
    { status: "all", stage: "any", council: "33", family: "rezoning" },
    { status: "all", stage: "any", future: "any_future", boro: "Brooklyn" },
    { status: "hearings", boro: "Queens" },
  ];
  for (const params of combinations) {
    assertParity(`combo ${JSON.stringify(params)}`, runRoute(landRoute(params)).receipt);
  }

  // A bounded cross-product, not the exhaustive one: enough to expose a key that stopped being
  // read when it is combined with another, without an unmaintainable test.
  const axes = [
    ["stage", ["any", "public_review", "city_council", "completed"]],
    ["family", ["any", "rezoning", "special_permit", "major_concession"]],
    ["procedure", ["review", "ulurp"]],
    ["boro", ["", "Brooklyn", "Manhattan", "Staten Island"]],
  ];
  let generated = 0;
  for (const stage of axes[0][1]) {
    for (const family of axes[1][1]) {
      for (const procedure of axes[2][1]) {
        for (const boro of axes[3][1]) {
          for (const effect of ["any", "upzone"]) {
            const route = facetRoute({ status: "all", stage, family, procedure, boro }, { regulatoryEffect: effect });
            assertParity(`generated ${stage}/${family}/${procedure}/${boro || "citywide"}/${effect}`, runRoute(route).receipt);
            generated += 1;
          }
        }
      }
    }
  }
  assert.equal(generated, 4 * 4 * 2 * 4 * 2);
});

/* ---------------------------------------------------- A2: Map has no query of its own -------- */

test("A2 the Map renderer consumes only the filtered rows it is handed", () => {
  // Assert against the browse-map section alone. The same file also holds the unrelated
  // project-detail Leaflet map, whose lot geometry and fitBounds are not this surface.
  const browse = runtimeSrc.slice(runtimeSrc.indexOf("LAND_MAP_SHELL_SCHEMA"));
  assert.equal(browse.length > 2000, true);

  // The mount signature is the boundary: rows in, markers out.
  assert.equal(/export async function mountLandBrowseMap\(host, \{rows, selectedProjectId, filters\}/.test(browse), true);
  // Those rows go straight into the model, unfiltered and untrimmed.
  assert.equal(/buildLandMapModel\(\{\s*rows: population,/.test(browse), true);
  assert.equal(/const population = Array\.isArray\(rows\) \? rows : \[\];/.test(browse), true);

  for (const forbidden of [
    /applyLandMapFilters/,
    /filterLandSnapshot/,
    /loadLandProjectsSnapshot/,
    /landProjectInventory/,
    /land_default_ulurp/,
    /landSearch\s*\(/,
    /population\.(?:filter|slice|sort)\(/,
    /markers\.(?:filter|slice|sort)\(/,
    /rows\.(?:filter|slice|sort)\(/,
    /MAP_LIMIT|maxMarkers|mapOnly/i,
    /inBounds|withinViewport|isVisible\(/i,
  ]) {
    assert.equal(forbidden.test(browse), false, `browse map must not contain ${forbidden}`);
  }

  // The only network the browse map does is the point artifact it joins against.
  const fetches = [...runtimeSrc.matchAll(/fetch\(([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(fetches)], ["LAND_MAP_POINTS_URL"]);

  // `bounds` is derived from markers that already exist; it never selects them. The only reader
  // of the model's bounds is the view box, which is drawing, not membership.
  assert.equal(/model\.bounds/.test(browse), true);
  const boundsReaders = [...browse.matchAll(/([A-Za-z]+)\(model\.bounds\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(boundsReaders)], ["landMapViewBox"]);

  // And the model itself stays a projection.
  assert.equal(/filterLandSnapshot|applyLandMapFilters|\bfetch\s*\(/.test(modelSrc), false);
});

test("A2 the parity module is pure: no clock, no request, no DOM, no data source", () => {
  for (const forbidden of [/\bfetch\s*\(/, /Date\.now/, /new Date\(/, /Math\.random/, /document\./, /localStorage/, /https?:\/\//]) {
    assert.equal(forbidden.test(paritySrc), false, `parity module must not use ${forbidden}`);
  }
});

test("A2 a Map that filtered, limited, or reordered on its own is reported", () => {
  const { receipt, rows, model } = runRoute(landRoute({ status: "all", stage: "any" }));
  assertParity("baseline", receipt);

  const canonical = landCanonicalIds(rows);
  const mutate = (patch) => landParityViolations({ ...receipt, ...patch });

  // A Map-only predicate that dropped a mapped row.
  assert.ok(mutate({
    marker_ids: receipt.marker_ids.slice(1),
    counts: { ...receipt.counts, mapped: receipt.counts.mapped - 1, total: receipt.counts.total - 1 },
  }).includes("partition_union_differs_from_canonical"));

  // A post-map limit.
  assert.ok(mutate({
    marker_ids: receipt.marker_ids.slice(0, 5),
    unmapped_ids: receipt.unmapped_ids.slice(0, 2),
  }).includes("partition_union_differs_from_canonical"));

  // Unmapped rows removed before counting — the failure the three-count panel exists to prevent.
  const droppedUnmapped = mutate({
    unmapped_ids: [],
    counts: { total: receipt.counts.mapped, mapped: receipt.counts.mapped, unmapped: 0 },
  });
  assert.ok(droppedUnmapped.includes("partition_union_differs_from_canonical"));
  assert.ok(droppedUnmapped.includes("total_count_differs_from_list_length"));

  // Markers re-ordered independently of the canonical population.
  assert.ok(mutate({ marker_ids: [...receipt.marker_ids].reverse() }).includes("marker_order_differs_from_canonical"));

  // A marker minted from a point key the rows never produced.
  assert.ok(mutate({
    marker_ids: [...receipt.marker_ids, POINT_ONLY_ID],
    counts: { ...receipt.counts, mapped: receipt.counts.mapped + 1, total: receipt.counts.total + 1 },
  }).includes("partition_union_differs_from_canonical"));

  // The same id on both sides of the partition.
  assert.ok(mutate({
    unmapped_ids: [...receipt.unmapped_ids, receipt.marker_ids[0]],
    counts: { ...receipt.counts, unmapped: receipt.counts.unmapped + 1, total: receipt.counts.total + 1 },
  }).includes("partition_not_disjoint"));

  // A List that reordered relative to the canonical result.
  assert.ok(mutate({ list_ids: [...canonical].reverse() }).includes("list_order_differs_from_canonical"));

  // Headline counts that agree with nothing.
  assert.ok(mutate({ counts: { total: canonical.length, mapped: 1, unmapped: 1 } }).includes("partition_counts_do_not_sum"));

  assert.equal(model.counts.total, canonical.length);
});

test("A2 an omitted dimension is caught rather than passing quietly", () => {
  // The drift this suite exists for: a renderer or a query path that stopped reading one key.
  // Simulated at the query seam, because that is where the omission would happen.
  const route = facetRoute({ status: "all", stage: "any" }, { regulatoryEffect: "upzone" });
  const state = landFilterStateFromRouteParams(route);
  assert.equal(state.regulatoryEffect, "upzone");

  const honest = filterLandSnapshot(landDefault.projects, landSnapshotQueryFromState(state, { today: TODAY }));
  const forgetful = filterLandSnapshot(landDefault.projects, {
    ...landSnapshotQueryFromState(state, { today: TODAY }),
    regulatoryEffect: "any",
  });
  assert.notDeepEqual(landCanonicalIds(honest), landCanonicalIds(forgetful));

  const receipt = buildLandParityReceipt({
    route,
    state,
    rows: honest,
    listIds: landCanonicalIds(forgetful),
    model: buildLandMapModel({ rows: honest, pointLookup: LOOKUP }),
  });
  assert.equal(receipt.parity, false);
  assert.ok(receipt.violations.includes("list_order_differs_from_canonical"));
});

/* --------------------------------------------- A3: URL, view, watch scope agree --------------- */

test("A3 a canonical Land URL round-trips to the same normalized query", () => {
  const routes = [
    landRoute({ status: "all", stage: "city_council", boro: "Brooklyn", q: "rezoning" }),
    facetRoute({ status: "all", stage: "any", family: "rezoning", procedure: "ulurp" }, { regulatoryEffect: "upzone" }),
    landRoute({ status: "all", stage: "any", cd: "M05", council: "33" }),
    // The spelling the product's own serializer emits for a hearings scope.
    landRoute({ status: "all", future: "hearing", attendance: "in_person" }),
  ];
  for (const route of routes) {
    const canonical = routeHashFromScope(scopeFromRouteHash(route), { surface: "land" });
    const first = landFilterStateFromRouteParams(route);
    const second = landFilterStateFromRouteParams(canonical);
    assert.deepEqual({ ...second }, { ...first }, route);
    // And a second trip through the serializer is a fixed point.
    const twice = routeHashFromScope(scopeFromRouteHash(canonical), { surface: "land" });
    assert.deepEqual({ ...landFilterStateFromRouteParams(twice) }, { ...first }, route);
    // The populations the two spellings produce are the same, not merely the same size.
    assert.deepEqual(runRoute(canonical).receipt.canonical_ids, runRoute(route).receipt.canonical_ids);
  }
});

test("A3 known scope v0 discrepancies for hearing-row selectors stay pinned", () => {
  // Two pre-existing behaviours of the scope v0 Land serializer, recorded rather than smoothed
  // over. Both concern hearing-row selectors, not project-query dimensions, so neither changes
  // which projects a route produces -- which is why every population fixture above is green.
  const canonical = (hash) => routeHashFromScope(scopeFromRouteHash(hash), { surface: "land" });

  // 1. `attendance` is serialized only beside the modern `future=hearing` spelling. The legacy
  //    inbound `status=hearings` spelling stores no futureAction, so the serializer drops it.
  //    The product never emits the legacy spelling; it only has to keep reading it.
  assert.equal(canonical("#land?future=hearing&attendance=in_person"), "#land?future=hearing&attendance=in_person");
  assert.equal(canonical("#land?status=hearings&attendance=in_person"), "#land?status=hearings");
  // The population is identical either way, which is the parity claim this card makes.
  assert.deepEqual(
    runRoute("#land?status=hearings&attendance=in_person").receipt.canonical_ids,
    runRoute("#land?status=hearings").receipt.canonical_ids,
  );

  // 2. The Land surface has no `closing` route key at all, so a hearings "closing this week"
  //    selection does not survive canonical serialization in either spelling.
  assert.equal(canonical("#land?future=hearing&closing=week"), "#land?future=hearing");
  assert.equal(landFilterStateFromRouteParams("#land?future=hearing&closing=week").closingWeek, true);
  assert.equal(landFilterStateFromRouteParams(canonical("#land?future=hearing&closing=week")).closingWeek, false);

  // Both are inventoried as selectors, not dimensions, so nobody later adds them to the query.
  assert.deepEqual(LAND_HEARING_ROW_SELECTORS.map((item) => item.routeKey), ["attendance", "closing"]);
});

test("A3 invalid and unknown URL values fall back without changing meaning", () => {
  const base = runRoute(landRoute({ status: "all", stage: "any" })).receipt;
  const nonsense = [
    landRoute({ status: "all", stage: "any", family: "not_a_family" }),
    landRoute({ status: "all", stage: "any", procedure: "sideways" }),
    landRoute({ status: "all", stage: "any", boro: "Atlantis" }),
    landRoute({ status: "all", stage: "any", cd: "Z99" }),
    landRoute({ status: "all", stage: "any", council: "77" }),
    landRoute({ status: "all", stage: "any", future: "someday" }),
    facetRoute({ status: "all", stage: "any" }, { regulatoryEffect: "sideways" }),
    landRoute({ status: "all", stage: "any", facet: "{not json" }),
  ];
  for (const route of nonsense) {
    const receipt = runRoute(route).receipt;
    assertParity(`invalid ${route}`, receipt);
    assert.deepEqual(receipt.canonical_ids, base.canonical_ids, route);
  }
  // An unknown stage is not the same as a missing one: it takes the dimension's default.
  assert.equal(landFilterStateFromRouteParams(landRoute({ stage: "sideways" })).stage, "active");
});

test("A3 legacy status aliases keep adopting the stage they always did", () => {
  const cases = [
    [landRoute({}), { status: "all", stage: "active", futureAction: "any" }],
    [landRoute({ status: "active" }), { status: "all", stage: "active", futureAction: "any" }],
    [landRoute({ status: "all" }), { status: "all", stage: "any", futureAction: "any" }],
    [landRoute({ status: "hearings" }), { status: "all", stage: "any", futureAction: "hearing" }],
    [landRoute({ status: "project:Active" }), { status: "all", stage: "active", futureAction: "any" }],
    [landRoute({ status: "public:In Public Review" }), { status: "all", stage: "public_review", futureAction: "any" }],
    [landRoute({ status: "project:On-Hold" }), { status: "project:On-Hold", stage: "any", futureAction: "any" }],
    // An explicit stage always wins over the legacy derivation.
    [landRoute({ status: "all", stage: "cpc" }), { status: "all", stage: "cpc", futureAction: "any" }],
  ];
  for (const [route, expected] of cases) {
    const state = landFilterStateFromRouteParams(route);
    for (const [key, value] of Object.entries(expected)) assert.equal(state[key], value, `${route} ${key}`);
    assertParity(`legacy ${route}`, runRoute(route).receipt);
  }
});

test("A3 changing only the view changes neither the population nor the watch scope", () => {
  const params = { status: "all", stage: "city_council", boro: "Queens", family: "rezoning" };
  const receipts = LAND_VIEWS.map((view) => runRoute(landRoute({ ...params, view })).receipt);
  const [list, map] = receipts;
  assert.equal(list.view, "list");
  assert.equal(map.view, "map");
  assert.deepEqual(landParityDivergence(list, map), []);
  // An absent view and an unknown view are both List, and both mean the same scope.
  const absent = runRoute(landRoute(params)).receipt;
  const unknown = runRoute(landRoute({ ...params, view: "globe" })).receipt;
  assert.deepEqual(landParityDivergence(absent, list), []);
  assert.deepEqual(landParityDivergence(unknown, list), []);
  // The presentation key never reaches semantic scope or the saved watch.
  for (const receipt of [...receipts, absent, unknown]) {
    assert.equal("view" in receipt.semantic_scope, false);
    assert.equal("view" in (receipt.watch_scope?.filter || {}), false);
    assertParity("view invariance", receipt);
  }
});

test("A3 the semantic scope carries every filter dimension a watch may keep", () => {
  const route = facetRoute(
    { status: "project:On-Hold", stage: "city_council", future: "any_future", procedure: "ulurp", family: "rezoning", boro: "Brooklyn", cd: "K09", council: "33", q: "bedford", view: "map" },
    { regulatoryEffect: "upzone" },
  );
  const state = landFilterStateFromRouteParams(route);
  const semantic = landSemanticScopeFromState(state);
  for (const dimension of LAND_FILTER_DIMENSIONS.filter((item) => item.reachesWatchScope)) {
    assert.ok(dimension.queryKey in semantic, `semantic scope drops ${dimension.queryKey}`);
  }
  assert.equal("view" in semantic, false);
  assert.equal("limit" in semantic, false);
  assert.equal("projectIds" in semantic, false);
});

test("A3 viewport, pan, zoom, and selection are not membership", () => {
  const route = landRoute({ status: "all", stage: "any", boro: "Brooklyn", view: "map" });
  const plain = runRoute(route).receipt;
  const selected = runRoute(route, { selectedProjectId: MAPPED_SPECIMEN }).receipt;
  // Selecting a marker changes nothing about which projects are in the result.
  assert.deepEqual(landParityDivergence(plain, selected), []);
  assertParity("selected", selected);
  // Nothing viewport-shaped is a query key, so a route cannot express one.
  const state = landFilterStateFromRouteParams(landRoute({ status: "all", stage: "any", zoom: "14", bbox: "-74,40,-73,41", level: "borough" }));
  assert.deepEqual({ ...state }, { ...landFilterStateFromRouteParams(landRoute({ status: "all", stage: "any" })) });
  for (const key of ["zoom", "bbox", "level", "viewport", "pan"]) {
    assert.equal(key in state, false);
  }
});

test("A3 a filter change clears an out-of-scope selection without changing the new results", () => {
  const wide = runRoute(landRoute({ status: "all", stage: "any", view: "map" }), { selectedProjectId: MAPPED_SPECIMEN });
  assert.equal(wide.model.selectedProjectId, MAPPED_SPECIMEN);

  // Narrow to a scope that does not hold the selected project.
  const narrow = runRoute(landRoute({ status: "all", stage: "any", boro: "Manhattan", view: "map" }), {
    selectedProjectId: MAPPED_SPECIMEN,
  });
  assert.equal(narrow.receipt.canonical_ids.includes(MAPPED_SPECIMEN), false);
  assert.equal(narrow.model.selectedProjectId, null);
  // The LM-07 rule forgets it rather than holding it against a later, wider filter.
  assert.equal(nextLandMapSelection({
    requested: MAPPED_SPECIMEN,
    painted: narrow.model.selectedProjectId || "",
    population: narrow.receipt.counts.total,
  }), null);
  // And the new result set is exactly what the new filter produces, selection or not.
  const withoutSelection = runRoute(landRoute({ status: "all", stage: "any", boro: "Manhattan", view: "map" }));
  assert.deepEqual(landParityDivergence(narrow.receipt, withoutSelection.receipt), []);
  assertParity("selection cleared", narrow.receipt);
});

/* ---------------------------------------- A4: the populations that hide in count-only tests --- */

test("A4 the default scope keeps the 40/33/7 arithmetic", () => {
  const { receipt } = runRoute(landRoute({ status: "all", stage: "any" }));
  assertParity("default", receipt);
  assert.equal(receipt.counts.total, BASELINE.total);
  assert.equal(receipt.counts.mapped, BASELINE.mapped);
  assert.equal(receipt.counts.unmapped, BASELINE.unmapped);
  assert.equal(receipt.unmapped_ids.includes(UNMAPPED_SPECIMEN), true);
  assert.equal(receipt.marker_ids.includes(MAPPED_SPECIMEN), true);
});

test("A4 a scope whose only result is mapped", () => {
  const { receipt } = runRoute(landRoute({ status: "all", stage: "any", q: "Westshore" }));
  assertParity("mapped only", receipt);
  assert.deepEqual(receipt.canonical_ids, [MAPPED_SPECIMEN]);
  assert.deepEqual(receipt.marker_ids, [MAPPED_SPECIMEN]);
  assert.deepEqual(receipt.unmapped_ids, []);
  assert.deepEqual(receipt.counts, { total: 1, mapped: 1, unmapped: 0 });
});

test("A4 a scope whose only result has no published location", () => {
  const { receipt } = runRoute(landRoute({ status: "all", stage: "any", cd: "Q07" }));
  assertParity("unmapped only", receipt);
  assert.deepEqual(receipt.canonical_ids, ["2024Q0135"]);
  assert.deepEqual(receipt.marker_ids, []);
  assert.deepEqual(receipt.unmapped_ids, ["2024Q0135"]);
  assert.deepEqual(receipt.counts, { total: 1, mapped: 0, unmapped: 1 });
  // The project is still a result. A map with no markers has not emptied the search.
  assert.equal(receipt.list_ids.length, 1);
});

test("A4 an all-unmapped scope keeps every row in the total", () => {
  const { receipt } = runRoute(landRoute({ status: "all", stage: "completed" }));
  assertParity("all unmapped", receipt);
  assert.equal(receipt.counts.mapped, 0);
  assert.equal(receipt.counts.unmapped, receipt.counts.total);
  assert.equal(receipt.counts.total > 1, true);
  assert.deepEqual(receipt.unmapped_ids, receipt.canonical_ids);
});

test("A4 a zero-result scope is empty on both sides and invents nothing", () => {
  for (const route of [
    landRoute({ status: "all", stage: "any", q: "zzzznotathing" }),
    landRoute({ status: "all", stage: "any", procedure: "elurp" }),
    facetRoute({ status: "all", stage: "any" }, { regulatoryEffect: "downzone" }),
  ]) {
    const { receipt } = runRoute(route);
    assertParity(`empty ${route}`, receipt);
    assert.deepEqual(receipt.canonical_ids, []);
    assert.deepEqual(receipt.marker_ids, []);
    assert.deepEqual(receipt.unmapped_ids, []);
    assert.deepEqual(receipt.counts, { total: 0, mapped: 0, unmapped: 0 });
  }
});

test("A4 a mixed scope partitions rather than choosing a side", () => {
  const { receipt } = runRoute(landRoute({ status: "all", stage: "any", cd: "M05" }));
  assertParity("mixed", receipt);
  assert.equal(receipt.counts.mapped > 0, true);
  assert.equal(receipt.counts.unmapped > 0, true);
  assert.equal(receipt.counts.mapped + receipt.counts.unmapped, receipt.counts.total);
});

test("A4 the limit is the canonical query's, below, at, and above the population", () => {
  const route = landRoute({ status: "all", stage: "any" });
  const full = runRoute(route).receipt;
  assert.equal(full.canonical_ids.length, BASELINE.total);

  for (const [label, limit, expected] of [
    ["below", BASELINE.total - 1, BASELINE.total - 1],
    ["equal", BASELINE.total, BASELINE.total],
    ["above", BASELINE.total + 5, BASELINE.total],
    ["one", 1, 1],
    ["zero", 0, 0],
  ]) {
    const { receipt } = runRoute(route, { limit });
    assertParity(`limit ${label}`, receipt);
    assert.equal(receipt.canonical_ids.length, expected, `limit ${label}`);
    // The limit truncates the canonical order; it does not re-pick a different set.
    assert.deepEqual(receipt.canonical_ids, full.canonical_ids.slice(0, expected), `limit ${label} prefix`);
    assert.equal(receipt.counts.total, expected);
  }

  // Same, on a small scope, so the boundary is not always the corpus size.
  const small = runRoute(landRoute({ status: "all", stage: "any", boro: "Staten Island" })).receipt;
  const size = small.canonical_ids.length;
  assert.equal(size > 1, true);
  for (const limit of [size - 1, size, size + 1]) {
    const { receipt } = runRoute(landRoute({ status: "all", stage: "any", boro: "Staten Island" }), { limit });
    assertParity(`small limit ${limit}`, receipt);
    assert.deepEqual(receipt.canonical_ids, small.canonical_ids.slice(0, Math.min(limit, size)));
  }
});

test("A4 keyword case, whitespace, and punctuation normalize to one population", () => {
  const canonical = runRoute(landRoute({ status: "all", stage: "any", q: "Westshore LSGD" })).receipt;
  assert.deepEqual(canonical.canonical_ids, [MAPPED_SPECIMEN]);
  for (const spelling of ["westshore lsgd", "WESTSHORE LSGD", "  Westshore   LSGD  ", "\tWestshore\nLSGD "]) {
    const { receipt } = runRoute(landRoute({ status: "all", stage: "any", q: spelling }));
    assertParity(`keyword ${JSON.stringify(spelling)}`, receipt);
    assert.deepEqual(receipt.canonical_ids, canonical.canonical_ids, JSON.stringify(spelling));
  }
  // Punctuation is part of the text, not stripped: it narrows honestly rather than widening.
  const punctuated = runRoute(landRoute({ status: "all", stage: "any", q: "Westshore, LSGD" })).receipt;
  assertParity("keyword punctuated", punctuated);
  assert.deepEqual(punctuated.canonical_ids, []);
});

test("A4 the receipt is deterministic for the same inputs", () => {
  const route = facetRoute({ status: "all", stage: "any", boro: "Brooklyn", q: "rezoning", view: "map" }, { regulatoryEffect: "upzone" });
  const first = JSON.stringify(runRoute(route).receipt);
  const second = JSON.stringify(runRoute(route).receipt);
  assert.equal(first, second);
  // Byte-stable across watch-bag key ordering too, which is an artifact of the serializer branch.
  const shuffled = buildLandParityReceipt({
    ...runRoute(route),
    route,
    listIds: runRoute(route).receipt.list_ids,
    watch: { filter: { keywords: ["rezoning"], borough: "Brooklyn" }, lens: "land" },
  });
  const other = buildLandParityReceipt({
    ...runRoute(route),
    route,
    listIds: runRoute(route).receipt.list_ids,
    watch: { lens: "land", filter: { borough: "Brooklyn", keywords: ["rezoning"] } },
  });
  assert.equal(JSON.stringify(shuffled.watch_scope), JSON.stringify(other.watch_scope));
});

/* ------------------------------------------- the receipt is evidence, not decoration --------- */

test("A4 the committed parity receipt is current and deterministic", () => {
  const evidence = buildParityEvidence();
  const committed = JSON.parse(
    readFileSync(new URL("../docs/evidence/land-filter-parity.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(evidence, committed, "run: node tools/land_filter_parity_receipt.mjs");
  // Same tree, same bytes: the generator reads no clock, no network, and no randomness.
  assert.equal(JSON.stringify(buildParityEvidence()), JSON.stringify(evidence));
  assert.equal(evidence.baseline.total, BASELINE.total);
  assert.equal(evidence.baseline.mapped, BASELINE.mapped);
  assert.equal(evidence.baseline.unmapped, BASELINE.unmapped);
  for (const fixture of evidence.fixtures) {
    assert.deepEqual(fixture.violations, [], fixture.id);
    assert.equal(fixture.parity, true, fixture.id);
    assert.equal(fixture.partition.disjoint, true, fixture.id);
    assert.equal(fixture.partition.union_equals_canonical, true, fixture.id);
    assert.equal(fixture.partition.counts_sum, true, fixture.id);
  }
  // The fixture matrix covers the populations a count-only test would pass.
  const byId = Object.fromEntries(evidence.fixtures.map((fixture) => [fixture.id, fixture]));
  assert.deepEqual(byId["mapped-only"].counts, { total: 1, mapped: 1, unmapped: 0 });
  assert.deepEqual(byId["unmapped-only"].counts, { total: 1, mapped: 0, unmapped: 1 });
  assert.deepEqual(byId.empty.counts, { total: 0, mapped: 0, unmapped: 0 });
  assert.equal(byId["all-unmapped"].counts.mapped, 0);
  assert.equal(byId["all-unmapped"].counts.total > 1, true);
  assert.equal(byId["limit-below"].counts.total, BASELINE.total - 1);
  assert.equal(byId["limit-above"].counts.total, BASELINE.total);
  // A renderer switch changes `view` and nothing else.
  assert.equal(byId["default-list"].view, "list");
  assert.equal(byId["default-map"].view, "map");
  assert.deepEqual(byId["default-list"].canonical_ids, byId["default-map"].canonical_ids);
  assert.deepEqual(byId["default-list"].watch_scope, byId["default-map"].watch_scope);
  assert.deepEqual(byId["combined-list"].canonical_ids, byId["combined-map"].canonical_ids);
  // Both recorded URL discrepancies are named in the receipt rather than left implicit.
  assert.deepEqual(
    evidence.inventory.recorded_discrepancies.map((item) => item.id),
    ["attendance-legacy-status-spelling", "closing-week-has-no-land-route-key"],
  );
});

test("A4 the receipt check fails on drift instead of passing quietly", () => {
  const check = (mutate) => {
    const evidence = buildParityEvidence();
    const fixture = evidence.fixtures.find((item) => item.id === "default-map");
    mutate(fixture);
    const receipt = buildLandParityReceipt({
      route: fixture.route,
      rows: fixture.canonical_ids.map((project_id) => ({ project_id })),
      listIds: fixture.list_ids,
      model: {
        markers: fixture.marker_ids.map((projectId) => ({ projectId })),
        unmapped: fixture.unmapped_ids.map((projectId) => ({ projectId })),
        counts: fixture.counts,
      },
      query: fixture.query,
    });
    return receipt.violations;
  };

  // A dropped unmapped row: the failure the three-count panel exists to prevent.
  assert.ok(check((fixture) => {
    fixture.unmapped_ids = fixture.unmapped_ids.slice(1);
    fixture.counts = { ...fixture.counts, unmapped: fixture.counts.unmapped - 1, total: fixture.counts.total - 1 };
  }).length > 0);
  // A map-only limit applied after the join.
  assert.ok(check((fixture) => { fixture.marker_ids = fixture.marker_ids.slice(0, 5); }).length > 0);
  // A changed order.
  assert.ok(check((fixture) => { fixture.marker_ids = [...fixture.marker_ids].reverse(); }).length > 0);
  // A marker minted from a point the population never produced.
  assert.ok(check((fixture) => {
    fixture.marker_ids = [...fixture.marker_ids, POINT_ONLY_ID];
    fixture.counts = { ...fixture.counts, mapped: fixture.counts.mapped + 1, total: fixture.counts.total + 1 };
  }).length > 0);
  // A List that disagrees with the canonical population.
  assert.ok(check((fixture) => { fixture.list_ids = fixture.list_ids.slice(1); }).length > 0);

  // And the honest fixture still passes, so the checks above are not vacuous.
  assert.deepEqual(check(() => {}), []);
});

test("A2 the module's top-level bindings cannot collide when the site is flattened", () => {
  // test/functional/21_module_dom_equivalence.py flattens site modules into one classic script
  // to compare the module and no-module DOM. Duplicate `function` declarations are legal there;
  // a duplicate top-level `const` or `let` is a hard "already been declared" and takes the page
  // down. land_map_model.mjs carries the same warning in prose -- this makes it executable.
  const bindings = [...paritySrc.matchAll(/^(?:export )?(?:const|let)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((match) => match[1]);
  assert.equal(bindings.length > 5, true);

  const siteDir = new URL("../site/", import.meta.url);
  const neighbours = [
    ...readdirSync(siteDir).filter((name) => name.endsWith(".mjs")).map((name) => `site/${name}`),
    ...readdirSync(new URL("../site/app/", import.meta.url))
      .filter((name) => name.endsWith(".mjs")).map((name) => `site/app/${name}`),
  ].filter((path) => path !== "site/land_filter_parity.mjs");

  const collisions = [];
  for (const path of neighbours) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    for (const name of bindings) {
      if (new RegExp(`^(?:export )?(?:const|let)\\s+${name}\\b`, "m").test(source)) {
        collisions.push(`${name} also declared in ${path}`);
      }
    }
  }
  assert.deepEqual(collisions, [], "rename the binding so the flattened fixture still parses");
});
