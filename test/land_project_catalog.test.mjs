/**
 * Admitted Land project catalog — shared population for Land, map points, and
 * district activity.
 *
 *   node --test test/land_project_catalog.test.mjs
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  LAND_PROJECT_CATALOG_SCHEMA,
  bindLandProjectCatalogCache,
  buildLandProjectCatalog,
  catalogProjectIdSet,
  catalogSourceDates,
  landProjectsForCatalogGeneration,
  mergeLandProjects,
} from "../site/land_project_catalog.mjs";
import { buildLandProjectCatalogFromRepo } from "../tools/build_land_project_catalog.mjs";
import { materializeLandProjectMapPoints } from "../site/land_project_map_points.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WAREHOUSE_PATH = join(ROOT, "site/data/zap_projects_warehouse_lookup.json");
const DEFAULTS_PATH = join(ROOT, "site/data/land_default_ulurp.json");
const CATALOG_PATH = join(ROOT, "site/data/land_project_catalog.json");
const BBL_PATH = join(ROOT, "site/data/zap_bbl_warehouse_lookup.json");
const MAP_POINTS_MODULE = readFileSync(join(ROOT, "site/land_project_map_points.mjs"), "utf8");
const MAP_BUILDER = readFileSync(join(ROOT, "tools/build_land_project_map_points.mjs"), "utf8");
const DISTRICT_BUILDER = readFileSync(join(ROOT, "tools/build_district_activity.mjs"), "utf8");
const LAND_APP = readFileSync(join(ROOT, "site/app/land.mjs"), "utf8");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fixtureWarehouse(rows, materializedAt = "2026-09-09T06:54:36.054Z") {
  return {
    schema_version: "test.warehouse",
    materialized_at: materializedAt,
    rows,
  };
}

function fixtureDefaults(projects, generatedAt = "2026-09-09T06:46:42.537Z") {
  return {
    schema_version: "test.defaults",
    generated_at: generatedAt,
    projects,
  };
}

describe("land_project_catalog", () => {
  it("A1 baseline catalog has exactly 244 unique IDs matching mergeLandProjects field-for-field", () => {
    assert.ok(existsSync(WAREHOUSE_PATH), "warehouse lookup present");
    assert.ok(existsSync(DEFAULTS_PATH), "defaults snapshot present");
    const warehouse = readJson(WAREHOUSE_PATH);
    const defaults = readJson(DEFAULTS_PATH);
    const merged = mergeLandProjects(warehouse, defaults);
    const catalog = buildLandProjectCatalog({ warehouse, defaults });

    assert.equal(catalog.schema, LAND_PROJECT_CATALOG_SCHEMA);
    assert.equal(catalog.project_count, 244);
    assert.equal(catalogProjectIdSet(catalog).size, 244);
    assert.equal(merged.length, 244);

    const mergedById = new Map(merged.map((row) => [row.project_id, row]));
    for (const project of catalog.projects) {
      const expected = mergedById.get(project.project_id);
      assert.ok(expected, `merged missing ${project.project_id}`);
      assert.deepEqual(project, expected);
    }
    assert.deepEqual(
      [...catalogProjectIdSet(catalog)].sort(),
      [...mergedById.keys()].sort(),
    );
  });

  it("A1 overlapping-field precedence matches defaults-over-warehouse mergeLandProjects", () => {
    const warehouse = fixtureWarehouse([
      {
        project_id: "2026R0127",
        project_name: "Warehouse Name",
        public_status: "Filed",
        borough: "Staten Island",
        warehouse_only: "keep",
      },
      {
        project_id: "ONLY-WH",
        project_name: "Warehouse Only",
        public_status: "Active",
      },
    ]);
    const defaults = fixtureDefaults([
      {
        project_id: "2026R0127",
        project_name: "Default Name",
        public_status: "Certified",
        default_only_field: "from-default",
      },
      {
        project_id: "ONLY-DEF",
        project_name: "Default Only",
        public_status: "Active",
      },
    ]);
    const merged = mergeLandProjects(warehouse, defaults);
    const catalog = buildLandProjectCatalog({ warehouse, defaults });
    const byId = new Map(catalog.projects.map((row) => [row.project_id, row]));

    assert.deepEqual(byId.get("2026R0127"), merged.find((row) => row.project_id === "2026R0127"));
    assert.equal(byId.get("2026R0127").project_name, "Default Name");
    assert.equal(byId.get("2026R0127").public_status, "Certified");
    assert.equal(byId.get("2026R0127").warehouse_only, "keep");
    assert.equal(byId.get("2026R0127").default_only_field, "from-default");
    assert.equal(byId.get("2026R0127").borough, "Staten Island");
    assert.ok(byId.get("ONLY-WH"));
    assert.ok(byId.get("ONLY-DEF"));
    assert.equal(catalog.project_count, 3);
  });

  it("A1 default-only records remain admitted", () => {
    const warehouse = readJson(WAREHOUSE_PATH);
    const defaults = readJson(DEFAULTS_PATH);
    const catalog = buildLandProjectCatalog({ warehouse, defaults });
    const warehouseIds = new Set((warehouse.rows || []).map((row) => row.project_id));
    const defaultOnly = (defaults.projects || []).filter((row) => !warehouseIds.has(row.project_id));
    assert.ok(defaultOnly.length >= 1, "fixture has default-only projects");
    const catalogIds = catalogProjectIdSet(catalog);
    for (const row of defaultOnly) {
      assert.ok(catalogIds.has(row.project_id), `default-only ${row.project_id} admitted`);
    }
  });

  it("A2 consumers share catalog generation and retain source dates independent of build time", () => {
    const built = buildLandProjectCatalogFromRepo(ROOT);
    assert.ok(existsSync(CATALOG_PATH), "committed catalog artifact");
    const committed = readJson(CATALOG_PATH);
    assert.equal(committed.schema, LAND_PROJECT_CATALOG_SCHEMA);
    assert.equal(committed.project_count, built.catalog.project_count);
    assert.equal(committed.generation.content_id, built.catalog.generation.content_id);
    assert.deepEqual(committed.source_dates, built.catalog.source_dates);

    const warehouse = readJson(WAREHOUSE_PATH);
    const defaults = readJson(DEFAULTS_PATH);
    assert.equal(
      committed.source_dates.warehouse_materialized_at,
      warehouse.materialized_at,
    );
    assert.equal(
      committed.source_dates.defaults_generated_at,
      defaults.generated_at,
    );
    assert.deepEqual(
      catalogSourceDates({ warehouse, defaults }),
      committed.source_dates,
    );

    // Build-time clock must not replace publisher source dates.
    assert.notEqual(committed.source_dates.warehouse_materialized_at, null);
    assert.notEqual(committed.source_dates.defaults_generated_at, null);
    assert.equal(committed.built_at, undefined);
    assert.equal(committed.materialized_at, committed.source_dates.warehouse_materialized_at);
    assert.equal(committed.generated_at, committed.source_dates.defaults_generated_at);

    assert.match(LAND_APP, /land_project_catalog\.json/);
    assert.match(LAND_APP, /bindLandProjectCatalogCache|landProjectsForCatalogGeneration|source_dates/);
    assert.match(MAP_BUILDER, /land_project_catalog/);
    assert.match(MAP_POINTS_MODULE, /catalog/);
    assert.match(DISTRICT_BUILDER, /land_project_catalog/);

    const mapPoints = materializeLandProjectMapPoints({
      catalog: committed,
      landDefault: defaults,
      zapBbl: { rows: [] },
      mapplutoCentroids: { by_bbl: {} },
    });
    assert.ok(mapPoints.receipt.inputs.land_project_catalog, "map points receipt records catalog input");
    assert.equal(mapPoints.receipt.inputs.land_project_catalog.count, committed.project_count);
    assert.equal(
      mapPoints.receipt.inputs.land_project_catalog.vintage.warehouse_materialized_at,
      committed.source_dates.warehouse_materialized_at,
    );
    assert.equal(
      mapPoints.receipt.inputs.land_project_catalog.vintage.content_id,
      committed.generation.content_id,
    );
    assert.equal(mapPoints.receipt.counts.universe, (defaults.projects || []).length);
  });

  it("A3 historical BBL keys do not enlarge the catalog", () => {
    assert.ok(existsSync(BBL_PATH), "BBL index present for boundary proof");
    const warehouse = readJson(WAREHOUSE_PATH);
    const defaults = readJson(DEFAULTS_PATH);
    const bblIndex = readJson(BBL_PATH);
    assert.ok((bblIndex.project_count || bblIndex.rows?.length || 0) > 1000);

    const withoutBbl = buildLandProjectCatalog({ warehouse, defaults });
    const withBbl = buildLandProjectCatalog({ warehouse, defaults, bblIndex });
    assert.equal(withoutBbl.project_count, 244);
    assert.equal(withBbl.project_count, 244);
    assert.deepEqual(
      [...catalogProjectIdSet(withBbl)].sort(),
      [...catalogProjectIdSet(withoutBbl)].sort(),
    );

    const bblOnlyId = (bblIndex.rows || []).map((row) => row.project_id)
      .find((id) => id && !catalogProjectIdSet(withoutBbl).has(id));
    assert.ok(bblOnlyId, "BBL index has historical-only project keys");
    assert.equal(catalogProjectIdSet(withBbl).has(bblOnlyId), false);
  });

  it("A3 removed catalog ID cannot persist through a stale consumer cache", () => {
    const first = buildLandProjectCatalog({
      warehouse: fixtureWarehouse([
        { project_id: "KEEP", project_name: "Keep" },
        { project_id: "DROP", project_name: "Drop Me" },
      ]),
      defaults: fixtureDefaults([]),
    });
    let cache = bindLandProjectCatalogCache(null, first);
    assert.deepEqual(
      cache.projects.map((row) => row.project_id).sort(),
      ["DROP", "KEEP"],
    );

    const second = buildLandProjectCatalog({
      warehouse: fixtureWarehouse([
        { project_id: "KEEP", project_name: "Keep" },
      ], "2026-09-10T00:00:00.000Z"),
      defaults: fixtureDefaults([]),
    });
    assert.notEqual(second.generation.content_id, first.generation.content_id);
    cache = bindLandProjectCatalogCache(cache, second);
    assert.deepEqual(cache.projects.map((row) => row.project_id), ["KEEP"]);
    assert.equal(cache.projects.some((row) => row.project_id === "DROP"), false);

    // Direct generation guard: asking for the old content_id against the new
    // catalog yields an empty population rather than a mixed set.
    assert.deepEqual(
      landProjectsForCatalogGeneration(second, first.generation.content_id),
      [],
    );
  });

  it("A4 failed-source cases refuse to materialize a catalog", () => {
    assert.throws(
      () => buildLandProjectCatalog({ warehouse: null, defaults: fixtureDefaults([]) }),
      (error) => error?.code === "LAND_PROJECT_CATALOG_SOURCE_MISSING",
    );
    assert.throws(
      () => buildLandProjectCatalog({ warehouse: fixtureWarehouse([]), defaults: null }),
      (error) => error?.code === "LAND_PROJECT_CATALOG_SOURCE_MISSING",
    );
    assert.throws(
      () => buildLandProjectCatalog({}),
      (error) => error?.code === "LAND_PROJECT_CATALOG_SOURCE_MISSING",
    );
  });
});
