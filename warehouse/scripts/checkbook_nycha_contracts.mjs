#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKBOOK_NYCHA_DATASET,
  CHECKBOOK_NYCHA_ENDPOINT,
  CHECKBOOK_NYCHA_MIN_DELAY_MS,
  CHECKBOOK_NYCHA_SOURCE_SYSTEM,
  checkbookNychaSuccess,
  contractsNychaRequestXml,
  normalizeNychaObservation,
  parseNychaTransactions,
  sha256,
} from "../lib/checkbook_nycha_contracts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = resolve(ROOT, "warehouse/fixtures/checkbook-nycha-contracts/BA2335819.json");
const RAW_DIR = resolve(ROOT, "warehouse/raw/checkbook-nycha-contracts");
const USER_AGENT = "CityScrollCheckbookNYCHACollector/1.0 (+https://cityscroll.org)";
const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

export function pageOffsets(recordCount, pageSize) {
  const count = Number(recordCount);
  const size = Number(pageSize);
  if (!Number.isInteger(count) || count < 0 || !Number.isInteger(size) || size < 1) throw new Error("invalid page bounds");
  return Array.from({ length: Math.ceil(count / size) }, (_, index) => 1 + index * size);
}

export function buildReceipt({ pages, retrievedAt, query }) {
  return {
    schema: "cityscroll.checkbook_nycha_contracts.receipt.v1",
    source_system: CHECKBOOK_NYCHA_SOURCE_SYSTEM,
    source_dataset: CHECKBOOK_NYCHA_DATASET,
    endpoint: CHECKBOOK_NYCHA_ENDPOINT,
    query,
    deterministic_paging: true,
    minimum_delay_ms: CHECKBOOK_NYCHA_MIN_DELAY_MS,
    retrieved_at: retrievedAt,
    pages: pages.map((page) => ({
      from: page.from,
      max_records: page.max_records,
      record_count: page.record_count,
      raw_response_hash: page.raw_response_hash,
      retrieved_at: page.retrieved_at,
      file: page.file,
    })),
  };
}

function responseRecordCount(xml) {
  const match = String(xml || "").match(/<record_count>\s*(\d+)\s*<\/record_count>/i);
  return match ? Number(match[1]) : null;
}

/**
 * Collect the publisher's 1-based records_from pages. The optional contract id
 * is a bounded operational selector; without it this follows the full
 * Contracts_NYCHA population after the first record_count is observed.
 */
export async function collectNychaPages({
  pageSize = 500,
  contractId = null,
  fetchImpl = fetch,
  sleep = wait,
  now = () => Date.now(),
  rawDir = RAW_DIR,
} = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("pageSize must be a positive integer");
  let lastResponseAt = null;
  let expectedCount = null;
  const pages = [];
  const rows = [];
  let firstRequest = true;
  for (;;) {
    const from = pages.length ? pages[pages.length - 1].from + pageSize : 1;
    if (expectedCount != null && from > expectedCount) break;
    if (!firstRequest && lastResponseAt != null) {
      const elapsed = now() - lastResponseAt;
      if (elapsed < CHECKBOOK_NYCHA_MIN_DELAY_MS) await sleep(CHECKBOOK_NYCHA_MIN_DELAY_MS - elapsed);
    }
    const retrievedAt = new Date(now()).toISOString();
    const response = await fetchImpl(CHECKBOOK_NYCHA_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/xml", "User-Agent": USER_AGENT },
      body: contractsNychaRequestXml({ from, maxRecords: pageSize, contractId }),
    });
    firstRequest = false;
    const xml = await response.text();
    lastResponseAt = now();
    if (!response.ok) throw new Error(`Checkbook HTTP ${response.status} at records_from ${from}`);
    if (!checkbookNychaSuccess(xml)) throw new Error(`Checkbook returned failure at records_from ${from}`);
    const recordCount = responseRecordCount(xml);
    if (!Number.isInteger(recordCount)) throw new Error(`Checkbook omitted record_count at records_from ${from}`);
    if (expectedCount != null && recordCount !== expectedCount) {
      throw new Error(`Checkbook record_count changed: ${expectedCount} -> ${recordCount}`);
    }
    expectedCount = recordCount;
    const rawResponseHash = sha256(xml);
    const file = `offset-${String(from).padStart(8, "0")}.xml`;
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(resolve(rawDir, file), xml);
    const parsedRows = parseNychaTransactions(xml);
    pages.push({ from, max_records: pageSize, record_count: recordCount, row_count: parsedRows.length, raw_response_hash: rawResponseHash, retrieved_at: retrievedAt, file });
    rows.push(...parsedRows.map((row) => normalizeNychaObservation(row, {
      rawResponse: xml,
      retrievedAt,
      page: { from, max_records: pageSize },
    })));
    if (parsedRows.length === 0 && from <= recordCount) throw new Error(`empty page before population end at records_from ${from}`);
    if (from + pageSize > recordCount) break;
  }
  return { rows, pages, recordCount: expectedCount };
}

function readFixture(path) {
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  if (!fixture?.raw_response || !fixture?.retrieved_at) throw new Error("fixture requires raw_response and retrieved_at");
  return fixture;
}

async function main() {
  const publish = process.argv.includes("--publish");
  const live = process.argv.includes("--live");
  const pageSizeIndex = process.argv.indexOf("--page-size");
  const pageSize = pageSizeIndex >= 0 ? Number(process.argv[pageSizeIndex + 1]) : 500;
  const contractIdIndex = process.argv.indexOf("--contract-id");
  const contractId = contractIdIndex >= 0 ? process.argv[contractIdIndex + 1] : null;
  if (live) {
    const collection = await collectNychaPages({ pageSize, contractId });
    const receipt = buildReceipt({
      retrievedAt: new Date().toISOString(),
      query: { type_of_data: CHECKBOOK_NYCHA_DATASET, contract_id: contractId, records_from: 1, max_records: pageSize },
      pages: collection.pages,
    });
    writeFileSync(resolve(RAW_DIR, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    if (publish) throw new Error("live --publish requires an explicit reviewed materialization; use the fixture publisher");
    console.log(JSON.stringify({ rows: collection.rows.length, pages: collection.pages.length, record_count: collection.recordCount }));
    return;
  }
  const fixturePath = process.argv.includes("--fixture")
    ? resolve(process.argv[process.argv.indexOf("--fixture") + 1]) : FIXTURE;
  if (!existsSync(fixturePath)) throw new Error(`missing fixture: ${fixturePath}`);
  const fixture = readFixture(fixturePath);
  const rows = parseNychaTransactions(fixture.raw_response);
  const agreement = rows.find((row) => row.record_type === "Agreement") || rows[0];
  const observation = normalizeNychaObservation(agreement, {
    rawResponse: fixture.raw_response,
    retrievedAt: fixture.retrieved_at,
    page: { from: 1, max_records: fixture.max_records || rows.length },
  });
  const receipt = buildReceipt({
    retrievedAt: fixture.retrieved_at,
    query: { type_of_data: CHECKBOOK_NYCHA_DATASET, contract_id: observation.contract_id, records_from: 1, max_records: fixture.max_records || rows.length },
    pages: [{ from: 1, max_records: fixture.max_records || rows.length, record_count: rows.length, raw_response_hash: sha256(fixture.raw_response), retrieved_at: fixture.retrieved_at }],
  });
  mkdirSync(RAW_DIR, { recursive: true });
  writeFileSync(resolve(RAW_DIR, "BA2335819.xml"), fixture.raw_response);
  writeFileSync(resolve(RAW_DIR, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  if (publish) {
    const spinePath = resolve(ROOT, "site/data/procurement_spine_sources.json");
    const spine = JSON.parse(readFileSync(spinePath, "utf8"));
    const rows = Array.isArray(spine.rows?.checkbook_nycha_contracts)
      ? spine.rows.checkbook_nycha_contracts : [];
    const key = `${observation.contract_id}|${observation.record_type || "Agreement"}`;
    const retained = rows.filter((row) => `${row.contract_id || row.id}|${row.record_type || "Agreement"}` !== key);
    spine.rows = { ...spine.rows, checkbook_nycha_contracts: [...retained, observation] };
    spine.sources = {
      ...spine.sources,
      checkbook_nycha_contracts: {
        source_system: CHECKBOOK_NYCHA_SOURCE_SYSTEM,
        source_dataset: CHECKBOOK_NYCHA_DATASET,
        coverage_status: "measured",
        population_backed: false,
        endpoint: CHECKBOOK_NYCHA_ENDPOINT,
        landing_page: "https://www.checkbooknyc.com/contract-api",
        retrieved_at: fixture.retrieved_at,
        population: { retained_observations: retained.length + 1, selected_fixture: observation.contract_id, raw_response_sha256: sha256(fixture.raw_response) },
        identity: "exact source contract_id; no cross-source join asserted",
      },
    };
    writeFileSync(spinePath, `${JSON.stringify(spine, null, 2)}\n`);
    const receiptPath = resolve(ROOT, "warehouse/receipts/proof/checkbook_nycha_contracts_population_latest.json");
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  console.log(JSON.stringify({ contract_id: observation.contract_id, source_record_id: observation.source_record_id, raw_response_hash: observation.raw_response_hash }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

export { contractsNychaRequestXml };
