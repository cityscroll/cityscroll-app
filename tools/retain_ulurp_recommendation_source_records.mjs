#!/usr/bin/env node
// Retain the existing ULURP recommendation-PDF feed as immutable observations.
//
//   node tools/retain_ulurp_recommendation_source_records.mjs --live --publish
//   node tools/retain_ulurp_recommendation_source_records.mjs --from-fixture
//   node tools/retain_ulurp_recommendation_source_records.mjs --check

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { extractUlurpKeys } from "../worker/src/lib/ulurp_recommendations_join.mjs";
import {
  retainAndMeasureUlurpRecommendationPdfs,
  USEFULNESS_FLOOR,
  PRECISION_FLOOR,
} from "../warehouse/lib/ulurp_recommendation_source_records.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test/fixtures/ulurp_recommendations/join_cases.json");
const ZAP = join(ROOT, "site/data/zap_projects_warehouse_lookup.json");
const EXISTING_LOOKUP = join(ROOT, "site/data/ulurp_recommendations_lookup.json");
const STAGE = join(ROOT, "warehouse/raw/ulurp-recommendation-pdfs-source-records");
const RECEIPT = join(STAGE, "receipt.json");
const SOURCE_RECORDS = join(STAGE, "source_records.jsonl");
const PUBLIC_RECEIPT = join(
  ROOT,
  "site/data/ulurp_recommendation_sources/verification_receipts/ulurp_recommendation_pdfs_source_records_2026-08-12.json",
);
const PRIOR_RECEIPT = join(
  ROOT,
  "site/data/ulurp_recommendation_sources/verification_receipts/ulurp_recommendations_2026-08-11.json",
);
const PROOF = join(ROOT, "warehouse/receipts/proof/ulurp_recommendation_pdf_source_records_latest.json");

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const writeJsonl = (path, rows) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
};

function parseArgs(argv) {
  const args = { live: false, fixture: false, publish: false, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--live") args.live = true;
    else if (value === "--from-fixture") args.fixture = true;
    else if (value === "--publish") args.publish = true;
    else if (value === "--check") args.check = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.live && !args.fixture && !args.check) args.fixture = true;
  return args;
}

async function fetchPdfRows() {
  const url = "https://data.cityofnewyork.us/resource/gt5i-dmde.json?$limit=50000";
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "CityScroll/1.0 (+https://cityscroll.org; ULURP source retention)",
    },
  });
  if (!response.ok) throw new Error(`SODA HTTP ${response.status}`);
  return response.json();
}

function fixturePdfRows() {
  return json(FIXTURE).cases.filter((row) => row.pdf).map((row) => row.pdf);
}

function zapRows() {
  const payload = json(ZAP);
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (rows.length >= 1000) return rows;
  // The committed warehouse is a capped sell-facing slice. Reuse the existing
  // exact-token ULURP lookup for the full-corpus join measurement; do not turn
  // the capped slice into a misleading zero-coverage result.
  const lookup = json(EXISTING_LOOKUP);
  return Object.keys(lookup.by_ulurp_key || {}).map((ulurp_numbers) => ({ ulurp_numbers }));
}

function check() {
  if (!existsSync(PUBLIC_RECEIPT)) throw new Error("missing published verification receipt");
  const receipt = json(PUBLIC_RECEIPT);
  if (receipt.gates?.materialize !== true) throw new Error("ULURP PDF retention gate is not accepted");
  if (receipt.measurement?.usefulness?.rate < USEFULNESS_FLOOR) throw new Error("usefulness below floor");
  if (receipt.measurement?.precision?.rate < PRECISION_FLOOR) throw new Error("precision below floor");
  console.log(`ulurp_recommendation_pdfs_source_records ok retained=${receipt.counts?.source_records} joined=${receipt.measurement?.usefulness?.joined}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) return check();
  const mode = args.live ? "live" : "fixture";
  const observedAt = args.live ? new Date().toISOString() : "2026-08-12T00:00:00.000Z";
  const pdfRows = args.live ? await fetchPdfRows() : fixturePdfRows();
  const priorMeasurement = existsSync(PRIOR_RECEIPT)
    ? json(PRIOR_RECEIPT).join_measurement
    : null;
  const result = retainAndMeasureUlurpRecommendationPdfs({
    pdfRows,
    zapRows: zapRows(),
    ingestedAt: observedAt,
    priorMeasurement,
  });
  const receipt = {
    schema: "cityscroll.ulurp_recommendation_pdf_source_records_verification.v1",
    observed_on: "2026-08-12",
    observed_at_utc: observedAt,
    mode,
    source: {
      id: "ulurp-recommendation-pdfs",
      dataset_id: "gt5i-dmde",
      resource: "https://data.cityofnewyork.us/resource/gt5i-dmde.json",
      row_count: result.counts.input_rows,
    },
    kill_sample: {
      strategy: mode === "live"
        ? "live Socrata PDF rows measured against the dated full-corpus exact-token receipt; capped ZAP warehouse retained as a fallback sample"
        : "committed ULURP recommendation fixture rows joined to committed ZAP warehouse",
      rejected: ["bare six-digit body", "title/project similarity", "Property Disposition records"],
    },
    counts: result.counts,
    measurement: result.measurement,
    gates: {
      usefulness_floor: USEFULNESS_FLOOR,
      precision_floor: PRECISION_FLOOR,
      materialize: result.measurement.gates.materialize,
    },
    materialize: result.measurement.gates.materialize,
    notes: [
      "Retention keeps publisher PDF rows as source_records-shaped snapshots; the public Land lookup remains unchanged.",
      "Source-null date, project, and PDF URL values remain null.",
      "The join is exact ULURP-token intersection; no fuzzy title matching is used.",
    ],
  };
  mkdirSync(STAGE, { recursive: true });
  writeJson(RECEIPT, { ...receipt, stage: relative(ROOT, STAGE) });
  writeJsonl(SOURCE_RECORDS, result.source_records);
  if (args.publish || result.measurement.gates.materialize) {
    writeJson(PUBLIC_RECEIPT, receipt);
    writeJson(PROOF, {
      schema: "cityscroll.ulurp_recommendation_pdf_source_records_proof.v1",
      observed_on: receipt.observed_on,
      materialize: receipt.materialize,
      counts: result.counts,
      usefulness: result.measurement.usefulness.rate,
      precision: result.measurement.precision.rate,
      verification_receipt: relative(ROOT, PUBLIC_RECEIPT),
    });
  }
  if (!receipt.materialize) {
    console.error("ULURP PDF source_records gate failed; staged rows are not promoted");
    process.exitCode = 2;
  }
  console.log(`ulurp_recommendation_pdfs_source_records retained=${result.counts.source_records} joined=${result.measurement.usefulness.joined} usefulness=${result.measurement.usefulness.rate} precision=${result.measurement.precision.rate} materialize=${receipt.materialize}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
