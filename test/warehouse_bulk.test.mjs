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
    assert.equal(cr.bulk_phase, "WH-07");
    assert.equal(cr.bulk_paging.page_size, 50000);
    assert.match(cr.bulk_paging.order, /request_id/);

    const ids = listDatasets().map((d) => d.id);
    assert.ok(ids.includes("doing-business-entities"));
  });

  it("ships verify SQL and bulk sample slot for OCP + ZAP + BBL", () => {
    assert.ok(
      existsSync(join(WAREHOUSE_DIR, "sql", "examples", "ocp_bulk_verify.sql"))
    );
    assert.ok(
      existsSync(join(WAREHOUSE_DIR, "sql", "examples", "zap_bulk_verify.sql"))
    );
    assert.ok(
      existsSync(join(WAREHOUSE_DIR, "sql", "examples", "zap_bbl_bulk_verify.sql"))
    );
    assert.ok(existsSync(join(WAREHOUSE_DIR, "scripts", "write_load_manifest.py")));
    assert.ok(
      existsSync(join(WAREHOUSE_DIR, "fixtures", "zap-projects", "sample.csv"))
    );
    assert.ok(
      existsSync(join(WAREHOUSE_DIR, "fixtures", "zap-bbl", "sample.csv"))
    );
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

describe("WH-07 City Record resumable paging", () => {
  it("builds stable page URLs and merges receipt profiles", () => {
    const r = spawnSync(
      pyBin(),
      [
        "-c",
        `
import sys
sys.path.insert(0, "warehouse/scripts")
from socrata_fetch import soda_csv_page_url, _merge_profiles
url = soda_csv_page_url("https://example.test", "abcd-1234", limit=50000, offset=100000, order="start_date DESC, request_id DESC")
assert "%24offset=100000" in url
assert "request_id+DESC" in url
p = _merge_profiles([
  {"start_date_min": "2016-01-01", "start_date_max": "2020-01-01", "section_counts": {"Agency Rules": 2}},
  {"start_date_min": "2015-01-01", "start_date_max": "2026-01-01", "section_counts": {"Agency Rules": 3, "Property Disposition": 4}},
])
assert p["start_date_min"] == "2015-01-01"
assert p["start_date_max"] == "2026-01-01"
assert p["section_counts"]["Agency Rules"] == 5
assert p["section_counts"]["Property Disposition"] == 4
print("OK")
`,
      ],
      { cwd: ROOT, encoding: "utf8" }
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /OK/);
  });

  it("ships the City Record verification query", () => {
    const sql = readFileSync(
      join(WAREHOUSE_DIR, "sql", "examples", "city_record_bulk_verify.sql"),
      "utf8"
    );
    assert.match(sql, /MIN\(start_date\)/);
    assert.match(sql, /Agency Rules/);
    assert.match(sql, /Property Disposition/);
  });

  it("commits the historical snapshot proof with prediction-program sections", () => {
    const proof = JSON.parse(
      readFileSync(
        join(
          WAREHOUSE_DIR,
          "receipts",
          "proof",
          "city-record_bulk_latest.json"
        ),
        "utf8"
      )
    );
    assert.equal(proof.phase, "WH-07");
    assert.ok(proof.register.row_count > 1_000_000);
    assert.ok(proof.snapshot_profile.start_date_min);
    assert.ok(proof.snapshot_profile.start_date_max);
    assert.ok(proof.snapshot_profile.section_counts["Agency Rules"] > 0);
    assert.ok(proof.snapshot_profile.section_counts["Property Disposition"] > 0);
    assert.equal(proof.raw.paging.resumable, true);
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
    assert.ok(m.next_dataset || m.remaining_primary_queue.length === 0);
    if (m.loaded.length) {
      const first = m.loaded[0];
      assert.ok(first.raw_sha256);
      assert.ok(Number(first.row_count) > 1000);
      assert.ok(first.proof_receipt.includes("bulk_latest"));
    }
    // WH-05: zap-projects is second bulk pack when proof receipt is present.
    const zapProof = join(
      WAREHOUSE_DIR,
      "receipts",
      "proof",
      "zap-projects_bulk_latest.json"
    );
    if (existsSync(zapProof)) {
      const zap = m.loaded.find((x) => x.dataset_id === "zap-projects");
      assert.ok(zap, "manifest should list zap-projects after bulk proof exists");
      assert.equal(zap.socrata_dataset_id, "hgx4-8ukb");
      assert.ok(Number(zap.row_count) > 1000);
      assert.ok(!m.remaining_primary_queue.includes("zap-projects"));
    }
  });
});

// Fixture ingest → DuckDB is characterized in warehouse_scaffold.test.mjs
// (one job at a time — do not parallel-run a second fixture ingest here).
