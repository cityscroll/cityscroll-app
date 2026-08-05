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
  buildMaterializationDoc as buildDbDoc,
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
  });
});

describe("WH-05 committed Doing Business materialization + speed receipt", () => {
  it("ships twin Doing Business lookup artifacts", () => {
    assert.ok(existsSync(DB_SITE), "site/data doing_business lookup missing — run build script");
    assert.ok(existsSync(DB_WORKER), "worker twin missing");
    const site = JSON.parse(readFileSync(DB_SITE, "utf8"));
    const worker = JSON.parse(readFileSync(DB_WORKER, "utf8"));
    assert.equal(site.schema_version, 1);
    assert.equal(site.phase, "WH-05");
    assert.equal(site.row_count, 0);
    assert.equal(site.mode, "live_fallback");
    assert.deepEqual(site.rows, worker.rows);
  });

  it("records speed receipt for Doing Business lookup", () => {
    assert.ok(existsSync(DB_SPEED), "doing-business speed receipt missing — rebuild with --bench");
    const db = JSON.parse(readFileSync(DB_SPEED, "utf8"));
    assert.equal(db.phase, "WH-05");
    assert.ok(db.edge_materialization_lookup.p50_ms < 5);
    assert.match(db.summary, /warehouse materialization/i);
  });
});
