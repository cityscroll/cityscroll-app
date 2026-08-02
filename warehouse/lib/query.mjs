#!/usr/bin/env node
/**
 * DuckDB query seam for the app/ops layer (WH-01).
 *
 * Public product routes stay precompute-first (Worker cached read models). This
 * module is the local SQL interface future batch jobs and WH-03/WH-04 tooling
 * call instead of live Socrata fan-out.
 *
 * Implementation: spawn the warehouse Python query CLI (DuckDB lives in the
 * warehouse venv). No native node-duckdb dependency on the Worker path.
 *
 *   node warehouse/lib/query.mjs --sql "SELECT COUNT(*) AS n FROM ocp_recent_contract_awards"
 *   node warehouse/lib/query.mjs --sql-file warehouse/sql/examples/ocp_awards_by_agency.sql
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { catalogExists, duckdbPath, WAREHOUSE_DIR } from "./catalog.mjs";

function resolvePython() {
  const venvPy = join(WAREHOUSE_DIR, ".venv", "bin", "python");
  if (existsSync(venvPy)) return venvPy;
  return process.env.WAREHOUSE_PYTHON || "python3";
}

/**
 * Run SQL against the warehouse catalog. Returns parsed JSON rows.
 * @param {string} sql
 * @param {{ python?: string }} [opts]
 */
export function queryWarehouse(sql, opts = {}) {
  if (!catalogExists()) {
    throw new Error(
      `DuckDB catalog missing at ${duckdbPath()}. Run warehouse ingest first ` +
        `(see warehouse/README.md).`
    );
  }
  const python = opts.python || resolvePython();
  const script = join(WAREHOUSE_DIR, "scripts", "query.py");
  const r = spawnSync(python, [script, "--sql", sql, "--format", "json"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || "").trim() || `exit ${r.status}`;
    throw new Error(`warehouse query failed: ${err}`);
  }
  return JSON.parse(r.stdout);
}

/**
 * Example seam used by characterization tests / WH-03 planning.
 * Counts rows in the OCP awards view after the WH-01 proof ingest.
 */
export function exampleOcpAwardCount() {
  const rows = queryWarehouse(
    "SELECT COUNT(*) AS n FROM ocp_recent_contract_awards"
  );
  return Number(rows[0]?.n ?? 0);
}

function printHelp() {
  console.log(`Usage:
  node warehouse/lib/query.mjs --sql "SELECT ..."
  node warehouse/lib/query.mjs --sql-file warehouse/sql/examples/ocp_awards_by_agency.sql
`);
}

function cli(argv) {
  const args = argv.slice(2);
  let sql = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sql") sql = args[++i];
    else if (args[i] === "--sql-file") sql = readFileSync(args[++i], "utf8");
    else if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!sql) {
    console.error("Provide --sql or --sql-file");
    printHelp();
    process.exit(2);
  }
  try {
    const rows = queryWarehouse(sql);
    console.log(JSON.stringify(rows, null, 2));
  } catch (e) {
    console.error(String(e && e.message ? e.message : e));
    process.exit(1);
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  cli(process.argv);
}
