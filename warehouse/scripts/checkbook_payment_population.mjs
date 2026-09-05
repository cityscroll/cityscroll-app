#!/usr/bin/env node
/** Acquire independent fiscal-year Checkbook Spending payment partitions. */

import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CHECKBOOK_CONTRACT_SPENDING_CATEGORY,
  PAYMENT_POPULATION_CONTRACT,
  PAYMENT_POPULATION_SOURCE_SYSTEM,
  SOURCE_FIELDS,
  groupPaymentsByAgency,
  normalizeCheckbookPaymentRows,
  parseCheckbookPaymentTransactions,
  sha256Json,
} from "../lib/checkbook_payment_population.mjs";

import { beginSharedPaymentRefresh, resolveSharedPaymentInput } from "../lib/shared_payment_input.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENDPOINT = "https://www.checkbooknyc.com/api";
const LANDING_PAGE = "https://www.checkbooknyc.com/data-feeds/api";
const USER_AGENT = "CityScrollCheckbookPaymentPopulation/1.0 (+https://cityscroll.org)";
const DEFAULT_STAGE = join(ROOT, "warehouse/raw/checkbook-payment-population");
const DEFAULT_RECEIPT = join(ROOT, "warehouse/receipts/proof/checkbook_payment_population_latest.json");
const DEFAULT_OUTPUT = join(DEFAULT_STAGE, "payments.csv");
const DEFAULT_FIXTURE = join(ROOT, "warehouse/fixtures/checkbook-payment-population/collector.json");
const MAX_PAGE_SIZE = 20_000;
const MIN_DELAY_MS = 1_200;
const CSV_FIELDS = ["transaction_id", "source_system", "fiscal_year", "issue_date", "agency", "payee_name", "contract_id", "spending_category", "check_amount", "document_id", "expense_category", "department", "budget_code", "capital_project", "industry", "mwbe_category", "sub_vendor", "associated_prime_vendor", "sub_contract_reference_id", "mocs_registered", "woman_owned_business", "emerging_business", "is_reversal", "source_fields_json"];

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

function parseArgs(argv) {
  const args = {
    fromFixture: false,
    fiscalYears: [2026],
    pageSize: MAX_PAGE_SIZE,
    delayMs: MIN_DELAY_MS,
    stageDir: DEFAULT_STAGE,
    receipt: DEFAULT_RECEIPT,
    output: DEFAULT_OUTPUT,
    fixture: DEFAULT_FIXTURE,
    reusePages: false,
    refresh: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from-fixture") args.fromFixture = true;
    else if (arg === "--fiscal-years") args.fiscalYears = String(argv[++index]).split(",").map(Number);
    else if (arg === "--page-size") args.pageSize = Number(argv[++index]);
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++index]);
    else if (arg === "--stage-dir") args.stageDir = resolve(argv[++index]);
    else if (arg === "--receipt") args.receipt = resolve(argv[++index]);
    else if (arg === "--output") args.output = resolve(argv[++index]);
    else if (arg === "--fixture") args.fixture = resolve(argv[++index]);
    else if (arg === "--reuse-pages") args.reusePages = true;
    else if (arg === "--refresh") args.refresh = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  args.fiscalYears = [...new Set(args.fiscalYears)].sort((a, b) => a - b);
  if (!args.fiscalYears.length || args.fiscalYears.some((year) => !Number.isInteger(year) || year < 2000 || year > 2100)) {
    throw new Error("--fiscal-years must contain valid years");
  }
  if (!Number.isInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > MAX_PAGE_SIZE) {
    throw new Error(`--page-size must be 1..${MAX_PAGE_SIZE}`);
  }
  if (!args.fromFixture && args.delayMs < MIN_DELAY_MS) {
    throw new Error(`live collection delay must be at least ${MIN_DELAY_MS} ms`);
  }
  return args;
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function repoRelative(path) {
  return relative(ROOT, path).replaceAll("\\", "/");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function escXml(value) {
  return String(value).replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  })[character]);
}

export function paymentPopulationRequestXml(fiscalYear, from, maxRecords) {
  const columns = SOURCE_FIELDS.map((field) => `<column>${field}</column>`).join("");
  return `<request><type_of_data>Spending</type_of_data><records_from>${from}</records_from>`
    + `<max_records>${maxRecords}</max_records><search_criteria>`
    + `<criteria><name>fiscal_year</name><type>value</type><value>${escXml(fiscalYear)}</value></criteria>`
    + `<criteria><name>spending_category</name><type>value</type><value>${CHECKBOOK_CONTRACT_SPENDING_CATEGORY}</value></criteria>`
    + `</search_criteria><response_columns>${columns}</response_columns></request>`;
}

function responseRecordCount(xml) {
  const match = String(xml).match(/<record_count>(\d+)<\/record_count>/);
  return match ? Number(match[1]) : null;
}

function checkbookSuccess(xml) {
  return /<status>[\s\S]*?<result>success<\/result>/.test(String(xml));
}

function fixtureFetcher(args) {
  const fixture = readJson(args.fixture);
  if (!fixture?.pages) throw new Error(`invalid payment population fixture: ${args.fixture}`);
  return async ({ year, offset }) => {
    const xml = fixture.pages[`fy${year}:${offset}`];
    if (!xml) throw new Error(`fixture has no page fy${year}:${offset}`);
    return { xml, fetchedAt: fixture.observed_at || new Date().toISOString(), httpStatus: 200 };
  };
}

function liveFetcher(args) {
  let lastRequestAt = 0;
  return async ({ year, offset }) => {
    const elapsed = Date.now() - lastRequestAt;
    if (lastRequestAt && elapsed < args.delayMs) await wait(args.delayMs - elapsed);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/xml", "User-Agent": USER_AGENT },
        body: paymentPopulationRequestXml(year, offset, args.pageSize),
      });
      lastRequestAt = Date.now();
      const xml = await response.text();
      if (!response.ok) throw new Error(`Checkbook HTTP ${response.status} for FY${year} offset ${offset}`);
      return { xml, fetchedAt: new Date().toISOString(), httpStatus: response.status };
    } finally {
      clearTimeout(timeout);
    }
  };
}

function addAgency(agencies, row) {
  const agency = row?.agency || "Unknown / not published";
  const current = agencies.get(agency) || { agency, transaction_count: 0, net_check_amount: 0 };
  current.transaction_count += 1;
  if (Number.isFinite(row?.check_amount)) current.net_check_amount += row.check_amount;
  agencies.set(agency, current);
}

function agencyGroups(agencies) {
  return [...agencies.values()]
    .map((group) => ({ ...group, net_check_amount: Math.round(group.net_check_amount * 100) / 100 }))
    .sort((a, b) => b.net_check_amount - a.net_check_amount || a.agency.localeCompare(b.agency));
}

function appendCsvRows(path, rows, assertRoom = () => {}) {
  const chunkSize = 1_000;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const lines = [];
    for (const row of rows.slice(start, start + chunkSize)) {
      lines.push(CSV_FIELDS.map((field) => csvCell(row[field])).join(","));
    }
    const chunk = `${lines.join("\n")}\n`;
    assertRoom(Buffer.byteLength(chunk));
    writeFileSync(path, chunk, { flag: "a" });
  }
}

async function collectPartitions(args) {
  const fetchPage = args.fromFixture ? fixtureFetcher(args) : liveFetcher(args);
  const pagesDir = join(args.stageDir, "pages");
  mkdirSync(pagesDir, { recursive: true });
  args.assertRoom?.(Buffer.byteLength(`${CSV_FIELDS.join(",")}\n`));
  writeFileSync(args.output, `${CSV_FIELDS.join(",")}\n`);
  const identitySet = new Set();
  const allAgencies = new Map();
  const partitions = [];
  const pageManifest = [];
  let sourceXmlRows = 0;
  let normalizedRows = 0;
  let sourceNetCheckAmount = 0;
  let normalizedNetCheckAmount = 0;
  let duplicateTransactionRows = 0;
  let reversalRows = 0;
  let nullAmountRows = 0;
  for (const year of args.fiscalYears) {
    let offset = 1;
    let expectedCount = null;
    let pageCount = 0;
    let sourceXmlRowsForPartition = 0;
    let normalizedRowsForPartition = 0;
    let sourceNetForPartition = 0;
    let normalizedNetForPartition = 0;
    let reversalRowsForPartition = 0;
    const partitionAgencies = new Map();
    while (expectedCount == null || offset <= expectedCount) {
      const file = `fy${year}-offset${String(offset).padStart(8, "0")}.xml`;
      const pagePath = join(pagesDir, file);
      const page = args.reusePages && existsSync(pagePath)
        ? { xml: readFileSync(pagePath, "utf8"), fetchedAt: null, httpStatus: null }
        : await fetchPage({ year, offset });
      const xml = page.xml;
      if (!checkbookSuccess(xml)) throw new Error(`Checkbook returned failure for FY${year} offset ${offset}`);
      const count = responseRecordCount(xml);
      if (!Number.isInteger(count)) throw new Error(`Checkbook omitted record_count for FY${year} offset ${offset}`);
      if (expectedCount != null && expectedCount !== count) {
        throw new Error(`Checkbook record_count changed for FY${year}: ${expectedCount} -> ${count}`);
      }
      expectedCount = count;
      const parsed = parseCheckbookPaymentTransactions(xml);
      args.assertRoom?.(Buffer.byteLength(xml));
      writeFileSync(join(pagesDir, file), xml);
      pageManifest.push({ fiscal_year: year, offset, record_count: count, row_count: parsed.length, file, fetched_at: page.fetchedAt, http_status: page.httpStatus, sha256: sha256Text(xml) });
      const normalizedPage = normalizeCheckbookPaymentRows(parsed, { fiscalYear: String(year) });
      appendCsvRows(args.output, normalizedPage.rows, args.assertRoom);
      for (const source of parsed) {
        const amount = Number(String(source.check_amount || "").replace(/[$,]/g, ""));
        if (Number.isFinite(amount)) {
          sourceNetForPartition += amount;
          sourceNetCheckAmount += amount;
        }
        sourceXmlRowsForPartition += 1;
        sourceXmlRows += 1;
      }
      for (const row of normalizedPage.rows) {
        normalizedRowsForPartition += 1;
        normalizedRows += 1;
        normalizedNetForPartition += Number.isFinite(row.check_amount) ? row.check_amount : 0;
        normalizedNetCheckAmount += Number.isFinite(row.check_amount) ? row.check_amount : 0;
        const isDuplicate = identitySet.has(row.transaction_id);
        if (isDuplicate) duplicateTransactionRows += 1;
        identitySet.add(row.transaction_id);
        if (row.is_reversal) { reversalRows += 1; reversalRowsForPartition += 1; }
        if (row.check_amount == null) nullAmountRows += 1;
        addAgency(allAgencies, row);
        addAgency(partitionAgencies, row);
      }
      pageCount += 1;
      if (offset + args.pageSize > expectedCount) break;
      offset += args.pageSize;
    }
    if (sourceXmlRowsForPartition !== expectedCount) {
      throw new Error(`parsed row count ${sourceXmlRowsForPartition} does not equal FY${year} publisher count ${expectedCount}`);
    }
    partitions.push({
      fiscal_year: year,
      source_record_count: expectedCount,
      source_xml_rows: sourceXmlRowsForPartition,
      normalized_rows: normalizedRowsForPartition,
      source_net_check_amount: Math.round(sourceNetForPartition * 100) / 100,
      normalized_net_check_amount: Math.round(normalizedNetForPartition * 100) / 100,
      reversal_rows: reversalRowsForPartition,
      agency_grouping: agencyGroups(partitionAgencies),
      pages: pageCount,
    });
  }
  return {
    partitions,
    pageManifest,
    source_xml_rows: sourceXmlRows,
    normalized_rows: normalizedRows,
    source_net_check_amount: Math.round(sourceNetCheckAmount * 100) / 100,
    normalized_net_check_amount: Math.round(normalizedNetCheckAmount * 100) / 100,
    unique_transaction_ids: identitySet.size,
    duplicate_transaction_rows: duplicateTransactionRows,
    reversal_rows: reversalRows,
    null_amount_rows: nullAmountRows,
    agency_grouping: agencyGroups(allAgencies),
  };
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

async function buildReceipt(args, collection, csv) {
  const partitions = collection.partitions.map((partition) => ({
    ...partition,
    reconciled: partition.source_record_count === partition.source_xml_rows
      && partition.source_xml_rows === partition.normalized_rows
      && partition.source_net_check_amount === partition.normalized_net_check_amount,
  }));
  const reconciliation = {
    partitions,
    source_xml_rows: collection.source_xml_rows,
    normalized_rows: collection.normalized_rows,
    source_net_check_amount: collection.source_net_check_amount,
    normalized_net_check_amount: collection.normalized_net_check_amount,
  };
  reconciliation.reconciled = partitions.every((part) => part.reconciled)
    && reconciliation.source_xml_rows === reconciliation.normalized_rows
    && reconciliation.source_net_check_amount === reconciliation.normalized_net_check_amount;
  return {
    schema: "cityscroll.checkbook_payment_population_receipt.v1",
    status: reconciliation.reconciled ? "complete" : "failed_reconciliation",
    failure_state: reconciliation.reconciled ? null : { message: "source and normalized payment totals did not reconcile" },
    population_contract: {
      id: PAYMENT_POPULATION_CONTRACT,
      name: "Checkbook citywide contract-spending payments by fiscal year",
      source_system: PAYMENT_POPULATION_SOURCE_SYSTEM,
      source_population: "Checkbook Spending API rows filtered by fiscal_year and spending_category=c",
      fiscal_years: args.fiscalYears,
      scope: "Citywide agencies; contract-spending category only; not a contract-ID sample",
    },
    collector_boundary: {
      independent_of: "warehouse/scripts/checkbook_spending.mjs",
      bounded_collector_role: "contract-seeded payment retention for graph enrichment",
      population_collector_role: "independent fiscal-year payment denominator for analytical acquisition",
      no_graph_publication: true,
    },
    source: {
      publisher: "Office of the New York City Comptroller",
      landing_page: LANDING_PAGE,
      endpoint: ENDPOINT,
      type_of_data: "Spending",
      spending_category_code: CHECKBOOK_CONTRACT_SPENDING_CATEGORY,
      spending_category_label: "Contracts",
    },
    paging: {
      strategy: "complete fiscal-year partitions; 1-based records_from; fixed page size; record_count stable per partition",
      page_size: args.pageSize,
      pages: collection.pageManifest.length,
      count_drift_policy: "fail without publishing",
      page_manifest_sha256: sha256Json(collection.pageManifest),
    },
    population: {
      publisher_record_count: partitions.reduce((sum, part) => sum + part.source_record_count, 0),
      source_xml_rows: collection.source_xml_rows,
      normalized_rows: collection.normalized_rows,
      unique_transaction_ids: collection.unique_transaction_ids,
      duplicate_transaction_rows: collection.duplicate_transaction_rows,
      reversal_rows: collection.reversal_rows,
      null_amount_rows: collection.null_amount_rows,
      agency_grouping: collection.agency_grouping,
      by_fiscal_year: partitions,
    },
    reconciliation,
    conversion: {
      csv: { ...csv, path: repoRelative(csv.path) },
      receipt: "warehouse/receipts/proof/checkbook_payment_population_conversion_latest.json",
      next_step: "warehouse/scripts/convert_checkbook_payment_population.py --csv <payments.csv> --parquet <payments.parquet> --source-receipt warehouse/receipts/proof/checkbook_payment_population_latest.json",
      source_fields_preserved: SOURCE_FIELDS,
    },
    checksums: { normalized_csv_sha256: csv.sha256 },
    coverage_statement: "This receipt covers only the declared fiscal-year contract-spending partitions. It must not be used to infer payment coverage for other fiscal years or spending categories.",
  };
}

export async function runPaymentPopulation(args) {
  const collection = await collectPartitions(args);
  const csv = { path: args.output, row_count: collection.normalized_rows, sha256: await sha256File(args.output) };
  const receipt = await buildReceipt(args, collection, csv);
  if (args.assertRoom) {
    receipt.conversion.csv.path = "warehouse/raw/checkbook-payment-population/payments.csv";
    args.assertRoom(Buffer.byteLength(JSON.stringify(receipt)));
  }
  writeJson(args.receipt, receipt);
  if (!receipt.reconciliation.reconciled) throw new Error("payment population reconciliation failed");
  return { collection, normalized: { counts: collection }, csv, receipt };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node warehouse/scripts/checkbook_payment_population.mjs [--from-fixture] [--fiscal-years 2026] [--page-size 20000] [--refresh]");
    return;
  }
  const useShared = process.env.CITYSCROLL_WAREHOUSE_CACHE && !args.fromFixture
    && args.stageDir === DEFAULT_STAGE && args.output === DEFAULT_OUTPUT && args.receipt === DEFAULT_RECEIPT && !args.reusePages;
  if (useShared && !args.refresh && existsSync(join(process.env.CITYSCROLL_WAREHOUSE_CACHE, "checkbook-payment-population/current.json"))) {
    const current = resolveSharedPaymentInput();
    const receipt = readJson(current.receipt);
    const years = receipt?.population_contract?.fiscal_years;
    if (receipt?.status === "complete" && receipt.reconciliation?.reconciled
      && receipt.population_contract?.id === PAYMENT_POPULATION_CONTRACT
      && JSON.stringify(years) === JSON.stringify(args.fiscalYears)) {
      console.log(`reused payment population: version=${current.version} years=${args.fiscalYears.join(",")}`);
      return;
    }
    throw new Error("shared payment selection differs; use --refresh to acquire and publish the requested fiscal years");
  }
  const shared = useShared ? beginSharedPaymentRefresh(process.env.CITYSCROLL_WAREHOUSE_CACHE) : null;
  if (shared) {
    args.stageDir = shared.stage;
    args.output = join(shared.stage, "payments.csv");
    args.receipt = join(shared.stage, "receipt.json");
    args.assertRoom = shared.assertRoom;
  }
  try {
    const result = await runPaymentPopulation(args);
    if (shared) await shared.publish();
    console.log(`wrote payment population: years=${args.fiscalYears.join(",")} rows=${result.receipt.population.normalized_rows} net=${result.receipt.reconciliation.normalized_net_check_amount} agencies=${result.receipt.population.agency_grouping.length}`);
  } catch (error) {
    writeJson(args.receipt, { schema: "cityscroll.checkbook_payment_population_receipt.v1", status: "failed", failure_state: { message: clean(error?.message || error) } });
    console.error(error?.stack || error);
    process.exitCode = 1;
  } finally { shared?.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
