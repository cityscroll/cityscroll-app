/**
 * Retain-last-good publish decisions for warehouse serve lookups.
 *
 * A verified_seed / live_fallback rematerialization must never replace a
 * committed full catalog. That failure mode emptied Doing Business and
 * collapsed Land place membership during first-class refresh.
 *
 *   node --test test/warehouse_serve_retain_last_good.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  decideWarehouseServePublish,
} from "../warehouse/lib/serve_publish_contract.mjs";
import {
  doingBusinessServeGateFindings,
  isDoingBusinessFullCatalog,
} from "../warehouse/lib/doing_business_lookup.mjs";
import {
  isZapBblFullCatalog,
  zapBblServeGateFindings,
  ZAP_BBL_MIN_PROJECT_COUNT,
} from "../warehouse/lib/zap_bbl_lookup.mjs";
import {
  landPlaceMembershipPopulationFindings,
  LAND_PLACE_MIN_NTA_PLACE_COUNT,
} from "../site/land_place_membership.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

describe("warehouse serve retain-last-good", () => {
  it("retains a full ZAP BBL catalog when rematerialization collapses to verified_seed", () => {
    const existing = readJson("site/data/zap_bbl_warehouse_lookup.json");
    assert.equal(isZapBblFullCatalog(existing), true);
    assert.equal(zapBblServeGateFindings(existing).length, 0);

    const candidate = {
      ...existing,
      mode: "verified_seed",
      project_count: 9,
      bbl_row_count: 86,
      rows: existing.rows.slice(0, 9),
    };
    assert.equal(isZapBblFullCatalog(candidate), false);
    assert.ok(zapBblServeGateFindings(candidate).some((f) => /verified_seed|below floor/i.test(f)));

    const decision = decideWarehouseServePublish(existing, candidate, {
      isFullCatalog: isZapBblFullCatalog,
      label: "ZAP BBL",
    });
    assert.equal(decision.action, "retain");
    assert.equal(decision.document.project_count, existing.project_count);
    assert.ok(decision.document.project_count >= ZAP_BBL_MIN_PROJECT_COUNT);
  });

  it("retains a full Doing Business catalog when rematerialization is live_fallback empty", () => {
    const existing = readJson("site/data/doing_business_warehouse_lookup.json");
    assert.equal(isDoingBusinessFullCatalog(existing), true);
    assert.equal(doingBusinessServeGateFindings(existing).length, 0);

    const candidate = {
      schema_version: 1,
      phase: "WH-05",
      mode: "live_fallback",
      row_count: 0,
      rows: [],
      materialized_at: "2026-10-07T14:00:00.000Z",
    };
    assert.equal(isDoingBusinessFullCatalog(candidate), false);
    assert.ok(doingBusinessServeGateFindings(candidate).some((f) => /live_fallback|empty/i.test(f)));

    const decision = decideWarehouseServePublish(existing, candidate, {
      isFullCatalog: isDoingBusinessFullCatalog,
      label: "Doing Business",
    });
    assert.equal(decision.action, "retain");
    assert.equal(decision.document.row_count, existing.row_count);
  });

  it("rejects degraded rematerialization when no full-catalog last-good exists", () => {
    const decision = decideWarehouseServePublish(null, {
      mode: "verified_seed",
      project_count: 9,
      bbl_row_count: 86,
      rows: [],
    }, {
      isFullCatalog: isZapBblFullCatalog,
      label: "ZAP BBL",
    });
    assert.equal(decision.action, "reject");
  });

  it("flags collapsed Land place membership populations", () => {
    const healthy = readJson("site/data/land_place_membership.json");
    assert.deepEqual(landPlaceMembershipPopulationFindings(healthy), []);
    assert.ok(
      Object.keys(healthy.by_geography.nta2020).length >= LAND_PLACE_MIN_NTA_PLACE_COUNT,
    );

    const collapsed = structuredClone(healthy);
    collapsed.by_geography.nta2020 = {
      BK0102: ["2024K0240"],
      MN0502: ["2020M0429"],
    };
    for (const entry of Object.values(collapsed.by_project)) {
      entry.bbl_association_state = "absent_from_index";
      entry.valid_bbl_count = 0;
    }
    const findings = landPlaceMembershipPopulationFindings(collapsed);
    assert.ok(findings.some((f) => /nta2020 nonempty place count/.test(f)));
    assert.ok(findings.some((f) => /absent_from_index share/.test(f)));
  });
});
