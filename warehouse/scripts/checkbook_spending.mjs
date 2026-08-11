#!/usr/bin/env node
/** Bounded Checkbook Spending collector — retains payment rows for the contract spine. */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseSpendingTransactions,
  checkbookSuccess,
} from "../../worker/src/lib/checkbook_lifecycle.mjs";
import {
  CHECKBOOK_SPENDING_CATEGORY_CONTRACTS,
  measurePaymentContractJoin,
  normalizeCheckbookSpendingRows,
  paymentRowToSourceRecord,
  selectCheckbookSpendingForGraph,
  sha256Json,
  sha256Text,
  USEFULNESS_FLOOR,
  PRECISION_FLOOR,
} from "../lib/checkbook_spending.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENDPOINT = "https://www.checkbooknyc.com/api";
const LANDING_PAGE = "https://www.checkbooknyc.com/data-feeds/api";
const USER_AGENT = "CityScrollCheckbookCollector/1.0 (+https://cityscroll.org)";
const MIN_DELAY_MS = 1_200;
const MAX_PAGE_SIZE = 50;
const MAX_SEED_CONTRACTS = 200;
const MAX_PAGES_PER_CONTRACT = 4;
const DEFAULT_KILL_SAMPLE = 50;
const DEFAULT_GRAPH_CAP = 500;
const DEFAULT_STAGE = join(ROOT, "warehouse/raw/checkbook-spending");
const DEFAULT_RECEIPT = join(DEFAULT_STAGE, "receipt.json");
const DEFAULT_SNAPSHOT = join(DEFAULT_STAGE, "retained_payments.json");
const DEFAULT_SOURCE_RECORDS = join(DEFAULT_STAGE, "source_records.jsonl");
const PUBLIC_RECEIPT = join(ROOT, "warehouse/receipts/proof/checkbook_spending_population_latest.json");
const VERIFICATION_RECEIPT = join(
  ROOT,
  "site/data/checkbook_spending_sources/verification_receipts/checkbook_spending_payment_retention_2026-08-11.json",
);
const SPINE = join(ROOT, "site/data/procurement_spine_sources.json");
const FIXTURE = join(ROOT, "warehouse/fixtures/checkbook-spending/collector.json");

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

function parseArgs(argv) {
  const args = {
    fromFixture: false,
    publish: false,
    check: false,
    killSample: DEFAULT_KILL_SAMPLE,
    pageSize: MAX_PAGE_SIZE,
    delayMs: MIN_DELAY_MS,
    graphCap: DEFAULT_GRAPH_CAP,
    maxPagesPerContract: MAX_PAGES_PER_CONTRACT,
    stageDir: DEFAULT_STAGE,
    receipt: DEFAULT_RECEIPT,
    snapshot: DEFAULT_SNAPSHOT,
    sourceRecords: DEFAULT_SOURCE_RECORDS,
    fixture: FIXTURE,
    verificationReceipt: VERIFICATION_RECEIPT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--from-fixture") args.fromFixture = true;
    else if (arg === "--publish") args.publish = true;
    else if (arg === "--check") args.check = true;
    else if (arg === "--kill-sample") args.killSample = Number(argv[++index]);
    else if (arg === "--page-size") args.pageSize = Number(argv[++index]);
    else if (arg === "--delay-ms") args.delayMs = Number(argv[++index]);
    else if (arg === "--graph-cap") args.graphCap = Number(argv[++index]);
    else if (arg === "--max-pages-per-contract") args.maxPagesPerContract = Number(argv[++index]);
    else if (arg === "--stage-dir") args.stageDir = resolve(argv[++index]);
    else if (arg === "--receipt") args.receipt = resolve(argv[++index]);
    else if (arg === "--snapshot") args.snapshot = resolve(argv[++index]);
    else if (arg === "--source-records") args.sourceRecords = resolve(argv[++index]);
    else if (arg === "--fixture") args.fixture = resolve(argv[++index]);
    else if (arg === "--verification-receipt") args.verificationReceipt = resolve(argv[++index]);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.killSample) || args.killSample < 1 || args.killSample > MAX_SEED_CONTRACTS) {
    throw new Error(`--kill-sample must be 1..${MAX_SEED_CONTRACTS}`);
  }
  if (!Number.isInteger(args.pageSize) || args.pageSize < 1 || args.pageSize > 999) {
    throw new Error("--page-size must be 1..999");
  }
  if (!args.fromFixture && args.delayMs < MIN_DELAY_MS) {
    throw new Error(`live collection delay must be at least ${MIN_DELAY_MS} ms`);
  }
  if (!Number.isInteger(args.graphCap) || args.graphCap < 1 || args.graphCap > 2_000) {
    throw new Error("--graph-cap must be 1..2000");
  }
  if (args.publish && args.fromFixture) throw new Error("fixture collection cannot publish");
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

export function spendingRequestXml(contractId, from, maxRecords) {
  return `<request><type_of_data>Spending</type_of_data><records_from>${from}</records_from>`
    + `<max_records>${maxRecords}</max_records><search_criteria>`
    + `<criteria><name>contract_id</name><type>value</type><value>${escXml(contractId)}</value></criteria>`
    + "</search_criteria></request>";
}

function responseRecordCount(xml) {
  const match = String(xml).match(/<record_count>(\d+)<\/record_count>/);
  return match ? Number(match[1]) : null;
}

/**
 * Stratified kill sample from the population-backed Checkbook Contracts graph:
 * prefer spent>0 contracts, then fill with spent=0, sorted by contract_id for
 * a deterministic fixed sample.
 */
export function selectKillSampleContracts(contractRows, sampleSize) {
  const list = Array.isArray(contractRows) ? contractRows : [];
  const spent = [];
  const zero = [];
  const seen = new Set();
  for (const row of list) {
    const id = clean(row?.contract_id || row?.prime_contract_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const entry = {
      contract_id: id,
      pin: row.pin || null,
      prime_vendor: row.prime_vendor || row.vendor || null,
      agency: row.agency || null,
      spent: Number(row.spent) || 0,
      status: row.status || "registered",
    };
    if (entry.spent > 0) spent.push(entry);
    else zero.push(entry);
  }
  spent.sort((a, b) => a.contract_id.localeCompare(b.contract_id));
  zero.sort((a, b) => a.contract_id.localeCompare(b.contract_id));
  // ~80% spent / 20% zero when available (matches product residual interest).
  const spentTarget = Math.min(spent.length, Math.max(1, Math.ceil(sampleSize * 0.8)));
  const zeroTarget = Math.min(zero.length, Math.max(0, sampleSize - spentTarget));
  const selected = [...spent.slice(0, spentTarget), ...zero.slice(0, zeroTarget)];
  if (selected.length < sampleSize) {
    for (const row of [...spent.slice(spentTarget), ...zero.slice(zeroTarget)]) {
      selected.push(row);
      if (selected.length >= sampleSize) break;
    }
  }
  return selected.slice(0, sampleSize);
}

function loadSeedContracts(args) {
  if (args.fromFixture) {
    const fixture = readJson(args.fixture);
    if (!fixture?.seed_contracts?.length) {
      throw new Error(`fixture missing seed_contracts: ${args.fixture}`);
    }
    return selectKillSampleContracts(fixture.seed_contracts, args.killSample);
  }
  const spine = readJson(SPINE);
  const rows = spine?.rows?.checkbook_contracts || [];
  if (!rows.length) throw new Error("procurement spine has no checkbook_contracts rows");
  return selectKillSampleContracts(rows, args.killSample);
}

function fixtureFetcher(args) {
  const fixture = readJson(args.fixture);
  if (!fixture?.pages) throw new Error(`invalid Checkbook Spending fixture: ${args.fixture}`);
  return async ({ contractId, offset }) => {
    const key = `${contractId}:${offset}`;
    const xml = fixture.pages[key] || fixture.pages[contractId];
    if (!xml) {
      // Honest empty success for seeds with no fixture page.
      return {
        xml: `<response><status><result>success</result></status><result_records><record_count>0</record_count><spending_transactions></spending_transactions></result_records></response>`,
        httpStatus: 200,
        fetchedAt: fixture.observed_at || new Date().toISOString(),
      };
    }
    return { xml, httpStatus: 200, fetchedAt: fixture.observed_at || new Date().toISOString() };
  };
}

function liveFetcher(args) {
  let lastRequestAt = 0;
  return async ({ contractId, offset }) => {
    const elapsed = Date.now() - lastRequestAt;
    if (lastRequestAt && elapsed < args.delayMs) await wait(args.delayMs - elapsed);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/xml", "User-Agent": USER_AGENT },
        body: spendingRequestXml(contractId, offset, args.pageSize),
      });
      lastRequestAt = Date.now();
      const xml = await response.text();
      if (!response.ok) throw new Error(`Checkbook HTTP ${response.status} for ${contractId} offset ${offset}`);
      return { xml, httpStatus: response.status, fetchedAt: new Date().toISOString() };
    } finally {
      clearTimeout(timeout);
    }
  };
}

async function collectPayments(args, seeds) {
  const pagesDir = join(args.stageDir, "pages");
  mkdirSync(pagesDir, { recursive: true });
  const fetchPage = args.fromFixture ? fixtureFetcher(args) : liveFetcher(args);
  const rawRows = [];
  const perContract = [];
  let fetchedPages = 0;

  for (const seed of seeds) {
    const contractId = seed.contract_id;
    let offset = 1;
    let expectedCount = null;
    let contractRows = 0;
    let pages = 0;
    let ok = true;
    let error = null;

    for (let page = 0; page < args.maxPagesPerContract; page += 1) {
      const result = await fetchPage({ contractId, offset });
      fetchedPages += 1;
      pages += 1;
      const xml = result.xml;
      const file = `${contractId.replace(/[^A-Za-z0-9._-]/g, "_")}-offset${String(offset).padStart(6, "0")}.xml`;
      writeFileSync(join(pagesDir, file), xml);

      if (!checkbookSuccess(xml)) {
        ok = false;
        error = "checkbook_failure";
        break;
      }
      const count = responseRecordCount(xml);
      if (expectedCount == null && Number.isInteger(count)) expectedCount = count;
      const txs = parseSpendingTransactions(xml).map((row) => ({
        ...row,
        seed_contract_id: contractId,
        seedContractId: contractId,
      }));
      rawRows.push(...txs);
      contractRows += txs.length;
      if (txs.length < args.pageSize) break;
      if (expectedCount != null && offset + args.pageSize > expectedCount) break;
      offset += args.pageSize;
    }

    perContract.push({
      contract_id: contractId,
      pin: seed.pin || null,
      spent: seed.spent || 0,
      ok,
      error,
      record_count: expectedCount,
      retained_rows: contractRows,
      pages,
    });
  }

  return { rawRows, perContract, fetchedPages };
}

function writeSourceRecordsJsonl(path, rows, ingestedAt) {
  mkdirSync(dirname(path), { recursive: true });
  const lines = [];
  for (const row of rows) {
    const record = paymentRowToSourceRecord(row, ingestedAt);
    if (record) lines.push(JSON.stringify(record));
  }
  writeFileSync(path, lines.length ? `${lines.join("\n")}\n` : "");
  return lines.length;
}

function publicReceipt(args, seeds, collection, normalized, measurement, selection, ingestedAt) {
  return {
    schema: "cityscroll.checkbook_spending_population_receipt.v1",
    status: measurement.gates.materialize ? "complete" : "measured_below_gate",
    failure_state: measurement.gates.materialize
      ? null
      : {
        observed_at: ingestedAt,
        message: measurement.gates.usefulness_cleared
          ? `precision ${measurement.precision.rate} below floor ${PRECISION_FLOOR}`
          : `usefulness ${measurement.usefulness.rate} below floor ${USEFULNESS_FLOOR}`,
        policy: "Payment rows are retained in the stage snapshot; graph materialization stays off until both gates clear.",
      },
    source: {
      publisher: "Office of the New York City Comptroller",
      landing_page: LANDING_PAGE,
      endpoint: ENDPOINT,
      pulled_at: ingestedAt,
      type_of_data: "Spending",
      spending_category: CHECKBOOK_SPENDING_CATEGORY_CONTRACTS,
      spending_category_label: "Contracts",
      join_path: "Contracts graph seed → Spending by contract_id (PIN rejected on Spending domain)",
    },
    paging: {
      strategy: "seed contract_id pages; records_from offsets; max pages per contract; polite delay",
      page_size: args.pageSize,
      max_pages_per_contract: args.maxPagesPerContract,
      fetched_pages: collection.fetchedPages,
      seed_contracts: seeds.length,
      delay_ms: args.fromFixture ? 0 : args.delayMs,
    },
    population: {
      seed_contracts: seeds.length,
      raw_payment_rows: collection.rawRows.length,
      retained_payments: normalized.counts.retained_payments,
      unique_contracts_with_payments: normalized.counts.unique_contracts,
      blocked: normalized.blocked,
      per_contract: collection.perContract,
    },
    measurement: {
      usefulness: measurement.usefulness,
      precision: measurement.precision,
      methods: measurement.methods,
      gates: measurement.gates,
      acceptance_rule: measurement.acceptance_rule,
    },
    retention: {
      mode: "individual_payment_rows",
      not: "spent_to_date_summary_only",
      source_records_shape: "worker/src/lib/checkbook_source_records.mjs#checkbookSpendingSourceSystemId",
      source_records_path: "warehouse stage source_records.jsonl (host-side immutable snapshot)",
      dual_write_flag: "CHECKBOOK_SOURCE_RECORD_DUAL_WRITE",
    },
    graph_slice: {
      cap: selection.cap,
      row_count: selection.selected_rows,
      strategy: selection.strategy,
      materialize: measurement.gates.materialize,
    },
    checksums: {
      retained_payments_sha256: sha256Json(normalized.rows),
      committed_graph_slice_sha256: sha256Json(selection.rows),
      seed_contract_ids_sha256: sha256Json(seeds.map((s) => s.contract_id).sort()),
    },
    identity_policy: {
      payment_identity: "payment:<contract_id>:<document_id>:<payee>:<issue_date>:<amount>",
      contract_join: "exact normalized contract_id (product path)",
      residual_pin_join: "pin_prefix_of_epin / epin_prefix_of_pin / exact pin via passport_join only when residual",
      never: "PIN-only Spending queries; fabricated payments; name-only joins",
    },
  };
}

function verificationReceipt(receipt, measurement) {
  return {
    schema: "cityscroll.checkbook_spending_payment_retention_verification.v1",
    observed_on: (receipt.source.pulled_at || "").slice(0, 10),
    source: receipt.source,
    kill_sample: {
      n: measurement.sample.seed_contracts,
      strategy: "stratified 80% spent>0 / 20% spent=0 from population-backed checkbook_contracts, sorted contract_id",
      contracts_with_payments: measurement.sample.contracts_with_payments,
      retained_payments: measurement.sample.retained_payments,
    },
    usefulness: measurement.usefulness,
    precision: measurement.precision,
    methods: measurement.methods,
    gates: measurement.gates,
    materialize: measurement.gates.materialize,
    population_backed: measurement.gates.materialize,
    notes: [
      "Checkbook Spending rejects PIN filters (code 1101); join is Contracts→Spending by contract_id.",
      "Retention keeps individual payment rows as source_records-shaped snapshots, not spent-to-date summaries.",
      "pin_prefix_of_epin is available for residual pin recovery; the kill sample primary path is exact contract_id.",
    ],
  };
}

function publishToSpine(receipt, selection) {
  if (!receipt.measurement.gates.materialize) {
    throw new Error("refusing to publish: usefulness/precision gates not cleared");
  }
  const doc = readJson(SPINE);
  if (!doc?.rows || !doc?.sources) throw new Error(`invalid procurement spine: ${SPINE}`);
  const pulledOn = receipt.source.pulled_at.slice(0, 10);
  doc.observed_on = pulledOn;
  doc.generated_at = receipt.source.pulled_at;
  doc.sources.checkbook_spending = {
    source_system: "checkbook-spending",
    coverage_status: "measured",
    population_backed: true,
    source_url: receipt.source.endpoint,
    pulled_at: receipt.source.pulled_at,
    population: {
      seed_contracts: receipt.population.seed_contracts,
      retained_payments: receipt.population.retained_payments,
      unique_contracts_with_payments: receipt.population.unique_contracts_with_payments,
      sha256: receipt.checksums.retained_payments_sha256,
    },
    modern_awards: {
      joined: receipt.measurement.usefulness.joined,
      total: receipt.measurement.usefulness.total,
      rate: receipt.measurement.usefulness.rate,
      basis: receipt.measurement.usefulness.denominator,
    },
    precision: receipt.measurement.precision,
    failure_state: null,
  };
  doc.materialization ||= {};
  doc.materialization.checkbook_spending = {
    graph_cap: selection.cap,
    graph_source: "rows.checkbook_spending",
    graph_rows: selection.selected_rows,
    strategy: selection.strategy,
    receipt: "warehouse/receipts/proof/checkbook_spending_population_latest.json",
    verification_receipt: "site/data/checkbook_spending_sources/verification_receipts/checkbook_spending_payment_retention_2026-08-11.json",
  };
  doc.rows.checkbook_spending = selection.rows;
  writeJson(SPINE, doc);
}

function checkCommitted() {
  const receipt = readJson(PUBLIC_RECEIPT);
  const verify = readJson(VERIFICATION_RECEIPT);
  const spine = readJson(SPINE);
  if (receipt?.status !== "complete" || receipt.failure_state != null) {
    throw new Error("missing successful Checkbook Spending population receipt");
  }
  if (!verify?.gates?.materialize) throw new Error("verification receipt does not clear materialize gates");
  const rows = spine?.rows?.checkbook_spending || [];
  if (rows.length !== receipt.graph_slice?.row_count) {
    throw new Error("Checkbook Spending graph row count does not match receipt");
  }
  if (sha256Json(rows) !== receipt.checksums?.committed_graph_slice_sha256) {
    throw new Error("Checkbook Spending graph slice checksum does not match receipt");
  }
  if (spine.sources?.checkbook_spending?.population_backed !== true) {
    throw new Error("Checkbook Spending source is not marked population-backed");
  }
  // Every published row must retain payment identity fields — not a summary total.
  for (const row of rows) {
    if (!row.contract_id) throw new Error("published spending row missing contract_id");
    if (row.document_id == null && row.check_amount == null) {
      throw new Error("published spending row lacks payment identity");
    }
  }
  console.log(
    `checkbook spending ok: retained=${receipt.population.retained_payments} `
    + `usefulness=${receipt.measurement.usefulness.rate} `
    + `precision=${receipt.measurement.precision.rate} graph=${rows.length}`,
  );
}

export async function runCheckbookSpendingCollector(args) {
  const seeds = loadSeedContracts(args);
  const collection = await collectPayments(args, seeds);
  const ingestedAt = new Date().toISOString();
  const normalized = normalizeCheckbookSpendingRows(collection.rawRows);
  const measurement = measurePaymentContractJoin(seeds, normalized.rows);
  const selection = selectCheckbookSpendingForGraph(normalized.rows, { cap: args.graphCap });
  const receipt = publicReceipt(args, seeds, collection, normalized, measurement, selection, ingestedAt);
  const verify = verificationReceipt(receipt, measurement);

  writeJson(args.snapshot, {
    schema: "cityscroll.checkbook_spending.retained.v1",
    generated_at: ingestedAt,
    counts: normalized.counts,
    blocked: normalized.blocked,
    rows: normalized.rows,
  });
  const sourceRecordCount = writeSourceRecordsJsonl(
    args.sourceRecords,
    normalized.rows,
    ingestedAt,
  );
  receipt.retention.source_records_written = sourceRecordCount;
  receipt.checksums.source_records_sha256 = sha256Text(
    existsSync(args.sourceRecords) ? readFileSync(args.sourceRecords, "utf8") : "",
  );

  writeJson(args.receipt, receipt);
  writeJson(args.verificationReceipt, verify);

  if (args.publish) {
    publishToSpine(receipt, selection);
    writeJson(PUBLIC_RECEIPT, receipt);
    writeJson(VERIFICATION_RECEIPT, verify);
  }

  return { receipt, selection, measurement, seeds, normalized };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(
        "Usage: node warehouse/scripts/checkbook_spending.mjs "
        + "[--from-fixture] [--publish] [--check] [--kill-sample 50] [--graph-cap 500]",
      );
      return;
    }
    if (args.check) return checkCommitted();
    const { receipt, measurement } = await runCheckbookSpendingCollector(args);
    console.log(
      `wrote Checkbook Spending receipt: seeds=${receipt.population.seed_contracts} `
      + `retained=${receipt.population.retained_payments} `
      + `usefulness=${measurement.usefulness.rate} `
      + `precision=${measurement.precision.rate} `
      + `materialize=${measurement.gates.materialize} `
      + `graph=${receipt.graph_slice.row_count}`,
    );
  } catch (error) {
    const receiptPath = args?.publish ? PUBLIC_RECEIPT : args?.receipt;
    if (receiptPath) {
      writeJson(receiptPath, {
        schema: "cityscroll.checkbook_spending_population_receipt.v1",
        status: "failed",
        failure_state: {
          observed_at: new Date().toISOString(),
          message: clean(error?.message || error),
          policy: "No spending graph slice was published from this run.",
        },
        source: { landing_page: LANDING_PAGE, endpoint: ENDPOINT },
      });
    }
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
