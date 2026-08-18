/**
 * WH-05: warehouse materialization for Doing Business (ZAP covered by
 * warehouse_zap_lookup / zap_warehouse_lookup tests on main).
 * Offline: pure index + committed JSON. No bulk download.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  assertDoingBusinessServeGate,
  buildMaterializationDoc as buildDbDoc,
  DOING_BUSINESS_CANARIES,
  DOING_BUSINESS_PUBLISHER_ROW_COUNT,
  doingBusinessServeGateFindings,
  loadProductSeedRows as loadDbSeed,
  rowToSodaShape as dbShape,
} from "../warehouse/lib/doing_business_lookup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DB_SITE = join(ROOT, "site", "data", "doing_business_warehouse_lookup.json");
const DB_WORKER = join(
  ROOT,
  "worker",
  "src",
  "data",
  "doing_business_warehouse_lookup.json",
);
const DB_SPEED = join(
  ROOT,
  "warehouse",
  "receipts",
  "proof",
  "wh05_doing_business_lookup_speed.json",
);
const DB_BULK_PROOF = join(
  ROOT,
  "warehouse",
  "receipts",
  "proof",
  "doing-business-entities_bulk_latest.json",
);

describe("WH-05 pure Doing Business materialization", () => {
  it("product seed includes CAMBA field case", () => {
    const seed = loadDbSeed();
    assert.ok(seed.length >= 3);
    assert.ok(seed.some((r) => /CAMBA/i.test(r.organization_name)));
    assert.ok(seed.every((r) => dbShape(r)));
  });

  it("materialization doc names the replaced live fetch", () => {
    const doc = buildDbDoc(
      [{ organization_name: "CAMBA  INC", ownership_structure_code: "COR" }],
      { mode: "test", now: "2026-08-02T00:00:00.000Z" },
    );
    assert.equal(doc.phase, "WH-05");
    assert.equal(doc.source, "warehouse");
    assert.match(doc.replaces_live_fetch.worker, /attachDoingBusiness/);
    assert.equal(doc.replaces_live_fetch.soda_dataset, "72mk-a8z7");
    assert.equal(doc.publisher_row_count, DOING_BUSINESS_PUBLISHER_ROW_COUNT);
  });

  it("serve gate rejects empty live_fallback and accepts full bulk", () => {
    const emptyFindings = doingBusinessServeGateFindings({
      mode: "live_fallback",
      row_count: 0,
      rows: [],
      materialized_at: "2026-08-18T00:00:00.000Z",
    });
    assert.ok(emptyFindings.some((f) => /live_fallback|empty/i.test(f)));

    const okDoc = buildDbDoc(
      Array.from({ length: DOING_BUSINESS_PUBLISHER_ROW_COUNT }, (_, i) => ({
        organization_name: i === 0 ? "CAMBA  INC" : `Vendor ${String(i).padStart(5, "0")}`,
        ownership_structure_code: "COR",
      })),
      { mode: "bulk_warehouse", now: "2026-08-18T00:00:00.000Z" },
    );
    assert.equal(doingBusinessServeGateFindings(okDoc).length, 0);
    assert.equal(assertDoingBusinessServeGate(okDoc), true);
  });
});

describe("WH-05 committed Doing Business materialization + speed receipt", () => {
  it("ships twin Doing Business lookup artifacts within publisher drift", () => {
    assert.ok(existsSync(DB_SITE), "site/data doing_business lookup missing — run build script");
    assert.ok(existsSync(DB_WORKER), "worker twin missing");
    const site = JSON.parse(readFileSync(DB_SITE, "utf8"));
    const worker = JSON.parse(readFileSync(DB_WORKER, "utf8"));
    assert.equal(site.schema_version, 1);
    assert.equal(site.phase, "WH-05");
    assert.equal(site.mode, "bulk_warehouse");
    assert.equal(site.row_count, site.rows.length);
    assert.deepEqual(site.rows, worker.rows);
    assert.deepEqual(site.mode, worker.mode);
    assertDoingBusinessServeGate(site);
    for (const canary of DOING_BUSINESS_CANARIES) {
      assert.ok(
        site.rows.some((r) => r.organization_name === canary),
        `missing canary ${canary}`,
      );
    }
  });

  it("records WH-02 bulk proof + speed receipt for Doing Business", () => {
    assert.ok(existsSync(DB_BULK_PROOF), "doing-business bulk proof missing — run WH-02 ingest");
    const bulk = JSON.parse(readFileSync(DB_BULK_PROOF, "utf8"));
    assert.equal(bulk.dataset_id, "doing-business-entities");
    assert.equal(bulk.bulk, true);
    assert.equal(bulk.socrata_dataset_id, "72mk-a8z7");
    assert.equal(bulk.raw?.row_count, DOING_BUSINESS_PUBLISHER_ROW_COUNT);

    assert.ok(existsSync(DB_SPEED), "doing-business speed receipt missing — rebuild with --bench");
    const db = JSON.parse(readFileSync(DB_SPEED, "utf8"));
    assert.equal(db.phase, "WH-05");
    assert.ok(db.edge_materialization_lookup.p50_ms < 5);
    assert.ok(db.materialization.row_count >= 10000);
    assert.match(db.summary, /warehouse materialization/i);
  });
});
