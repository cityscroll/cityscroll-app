#!/usr/bin/env node

/**
 * Materialize Community Board payment actuals from the existing AP-08
 * Checkbook Spending population. This builder reads the retained CSV only;
 * it never issues a second Checkbook request.
 */

import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

import {
  buildCommunityBoardPaymentActuals,
  resolveCommunityBoardPaymentIdentity,
  validateCommunityBoardPaymentActuals,
} from "../site/community_board_payment_actuals.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_INPUT = resolve(ROOT, "warehouse/raw/checkbook-payment-population/payments.csv");
const DEFAULT_REGISTRY = resolve(ROOT, "site/data/community_board_financial_identity_crosswalk.json");
const DEFAULT_LOOKUP = resolve(ROOT, "site/data/community_board_constellation_lookup.json");
const DEFAULT_RECEIPT = resolve(ROOT, "warehouse/receipts/proof/checkbook_payment_population_latest.json");
const DEFAULT_MEASUREMENT_RECEIPT = resolve(ROOT, "warehouse/receipts/proof/community_board_payment_actuals_latest.json");
const DEFAULT_OUTPUT = resolve(ROOT, "site/data/community_board_payment_actuals.json");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") args.check = true;
    else if (arg.startsWith("--")) args[arg.slice(2)] = argv[++index];
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return args;
}

function csvCells(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      cells.push(cell); cell = "";
    } else cell += character;
  }
  cells.push(cell);
  return cells;
}

function clean(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

async function readPaymentRows(input, { onRow = null } = {}) {
  const rows = [];
  const stream = createReadStream(input, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  let index;
  for await (const line of lines) {
    if (!header) {
      header = csvCells(line);
      index = new Map(header.map((name, position) => [name, position]));
      continue;
    }
    if (!line.trim()) continue;
    const cells = csvCells(line);
    const row = {
      transaction_id: clean(cells[index.get("transaction_id")]),
      fiscal_year: clean(cells[index.get("fiscal_year")]),
      issue_date: clean(cells[index.get("issue_date")]),
      agency: clean(cells[index.get("agency")]),
      payee_name: clean(cells[index.get("payee_name")]),
      contract_id: clean(cells[index.get("contract_id")]),
      check_amount: clean(cells[index.get("check_amount")]),
      document_id: clean(cells[index.get("document_id")]),
    };
    if (onRow) await onRow(row);
    else rows.push(row);
  }
  return rows;
}

function sourceVintage(receipt, payments, paymentIssueDateThrough = null) {
  const dates = payments.map((row) => row.issue_date).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value || ""));
  return {
    observed_at: receipt.source?.pulled_at || receipt.generated_at || null,
    payment_issue_date_through: paymentIssueDateThrough || dates.sort().at(-1) || null,
    basis: receipt.source?.pulled_at || receipt.generated_at
      ? "upstream_receipt_observed_at"
      : "latest_retained_payment_issue_date; upstream receipt has no fetch timestamp",
  };
}

async function build({ input = DEFAULT_INPUT, registry = DEFAULT_REGISTRY, lookup = DEFAULT_LOOKUP, receipt = DEFAULT_RECEIPT, generated_at = "2026-08-27T00:00:00.000Z", through_date = "2026-08-27" } = {}) {
  const identityRegistry = JSON.parse(readFileSync(registry, "utf8"));
  const constellation = JSON.parse(readFileSync(lookup, "utf8"));
  const sourceReceipt = JSON.parse(readFileSync(receipt, "utf8"));
  const payments = [];
  let candidateRows = 0;
  let paymentIssueDateThrough = null;
  await readPaymentRows(input, { onRow: async (row) => {
    candidateRows += 1;
    if (row.issue_date && (!paymentIssueDateThrough || row.issue_date > paymentIssueDateThrough)) paymentIssueDateThrough = row.issue_date;
    // Keep only board-labelled Spending observations in memory. The complete
    // citywide population remains the upstream source denominator, while the
    // projection only needs rows that can resolve through CB-MONEY-00.
    if (resolveCommunityBoardPaymentIdentity(identityRegistry, row) || /community board/i.test(row.agency || "")) payments.push(row);
  }});
  const years = sourceReceipt.population_contract?.fiscal_years || [...new Set(payments.map((row) => Number(row.fiscal_year)).filter(Number.isInteger))];
  const vintage = sourceVintage(sourceReceipt, payments, paymentIssueDateThrough);
  const boards = Object.values(constellation.by_id || {}).map((board) => ({ board_id: board.body_id, name: board.display_name }));
  const payload = buildCommunityBoardPaymentActuals({
    boards,
    identityRegistry,
    payments,
    source: {
      endpoint: sourceReceipt.source?.endpoint || "https://www.checkbooknyc.com/api",
      source_receipt: "warehouse/receipts/proof/checkbook_payment_population_latest.json",
      source_vintage: vintage,
      observed_at: vintage.observed_at,
      source_data_through: vintage.payment_issue_date_through,
      source_status: sourceReceipt.status === "complete" ? "partial_board_identity_coverage" : "unavailable",
    },
    fiscalYears: years,
    generatedAt: generated_at,
    throughDate: through_date,
    candidatePaymentRows: candidateRows,
  });
  const validation = validateCommunityBoardPaymentActuals(payload);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  payload.receipt = {
    schema: "cityscroll.community_board_payment_actuals_receipt.v1",
    workstream_card: "CB-MONEY-02",
    generated_at,
    source: {
      population_contract: sourceReceipt.population_contract?.id || null,
      source_system: payload.source.source_system,
      source_receipt: payload.source.source_receipt,
      source_vintage: payload.source.source_vintage,
      source_data_through: payload.source.source_data_through,
      input: "warehouse/raw/checkbook-payment-population/payments.csv",
    },
    identity: payload.identity,
    join: {
      identity_location: "spending observation agency",
      identity_method: "exact reviewed publisher identity matched to CB-MONEY-00 checkbook_spending binding",
      contract_relation: "exact contract_id from Spending observation to Checkbook Contracts contract_id",
      forbidden_fallbacks: ["vendor address", "project location", "description text", "Community District", "fuzzy name matching"],
    },
    measurement: {
      candidate_payment_rows: payload.payment_population.candidate_rows,
      retained_payment_rows: payload.payment_population.retained_payment_rows,
      duplicate_rows_suppressed: payload.payment_population.duplicate_rows_suppressed,
      invalid_rows: payload.payment_population.invalid_rows,
      unmatched_agencies: payload.payment_population.unmatched_agencies,
      inspectable_source_references: payload.rows.reduce((sum, row) => sum + row.observations.length, 0),
      board_fy_rows: payload.rows.length,
      board_coverage: payload.coverage.board_states,
      coverage_status: payload.coverage.status,
    },
    semantics: {
      through_date: payload.through_date,
      through_date_copy: payload.through_date_copy,
      no_full_year_claim: true,
      generic_community_boards_aggregate_preserved: true,
      procurement_lifecycle_changed: false,
    },
    source_observation_contract: {
      source_system: "checkbook_payment_population",
      source_system_id: "transaction_id",
      inspectable_fields: ["transaction_id", "document_id", "contract_id", "issue_date", "fiscal_year", "payee_name", "check_amount"],
    },
  };
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const output = resolve(ROOT, args.output || DEFAULT_OUTPUT);
  const measurementReceipt = resolve(ROOT, args.measurement_receipt || DEFAULT_MEASUREMENT_RECEIPT);
  const payload = await build(args);
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  if (args.check) {
    if (readFileSync(output, "utf8") !== serialized) throw new Error(`stale Community Board payment actuals: ${output}`);
    if (readFileSync(measurementReceipt, "utf8") !== `${JSON.stringify(payload.receipt, null, 2)}\n`) throw new Error(`stale Community Board payment actuals receipt: ${measurementReceipt}`);
    console.log(`Community Board payment actuals current: rows=${payload.rows.length} payments=${payload.payment_population.retained_payment_rows}`);
  } else {
    writeFileSync(output, serialized);
    writeFileSync(measurementReceipt, `${JSON.stringify(payload.receipt, null, 2)}\n`);
    console.log(`wrote Community Board payment actuals: rows=${payload.rows.length} payments=${payload.payment_population.retained_payment_rows}`);
  }
}

if (process.argv[1]?.endsWith("build_community_board_payment_actuals.mjs")) await main();

export { build, csvCells, readPaymentRows };
