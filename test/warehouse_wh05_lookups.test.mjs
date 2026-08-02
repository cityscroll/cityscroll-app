/**
 * WH-05: warehouse materializations for Doing Business + ZAP projects.
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
import {
  buildMaterializationDoc as buildZapDoc,
  buildZapLookupIndex,
  loadProductSeedRows as loadZapSeed,
  lookupZapInIndex,
  rowToSodaShape as zapShape,
} from "../warehouse/lib/zap_projects_lookup.mjs";

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

const ZAP_SITE = join(ROOT, "site", "data", "zap_projects_warehouse_lookup.json");
const ZAP_WORKER = join(
  ROOT,
  "worker",
  "src",
  "data",
  "zap_projects_warehouse_lookup.json",
);
const ZAP_SPEED = join(
  ROOT,
  "warehouse",
  "receipts",
  "proof",
  "wh05_zap_projects_lookup_speed.json",
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

describe("WH-05 pure ZAP projects materialization", () => {
  it("product seed ships Active ULURP project_ids", () => {
    const seed = loadZapSeed();
    assert.ok(seed.length >= 5);
    assert.ok(seed.every((r) => zapShape(r)?.project_id));
    const index = buildZapLookupIndex(seed);
    const first = seed[0].project_id;
    const hit = lookupZapInIndex(first, index);
    assert.equal(hit.hit, true);
    assert.equal(hit.row.project_id, first);
    const miss = lookupZapInIndex("NOT-A-REAL-PROJECT", index);
    assert.equal(miss.hit, false);
  });

  it("materialization doc names the replaced live fetch", () => {
    const doc = buildZapDoc(
      [{ project_id: "2024Q0135", project_name: "Test", project_status: "Active" }],
      { mode: "test", now: "2026-08-02T00:00:00.000Z" },
    );
    assert.equal(doc.phase, "WH-05");
    assert.match(doc.replaces_live_fetch.worker, /fetchOpenDataRow/);
    assert.equal(doc.replaces_live_fetch.soda_dataset, "hgx4-8ukb");
  });
});

describe("WH-05 committed materializations + speed receipts", () => {
  it("ships twin Doing Business lookup artifacts", () => {
    assert.ok(existsSync(DB_SITE), "site/data doing_business lookup missing — run build script");
    assert.ok(existsSync(DB_WORKER), "worker twin missing");
    const site = JSON.parse(readFileSync(DB_SITE, "utf8"));
    const worker = JSON.parse(readFileSync(DB_WORKER, "utf8"));
    assert.equal(site.schema_version, 1);
    assert.equal(site.phase, "WH-05");
    assert.ok(site.row_count >= 3);
    assert.deepEqual(site.rows, worker.rows);
    assert.ok(site.rows.some((r) => /CAMBA/i.test(r.organization_name)));
  });

  it("ships twin ZAP projects lookup artifacts", () => {
    assert.ok(existsSync(ZAP_SITE), "site/data zap_projects lookup missing — run build script");
    assert.ok(existsSync(ZAP_WORKER), "worker twin missing");
    const site = JSON.parse(readFileSync(ZAP_SITE, "utf8"));
    const worker = JSON.parse(readFileSync(ZAP_WORKER, "utf8"));
    assert.equal(site.schema_version, 1);
    assert.equal(site.phase, "WH-05");
    assert.ok(site.row_count >= 5);
    assert.deepEqual(site.rows, worker.rows);
  });

  it("records speed receipts for both lookups", () => {
    assert.ok(existsSync(DB_SPEED), "doing-business speed receipt missing — rebuild with --bench");
    assert.ok(existsSync(ZAP_SPEED), "zap projects speed receipt missing — rebuild with --bench");
    const db = JSON.parse(readFileSync(DB_SPEED, "utf8"));
    const zap = JSON.parse(readFileSync(ZAP_SPEED, "utf8"));
    assert.equal(db.phase, "WH-05");
    assert.equal(zap.phase, "WH-05");
    assert.ok(db.edge_materialization_lookup.p50_ms < 5);
    assert.ok(zap.edge_materialization_lookup.p50_ms < 5);
    assert.match(db.summary, /warehouse materialization/i);
    assert.match(zap.summary, /warehouse materialization/i);
  });
});
