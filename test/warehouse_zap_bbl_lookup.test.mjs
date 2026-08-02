/**
 * WH-06: warehouse ZAP BBL lookup + materialization characterization.
 * Offline: pure index + fixture catalog (when venv present). No bulk download.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { WAREHOUSE_DIR, getDataset } from "../warehouse/lib/catalog.mjs";
import {
  buildBblMaterializationDoc,
  buildZapBblLookupIndex,
  groupBblRowsByProject,
  loadBblProductSeedRows,
  loadBblSampleRows,
  lookupZapBblsInIndex,
  parseCsv,
  rowToBblShape,
  sqlBblsByProjectId,
  ZAP_BBL_DATASET_KEY,
} from "../warehouse/lib/zap_bbl_lookup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOOKUP_SITE = join(ROOT, "site", "data", "zap_bbl_warehouse_lookup.json");
const LOOKUP_WORKER = join(
  ROOT,
  "worker",
  "src",
  "data",
  "zap_bbl_warehouse_lookup.json"
);
const SPEED_RECEIPT = join(
  ROOT,
  "warehouse",
  "receipts",
  "proof",
  "wh06_zap_bbl_lookup_speed.json"
);

describe("WH-06 pure ZAP BBL materialization index", () => {
  it("hits by project_id; misses fall through", () => {
    const grouped = groupBblRowsByProject([
      { project_id: "2022M0258", bbl: "1017670001" },
      { project_id: "2022M0258", bbl: "1017670002" },
      { project_id: "OTHER", bbl: "2000010001" },
    ]);
    const index = buildZapBblLookupIndex(grouped);
    const hit = lookupZapBblsInIndex("2022M0258", index);
    assert.equal(hit.hit, true);
    assert.equal(hit.join_key, "project_id");
    assert.deepEqual(hit.bbls, ["1017670001", "1017670002"]);

    const miss = lookupZapBblsInIndex("NOPE999", index);
    assert.equal(miss.hit, false);
    assert.deepEqual(miss.bbls, []);

    const empty = lookupZapBblsInIndex("", index);
    assert.equal(empty.hit, false);
  });

  it("product seed ships demo project_id 2022M0258 with 10-digit BBLs", () => {
    const seed = loadBblProductSeedRows();
    assert.ok(seed.length >= 1);
    assert.ok(seed.some((r) => r.project_id === "2022M0258"));
    assert.ok(seed.every((r) => rowToBblShape(r)));
    assert.ok(seed.every((r) => /^\d{10}$/.test(r.bbl)));
  });

  it("sample fixture includes synthetic FIXZAP001 lots", () => {
    const sample = loadBblSampleRows();
    assert.ok(sample.some((r) => r.project_id === "FIXZAP001"));
  });

  it("pads short numeric BBLs and rejects garbage", () => {
    assert.equal(rowToBblShape({ project_id: "X", bbl: "17670001" })?.bbl, "0017670001");
    assert.equal(rowToBblShape({ project_id: "X", bbl: "not-a-bbl" }), null);
    assert.equal(rowToBblShape({ project_id: "", bbl: "1017670001" }), null);
  });

  it("materialization doc names the replaced live fetch", () => {
    const doc = buildBblMaterializationDoc(
      [{ project_id: "X", bbls: ["1017670001"] }],
      { mode: "test", now: "2026-08-02T00:00:00.000Z" }
    );
    assert.equal(doc.phase, "WH-06");
    assert.equal(doc.source, "warehouse");
    assert.match(doc.replaces_live_fetch.worker, /fetchBbls/);
    assert.equal(doc.replaces_live_fetch.soda_dataset, "2iga-a6mk");
    assert.equal(getDataset(ZAP_BBL_DATASET_KEY).dataset_id, "2iga-a6mk");
    assert.equal(doc.project_count, 1);
    assert.equal(doc.bbl_row_count, 1);
  });

  it("sqlBblsByProjectId escapes and limits", () => {
    const sql = sqlBblsByProjectId("2022M0258");
    assert.match(sql, /project_id/);
    assert.match(sql, /2022M0258/);
    assert.match(sql, /LIMIT 40/);
  });

  it("parses quoted CSV fields with commas", () => {
    const text =
      'project_id,bbl,validated_borough\n' +
      'X001,1017670001,"Manhattan, NY"\n';
    const rows = parseCsv(text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].validated_borough, "Manhattan, NY");
  });
});

describe("WH-06 committed materialization artifacts", () => {
  it("ships site + worker lookup twins with demo project", () => {
    assert.ok(existsSync(LOOKUP_SITE), "run node tools/build_zap_bbl_warehouse_lookup.mjs --fixture");
    assert.ok(existsSync(LOOKUP_WORKER));
    const site = JSON.parse(readFileSync(LOOKUP_SITE, "utf8"));
    const worker = JSON.parse(readFileSync(LOOKUP_WORKER, "utf8"));
    assert.equal(site.schema_version, 1);
    assert.equal(site.phase, "WH-06");
    assert.equal(site.dataset_id, "2iga-a6mk");
    assert.ok(site.project_count >= 1);
    assert.ok(site.rows.some((r) => r.project_id === "2022M0258" && r.bbls?.length));
    assert.deepEqual(site.rows, worker.rows);
  });

  it("ships speed receipt naming fetchBbls", () => {
    assert.ok(existsSync(SPEED_RECEIPT), "run build with --bench");
    const receipt = JSON.parse(readFileSync(SPEED_RECEIPT, "utf8"));
    assert.equal(receipt.phase, "WH-06");
    assert.equal(receipt.replaced_fetch.function, "fetchBbls");
    assert.equal(receipt.replaced_fetch.soda_dataset, "2iga-a6mk");
  });

  it("fixture path under warehouse/fixtures/zap-bbl", () => {
    assert.ok(existsSync(join(WAREHOUSE_DIR, "fixtures", "zap-bbl", "sample.csv")));
    assert.ok(existsSync(join(WAREHOUSE_DIR, "fixtures", "zap-bbl", "product_seed.csv")));
    assert.ok(existsSync(join(WAREHOUSE_DIR, "sql", "examples", "zap_bbl_bulk_verify.sql")));
  });
});
