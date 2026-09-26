/**
 * L04 — Near You Land results from the shared place index.
 * Verifier: node --test test/land_district_activity_membership.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { civicGeographyKey } from "../site/civic_geography_registry.mjs";
import { geographyRecordProjection } from "../site/geography_navigation_records.mjs";
import {
  LAND_PLACE_ASSOCIATION_KIND,
  landPlaceLayerCoverage,
} from "../site/land_place_membership.mjs";
import {
  buildDistrictActivity,
  landDistrictActivityNtaFindings,
  landNtaSlotsFromMembershipEntry,
  resolveLandPlaceMembershipInput,
} from "../tools/lib/district_activity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

const boundaries = loadJson("site/data/district_boundaries.json");
const membership = loadJson("site/data/land_place_membership.json");
const catalog = loadJson("site/data/land_project_catalog.json");

function projectRow(projectId) {
  const row = (catalog.projects || []).find((entry) => entry.project_id === projectId);
  assert.ok(row, `catalog missing ${projectId}`);
  return row;
}

function minimalGeographyLayers() {
  return [
    {
      type: "nta2020",
      source: { contract_id: "dcp-nta2020-boundaries" },
      vintage: { id: "26B" },
      features: [
        { id: "SI0105", label: "Westerleigh-Castleton Corners" },
        { id: "BK1301", label: "Coney Island-Sea Gate" },
        { id: "BK1391", label: "Calvert Vaux Park" },
        { id: "MN0401", label: "Hell's Kitchen" },
        { id: "MN0402", label: "Midtown-Times Square" },
        { id: "QN0101", label: "Astoria (North)-Woodside (North)" },
      ],
    },
    {
      type: "borough",
      source: { contract_id: "community-district-boundaries" },
      vintage: { id: "2026-05-26" },
      features: [
        { id: "1", label: "Manhattan" },
        { id: "3", label: "Brooklyn" },
        { id: "5", label: "Staten Island" },
      ],
    },
    {
      type: "community_district",
      source: { contract_id: "community-district-boundaries" },
      vintage: { id: "2026-05-26" },
      features: [
        { id: "R01", label: "Staten Island Community District 1" },
        { id: "K13", label: "Brooklyn Community District 13" },
        { id: "K11", label: "Brooklyn Community District 11" },
        { id: "M04", label: "Manhattan Community District 4" },
        { id: "M05", label: "Manhattan Community District 5" },
      ],
    },
    {
      type: "council_district",
      source: { contract_id: "council-district-boundaries" },
      vintage: { id: "2026-05-26" },
      features: [
        { id: "49", label: "Council District 49" },
        { id: "47", label: "Council District 47" },
        { id: "3", label: "Council District 3" },
      ],
    },
    {
      type: "police_precinct",
      source: { contract_id: "dcp-police-precinct-boundaries" },
      vintage: { id: "26B" },
      features: [],
    },
  ];
}

function buildLandActivity(opts = {}) {
  const ids = opts.projectIds || [
    "2026R0127",
    "2025K0305",
    "2023M0213",
    "2025M0252",
    "2022Y0395",
  ];
  return buildDistrictActivity({
    boundaries,
    geographyLayers: minimalGeographyLayers(),
    zapRows: ids.map(projectRow),
    landPlaceMembership: opts.landPlaceMembership === undefined
      ? membership
      : opts.landPlaceMembership,
    propertyRows: [],
    meetingsRows: [],
    rulesRows: [],
    moneyRows: [],
    contractActionRows: [],
    builtAt: "2026-09-26T00:00:00.000Z",
  });
}

function landIdsForNta(activity, ntaId) {
  const key = civicGeographyKey("nta2020", ntaId);
  return activity.geography_items?.by_key?.[key]?.land || [];
}

test("A1: retained NTA anchors appear once from the shared place index", () => {
  const activity = buildLandActivity();
  assert.deepEqual(landIdsForNta(activity, "SI0105"), ["2026R0127"]);
  assert.equal(
    landIdsForNta(activity, "BK1301").filter((id) => id === "2025K0305").length,
    1,
  );
  assert.equal(
    landIdsForNta(activity, "BK1391").filter((id) => id === "2025K0305").length,
    1,
  );
  assert.equal(
    landIdsForNta(activity, "MN0401").filter((id) => id === "2023M0213").length,
    1,
  );
  assert.equal(
    landIdsForNta(activity, "MN0402").filter((id) => id === "2023M0213").length,
    1,
  );

  // A1 checks retained anchors; complete per-NTA set equality is A4.
  assert.equal(landIdsForNta(activity, "SI0105").includes("2026R0127"), true);
  assert.equal(landIdsForNta(activity, "BK1301").includes("2025K0305"), true);
  assert.equal(landIdsForNta(activity, "BK1391").includes("2025K0305"), true);
  assert.equal(landIdsForNta(activity, "MN0401").includes("2023M0213"), true);
  assert.equal(landIdsForNta(activity, "MN0402").includes("2023M0213"), true);

  const siRecord = activity.records.land["2026R0127"];
  const siNta = siRecord.place.geographies.find((geo) => geo.key === civicGeographyKey("nta2020", "SI0105"));
  assert.equal(siNta.location_role, "project_geometry");
  assert.equal(siNta.association_kind, LAND_PLACE_ASSOCIATION_KIND);
  assert.equal(siNta.method, LAND_PLACE_ASSOCIATION_KIND);
  assert.equal(siNta.provenance.association_kind, LAND_PLACE_ASSOCIATION_KIND);

  // Publisher CD/council remain present beside the NTA membership.
  assert.ok(siRecord.place.geographies.some((geo) => geo.type === "community_district" && geo.id === "R01"));
  assert.ok(siRecord.place.geographies.some((geo) => geo.type === "council_district" && geo.id === "49"));
});

test("A2: no-BBL citywide and publisher-only CD never become physical NTA evidence", () => {
  const activity = buildLandActivity();
  const ntaKeys = Object.entries(activity.geography_items.definitions || {})
    .filter(([, definition]) => definition.type === "nta2020")
    .map(([key]) => key);

  for (const key of ntaKeys) {
    const land = activity.geography_items.by_key?.[key]?.land || [];
    assert.equal(land.includes("2022Y0395"), false, `${key} must omit citywide no-BBL`);
    assert.equal(land.includes("2025M0252"), false, `${key} must omit publisher-only CD`);
  }

  // Positive control: a forged CD→NTA crosswalk slot would fail this checker.
  const forged = {
    ...membership,
    by_project: {
      ...membership.by_project,
      "2025M0252": {
        ...membership.by_project["2025M0252"],
        layers: {
          ...membership.by_project["2025M0252"].layers,
          nta2020: {
            ...membership.by_project["2025M0252"].layers.nta2020,
            places: ["MN0401"],
          },
        },
      },
    },
    by_geography: {
      ...membership.by_geography,
      nta2020: {
        ...membership.by_geography.nta2020,
        MN0401: [...(membership.by_geography.nta2020.MN0401 || []), "2025M0252"],
      },
    },
  };
  const forgedActivity = buildLandActivity({ landPlaceMembership: forged });
  assert.equal(landIdsForNta(forgedActivity, "MN0401").includes("2025M0252"), true);
  // Real membership still excludes the publisher-only project.
  assert.equal(landIdsForNta(activity, "MN0401").includes("2025M0252"), false);
  assert.equal(landNtaSlotsFromMembershipEntry(membership.by_project["2025M0252"]).length, 0);
  assert.equal(landNtaSlotsFromMembershipEntry(membership.by_project["2022Y0395"]).length, 0);
});

test("A3: unavailable membership yields unavailable Land place query and keeps prior vintage", () => {
  const ready = buildLandActivity();
  const readyCoverage = ready.geography_items.coverage.by_lens.land.types.nta2020;
  assert.equal(readyCoverage.status, "ready");
  assert.equal(readyCoverage.generation_id, membership.generation.id);
  assert.deepEqual(readyCoverage.source_dates, membership.source_dates);

  const missing = buildLandActivity({ landPlaceMembership: null });
  const missingKey = civicGeographyKey("nta2020", "SI0105");
  const missingProjection = geographyRecordProjection(missing, { key: missingKey, lens: "land" });
  assert.equal(missingProjection.state, "unavailable");
  assert.equal(missingProjection.exact, false);
  assert.equal(missingProjection.count, null);
  assert.deepEqual(
    landDistrictActivityNtaFindings(missing, null, "SI0105"),
    [],
  );

  const corrupt = buildLandActivity({
    landPlaceMembership: { schema: "not-a-membership", by_project: {} },
  });
  const corruptProjection = geographyRecordProjection(corrupt, { key: missingKey, lens: "land" });
  assert.equal(corruptProjection.state, "unavailable");
  assert.equal(corrupt.sources.land.place_membership.status, "unavailable");
  assert.equal(corrupt.sources.land.place_membership.reason, "land_place_membership_corrupt");

  // Publisher CD land queries remain available when only the NTA place index is down.
  const cdKey = civicGeographyKey("community_district", "R01");
  // Ensure the publisher slot still materialized the CD key.
  const readyCd = geographyRecordProjection(ready, { key: cdKey, lens: "land" });
  assert.ok(readyCd.state === "ready" || readyCd.state === "zero");
  const missingCd = geographyRecordProjection(missing, { key: cdKey, lens: "land" });
  assert.ok(missingCd.state === "ready" || missingCd.state === "zero");
});

test("A4: complete per-NTA ID sets match L02 and preserve publisher role regressions", () => {
  const activity = buildLandActivity({
    projectIds: Object.keys(membership.by_project),
  });

  for (const ntaId of Object.keys(membership.by_geography.nta2020 || {})) {
    assert.deepEqual(
      landDistrictActivityNtaFindings(activity, membership, ntaId),
      [],
      ntaId,
    );
  }

  // Positive control: dropping an expected ID is observable.
  const drifted = structuredClone(activity);
  const siKey = civicGeographyKey("nta2020", "SI0105");
  drifted.geography_items.by_key[siKey].land = [];
  assert.ok(landDistrictActivityNtaFindings(drifted, membership, "SI0105").length > 0);

  // Publisher role regression: CD/council methods stay publisher_*, NTA stays published_project_lot.
  const westshore = activity.records.land["2025K0305"];
  const publisherCd = westshore.place.geographies.find((geo) => geo.type === "community_district");
  assert.ok(publisherCd);
  assert.match(String(publisherCd.method || publisherCd.provenance?.placement_method || ""), /publisher_/);
  const ntaGeo = westshore.place.geographies.find((geo) => geo.type === "nta2020");
  assert.equal(ntaGeo.association_kind, LAND_PLACE_ASSOCIATION_KIND);
  assert.equal(ntaGeo.location_role, "project_geometry");
});

test("A5: incomplete spatial coverage keeps bounded zero distinct from unavailable", () => {
  const coverage = landPlaceLayerCoverage(membership.by_project["2025K0305"], "nta2020");
  assert.equal(coverage.matched, 14);
  assert.equal(coverage.total, 25);
  assert.equal(coverage.fraction, "14/25");

  const activity = buildLandActivity();
  const landCoverage = activity.geography_items.coverage.by_lens.land;
  assert.equal(landCoverage.status, "ready");
  assert.equal(landCoverage.match_bound, "spatially_matched_population");
  assert.equal(typeof landCoverage.admitted, "number");
  assert.equal(typeof landCoverage.spatially_matched, "number");
  assert.equal(typeof landCoverage.partially_covered, "number");
  assert.ok(landCoverage.partially_covered >= 1);
  assert.ok(landCoverage.spatially_matched >= 1);
  assert.ok(landCoverage.admitted >= landCoverage.spatially_matched);

  // Empty NTA under a ready index is numeric zero within the matched population.
  const emptyKey = civicGeographyKey("nta2020", "QN0101");
  // Seed an empty land array the way a neighboring lens would serialize the key.
  activity.geography_items.definitions[emptyKey] = {
    key: emptyKey,
    type: "nta2020",
    id: "QN0101",
    label: "Astoria (North)-Woodside (North)",
  };
  activity.geography_items.by_key[emptyKey] = {
    land: [],
    property: [],
    rules: [],
    meetings: [],
    money: [],
  };
  const zero = geographyRecordProjection(activity, { key: emptyKey, lens: "land" });
  assert.equal(zero.state, "zero");
  assert.equal(zero.exact, true);
  assert.equal(zero.count, 0);

  // Missing/corrupt inputs remain a failed (non-exact) query — not numeric zero.
  assert.equal(resolveLandPlaceMembershipInput(null).status, "unavailable");
  const unavailable = buildLandActivity({ landPlaceMembership: null });
  const unavailableProjection = geographyRecordProjection(unavailable, {
    key: emptyKey,
    lens: "land",
  });
  assert.equal(unavailableProjection.state, "unavailable");
  assert.equal(unavailableProjection.exact, false);
  assert.equal(unavailableProjection.count, null);
});
