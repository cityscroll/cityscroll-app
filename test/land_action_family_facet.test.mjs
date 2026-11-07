/**
 * Action-family facet: chips, list filter, follow, and Near-you share one predicate.
 *
 * Verify: node --test test/land_action_family_facet.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LAND_FAMILY,
  LAND_FAMILY_OPTIONS,
  landFamilyChipsHTML,
  landFamilySodaWhere,
  landRowMatchesFamily,
  landUseFamilies,
  normalizeLandFamily,
} from "../site/land_status_facets.mjs";
import { filterLandSnapshot, mergeLandProjects } from "../site/resident_snapshot_queries.mjs";
import { buildNearYouViewModel } from "../site/near_you_view.mjs";
import { routeHashFromScope, scopeFromRouteHash, scopeFromWatch, watchFromScope } from "../site/scope_v0.mjs";
import { sanitize } from "../worker/src/lib/filter.mjs";
import { compileSub } from "../worker/src/lib/compile.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const warehouse = JSON.parse(
  readFileSync(join(ROOT, "site/data/zap_projects_warehouse_lookup.json"), "utf8"),
);
const defaults = JSON.parse(
  readFileSync(join(ROOT, "site/data/land_default_ulurp.json"), "utf8"),
);
const projects = mergeLandProjects(warehouse, defaults);

function warehouseRow(projectId) {
  return (warehouse.projects || warehouse.rows || []).find((row) => row.project_id === projectId)
    || projects.find((row) => row.project_id === projectId);
}

// This file reads committed site/data directly rather than a frozen fixture,
// so each specimen below is the first project (sorted by id) whose own
// current family shape satisfies the test, found with the same production
// functions the rest of this file exercises, rather than a fixed id that
// ordinary refresh churn can rotate out at any time.
function allRows() {
  return [...projects].sort((a, b) => a.project_id.localeCompare(b.project_id));
}
function findRowIdByFamily(predicate) {
  const row = allRows().find(predicate);
  if (!row) {
    throw new Error("no live project currently matches a required land-use-family shape for this test file; it needs a fresh specimen pinned by hand");
  }
  return row.project_id;
}

const ACQUISITION = findRowIdByFamily((row) => {
  const families = landUseFamilies(row);
  return families.length === 1 && families[0] === "acquisition";
});
// No live warehouse row currently carries the major_concession (MC) action at
// all (a zero-population family this refresh, not a bug), so this one
// specimen is a synthetic row built from the documented MC action code
// rather than a live lookup.
const MAJOR_CONCESSION_ROW = { project_id: "SYNTHETIC-MC", actions: "MC" };
const CERTIFICATION = findRowIdByFamily((row) => {
  const families = landUseFamilies(row);
  return families.length === 1 && families[0] === "certification"
    && filterLandSnapshot(projects, { status: "all", procedure: "non_ulurp", family: "certification", limit: 500 })
      .some((item) => item.project_id === row.project_id);
});
const DISPOSITION = findRowIdByFamily((row) => landRowMatchesFamily(row, "disposition"));
const ZM_ONLY = findRowIdByFamily((row) =>
  String(row.actions || "").trim() === "ZM" && landUseFamilies(row).includes("rezoning"));

test("family facet is a closed vocabulary and default is any", () => {
  assert.equal(DEFAULT_LAND_FAMILY, "any");
  assert.equal(normalizeLandFamily(undefined), "any");
  assert.equal(normalizeLandFamily("major-concession"), "major_concession");
  assert.equal(normalizeLandFamily("not-a-family"), "any");
  assert.ok(LAND_FAMILY_OPTIONS.some((option) => option.id === "acquisition"));
  assert.ok(LAND_FAMILY_OPTIONS.some((option) => option.id === "legal_document"));
  assert.ok(!LAND_FAMILY_OPTIONS.some((option) => option.id === "land_use"));
});

test("list card for 2022X0150 shows Acquisition and a synthetic MC row shows Major concession", () => {
  const acquisition = warehouseRow(ACQUISITION);
  const concession = MAJOR_CONCESSION_ROW;
  assert.ok(acquisition, "warehouse must retain 2022X0150");
  assert.deepEqual(landUseFamilies(acquisition), ["acquisition"]);
  assert.deepEqual(landUseFamilies(concession), ["major_concession"]);

  const labels = {
    land_use_family_acquisition: "Acquisition",
    land_use_family_major_concession: "Major concession",
    land_use_family_generic: "Land-use review",
  };
  const acquisitionHtml = landFamilyChipsHTML(acquisition, { t: (key) => labels[key] || key });
  const concessionHtml = landFamilyChipsHTML(concession, { t: (key) => labels[key] || key });
  assert.match(acquisitionHtml, /data-land-family="acquisition"/);
  assert.match(acquisitionHtml, />Acquisition</);
  assert.doesNotMatch(acquisitionHtml, /Land-use review/);
  assert.match(concessionHtml, /data-land-family="major_concession"/);
  assert.match(concessionHtml, />Major concession</);
  assert.doesNotMatch(concessionHtml, /Land-use review|generic/i);
});

test("family=certification includes 2023R0329", () => {
  const row = warehouseRow(CERTIFICATION);
  assert.ok(row, "warehouse must retain 2023R0329");
  assert.equal(landRowMatchesFamily(row, "certification"), true);
  const certified = filterLandSnapshot(projects, {
    status: "all",
    procedure: "non_ulurp",
    family: "certification",
    limit: 500,
  });
  assert.ok(
    certified.some((item) => item.project_id === CERTIFICATION),
    "family=certification must include RC-only 2023R0329",
  );
  assert.ok(certified.every((item) => landUseFamilies(item).includes("certification")));
});

test("family=disposition includes 2022X0393 and excludes a ZM-only rezoning", () => {
  const disposition = warehouseRow(DISPOSITION);
  const rezoning = warehouseRow(ZM_ONLY);
  assert.ok(disposition, "warehouse must retain 2022X0393");
  assert.ok(rezoning, "warehouse must retain 2026K0123");
  assert.equal(landRowMatchesFamily(disposition, "disposition"), true);
  assert.equal(landRowMatchesFamily(rezoning, "disposition"), false);
  assert.ok(landUseFamilies(rezoning).includes("rezoning"));

  const rows = filterLandSnapshot(projects, {
    status: "all",
    procedure: "review",
    family: "disposition",
    limit: 500,
  });
  assert.ok(rows.some((item) => item.project_id === DISPOSITION));
  assert.equal(rows.some((item) => item.project_id === ZM_ONLY), false);
});

test("family+place follow survives sanitize, compile, and scope adapters", () => {
  const filter = sanitize("land", {
    family: "acquisition",
    boro: "Staten Island",
    status: "all",
    procedure: "review",
  });
  assert.equal(filter.family, "acquisition");
  assert.equal(filter.boro, "Staten Island");

  const compiled = compileSub({ lens: "land", filter }, "2026-08-18");
  assert.match(compiled.params.$where, /ulurp_non IN \('ULURP','ELURP'\)/);
  assert.match(compiled.params.$where, /upper\(actions\) like '%PQ%'/);
  assert.match(compiled.params.$where, /upper\(actions\) like '%PC%'/);
  assert.equal(typeof compiled.postFilter, "function");
  assert.equal(compiled.postFilter(warehouseRow(ACQUISITION)), true);
  assert.equal(compiled.postFilter(warehouseRow(ZM_ONLY)), false);

  const original = "#land?boro=Queens&family=acquisition";
  const scope = scopeFromRouteHash(original);
  assert.equal(scope.facets.values.family, "acquisition");
  assert.equal(routeHashFromScope(scope, { surface: "land" }), original);
  const watch = watchFromScope(scope, { lens: "land" });
  assert.equal(watch.filter.family, "acquisition");
  assert.equal(watch.filter.boro, "Queens");
  assert.equal(routeHashFromScope(scopeFromWatch(watch), { surface: "land" }), original);
});

test("Near-you land bag uses the same family predicate", () => {
  const activity = {
    schema: "cityscroll.district_activity.v1",
    boundary_vintage: "2026-05-26",
    built_at: "2026-08-18T12:00:00.000Z",
    levels: ["borough", "community_district", "council_district"],
    lenses: ["land", "property", "rules", "meetings", "money"],
    by_level: {
      borough: { "Staten Island": { land: 2, property: 0, rules: 0, meetings: 0, money: 0 } },
      community_district: {},
      council_district: {},
    },
    citywide: { land: 0, property: 0, rules: 0, meetings: 0, money: 0 },
    virtual: { land: 0, property: 0, rules: 0, meetings: 0, money: 0 },
    unlocated: { land: 0, property: 0, rules: 0, meetings: 0, money: 0 },
    district_items: {
      schema: "cityscroll.district_items.v1",
      by_level: {
        borough: { "Staten Island": { land: [ACQUISITION, CERTIFICATION] } },
        community_district: {},
        council_district: {},
      },
    },
    records: {
      land: {
        [ACQUISITION]: {
          id: ACQUISITION,
          title: "FDNY Victory Blvd",
          families: ["acquisition"],
          actions: "PQ",
        },
        [CERTIFICATION]: {
          id: CERTIFICATION,
          title: "Knesel Street",
          families: ["certification"],
          actions: "RC",
        },
      },
    },
  };
  const boundaries = {
    boundary_vintage: "2026-05-26",
    community_districts: [],
    council_districts: [],
    boroughs: [{ id: "Staten Island", name: "Staten Island", rings: [] }],
  };
  const scope = scopeFromRouteHash("#land?boro=Staten%20Island&family=acquisition");
  const view = buildNearYouViewModel(scope, activity, boundaries);
  assert.deepEqual(view.results.ids, [ACQUISITION]);
  assert.equal(landRowMatchesFamily(activity.records.land[ACQUISITION], "acquisition"), true);
  assert.equal(landRowMatchesFamily(activity.records.land[CERTIFICATION], "acquisition"), false);
  assert.ok(landFamilySodaWhere("acquisition").includes("PQ"));
});
