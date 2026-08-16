#!/usr/bin/env node
// Retain the committed real ZAP project materialization as source_records-shaped
// snapshots and prove its existing graph edges meet the provenance contract.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRECISION_FLOOR,
  retainZapProjectSourceRecords,
  USEFULNESS_FLOOR,
} from "../warehouse/lib/zap_project_source_records.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOOKUP = join(ROOT, "site/data/zap_projects_warehouse_lookup.json");
const STAGE = join(ROOT, "warehouse/raw/zap-project-source-records");
const VERIFICATION = join(
  ROOT,
  "site/data/zap_project_sources/verification_receipts/zap_projects_source_records_2026-08-16.json",
);
const PROOF = join(ROOT, "warehouse/receipts/proof/zap_project_source_records_latest.json");

function parseArgs(argv) {
  const args = {
    check: false,
    publish: false,
    observedAt: null,
    stageDir: STAGE,
    verification: VERIFICATION,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") args.check = true;
    else if (arg === "--publish") args.publish = true;
    else if (arg === "--observed-at") args.observedAt = argv[++index];
    else if (arg === "--stage-dir") args.stageDir = resolve(argv[++index]);
    else if (arg === "--verification-receipt") args.verification = resolve(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function checkReceipt(path) {
  if (!existsSync(path)) throw new Error(`missing verification receipt ${relative(ROOT, path)}`);
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  if (!receipt.materialize || receipt.gates?.materialize !== true) {
    throw new Error("ZAP project source-record gate did not materialize");
  }
  if (
    receipt.measurement?.usefulness?.rate < USEFULNESS_FLOOR
    || receipt.measurement?.precision?.rate < PRECISION_FLOOR
  ) {
    throw new Error("ZAP project source-record verification fell below its gate");
  }
  console.log(
    `zap_project_source_records ok retained=${receipt.counts.retained} `
      + `edges=${receipt.counts.edges} usefulness=${receipt.measurement.usefulness.rate} `
      + `precision=${receipt.measurement.precision.rate}`,
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) return checkReceipt(args.verification);

  const lookup = JSON.parse(readFileSync(LOOKUP, "utf8"));
  const observedAt = args.observedAt || new Date().toISOString();
  const result = retainZapProjectSourceRecords(lookup.rows, { observedAt });
  const receipt = {
    schema: "cityscroll.zap_project_source_records_verification.v1",
    observed_on: observedAt.slice(0, 10),
    observed_at_utc: observedAt,
    source: {
      id: "zap-projects",
      dataset_id: lookup.dataset_id,
      resource: "https://data.cityofnewyork.us/resource/hgx4-8ukb.json",
      materialized_at: lookup.materialized_at,
      row_count: lookup.row_count,
    },
    counts: result.counts,
    blocked: result.blocked,
    measurement: result.measurement,
    gates: result.gates,
    materialize: result.gates.materialize,
    ratchet: {
      mode: "shadow_source_records_only",
      public_edge_totals_changed: false,
      admitted_edges: "existing graph links with complete source/method/confidence/time provenance",
      rejected_edges: "missing publisher project identity or missing provenance contract fields",
    },
    candidate_inventory: {
      already_dual_written: [
        "nyc-council-members",
        "city-clerk-elobbyist",
        "cfb-campaign-contributions",
      ],
      landed_here: "zap-projects",
      remaining_not_yet_dual_written: [],
    },
  };

  writeJson(join(args.stageDir, "receipt.json"), receipt);
  writeJsonl(join(args.stageDir, "source_records.jsonl"), result.source_records);
  if (args.publish) {
    writeJson(args.verification, receipt);
    writeJson(PROOF, {
      schema: "cityscroll.zap_project_source_records_proof.v1",
      observed_on: receipt.observed_on,
      materialize: receipt.materialize,
      counts: receipt.counts,
      usefulness: receipt.measurement.usefulness.rate,
      precision: receipt.measurement.precision.rate,
      verification_receipt: relative(ROOT, args.verification),
    });
  }
  if (!receipt.materialize) process.exitCode = 2;
  console.log(
    `zap_project_source_records retained=${receipt.counts.retained} `
      + `edges=${receipt.counts.edges} materialize=${receipt.materialize}`,
  );
}

main();
