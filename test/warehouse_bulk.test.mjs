/**
 * WH-02 bulk pack characterization (no network, no multi-MB bulk in CI).
 * Structure + CLI contracts + optional offline fixture path still green.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import {
  WAREHOUSE_DIR,
  loadRegistry,
  getDataset,
  listDatasets,
} from "../warehouse/lib/catalog.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function pyBin() {
  const venv = join(WAREHOUSE_DIR, ".venv", "bin", "python");
  return existsSync(venv) ? venv : "python3";
}

describe("WH-02 registry + pack plan", () => {
  it("registers ZAP + primary queue and names OCP as first pick", () => {
    const reg = loadRegistry();
    assert.ok(reg.wh02_pack);
    assert.equal(reg.wh02_pack.first_pick, "ocp-recent-contract-awards");
    assert.deepEqual(reg.wh02_pack.queue, [
      "ocp-recent-contract-awards",
      "zap-projects",
      "zap-bbl",
      "city-record",
    ]);

    const ocp = getDataset("ocp-recent-contract-awards");
    assert.equal(ocp.dataset_id, "qyyg-4tf5");
    assert.equal(ocp.wh02_full_export, true);

    const zap = getDataset("zap-projects");
    assert.equal(zap.dataset_id, "hgx4-8ukb");
    assert.equal(zap.table_name, "zap_projects");

    const bbl = getDataset("zap-bbl");
    assert.equal(bbl.dataset_id, "2iga-a6mk");

    const cr = getDataset("city-record");
    assert.equal(cr.dataset_id, "dg92-zbpx");

    const ids = listDatasets().map((d) => d.id);
    assert.ok(ids.includes("doing-business-entities"));
  });

  it("ships verify SQL and bulk sample slot for OCP", () => {
    assert.ok(
      existsSync(join(WAREHOUSE_DIR, "sql", "examples", "ocp_bulk_verify.sql"))
    );
    assert.ok(existsSync(join(WAREHOUSE_DIR, "scripts", "write_load_manifest.py")));
  });
});

describe("WH-02 column map (bulk headers → SODA fieldNames)", () => {
  it("builds SELECT aliases for product-aligned columns", () => {
    const r = spawnSync(
      pyBin(),
      [
        "-c",
        `
import sys
sys.path.insert(0, "warehouse/scripts")
from convert_parquet import build_select_list
sql = build_select_list(
    ["RequestID", "AgencyName", "PIN"],
    {"RequestID": "request_id", "AgencyName": "agency_name", "PIN": "pin"},
)
assert "request_id" in sql and "agency_name" in sql and "pin" in sql
assert '"RequestID"' in sql
assert build_select_list(["a"], None) == "*"
print("OK")
`,
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /OK/);
  });
});

describe("WH-02 bulk CLI contracts", () => {
  it("refuses --bulk without --ack-large", () => {
    const r = spawnSync(
      pyBin(),
      [
        join(WAREHOUSE_DIR, "scripts", "ingest.py"),
        "--dataset",
        "ocp-recent-contract-awards",
        "--bulk",
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    assert.notEqual(r.status, 0);
    const out = `${r.stdout || ""}\n${r.stderr || ""}`;
    assert.match(out, /--ack-large/);
  });

  it("refuses --bulk + --from-fixture", () => {
    const r = spawnSync(
      pyBin(),
      [
        join(WAREHOUSE_DIR, "scripts", "ingest.py"),
        "--dataset",
        "ocp-recent-contract-awards",
        "--bulk",
        "--ack-large",
        "--from-fixture",
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    assert.notEqual(r.status, 0);
    const out = `${r.stdout || ""}\n${r.stderr || ""}`;
    assert.match(out, /Cannot combine/);
  });
});

describe("WH-02 load manifest shape (when present)", () => {
  it("manifest documents loaded vs remaining without embedding bulk bytes", () => {
    const path = join(WAREHOUSE_DIR, "manifests", "wh02_load_manifest.json");
    if (!existsSync(path)) {
      // Manifest is produced after a successful bulk run; structural tests above still run.
      return;
    }
    const m = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(m.phase, "WH-02");
    assert.equal(m.git_policy.commit_raw_bulk, false);
    assert.equal(m.git_policy.commit_parquet_bulk, false);
    assert.ok(Array.isArray(m.loaded));
    assert.ok(Array.isArray(m.remaining_primary_queue));
    assert.ok(m.next_dataset);
    if (m.loaded.length) {
      const first = m.loaded[0];
      assert.ok(first.raw_sha256);
      assert.ok(Number(first.row_count) > 1000);
      assert.ok(first.proof_receipt.includes("bulk_latest"));
    }
  });
});

// Fixture ingest → DuckDB is characterized in warehouse_scaffold.test.mjs
// (one job at a time — do not parallel-run a second fixture ingest here).
