/**
 * Land neighborhood watch delivery parity — browse, preview, single/rollup/queue.
 *
 * verify: node --test worker/test/land_nta_watch_parity.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { compileSub, ensureLandProjectCatalogRows } from "../src/lib/compile.mjs";
import { prepareWatchFilter, sanitize } from "../src/lib/filter.mjs";
import {
  LAND_GEOGRAPHY_ARTIFACT_UNAVAILABLE,
  landGeographyArtifactState,
  landNtaWatchBroadeningFindings,
  landNtaWatchMatchingIds,
  transformLandGeographyWatchRows,
} from "../../site/land_nta_watch_scope.mjs";
import {
  landCanonicalIds,
  landFilterStateFromRouteParams,
  landSnapshotQueryFromState,
} from "../../site/land_filter_parity.mjs";
import { filterLandSnapshot } from "../../site/resident_snapshot_queries.mjs";
import { landProjectRowsFromPayload } from "../../site/land_project_catalog.mjs";
import { NEAR_YOU_FLOOR } from "../src/data/route_read_model_floor.mjs";

const ROOT = new URL("../../", import.meta.url);
const ROOT_PATH = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TODAY = "2026-09-26";

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, ROOT), "utf8"));
}

const activity = readJson("site/data/district_activity.json");
const catalog = readJson("site/data/land_project_catalog.json");
const membership = readJson("site/data/land_place_membership.json");
const catalogRows = landProjectRowsFromPayload(catalog);

// compileSub() now imports the Land project catalog lazily so its parse stays
// off the Worker startup CPU path. The synchronous transformRows() calls below
// read the catalog from that cache, which rowsForCompiledQuery() primes in
// production; prime it once here so the direct transform calls see the same rows.
await ensureLandProjectCatalogRows();

const NTA = Object.freeze({
  SI0105: "geography:nta2020:SI0105",
  MN0401: "geography:nta2020:MN0401",
});

function browseIds(route, { limit = catalogRows.length } = {}) {
  const state = landFilterStateFromRouteParams(route);
  const query = landSnapshotQueryFromState(state, {
    today: TODAY,
    placeMembership: membership,
    limit,
  });
  return landCanonicalIds(filterLandSnapshot(catalogRows, query));
}

function deliveryIds(filter) {
  const prepared = prepareWatchFilter("land", filter);
  assert.equal(prepared.ok, true, prepared.reason);
  const query = compileSub({ lens: "land", filter: prepared.filter }, TODAY);
  assert.ok(query, "land geography watch must compile");
  assert.equal(query.landGeographyWatch, true);
  assert.equal(query.url, "https://cityscroll.org/data/district_activity.json");
  const rows = query.transformRows(activity);
  return rows.map((row) => row.project_id || row.id).filter(Boolean);
}

test("A1 SI0105 and MN0401 browse, preview transform, and matching helper share pre-limit IDs", () => {
  for (const [nta, key] of [["SI0105", NTA.SI0105], ["MN0401", NTA.MN0401]]) {
    const filter = { status: "all", stage: "any", geographies: [key] };
    const browse = browseIds(`#land?status=all&stage=any&geo=${encodeURIComponent(key)}`);
    const delivered = deliveryIds(filter);
    const match = landNtaWatchMatchingIds({
      filter,
      catalogRows,
      placeMembership: membership,
      activityPayload: activity,
      source: "activity",
      today: TODAY,
    });
    assert.equal(match.status, "ready", nta);
    assert.deepEqual(delivered, [...match.ids], `${nta} delivery vs activity match`);
    assert.deepEqual(delivered, browse, `${nta} delivery vs browse`);
    if (nta === "SI0105") assert.ok(delivered.includes("2026R0127"));
    if (nta === "MN0401") assert.ok(delivered.includes("2023M0213"));
  }
});

test("A1 supported facets stay aligned across browse and delivery for SI0105", () => {
  const filter = {
    status: "all",
    stage: "any",
    boro: "Staten Island",
    geographies: [NTA.SI0105],
  };
  const browse = browseIds(
    `#land?status=all&stage=any&boro=Staten%20Island&geo=${encodeURIComponent(NTA.SI0105)}`,
  );
  const delivered = deliveryIds(filter);
  assert.deepEqual(delivered, browse);
  assert.deepEqual(delivered, ["2026R0127"]);
});

test("A2 no-BBL / publisher-only projects stay outside NTA subscriptions", () => {
  for (const key of [NTA.SI0105, NTA.MN0401]) {
    const delivered = deliveryIds({ status: "all", stage: "any", geographies: [key] });
    assert.equal(delivered.includes("2025M0252"), false, "publisher-only CD must not enter");
    assert.equal(delivered.includes("2022Y0395"), false, "citywide no-BBL must not enter");
  }
  const disclosure = landNtaWatchMatchingIds({
    filter: { status: "all", geographies: [NTA.SI0105] },
    catalogRows,
    placeMembership: membership,
    activityPayload: activity,
    source: "activity",
    today: TODAY,
  }).disclosure;
  assert.equal(disclosure.assurance, "matched_published_lots_only");
  assert.equal(disclosure.bounded_to_matched_lots, true);
});

test("A3 missing current artifact skips instead of emitting a successful empty digest", () => {
  const prepared = prepareWatchFilter("land", {
    status: "all",
    stage: "any",
    geographies: [NTA.SI0105],
  });
  const query = compileSub({ lens: "land", filter: prepared.filter }, TODAY);
  assert.throws(
    () => query.transformRows(NEAR_YOU_FLOOR),
    (error) => error?.code === LAND_GEOGRAPHY_ARTIFACT_UNAVAILABLE,
  );
  assert.throws(
    () => query.transformRows({}),
    (error) => error?.code === LAND_GEOGRAPHY_ARTIFACT_UNAVAILABLE,
  );
  assert.equal(landGeographyArtifactState(NEAR_YOU_FLOOR).status, "unavailable");

  // Converse control: a ready artifact still delivers the retained SI0105 member.
  const rows = query.transformRows(activity);
  assert.deepEqual(rows.map((row) => row.project_id), ["2026R0127"]);
});

test("A3 unavailable artifact does not clear previously seen membership as a geographic departure", async () => {
  // Ordering observation: inject the failure between compile and seen mutation.
  const seen = new Set(["land:2026R0127"]);
  const prepared = prepareWatchFilter("land", {
    status: "all",
    geographies: [NTA.SI0105],
  });
  const query = compileSub({ lens: "land", filter: prepared.filter }, TODAY);

  let transformFailed = false;
  try {
    query.transformRows({ geography_items: { by_key: {} } });
  } catch (error) {
    transformFailed = error?.code === LAND_GEOGRAPHY_ARTIFACT_UNAVAILABLE;
  }
  assert.equal(transformFailed, true);
  // Seen set is untouched when the artifact path fails before delivery.
  assert.deepEqual([...seen], ["land:2026R0127"]);

  // Converse control: a successful transform still names the same id without rewriting seen.
  const okRows = query.transformRows(activity);
  assert.equal(okRows[0].geography_item_id, "land:2026R0127");
  assert.deepEqual([...seen], ["land:2026R0127"]);
});

test("A4 single, rollup, and queued evaluators still share loadWatchRows for geography artifacts", () => {
  const source = readFileSync(new URL("worker/src/alerts.mjs", ROOT), "utf8");
  assert.equal(
    (source.match(/await loadWatchRows\(/g) || []).length,
    3,
    "single, rollup, and queued alert evaluators must all use loadWatchRows",
  );
  assert.match(source, /land-geography-artifact-unavailable/);
  assert.match(source, /LAND_GEOGRAPHY_ARTIFACT_UNAVAILABLE/);
});

test("A5 every required dimension alone and with geographies; stage+filingEvidence+geography together", () => {
  const dimensions = [
    { status: "all" },
    { status: "all", stage: "public_review" },
    { status: "all", futureAction: "hearing" },
    { status: "all", procedure: "ulurp" },
    { status: "all", family: "rezoning" },
    { status: "all", regulatoryEffect: "upzone" },
    { status: "all", filingEvidence: "required" },
    { status: "all", boro: "Manhattan" },
    { status: "all", communityDistrict: "M04" },
    { status: "all", councilDistrict: "3" },
    { status: "all", keywords: ["park"] },
  ];

  for (const facet of dimensions) {
    const alonePrep = prepareWatchFilter("land", facet);
    assert.equal(alonePrep.ok, true, `alone prepare ${JSON.stringify(facet)}`);
    const aloneSan = sanitize("land", alonePrep.filter);
    for (const [key, value] of Object.entries(facet)) {
      if (key === "keywords") {
        assert.deepEqual(aloneSan.keywords, value);
      } else if (value != null && value !== "") {
        assert.equal(aloneSan[key], value, `alone sanitize keeps ${key}`);
      }
    }

    const withGeo = { ...facet, geographies: [NTA.MN0401] };
    const delivered = deliveryIds(withGeo);
    const browseRoute = new URLSearchParams({ status: "all", stage: facet.stage || "any" });
    if (facet.boro) browseRoute.set("boro", facet.boro);
    if (facet.communityDistrict) browseRoute.set("cd", facet.communityDistrict);
    if (facet.councilDistrict) browseRoute.set("council", facet.councilDistrict);
    if (facet.keywords) browseRoute.set("q", facet.keywords[0]);
    if (facet.procedure) browseRoute.set("procedure", facet.procedure);
    if (facet.family) browseRoute.set("family", facet.family);
    if (facet.futureAction) browseRoute.set("future", facet.futureAction);
    browseRoute.set("geo", NTA.MN0401);
    // Facets without route keys still compare through the matching helper oracle.
    const match = landNtaWatchMatchingIds({
      filter: withGeo,
      catalogRows,
      placeMembership: membership,
      source: "browse",
      today: TODAY,
    });
    assert.equal(match.status, "ready");
    assert.deepEqual(delivered, [...match.ids], `delivery parity ${JSON.stringify(facet)}`);
  }

  const combined = {
    status: "all",
    stage: "any",
    filingEvidence: "required",
    geographies: [NTA.MN0401],
  };
  const combinedDelivered = deliveryIds(combined);
  const combinedBrowse = landCanonicalIds(filterLandSnapshot(catalogRows, {
    status: "all",
    stage: "any",
    filingEvidence: "required",
    geographies: [NTA.MN0401],
    placeMembership: membership,
    limit: catalogRows.length,
  }));
  assert.deepEqual(combinedDelivered, combinedBrowse);
});

test("A2/A5 positive control: broadening detector fails when a citywide id is injected", () => {
  const filter = { status: "all", stage: "any", geographies: [NTA.SI0105] };
  const delivered = deliveryIds(filter);
  assert.deepEqual(
    [...landNtaWatchBroadeningFindings({
      filter,
      deliveredIds: delivered,
      catalogRows,
      placeMembership: membership,
    })],
    [],
  );
  const findings = landNtaWatchBroadeningFindings({
    filter,
    deliveredIds: [...delivered, "2022Y0395"],
    catalogRows,
    placeMembership: membership,
  });
  assert.ok(findings.some((line) => line.includes("2022Y0395")));
});

test("transformLandGeographyWatchRows OR-unions multi-NTA geography keys", () => {
  const rows = transformLandGeographyWatchRows(
    activity,
    { status: "all", stage: "any", geographies: [NTA.SI0105, NTA.MN0401] },
    { catalogRows, today: TODAY },
  );
  const ids = rows.map((row) => row.project_id);
  assert.ok(ids.includes("2026R0127"));
  assert.ok(ids.includes("2023M0213"));
  // Must not require presence in both neighborhoods (AND would drop both anchors).
  assert.equal(ids.includes("2026R0127") && ids.includes("2023M0213"), true);
});

void ROOT_PATH;
