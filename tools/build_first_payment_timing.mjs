#!/usr/bin/env node

/**
 * Publish first-payment timing by agency: for every registered contract whose
 * start date falls inside the retained Checkbook payment years, the date of its
 * first positive payment, and per agency how many were first paid within 1, 6
 * and 12 months of the start date.
 *
 * Streams the same AP-08 payment population as tools/build_analytical_payments.mjs
 * and applies the same receipt checks; reads the committed registered-contract
 * projection. Never reacquires anything.
 */
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";

import { resolveSharedPaymentInput } from "../warehouse/lib/shared_payment_input.mjs";
import {
  FIRST_PAYMENT_TIMING_CONTRACTS_URL,
  FIRST_PAYMENT_TIMING_URL,
  createFirstPaymentTracker,
  firstPaymentTiming,
  fiscalYearCoverage,
} from "../warehouse/lib/first_payment_timing.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_INPUT = resolve(ROOT, "warehouse/raw/checkbook-payment-population/payments.csv");
const DEFAULT_RECEIPT = resolve(ROOT, "warehouse/receipts/proof/checkbook_payment_population_latest.json");
const DEFAULT_CONTRACTS = resolve(ROOT, "site/data/analytics_registered_contracts.json");
const DEFAULT_OUTPUT = resolve(ROOT, "site", FIRST_PAYMENT_TIMING_URL);

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    if (key === "--check") { out.check = true; continue; }
    out[key.slice(2)] = argv[++i];
  }
  return out;
}

function csvLine(value) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '"') {
      if (quoted && value[i + 1] === '"') { cell += '"'; i += 1; } else quoted = !quoted;
    } else if (char === "," && !quoted) { cells.push(cell); cell = ""; } else cell += char;
  }
  cells.push(cell);
  return cells;
}

function readContracts(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schema !== "cityscroll.analytics_registered_contracts.v1") throw new Error("first-payment timing requires the registered-contract projection");
  const rows = [];
  for (const shard of manifest.shards || []) {
    const payload = JSON.parse(readFileSync(resolve(dirname(manifestPath), shard.path), "utf8"));
    if (!Array.isArray(payload.rows) || payload.rows.length !== shard.row_count) throw new Error(`registered-contract shard ${shard.path} does not match its manifest row count`);
    rows.push(...payload.rows);
  }
  if (rows.length !== manifest.row_count) throw new Error("registered-contract shards do not add up to the manifest row count");
  return { manifest, rows };
}

async function build({ input, receipt, contracts: contractsPath = DEFAULT_CONTRACTS, generatedAt, output = DEFAULT_OUTPUT } = {}) {
  const shared = resolveSharedPaymentInput({ input, receipt });
  input = input || shared?.input || DEFAULT_INPUT;
  receipt = receipt || shared?.receipt || DEFAULT_RECEIPT;
  const receiptPayload = JSON.parse(readFileSync(receipt, "utf8"));
  if (receiptPayload.status !== "complete" || receiptPayload.reconciliation?.reconciled !== true) {
    throw new Error("first-payment timing requires a complete, reconciled payment receipt");
  }
  if (receiptPayload.source?.acquisition_mode !== "live-publisher" && resolve(output) === DEFAULT_OUTPUT) {
    throw new Error("public first-payment timing requires live-publisher payment provenance");
  }
  const pulledAt = receiptPayload.source?.pulled_at;
  if (typeof pulledAt !== "string" || !Number.isFinite(Date.parse(pulledAt))) {
    throw new Error("first-payment timing requires a dated payment acquisition");
  }
  const coverage = fiscalYearCoverage(receiptPayload.population_contract?.fiscal_years);
  const { manifest, rows: contractRows } = readContracts(resolve(contractsPath));
  const tracker = createFirstPaymentTracker(new Set(contractRows.map((row) => String(row.prime_contract_id || "").trim()).filter(Boolean)));
  const checksum = createHash("sha256");
  const stream = createReadStream(input);
  stream.on("data", (chunk) => checksum.update(chunk));
  let index;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    if (!index) { index = new Map(csvLine(line).map((name, i) => [name, i])); continue; }
    if (!line.trim()) continue;
    const cells = csvLine(line);
    tracker.accept({
      contractId: cells[index.get("contract_id")],
      issueDate: cells[index.get("issue_date")],
      amount: Number(cells[index.get("check_amount")]),
    });
  }
  if (!index) throw new Error("first-payment timing requires a CSV header");
  for (const column of ["contract_id", "issue_date", "check_amount"]) {
    if (!index.has(column)) throw new Error(`payment population CSV has no ${column} column`);
  }
  const expected = receiptPayload.conversion?.csv?.row_count;
  if (!Number.isSafeInteger(expected) || expected !== tracker.stats.payment_rows) {
    throw new Error("first-payment timing input row count does not match its payment receipt");
  }
  if (checksum.digest("hex") !== receiptPayload.checksums?.normalized_csv_sha256) {
    throw new Error("first-payment timing input checksum does not match its payment receipt");
  }
  return firstPaymentTiming({
    contracts: contractRows,
    firstPayments: tracker.firstPayments,
    coverage,
    contractsSnapshot: manifest.snapshot_date || null,
    paymentsSnapshot: new Date(pulledAt).toISOString(),
    paymentStats: tracker.stats,
    generatedAt,
  });
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function main() {
  const parsed = args(process.argv.slice(2));
  const output = resolve(ROOT, parsed.output || DEFAULT_OUTPUT);
  const contractsOutput = resolve(dirname(output), FIRST_PAYMENT_TIMING_CONTRACTS_URL.replace(/^data\//, ""));
  const { summary, contracts } = await build({ ...parsed, output });
  if (parsed.check) {
    if (readFileSync(output, "utf8") !== serialize(summary)) throw new Error(`stale first-payment timing: ${output}`);
    if (readFileSync(contractsOutput, "utf8") !== serialize(contracts)) throw new Error(`stale first-payment timing contracts: ${contractsOutput}`);
    console.log(`first-payment timing current: contracts=${contracts.row_count}`);
    return;
  }
  mkdirSync(dirname(contractsOutput), { recursive: true });
  writeFileSync(contractsOutput, serialize(contracts));
  writeFileSync(output, serialize(summary));
  console.log(`wrote first-payment timing: contracts=${contracts.row_count} agencies=${summary.agencies.length}`);
}

if (process.argv[1]?.endsWith("build_first_payment_timing.mjs")) await main();

export { build };
