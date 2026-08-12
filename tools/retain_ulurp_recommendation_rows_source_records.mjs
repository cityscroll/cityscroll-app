#!/usr/bin/env node
// Retain the existing Borough President recommendation feed as immutable observations.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  retainAndMeasureUlurpRecommendations,
  USEFULNESS_FLOOR,
  PRECISION_FLOOR,
} from "../warehouse/lib/ulurp_recommendation_rows_source_records.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test/fixtures/ulurp_recommendations/join_cases.json");
const STAGE = join(ROOT, "warehouse/raw/ulurp-recommendations-source-records");
const PUBLIC_RECEIPT = join(ROOT, "site/data/ulurp_recommendation_sources/verification_receipts/ulurp_recommendations_source_records_2026-08-12.json");
const PROOF = join(ROOT, "warehouse/receipts/proof/ulurp_recommendation_source_records_latest.json");
const PRIOR = join(ROOT, "site/data/ulurp_recommendation_sources/verification_receipts/ulurp_recommendations_2026-08-11.json");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };
const writeJsonl = (path, rows) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`); };

function args(argv) {
  const out = { live: false, fixture: false, publish: false, check: false };
  for (const value of argv) {
    if (value === "--live") out.live = true;
    else if (value === "--from-fixture") out.fixture = true;
    else if (value === "--publish") out.publish = true;
    else if (value === "--check") out.check = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!out.live && !out.fixture && !out.check) out.fixture = true;
  return out;
}

async function liveRows() {
  const response = await fetch("https://data.cityofnewyork.us/resource/4j6i-9rmr.json?$limit=50000", { headers: { Accept: "application/json", "User-Agent": "CityScroll/1.0 (+https://cityscroll.org; ULURP source retention)" } });
  if (!response.ok) throw new Error(`SODA HTTP ${response.status}`);
  return response.json();
}

function fixtureRows() {
  return json(FIXTURE).cases.filter((row) => row.recommendation).map((row) => row.recommendation);
}

function check() {
  const receipt = json(PUBLIC_RECEIPT);
  if (receipt.materialize !== true || receipt.measurement.usefulness.rate < USEFULNESS_FLOOR || receipt.measurement.precision.rate < PRECISION_FLOOR) throw new Error("ULURP recommendation source-record gate is not accepted");
  console.log(`ulurp_recommendations_source_records ok retained=${receipt.counts.source_records} joined=${receipt.counts.joined}`);
}

async function main() {
  const options = args(process.argv.slice(2));
  if (options.check) return check();
  const mode = options.live ? "live" : "fixture";
  const observedAt = options.live ? new Date().toISOString() : "2026-08-12T00:00:00.000Z";
  const result = retainAndMeasureUlurpRecommendations({
    rows: options.live ? await liveRows() : fixtureRows(),
    ingestedAt: observedAt,
    priorMeasurement: existsSync(PRIOR) ? json(PRIOR).join_measurement : null,
  });
  const receipt = {
    schema: "cityscroll.ulurp_recommendation_source_records_verification.v1",
    observed_on: "2026-08-12",
    observed_at_utc: observedAt,
    mode,
    source: { id: "ulurp-recommendations", dataset_id: "4j6i-9rmr", resource: "https://data.cityofnewyork.us/resource/4j6i-9rmr.json", row_count: result.counts.input_rows },
    kill_sample: { strategy: "dated full-corpus exact ULURP-token receipt", rejected: ["title/project similarity", "bare six-digit body", "Property Disposition records"] },
    counts: result.counts,
    measurement: result.measurement,
    gates: { usefulness_floor: USEFULNESS_FLOOR, precision_floor: PRECISION_FLOOR, materialize: result.measurement.gates.materialize },
    materialize: result.measurement.gates.materialize,
    notes: ["Retention keeps publisher rows as source_records-shaped snapshots; the public Land lookup remains unchanged.", "Source-null fields remain null.", "The join is exact ULURP-token intersection; no fuzzy title matching is used."],
  };
  writeJson(join(STAGE, "receipt.json"), { ...receipt, stage: relative(ROOT, STAGE) });
  writeJsonl(join(STAGE, "source_records.jsonl"), result.source_records);
  if (options.publish || receipt.materialize) {
    writeJson(PUBLIC_RECEIPT, receipt);
    writeJson(PROOF, { schema: "cityscroll.ulurp_recommendation_source_records_proof.v1", observed_on: receipt.observed_on, materialize: receipt.materialize, counts: result.counts, usefulness: result.measurement.usefulness.rate, precision: result.measurement.precision.rate, verification_receipt: relative(ROOT, PUBLIC_RECEIPT) });
  }
  if (!receipt.materialize) process.exitCode = 2;
  console.log(`ulurp_recommendations_source_records retained=${result.counts.source_records} joined=${result.counts.joined} usefulness=${result.measurement.usefulness.rate} precision=${result.measurement.precision.rate} materialize=${receipt.materialize}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
