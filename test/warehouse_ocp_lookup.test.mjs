/**
 * WH-03: warehouse OCP lookup + materialization characterization.
 * Offline: pure index + fixture catalog (when venv present). No bulk download.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { catalogExists, WAREHOUSE_DIR } from "../warehouse/lib/catalog.mjs";
import {
  buildMaterializationDoc,
  buildOcpLookupIndex,
  loadProductSeedRows,
  lookupOcpAwardRowsFromWarehouse,
  lookupOcpInIndex,
  rowToSodaShape,
  sqlOcpByRequestId,
} from "../warehouse/lib/ocp_lookup.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOOKUP_SITE = join(ROOT, "site", "data", "ocp_awards_warehouse_lookup.json");
const LOOKUP_WORKER = join(
  ROOT,
  "worker",
  "src",
  "data",
  "ocp_awards_warehouse_lookup.json"
);
const SPEED_RECEIPT = join(
  ROOT,
  "warehouse",
  "receipts",
  "proof",
  "wh03_ocp_lookup_speed.json"
);

describe("WH-03 pure OCP materialization index", () => {
  it("hits by request_id and pin; misses fall through", () => {
    const rows = [
      {
        request_id: "20260723031",
        start_date: "2026-07-30T00:00:00.000",
        pin: "81626W0043001",
        contract_amount: "250000",
        vendor_name: "Make it Zesty LLC",
        agency_name: "Health and Mental Hygiene",
        type_of_notice_description: "Award",
        short_title: "Catering Services",
      },
    ];
    const index = buildOcpLookupIndex(rows);
    const byId = lookupOcpInIndex({ request_id: "20260723031" }, index);
    assert.equal(byId.hit, true);
    assert.equal(byId.join_key, "request_id");
    assert.equal(byId.rows[0].vendor_name, "Make it Zesty LLC");

    const byPin = lookupOcpInIndex({ pin: "81626W0043001" }, index);
    assert.equal(byPin.hit, true);
    assert.equal(byPin.join_key, "pin");

    const miss = lookupOcpInIndex({ request_id: "nope", pin: "nope" }, index);
    assert.equal(miss.hit, false);

    const emptyKeys = lookupOcpInIndex({}, index);
    assert.equal(emptyKeys.hit, true);
    assert.equal(emptyKeys.rows.length, 0);
  });

  it("product seed ships real field-case request_ids", () => {
    const seed = loadProductSeedRows();
    assert.ok(seed.length >= 3);
    assert.ok(seed.some((r) => r.request_id === "20260723031"));
    assert.ok(seed.every((r) => rowToSodaShape(r)));
  });

  it("materialization doc names the replaced live fetch", () => {
    const doc = buildMaterializationDoc(
      [{ request_id: "X", pin: "P", contract_amount: "1" }],
      { mode: "test", now: "2026-08-02T00:00:00.000Z" }
    );
    assert.equal(doc.phase, "WH-03");
    assert.equal(doc.source, "warehouse");
    assert.match(doc.replaces_live_fetch.worker, /fetchOcpAwardRows/);
    assert.equal(doc.replaces_live_fetch.soda_dataset, "qyyg-4tf5");
  });
});

describe("WH-03 committed materialization + speed receipt", () => {
  it("ships twin lookup artifacts with product demos", () => {
    assert.ok(existsSync(LOOKUP_SITE), "site/data lookup missing — run build script");
    assert.ok(existsSync(LOOKUP_WORKER), "worker/src/data lookup missing");
    const site = JSON.parse(readFileSync(LOOKUP_SITE, "utf8"));
    const worker = JSON.parse(readFileSync(LOOKUP_WORKER, "utf8"));
    assert.equal(site.schema_version, 1);
    assert.equal(site.phase, "WH-03");
    assert.ok(site.row_count >= 3);
    assert.deepEqual(site.rows, worker.rows);
    const ids = new Set(site.rows.map((r) => r.request_id));
    assert.ok(ids.has("20260723031"), "catering field-case must be materializable");
  });

  it("records a measured speed receipt for the OCP fetch replacement", () => {
    assert.ok(existsSync(SPEED_RECEIPT), "speed receipt missing — run build with --bench");
    const r = JSON.parse(readFileSync(SPEED_RECEIPT, "utf8"));
    assert.equal(r.phase, "WH-03");
    assert.equal(r.replaced_fetch.function, "fetchOcpAwardRows");
    assert.equal(r.replaced_fetch.soda_dataset, "qyyg-4tf5");
    assert.ok(r.materialized_index_edge_path);
    assert.ok(
      r.materialized_index_edge_path.p50_ms < 5,
      "materialized index should be sub-5ms"
    );
    if (r.soda_live_previous_path && r.soda_live_previous_path.p50_ms != null) {
      assert.ok(
        r.speedup && r.speedup.summary,
        "expected speedup summary when SODA was reachable"
      );
    }
  });
});

describe("WH-03 DuckDB query seam (when catalog present)", () => {
  it("looks up fixture rows by request_id without SODA", () => {
    if (!catalogExists()) return;
    const py = join(WAREHOUSE_DIR, ".venv", "bin", "python");
    if (!existsSync(py)) return;

    // Ensure fixture catalog is warm (idempotent).
    spawnSync(
      py,
      [
        join(WAREHOUSE_DIR, "scripts", "ingest.py"),
        "--dataset",
        "ocp-recent-contract-awards",
        "--from-fixture",
        "--limit",
        "5",
        "--force-headroom",
      ],
      { cwd: ROOT, encoding: "utf8" }
    );

    assert.match(sqlOcpByRequestId("FIX001"), /request_id/);
    const r = lookupOcpAwardRowsFromWarehouse({ request_id: "FIX001" });
    assert.equal(r.ok, true);
    assert.equal(r.path, "warehouse");
    assert.ok(r.rows.length >= 1);
    assert.equal(r.rows[0].request_id, "FIX001");
    assert.equal(r.rows[0].vendor_name, "FIXTURE VENDOR A");
  });
});
