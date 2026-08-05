/**
 * WH-01 warehouse scaffold characterization.
 * Structure + registry + (when catalog present) query seam.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import {
  WAREHOUSE_DIR,
  DATASETS_PATH,
  loadRegistry,
  getDataset,
  listDatasets,
  duckdbPath,
  catalogExists,
} from "../warehouse/lib/catalog.mjs";
import {
  DEFAULT_QUERY_MAX_BUFFER_BYTES,
  queryWarehouse,
  exampleOcpAwardCount,
} from "../warehouse/lib/query.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GITIGNORE = readFileSync(join(ROOT, ".gitignore"), "utf8");

describe("WH-01 warehouse scaffold layout", () => {
  it("keeps warehouse code + fixtures in-repo", () => {
    assert.ok(existsSync(join(WAREHOUSE_DIR, "README.md")));
    assert.ok(existsSync(DATASETS_PATH));
    assert.ok(existsSync(join(WAREHOUSE_DIR, "scripts", "ingest.py")));
    assert.ok(existsSync(join(WAREHOUSE_DIR, "scripts", "cpu_guard.py")));
    assert.ok(existsSync(join(WAREHOUSE_DIR, "lib", "query.mjs")));
    assert.ok(
      existsSync(
        join(
          WAREHOUSE_DIR,
          "fixtures",
          "ocp-recent-contract-awards",
          "sample.csv"
        )
      )
    );
    assert.ok(
      existsSync(join(WAREHOUSE_DIR, "sql", "examples", "ocp_awards_by_agency.sql"))
    );
  });

  it("gitignores bulk raw/parquet/duckdb and the venv", () => {
    assert.match(GITIGNORE, /warehouse\/raw\//);
    assert.match(GITIGNORE, /warehouse\/parquet\//);
    assert.match(GITIGNORE, /warehouse\/duckdb\//);
    assert.match(GITIGNORE, /warehouse\/\.venv\//);
    assert.match(GITIGNORE, /warehouse\/\.ingest\.lock/);
  });
});

describe("WH-01 dataset registry", () => {
  it("loads parameterized datasets with CPU defaults", () => {
    const reg = loadRegistry();
    assert.equal(reg.schema_version, 1);
    assert.equal(reg.defaults.one_job_at_a_time, true);
    assert.equal(reg.defaults.cpu_wrap, true);
    assert.equal(reg.defaults.headroom_gate, true);
    assert.ok(reg.defaults.max_rows_default <= 100);

    const ocp = getDataset("ocp-recent-contract-awards");
    assert.equal(ocp.dataset_id, "qyyg-4tf5");
    assert.equal(ocp.table_name, "ocp_recent_contract_awards");
    assert.equal(ocp.kind, "socrata");
    assert.ok(ocp.default_limit <= 100);

    const ids = listDatasets().map((d) => d.id);
    assert.ok(ids.includes("city-record"));
    assert.ok(ids.includes("doing-business-entities"));
  });
});

describe("WH-01 CPU guard contract (python unit)", () => {
  it("enforces row caps without --ack-large", () => {
    const py = existsSync(join(WAREHOUSE_DIR, ".venv", "bin", "python"))
      ? join(WAREHOUSE_DIR, ".venv", "bin", "python")
      : "python3";
    const code = `
import sys
sys.path.insert(0, "warehouse/scripts")
from cpu_guard import enforce_row_cap
try:
    enforce_row_cap(5000, {"max_rows_hard_cap": 10000, "require_ack_above": 1000}, ack_large=False)
    print("FAIL_ALLOWED")
except SystemExit as e:
    print("BLOCKED")
assert enforce_row_cap(50, {"max_rows_hard_cap": 10000, "require_ack_above": 1000}, ack_large=False) == 50
print("OK")
`;
    const r = spawnSync(py, ["-c", code], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /BLOCKED/);
    assert.match(r.stdout, /OK/);
  });
});

function spawnWithLockRetry(cmd, args, opts, attempts = 8) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = spawnSync(cmd, args, opts);
    const out = `${last.stdout || ""}\n${last.stderr || ""}`;
    if (last.status === 0) return last;
    if (!/holds the lock|One job at a time/i.test(out)) return last;
    spawnSync("sleep", ["0.4"], { encoding: "utf8" });
  }
  return last;
}

describe("WH-01 proof ingest + query seam", () => {
  it("fixture ingest produces a countable DuckDB view", () => {
    const py = join(WAREHOUSE_DIR, ".venv", "bin", "python");
    if (!existsSync(py)) {
      // CI without venv: structural tests above still run.
      return;
    }
    // Retry when WH-04 ER tests hold the shared single-job lock.
    const ingest = spawnWithLockRetry(
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
    assert.equal(ingest.status, 0, ingest.stderr || ingest.stdout);
    assert.match(ingest.stdout, /OK/);
    assert.ok(catalogExists(), `expected catalog at ${duckdbPath()}`);

    const n = exampleOcpAwardCount();
    assert.equal(n, 5);

    const byAgency = queryWarehouse(
      "SELECT agency_name, COUNT(*) AS n FROM ocp_recent_contract_awards GROUP BY 1 ORDER BY agency_name"
    );
    assert.ok(byAgency.length >= 1);
    assert.ok(byAgency.every((r) => r.agency_name && Number(r.n) >= 1));

    const proof = join(
      WAREHOUSE_DIR,
      "receipts",
      "proof",
      "ocp-recent-contract-awards_latest.json"
    );
    assert.ok(existsSync(proof));
    const receipt = JSON.parse(readFileSync(proof, "utf8"));
    assert.equal(receipt.phase, "WH-01");
    assert.equal(receipt.raw.mode, "fixture");
    assert.equal(receipt.cpu_discipline.single_job_lock, true);
    assert.equal(receipt.cpu_discipline.duckdb_threads, 1);
  });

  it("carries bulk materialization results larger than the old 16 MiB transport cap", () => {
    if (!catalogExists()) return;
    assert.ok(DEFAULT_QUERY_MAX_BUFFER_BYTES >= 64 * 1024 * 1024);

    const dir = mkdtempSync(join(tmpdir(), "warehouse-query-buffer-"));
    const fakePython = join(dir, "fake-python");
    writeFileSync(
      fakePython,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([{ payload: "x".repeat(20 * 1024 * 1024) }]));\n`,
    );
    chmodSync(fakePython, 0o755);
    try {
      const rows = queryWarehouse("SELECT bulk_payload", { python: fakePython });
      assert.equal(rows[0].payload.length, 20 * 1024 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
