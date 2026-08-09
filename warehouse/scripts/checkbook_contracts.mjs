#!/usr/bin/env node
/** Bounded, resumable Checkbook Contracts population collector and graph publisher. */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseContractTransactions, checkbookSuccess } from "../../worker/src/lib/checkbook_lifecycle.mjs";
import {
  normalizeCheckbookContractRows,
  selectCheckbookContractsForGraph,
  sha256Json,
} from "../lib/checkbook_contracts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENDPOINT = "https://www.checkbooknyc.com/api";
const LANDING_PAGE = "https://www.checkbooknyc.com/data-feeds/api";
const USER_AGENT = "CityScrollCheckbookCollector/1.0 (+https://cityscroll.org)";
const MIN_DELAY_MS = 1_200;
const MAX_PAGE_SIZE = 999;
const MAX_FISCAL_YEARS = 5;
const MAX_RAW_ROWS = 100_000;
const MAX_RESUME_AGE_HOURS = 6;
const DEFAULT_YEARS = [2025, 2026, 2027];
const DEFAULT_STAGE = join(ROOT, "warehouse/raw/checkbook-contracts");
const DEFAULT_RECEIPT = join(DEFAULT_STAGE, "receipt.json");
const DEFAULT_SNAPSHOT = join(DEFAULT_STAGE, "normalized.json");
const PUBLIC_RECEIPT = join(ROOT, "warehouse/receipts/proof/checkbook_contracts_population_latest.json");
const SPINE = join(ROOT, "site/data/procurement_spine_sources.json");
const PASSPORT = SPINE;
const CITY_RECORD = join(ROOT, "site/data/ocp_awards_warehouse_lookup.json");
const FIXTURE = join(ROOT, "warehouse/fixtures/checkbook-contracts/collector.json");

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function parseArgs(argv) {
  const args = {
    fromFixture: false,
    publish: false,
    check: false,
    resume: false,
    refresh: false,
    fiscalYears: DEFAULT_YEARS,
    pageSize: 500,
    delayMs: MIN_DELAY_MS,
    graphCap: 500,
    stageDir: DEFAULT_STAGE,
    receipt: DEFAULT_RECEIPT,
    snapshot: DEFAULT_SNAPSHOT,
    fixture: FIXTURE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from-fixture") args.fromFixture = true;
    else if (arg === "--publish") args.publish = true;
    else if (arg === "--check") args.check = true;
    else if (arg === "--resume") args.resume = true;
    else if (arg === "--refresh") args.refresh = true;
    else if (arg === "--fiscal-years") args.fiscalYears = String(argv[++index]).split(",").map(Number);
    else if (arg === "--page-size") args.pageSize = Number(argv[++index]);
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++index]);
    else if (arg === "--graph-cap") args.graphCap = Number(argv[++index]);
    else if (arg === "--stage-dir") args.stageDir = resolve(argv[++index]);
    else if (arg === "--receipt") args.receipt = resolve(argv[++index]);
    else if (arg === "--snapshot") args.snapshot = resolve(argv[++index]);
    else if (arg === "--fixture") args.fixture = resolve(argv[++index]);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  args.fiscalYears = [...new Set(args.fiscalYears)].sort((a, b) => a - b);
  if (!args.fiscalYears.length || args.fiscalYears.length > MAX_FISCAL_YEARS
    || args.fiscalYears.some((year) => !Number.isInteger(year) || year < 2000 || year > 2100)) {
    throw new Error(`--fiscal-years must contain 1..${MAX_FISCAL_YEARS} valid years`);
  }
  if (!Number.isInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > MAX_PAGE_SIZE) {
    throw new Error(`--page-size must be 1..${MAX_PAGE_SIZE}`);
  }
  if (!args.fromFixture && args.delayMs < MIN_DELAY_MS) {
    throw new Error(`live collection delay must be at least ${MIN_DELAY_MS} ms`);
  }
  if (!Number.isInteger(args.graphCap) || args.graphCap < 1 || args.graphCap > 2_000) {
    throw new Error("--graph-cap must be 1..2000");
  }
  if (args.publish && args.fromFixture) throw new Error("fixture collection cannot publish");
  if (args.resume && args.refresh) throw new Error("--resume and --refresh are mutually exclusive");
  return args;
}

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function escXml(value) {
  return String(value).replace(/[<>&'"]/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  })[character]);
}

export function contractsRequestXml(fiscalYear, from, maxRecords) {
  return `<request><type_of_data>Contracts</type_of_data><records_from>${from}</records_from>`
    + `<max_records>${maxRecords}</max_records><search_criteria>`
    + "<criteria><name>status</name><type>value</type><value>registered</value></criteria>"
    + "<criteria><name>category</name><type>value</type><value>expense</value></criteria>"
    + `<criteria><name>fiscal_year</name><type>value</type><value>${escXml(fiscalYear)}</value></criteria>`
    + "</search_criteria></request>";
}

function responseRecordCount(xml) {
  const match = String(xml).match(/<record_count>(\d+)<\/record_count>/);
  return match ? Number(match[1]) : null;
}

function pageKey(year, offset) {
  return `${year}:${offset}`;
}

function pageFilename(year, offset) {
  return `fy${year}-offset${String(offset).padStart(8, "0")}.xml`;
}

function checkpointFor(args) {
  const checkpointPath = join(args.stageDir, "checkpoint.json");
  const query = {
    endpoint: ENDPOINT,
    data_type: "Contracts",
    status: "registered",
    category: "expense",
    fiscal_years: args.fiscalYears,
    page_size: args.pageSize,
  };
  const queryHash = sha256Json(query);
  const existing = readJson(checkpointPath);
  if (existing && existing.query_sha256 !== queryHash) {
    throw new Error("checkpoint query differs; use a separate --stage-dir for this pull");
  }
  if (existing && !args.resume && !args.refresh) {
    throw new Error("checkpoint already exists; use --resume for an interrupted pull or --refresh for a new population snapshot");
  }
  if (existing && args.resume) {
    const started = Date.parse(existing.started_at);
    const ageHours = Number.isFinite(started) ? (Date.now() - started) / 3_600_000 : Infinity;
    if (ageHours > MAX_RESUME_AGE_HOURS) {
      throw new Error(`checkpoint is older than the ${MAX_RESUME_AGE_HOURS}-hour resume window; start a new --refresh pull`);
    }
  }
  const checkpoint = existing && !args.refresh ? existing : {
    schema: "cityscroll.checkbook_contracts.checkpoint.v1",
    query,
    query_sha256: queryHash,
    started_at: new Date().toISOString(),
    updated_at: null,
    pages: {},
    population_counts: {},
  };
  return { checkpoint, checkpointPath };
}

function fixtureFetcher(args) {
  const fixture = readJson(args.fixture);
  if (!fixture?.pages) throw new Error(`invalid Checkbook fixture: ${args.fixture}`);
  return async ({ year, offset }) => {
    const xml = fixture.pages[pageKey(year, offset)];
    if (!xml) throw new Error(`fixture has no page ${pageKey(year, offset)}`);
    return { xml, httpStatus: 200, fetchedAt: fixture.observed_at || new Date().toISOString() };
  };
}

function liveFetcher(args) {
  let lastRequestAt = 0;
  return async ({ year, offset }) => {
    const elapsed = Date.now() - lastRequestAt;
    if (lastRequestAt && elapsed < args.delayMs) await wait(args.delayMs - elapsed);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/xml", "User-Agent": USER_AGENT },
        body: contractsRequestXml(year, offset, args.pageSize),
      });
      lastRequestAt = Date.now();
      const xml = await response.text();
      if (!response.ok) throw new Error(`Checkbook HTTP ${response.status} for FY${year} offset ${offset}`);
      return { xml, httpStatus: response.status, fetchedAt: new Date().toISOString() };
    } finally {
      clearTimeout(timeout);
    }
  };
}

async function collectPages(args) {
  const { checkpoint, checkpointPath } = checkpointFor(args);
  const pagesDir = join(args.stageDir, "pages");
  const fetchPage = args.fromFixture ? fixtureFetcher(args) : liveFetcher(args);
  const rawRows = [];
  let checkpointHits = 0;
  let fetchedPages = 0;

  for (const year of args.fiscalYears) {
    let offset = 1;
    let expectedCount = checkpoint.population_counts[String(year)] ?? null;
    while (expectedCount == null || offset <= expectedCount) {
      const key = pageKey(year, offset);
      const cached = checkpoint.pages[key];
      let xml;
      if (cached) {
        const cachedPath = join(pagesDir, cached.file);
        if (!existsSync(cachedPath)) throw new Error(`checkpoint page missing: ${cached.file}`);
        xml = readFileSync(cachedPath, "utf8");
        if (sha256(xml) !== cached.sha256) throw new Error(`checkpoint checksum mismatch: ${cached.file}`);
        checkpointHits += 1;
      } else {
        const page = await fetchPage({ year, offset });
        xml = page.xml;
        if (!checkbookSuccess(xml)) throw new Error(`Checkbook returned failure for FY${year} offset ${offset}`);
        const count = responseRecordCount(xml);
        if (!Number.isInteger(count)) throw new Error(`Checkbook omitted record_count for FY${year} offset ${offset}`);
        if (expectedCount != null && count !== expectedCount) {
          throw new Error(`Checkbook record_count changed for FY${year}: ${expectedCount} -> ${count}`);
        }
        expectedCount = count;
        checkpoint.population_counts[String(year)] = count;
        if (Object.values(checkpoint.population_counts).reduce((sum, value) => sum + value, 0) > MAX_RAW_ROWS) {
          throw new Error(`bounded collector refused more than ${MAX_RAW_ROWS} raw rows`);
        }
        const file = pageFilename(year, offset);
        mkdirSync(pagesDir, { recursive: true });
        writeFileSync(join(pagesDir, file), xml);
        checkpoint.pages[key] = {
          fiscal_year: year,
          offset,
          row_count: parseContractTransactions(xml).length,
          record_count: count,
          fetched_at: page.fetchedAt,
          http_status: page.httpStatus,
          sha256: sha256(xml),
          file,
        };
        checkpoint.updated_at = new Date().toISOString();
        writeJson(checkpointPath, checkpoint);
        fetchedPages += 1;
      }

      const count = responseRecordCount(xml);
      if (expectedCount != null && count !== expectedCount) {
        throw new Error(`checkpoint record_count changed for FY${year}: ${expectedCount} -> ${count}`);
      }
      expectedCount = count;
      const transactions = parseContractTransactions(xml).map((row) => ({
        ...row,
        status: row.status || "registered",
        sourceFiscalYears: [String(year)],
      }));
      rawRows.push(...transactions);
      if (transactions.length === 0 && offset <= expectedCount) {
        throw new Error(`empty page before population end for FY${year} offset ${offset}`);
      }
      offset += args.pageSize;
    }
  }

  const expectedRows = Object.values(checkpoint.population_counts).reduce((sum, value) => sum + value, 0);
  if (rawRows.length !== expectedRows) {
    throw new Error(`parsed row count ${rawRows.length} does not equal API denominator ${expectedRows}`);
  }
  checkpoint.completed_at ||= new Date().toISOString();
  checkpoint.updated_at = checkpoint.completed_at;
  checkpoint.normalized_page_manifest_sha256 = sha256Json(
    Object.values(checkpoint.pages)
      .map(({ fiscal_year, offset, row_count, record_count, sha256: digest }) => ({ fiscal_year, offset, row_count, record_count, sha256: digest }))
      .sort((a, b) => a.fiscal_year - b.fiscal_year || a.offset - b.offset),
  );
  writeJson(checkpointPath, checkpoint);
  return { rawRows, checkpoint, checkpointHits, fetchedPages };
}

function sourceInputs() {
  const spine = readJson(PASSPORT, { rows: {} });
  const cityRecord = readJson(CITY_RECORD, { rows: [] });
  return {
    spine,
    passportRows: spine.rows?.passport_contracts || [],
    cityRecordRows: cityRecord.rows || [],
  };
}

function publicReceipt(args, collection, normalized, selection) {
  const completedAt = collection.checkpoint.completed_at;
  const { measurement } = selection;
  return {
    schema: "cityscroll.checkbook_contracts_population_receipt.v1",
    status: "complete",
    failure_state: null,
    source: {
      publisher: "Office of the New York City Comptroller",
      landing_page: LANDING_PAGE,
      endpoint: ENDPOINT,
      pulled_at: completedAt,
      type_of_data: "Contracts",
      status: "registered",
      category: "expense",
      fiscal_years: args.fiscalYears,
    },
    paging: {
      strategy: "explicit fiscal-year partitions; records_from offsets; pages checkpointed with SHA-256; every page must retain the first observed record_count",
      page_size: args.pageSize,
      pages: Object.keys(collection.checkpoint.pages).length,
      checkpoint_hits: collection.checkpointHits,
      fetched_pages: collection.fetchedPages,
      resumable: true,
      count_drift_policy: "fail without publishing",
      max_fiscal_years: MAX_FISCAL_YEARS,
      max_raw_rows: MAX_RAW_ROWS,
      max_resume_age_hours: MAX_RESUME_AGE_HOURS,
      source_snapshot_token: "not_provided_by_publisher",
    },
    population: {
      api_transaction_rows: Object.values(collection.checkpoint.population_counts).reduce((sum, value) => sum + value, 0),
      by_fiscal_year: collection.checkpoint.population_counts,
      normalized_unique_contracts: normalized.counts.unique_contracts,
      duplicate_slices_collapsed: normalized.counts.duplicate_slices_collapsed,
      prime_slices: normalized.counts.prime_slices,
      subvendor_slices: normalized.counts.subvendor_slices,
      other_slices: normalized.counts.other_slices,
      blocked: normalized.blocked,
    },
    checksums: {
      page_manifest_sha256: collection.checkpoint.normalized_page_manifest_sha256,
      normalized_contracts_sha256: sha256Json(normalized.rows),
      committed_graph_slice_sha256: sha256Json(selection.rows),
    },
    overlap_before_graph_selection: measurement,
    graph_slice: {
      cap: selection.cap,
      row_count: selection.selected_rows,
      selected_buckets: selection.selected_buckets,
      strategy: selection.strategy,
      source: "normalized unique contracts from the measured fiscal-year population",
    },
    identity_policy: {
      contract_identity: "exact prime_contract_id",
      authority_keys: "exact contract_id and exact PIN/EPIN only",
      prime_subvendor_rule: "one graph row per prime_contract_id; subvendor slices contribute counts only",
      legal_name_rule: "vendor names are corroborating observations, never contract identity keys",
    },
  };
}

function publishToSpine(receipt, selection) {
  const doc = readJson(SPINE);
  if (!doc?.rows || !doc?.sources) throw new Error(`invalid procurement spine: ${SPINE}`);
  const pulledOn = receipt.source.pulled_at.slice(0, 10);
  doc.observed_on = pulledOn;
  doc.generated_at = receipt.source.pulled_at;
  doc.sources.checkbook_contracts = {
    source_system: "checkbook-contracts",
    coverage_status: "measured",
    population_backed: true,
    source_url: receipt.source.endpoint,
    pulled_at: receipt.source.pulled_at,
    population: {
      api_transaction_rows: receipt.population.api_transaction_rows,
      normalized_unique_contracts: receipt.population.normalized_unique_contracts,
      fiscal_years: receipt.source.fiscal_years,
      sha256: receipt.checksums.normalized_contracts_sha256,
    },
    overlap: receipt.overlap_before_graph_selection,
    section_denominator: {
      status: "measured",
      denominator: "normalized unique Checkbook contracts in the collected fiscal-year population",
      rows: receipt.population.normalized_unique_contracts,
      source_population: receipt.population.api_transaction_rows,
    },
    modern_awards: {
      joined: receipt.overlap_before_graph_selection.city_record.matched_modern_awards,
      total: receipt.overlap_before_graph_selection.city_record.modern_awards_with_pin,
      rate: receipt.overlap_before_graph_selection.city_record.modern_award_rate,
      basis: receipt.overlap_before_graph_selection.city_record.denominator,
    },
    failure_state: null,
  };
  doc.materialization ||= {};
  doc.materialization.checkbook_contracts = {
    graph_cap: selection.cap,
    graph_source: "rows.checkbook_contracts",
    graph_rows: selection.selected_rows,
    selected_buckets: selection.selected_buckets,
    strategy: selection.strategy,
    receipt: "warehouse/receipts/proof/checkbook_contracts_population_latest.json",
  };
  doc.rows.checkbook_contracts = selection.rows;
  writeJson(SPINE, doc);
}

function checkCommitted() {
  const receipt = readJson(PUBLIC_RECEIPT);
  const spine = readJson(SPINE);
  if (receipt?.status !== "complete" || receipt.failure_state != null) throw new Error("missing successful Checkbook population receipt");
  const rows = spine?.rows?.checkbook_contracts || [];
  if (rows.length !== receipt.graph_slice?.row_count) throw new Error("Checkbook graph row count does not match receipt");
  if (sha256Json(rows) !== receipt.checksums?.committed_graph_slice_sha256) throw new Error("Checkbook graph slice checksum does not match receipt");
  if (spine.sources?.checkbook_contracts?.population_backed !== true) throw new Error("Checkbook source is not marked population-backed");
  console.log(`checkbook contracts ok: population=${receipt.population.normalized_unique_contracts} graph=${rows.length}`);
}

export async function runCheckbookContractsCollector(args) {
  const collection = await collectPages(args);
  const normalized = normalizeCheckbookContractRows(collection.rawRows);
  const inputs = sourceInputs();
  const selection = selectCheckbookContractsForGraph(
    normalized.rows,
    inputs.passportRows,
    inputs.cityRecordRows,
    { cap: args.graphCap },
  );
  const receipt = publicReceipt(args, collection, normalized, selection);
  writeJson(args.snapshot, {
    schema: "cityscroll.checkbook_contracts.normalized.v1",
    generated_at: receipt.source.pulled_at,
    counts: normalized.counts,
    blocked: normalized.blocked,
    rows: normalized.rows,
  });
  writeJson(args.receipt, receipt);
  if (args.publish) {
    publishToSpine(receipt, selection);
    writeJson(PUBLIC_RECEIPT, receipt);
  }
  return { receipt, selection };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log("Usage: node warehouse/scripts/checkbook_contracts.mjs [--from-fixture] [--publish] [--check] [--resume|--refresh] [--fiscal-years 2025,2026,2027]");
      return;
    }
    if (args.check) return checkCommitted();
    const { receipt } = await runCheckbookContractsCollector(args);
    console.log(`wrote Checkbook receipt: raw=${receipt.population.api_transaction_rows} unique=${receipt.population.normalized_unique_contracts} graph=${receipt.graph_slice.row_count}`);
  } catch (error) {
    const receiptPath = args?.publish ? PUBLIC_RECEIPT : args?.receipt;
    if (receiptPath) {
      writeJson(receiptPath, {
        schema: "cityscroll.checkbook_contracts_population_receipt.v1",
        status: "failed",
        failure_state: {
          observed_at: new Date().toISOString(),
          message: clean(error?.message || error),
          policy: "No graph slice was published from this run.",
        },
        source: { landing_page: LANDING_PAGE, endpoint: ENDPOINT },
      });
    }
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
