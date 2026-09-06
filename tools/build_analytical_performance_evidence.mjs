#!/usr/bin/env node
/** Build AP-10's source-bounded public performance-evidence coverage. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PERFORMANCE_EVIDENCE_ANALYTICAL_PROJECTION_URL,
  PERFORMANCE_EVIDENCE_SOURCE_COVERAGE,
  assertNoPerformanceOverclaim,
  projectPerformanceEvidenceCoverage,
} from "../site/analytical_performance_evidence.mjs";
import { readAnalyticalProjectionDocument } from "./lib/analytical_projection_io.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONTRACTS = resolve(ROOT, "site/data/analytics_registered_contracts.json");
const DEFAULT_EVIDENCE = resolve(ROOT, "site/data/performance_evidence_sources.json");
const DEFAULT_OUTPUT = resolve(ROOT, "site", PERFORMANCE_EVIDENCE_ANALYTICAL_PROJECTION_URL);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--check") result.check = true;
    else if (["--contracts", "--evidence", "--output"].includes(key)) result[key.slice(2)] = resolve(argv[++i]);
    else if (key === "--help" || key === "-h") result.help = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  return result;
}

function rowsFrom(payload) {
  return Array.isArray(payload) ? payload : Array.isArray(payload?.rows) ? payload.rows : [];
}

function build({ contracts = DEFAULT_CONTRACTS, evidence = DEFAULT_EVIDENCE, output = DEFAULT_OUTPUT, check = false } = {}) {
  const contractPayload = readAnalyticalProjectionDocument(contracts);
  const evidencePayload = existsSync(evidence) ? readJson(evidence) : { rows: [] };
  const projection = projectPerformanceEvidenceCoverage(
    rowsFrom(contractPayload),
    rowsFrom(evidencePayload),
    {
      generated_at: contractPayload.generated_at || null,
      snapshot_date: contractPayload.snapshot_date || null,
      source_coverage: evidencePayload.source_coverage || PERFORMANCE_EVIDENCE_SOURCE_COVERAGE,
    },
  );
  projection.inputs = {
    registered_contract_projection: "site/data/analytics_registered_contracts.json",
    accepted_evidence_rows: rowsFrom(evidencePayload).length,
    evidence_input: evidence === DEFAULT_EVIDENCE ? "site/data/performance_evidence_sources.json" : evidence,
  };
  assertNoPerformanceOverclaim(projection);
  mkdirSync(dirname(output), { recursive: true });
  const serialized = `${JSON.stringify(projection, null, 2)}\n`;
  if (check) {
    const current = readFileSync(output, "utf8");
    if (current !== serialized) throw new Error(`stale analytical performance evidence projection: ${output}`);
  } else {
    writeFileSync(output, serialized);
  }
  return projection;
}

const parsed = args(process.argv.slice(2));
if (parsed.help) {
  console.log("Usage: node tools/build_analytical_performance_evidence.mjs [--contracts path] [--evidence path] [--output path] [--check]");
} else {
  const projection = build(parsed);
  console.log(`${parsed.check ? "analytical performance evidence current" : "wrote analytical performance evidence"}: contracts=${projection.rows.length}`);
}

export { build };
