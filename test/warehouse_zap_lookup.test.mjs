/**
 * WH-05: warehouse ZAP lookup + materialization characterization.
 * Offline: pure index + fixture catalog (when venv present). No bulk download.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { WAREHOUSE_DIR, getDataset } from "../warehouse/lib/catalog.mjs";
import {
  buildMaterializationDoc,
  buildZapLookupIndex,
  loadProductSeedRows,
  lookupZapInIndex,
  parseCsv,
  rowToSodaShape,
  sqlZapByProjectId,
  ZAP_DATASET_KEY,
} from "../warehouse/lib/zap_lookup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOOKUP_SITE = join(ROOT, "site", "data", "zap_projects_warehouse_lookup.json");
const LOOKUP_WORKER = join(
  ROOT,
  "worker",
  "src",
  "data",
  "zap_projects_warehouse_lookup.json"
);
const SPEED_RECEIPT = join(
  ROOT,
  "warehouse",
  "receipts",
  "proof",
  "wh05_zap_lookup_speed.json"
);

describe("WH-05 pure ZAP materialization index", () => {
  it("hits by project_id; misses fall through", () => {
    const rows = [
      {
        project_id: "2022M0258",
        project_name: "Timbale Terrace",
        public_status: "Completed",
        project_status: "Complete",
        ulurp_numbers: "240046HAM; 240047PQM",
        borough: "Manhattan",
      },
    ];
    const index = buildZapLookupIndex(rows);
    const hit = lookupZapInIndex("2022M0258", index);
    assert.equal(hit.hit, true);
    assert.equal(hit.join_key, "project_id");
    assert.equal(hit.row.project_name, "Timbale Terrace");

    const miss = lookupZapInIndex("NOPE999", index);
    assert.equal(miss.hit, false);
    assert.equal(miss.row, null);

    const empty = lookupZapInIndex("", index);
    assert.equal(empty.hit, false);
  });

  it("product seed ships demo project_id 2022M0258", () => {
    const seed = loadProductSeedRows();
    assert.ok(seed.length >= 1);
    assert.ok(seed.some((r) => r.project_id === "2022M0258"));
    assert.ok(seed.every((r) => rowToSodaShape(r)));
  });

  it("parses quoted CSV fields with commas", () => {
    const text =
      'project_id,project_name,public_status\n' +
      'X001,"Name, with comma",Active\n';
    const rows = parseCsv(text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].project_name, "Name, with comma");
  });

  it("materialization doc names the replaced live fetch", () => {
    const doc = buildMaterializationDoc(
      [{ project_id: "X", project_name: "P" }],
      { mode: "test", now: "2026-08-02T00:00:00.000Z" }
    );
    assert.equal(doc.phase, "WH-05");
    assert.equal(doc.source, "warehouse");
    assert.match(doc.replaces_live_fetch.worker, /fetchOpenDataRow/);
    assert.equal(doc.replaces_live_fetch.soda_dataset, "hgx4-8ukb");
    assert.equal(getDataset(ZAP_DATASET_KEY).dataset_id, "hgx4-8ukb");
  });

  it("sqlZapByProjectId escapes and limits", () => {
    const sql = sqlZapByProjectId("2022M0258");
    assert.match(sql, /project_id/);
    assert.match(sql, /2022M0258/);
    assert.match(sql, /LIMIT 1/);
  });
});

describe("WH-05 committed materialization + speed receipt", () => {
  it("ships twin lookup artifacts with product demos", () => {
    assert.ok(existsSync(LOOKUP_SITE), "site/data lookup missing — run build script");
    assert.ok(existsSync(LOOKUP_WORKER), "worker/src/data lookup missing");
    const site = JSON.parse(readFileSync(LOOKUP_SITE, "utf8"));
    const worker = JSON.parse(readFileSync(LOOKUP_WORKER, "utf8"));
    assert.equal(site.schema_version, 1);
    assert.equal(site.phase, "WH-05");
    assert.ok(site.row_count >= 2);
    assert.deepEqual(site.rows, worker.rows);
    assert.ok(site.rows.some((r) => r.project_id === "2022M0258"));
  });

  it("ships optional speed receipt when present", () => {
    if (!existsSync(SPEED_RECEIPT)) return;
    const r = JSON.parse(readFileSync(SPEED_RECEIPT, "utf8"));
    assert.equal(r.phase, "WH-05");
    assert.equal(r.replaced_fetch.function, "fetchOpenDataRow");
    assert.equal(r.replaced_fetch.soda_dataset, "hgx4-8ukb");
  });

  it("fixture sample exists for offline ingest", () => {
    assert.ok(
      existsSync(join(WAREHOUSE_DIR, "fixtures", "zap-projects", "sample.csv"))
    );
    assert.ok(
      existsSync(join(WAREHOUSE_DIR, "sql", "examples", "zap_bulk_verify.sql"))
    );
  });
});
