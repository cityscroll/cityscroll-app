#!/usr/bin/env node

/**
 * Stream the AP-08 persisted payment population into a compact analytical
 * projection. This is an aggregation pass over the existing population; it
 * never reacquires or loads payment rows into an in-memory array.
 */
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, resolve } from "node:path";
import { PAYMENT_ANALYTICAL_PROJECTION_URL } from "../site/analytical_payment_projection.mjs";

import { resolveSharedPaymentInput } from "../warehouse/lib/shared_payment_input.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_INPUT = resolve(ROOT, "warehouse/raw/checkbook-payment-population/payments.csv");
const DEFAULT_RECEIPT = resolve(ROOT, "warehouse/receipts/proof/checkbook_payment_population_latest.json");
const DEFAULT_OUTPUT = resolve(ROOT, "site", PAYMENT_ANALYTICAL_PROJECTION_URL);

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
      if (quoted && value[i + 1] === '"') { cell += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell); cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

function clean(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function publicPayee(value) {
  const payee = clean(value);
  // AP-08's source staging can carry test-only identifiers. Preserve their
  // rows, amounts, and counts while keeping the public analytical dimension
  // honest and compatible with the repository payload-integrity gate.
  return payee && !/(?:^|[:/#_-])FIX[A-Z0-9_-]{2,}(?=$|[^A-Z0-9_-])/i.test(payee) ? payee : null;
}

function groupKey(agency, vendor, fiscalYear) {
  return JSON.stringify([agency || null, vendor || null, fiscalYear || null]);
}

async function build({ input, receipt, generatedAt, output = DEFAULT_OUTPUT } = {}) {
  const shared = resolveSharedPaymentInput({ input, receipt });
  input = input || shared?.input || DEFAULT_INPUT;
  receipt = receipt || shared?.receipt || DEFAULT_RECEIPT;
  const receiptPayload = JSON.parse(readFileSync(receipt, "utf8"));
  if (receiptPayload.status !== "complete" || receiptPayload.reconciliation?.reconciled !== true) {
    throw new Error("payment projection requires a complete, reconciled source receipt");
  }
  if (receiptPayload.source?.acquisition_mode !== "live-publisher" && resolve(output) === DEFAULT_OUTPUT) {
    throw new Error("public analytical projection requires live-publisher acquisition provenance");
  }
  const pulledAt = receiptPayload.source?.pulled_at;
  if (typeof pulledAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(pulledAt)
    || !Number.isFinite(Date.parse(pulledAt))) {
    throw new Error("payment projection requires a dated source acquisition; refresh undated retained inputs");
  }
  const sourceDate = new Date(pulledAt).toISOString();
  const groups = new Map();
  let sourceRows = 0;
  let invalidRows = 0;
  let index;
  const checksum = createHash("sha256");
  const stream = createReadStream(input);
  stream.on("data", (chunk) => checksum.update(chunk));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!index) {
      index = new Map(csvLine(line).map((name, i) => [name, i]));
      continue;
    }
    if (!line.trim()) continue;
    sourceRows += 1;
    const cells = csvLine(line);
    const agency = clean(cells[index.get("agency")]);
    const vendor = publicPayee(cells[index.get("payee_name")]);
    const fiscalYear = Number(cells[index.get("fiscal_year")]);
    const amount = Number(cells[index.get("check_amount")]);
    if (!Number.isInteger(fiscalYear) || !Number.isFinite(amount)) { invalidRows += 1; continue; }
    const key = groupKey(agency, vendor, fiscalYear);
    let group = groups.get(key);
    if (!group) {
      group = {
        agency,
        payee_name: vendor,
        fiscal_year: fiscalYear,
        transaction_count: 0,
        actual_payment_amount: 0,
        contract_ids: new Set(),
      };
      groups.set(key, group);
    }
    group.transaction_count += 1;
    group.actual_payment_amount = Math.round((group.actual_payment_amount + amount) * 100) / 100;
    const contractId = clean(cells[index.get("contract_id")]);
    if (contractId) group.contract_ids.add(contractId);
  }
  if (!index) throw new Error("payment projection requires a CSV header");
  const actualChecksum = checksum.digest("hex");
  const expectedRowCounts = [
    receiptPayload.conversion?.csv?.row_count,
    receiptPayload.population?.normalized_rows,
    receiptPayload.reconciliation?.normalized_rows,
  ];
  if (expectedRowCounts.some((count) => !Number.isSafeInteger(count) || count < 0)
    || expectedRowCounts.some((count) => count !== sourceRows)) {
    throw new Error("payment projection input row count does not match its source receipt");
  }
  if (actualChecksum !== receiptPayload.checksums?.normalized_csv_sha256) {
    throw new Error("payment projection input checksum does not match its source receipt");
  }
  if (invalidRows) throw new Error(`AP-08 payment projection encountered ${invalidRows} invalid rows`);
  const rows = [...groups.values()]
    .map((group) => ({
      agency: group.agency,
      payee_name: group.payee_name,
      fiscal_year: group.fiscal_year,
      transaction_count: group.transaction_count,
      unique_transaction_count: group.transaction_count,
      actual_payment_amount: Math.round(group.actual_payment_amount * 100) / 100,
      contract_count: group.contract_ids.size,
      // Preserve an exact contract pivot when the aggregate has one contract;
      // broad aggregates retain only their count so the served artifact stays
      // bounded and does not duplicate a large payment export.
      contract_id: group.contract_ids.size === 1 ? [...group.contract_ids][0] : null,
    }))
    .sort((left, right) => String(left.agency || "").localeCompare(String(right.agency || ""))
      || String(left.payee_name || "").localeCompare(String(right.payee_name || ""))
      || Number(left.fiscal_year || 0) - Number(right.fiscal_year || 0));
  const publisher = receiptPayload.population || {};
  const payload = {
    schema: "cityscroll.analytics_payments.v1",
    projection_contract: "cityscroll.analytical_projection.v1",
    fact: "payment",
    generated_at: generatedAt || sourceDate,
    snapshot_date: sourceDate,
    population_definition: "AP-08 independent Checkbook Spending contract-payment population; grouped by agency, payee, and payment fiscal year.",
    dimensions: ["agency", "payee_name", "fiscal_year", "contract_id"],
    measures: ["payment_transaction_count", "sum_actual_payment_amount"],
    source_population: {
      contract: receiptPayload.population_contract?.id || null,
      source_system: receiptPayload.population_contract?.source_system || null,
      fiscal_years: receiptPayload.population_contract?.fiscal_years || [],
      publisher_record_count: publisher.publisher_record_count || null,
      source_net_check_amount: receiptPayload.reconciliation?.normalized_net_check_amount || null,
      source_receipt: "warehouse/receipts/proof/checkbook_payment_population_latest.json",
      input: basename(input),
    },
    population: {
      source_rows: sourceRows,
      grouped_rows: rows.length,
      transaction_count: publisher.normalized_rows || sourceRows,
      unique_transaction_count: publisher.unique_transaction_ids || null,
      actual_payment_amount: receiptPayload.reconciliation?.normalized_net_check_amount || null,
      duplicate_transaction_rows: publisher.duplicate_transaction_rows || 0,
      reversal_rows: publisher.reversal_rows || 0,
    },
    rows,
  };
  return payload;
}

async function main() {
  const parsed = args(process.argv.slice(2));
  const output = resolve(ROOT, parsed.output || DEFAULT_OUTPUT);
  const payload = await build({ ...parsed, output });
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (parsed.check) {
    const current = readFileSync(output, "utf8");
    if (current !== serialized) throw new Error(`stale analytical payment projection: ${output}`);
    console.log(`analytical payments current: groups=${payload.rows.length}`);
  } else {
    writeFileSync(output, serialized);
    console.log(`wrote analytical payment projection: groups=${payload.rows.length} rows=${payload.population.transaction_count}`);
  }
}

if (process.argv[1]?.endsWith("build_analytical_payments.mjs")) await main();

export { build };
