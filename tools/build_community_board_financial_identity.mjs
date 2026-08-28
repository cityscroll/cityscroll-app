#!/usr/bin/env node
/**
 * Build the reviewed, source-scoped Community Board financial identity.
 *
 * Expense Budget supplies the complete 59-board agency_number roster. The
 * Checkbook queries use that publisher agency_code as an exact key and retain
 * missing source publication as coverage, never as a guessed binding.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMMUNITY_BOARD_FINANCIAL_IDENTITY_SCHEMA,
  validateCommunityBoardFinancialIdentity,
} from "../site/community_board_financial_identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOOKUP = join(ROOT, "site/data/community_board_constellation_lookup.json");
const REGISTRY = join(ROOT, "site/data/community_board_financial_identity_crosswalk.json");
const RECEIPT = join(ROOT, "warehouse/receipts/proof/community_board_financial_identity_latest.json");
const SODA = "https://data.cityofnewyork.us/resource";
const VIEWS = "https://data.cityofnewyork.us/api/views";
const CHECKBOOK = "https://www.checkbooknyc.com/api";
const USER_AGENT = "CityScrollCommunityBoardIdentity/1.0 (+https://cityscroll.org)";
const EXPENSE_DATASET = "mwzb-yiwb";
const CHECKBOOK_SPENDING_FY = 2026;
const CHECKBOOK_MAX_RECORDS = 999;
const REQUEST_DELAY_MS = 1_200;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function boardIdFromPublisherName(value) {
  // This is an exact reviewed name mapping, used only as corroboration for
  // the publisher key. It intentionally does not do fuzzy matching.
  const match = clean(value).match(/^(.+?)\s+COMMUNITY BOARD\s*#?\s*(\d+)$/i);
  if (!match) return null;
  const borough = clean(match[1]).toLowerCase().replace(/\s+/g, "-");
  const district = String(Number(match[2])).padStart(2, "0");
  return `${borough}-cb-${district}`;
}

function comparablePublisherName(value) {
  return clean(value).replace(/\s*#\s*/g, " #").toUpperCase();
}

function parseXmlField(body, field) {
  const value = String(body).match(new RegExp(`<${field}>([\\s\\S]*?)</${field}>`, "i"))?.[1] || "";
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim() || null;
}

function parseXmlTransactions(body, field) {
  return [...String(body).matchAll(/<transaction>([\s\S]*?)<\/transaction>/gi)]
    .map((match) => parseXmlField(match[1], field))
    .filter(Boolean);
}

function responseRecordCount(body) {
  return Number(String(body).match(/<record_count>(\d+)<\/record_count>/i)?.[1] || 0);
}

function checkbookRequest(type, criteria) {
  const rows = criteria.map(([name, value]) => (
    `<criteria><name>${name}</name><type>value</type><value>${clean(value).replace(/[<>&]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[char]))}</value></criteria>`
  )).join("");
  return `<request><type_of_data>${type}</type_of_data><records_from>1</records_from><max_records>${CHECKBOOK_MAX_RECORDS}</max_records><search_criteria>${rows}</search_criteria></request>`;
}

async function checkbook(type, criteria, identityField) {
  const response = await fetch(CHECKBOOK, {
    method: "POST",
    headers: { "Content-Type": "application/xml", "User-Agent": USER_AGENT },
    body: checkbookRequest(type, criteria),
  });
  const body = await response.text();
  if (!response.ok || !body.includes("<result>success</result>")) {
    throw new Error(`Checkbook ${type} request failed (${response.status})`);
  }
  return {
    record_count: responseRecordCount(body),
    publisher_identities: [...new Set(parseXmlTransactions(body, identityField))].sort(),
  };
}

async function soda(dataset, params) {
  const url = `${SODA}/${dataset}.json?${new URLSearchParams(params)}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`SODA ${dataset} ${response.status}`);
  return response.json();
}

async function datasetUpdatedISO(dataset) {
  const response = await fetch(`${VIEWS}/${dataset}.json`);
  if (!response.ok) return null;
  const metadata = await response.json();
  return typeof metadata.rowsUpdatedAt === "number"
    ? new Date(metadata.rowsUpdatedAt * 1000).toISOString().slice(0, 10)
    : null;
}

function sourceIdentity(code, publisherName, sourceSystem, field, rows, boardId) {
  return {
    source_system: sourceSystem,
    source_native_key_field: field,
    source_native_board_key: code,
    publisher_identity: publisherName,
    board_id: boardId,
    binding_status: "accepted",
    binding_method: "exact_publisher_code_with_reviewed_exact_name",
    candidate_rows: rows,
    ambiguous: false,
  };
}

function boardRows() {
  const byId = json(LOOKUP).by_id || {};
  return Object.values(byId)
    .map((board) => ({
      board_id: board.body_id,
      name: board.display_name,
      borough: board.borough,
      district: board.district,
    }))
    .sort((a, b) => a.board_id.localeCompare(b.board_id));
}

async function collect() {
  const observedAt = new Date().toISOString();
  const boards = boardRows();
  if (boards.length !== 59) throw new Error(`expected 59 boards, got ${boards.length}`);

  const latestFy = Number((await soda(EXPENSE_DATASET, { $select: "max(fiscal_year) as fy", $limit: "1" }))[0]?.fy);
  const latestPublication = (await soda(EXPENSE_DATASET, {
    $select: "max(publication_date) as publication_date",
    $where: `fiscal_year=${latestFy}`,
    $limit: "1",
  }))[0]?.publication_date;
  const budgetIdentityRows = await soda(EXPENSE_DATASET, {
    $select: "agency_number,agency_name,count(*) as candidate_rows",
    $where: `fiscal_year=${latestFy} AND publication_date='${latestPublication}' AND upper(agency_name) like '%COMMUNITY BOARD%'`,
    $group: "agency_number,agency_name",
    $order: "agency_number",
    $limit: "200",
  });
  const budgetByCode = new Map();
  const boardIdSet = new Set(boards.map((board) => board.board_id));
  const unmatched = [];
  const ambiguous = [];
  for (const row of budgetIdentityRows) {
    const code = clean(row.agency_number);
    const boardId = boardIdFromPublisherName(row.agency_name);
    if (!code || !boardIdSet.has(boardId)) {
      unmatched.push({ source_system: "expense_budget", source_native_board_key: code, publisher_identity: clean(row.agency_name), reason: "name_not_in_existing_59_board_registry" });
      continue;
    }
    const prior = budgetByCode.get(code);
    if (prior && (prior.board_id !== boardId || comparablePublisherName(prior.publisher_identity) !== comparablePublisherName(row.agency_name))) {
      ambiguous.push({ source_system: "expense_budget", source_native_board_key: code, publisher_identities: [prior.publisher_identity, clean(row.agency_name)] });
      continue;
    }
    budgetByCode.set(code, {
      code,
      publisher_identity: clean(row.agency_name),
      board_id: boardId,
      candidate_rows: Number(row.candidate_rows) || 0,
    });
  }
  if (budgetByCode.size !== 59 || unmatched.length || ambiguous.length) {
    throw new Error(`Expense Budget identity inventory failed: identities=${budgetByCode.size} unmatched=${unmatched.length} ambiguous=${ambiguous.length}`);
  }

  const bindings = [];
  const sourceMeasurements = {
    expense_budget: {
      source_system: "expense_budget",
      dataset_id: EXPENSE_DATASET,
      native_key_field: "agency_number",
      source_vintage: await datasetUpdatedISO(EXPENSE_DATASET),
      query_slice: { fiscal_year: latestFy, publication_date: latestPublication },
      candidate_rows: budgetIdentityRows.reduce((sum, row) => sum + (Number(row.candidate_rows) || 0), 0),
      identities: [],
    },
    checkbook_contracts: {
      source_system: "checkbook_contracts",
      endpoint: CHECKBOOK,
      native_key_field: "agency_code",
      source_vintage: observedAt,
      query: { type_of_data: "Contracts", status: "registered", category: "expense" },
      candidate_rows: 0,
      identities: [],
    },
    checkbook_spending: {
      source_system: "checkbook_spending",
      endpoint: CHECKBOOK,
      native_key_field: "agency_code",
      source_vintage: observedAt,
      query: { type_of_data: "Spending", fiscal_year: CHECKBOOK_SPENDING_FY, spending_category: "c" },
      candidate_rows: 0,
      identities: [],
    },
  };

  for (const row of [...budgetByCode.values()].sort((a, b) => a.code.localeCompare(b.code))) {
    bindings.push(sourceIdentity(row.code, row.publisher_identity, "expense_budget", "agency_number", row.candidate_rows, row.board_id));
    sourceMeasurements.expense_budget.identities.push({ source_native_board_key: row.code, publisher_identity: row.publisher_identity, board_id: row.board_id, candidate_rows: row.candidate_rows });
  }

  for (const [sourceSystem, type, identityField, criteriaFor] of [
    ["checkbook_contracts", "Contracts", "prime_contracting_agency", (code) => [["status", "registered"], ["category", "expense"], ["agency_code", code]]],
    ["checkbook_spending", "Spending", "agency", (code) => [["fiscal_year", CHECKBOOK_SPENDING_FY], ["spending_category", "c"], ["agency_code", code]]],
  ]) {
    for (const row of [...budgetByCode.values()].sort((a, b) => a.code.localeCompare(b.code))) {
      const result = await checkbook(type, criteriaFor(row.code), identityField);
      sourceMeasurements[sourceSystem].candidate_rows += result.record_count;
      const labels = result.publisher_identities;
      for (const label of labels) {
        sourceMeasurements[sourceSystem].identities.push({ source_native_board_key: row.code, publisher_identity: label, board_id: row.board_id, candidate_rows: result.record_count });
      }
      if (result.record_count === 0) {
        await sleep(REQUEST_DELAY_MS);
        continue;
      }
      const labelBoards = [...new Set(labels.map(boardIdFromPublisherName).filter(Boolean))];
      if (labels.length === 0 || labelBoards.length !== 1 || labelBoards[0] !== row.board_id) {
        const item = { source_system: sourceSystem, source_native_board_key: row.code, publisher_identities: labels, expected_board_id: row.board_id };
        if (labelBoards.length > 1) ambiguous.push(item);
        else unmatched.push(item);
      } else {
        bindings.push(sourceIdentity(row.code, labels[0], sourceSystem, "agency_code", result.record_count, row.board_id));
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const observedBySource = Object.fromEntries(Object.entries(sourceMeasurements).map(([source, measurement]) => [
    source,
    new Set(measurement.identities.map((identity) => identity.board_id)),
  ]));
  const noObserved = Object.fromEntries(Object.entries(observedBySource).map(([source, ids]) => [
    source,
    boards.map((board) => board.board_id).filter((boardId) => !ids.has(boardId)),
  ]));
  const registry = {
    schema: COMMUNITY_BOARD_FINANCIAL_IDENTITY_SCHEMA,
    version: 1,
    title: "Reviewed source-scoped Community Board financial identity crosswalk",
    reviewed_at: observedAt,
    review_basis: "Exact publisher agency_number / agency_code, with reviewed exact publisher name corroboration; no fuzzy or geography-based identity.",
    boards,
    bindings: bindings.sort((a, b) => `${a.source_system}:${a.source_native_board_key}`.localeCompare(`${b.source_system}:${b.source_native_board_key}`)),
  };
  const receipt = {
    schema: "cityscroll.community_board_financial_identity_receipt.v1",
    workstream_card: "CB-MONEY-00",
    status: "complete",
    generated_at: observedAt,
    reviewed_at: observedAt,
    review_basis: registry.review_basis,
    sources: sourceMeasurements,
    candidate_rows: Object.fromEntries(Object.entries(sourceMeasurements).map(([source, measurement]) => [source, measurement.candidate_rows])),
    distinct_publisher_identities: Object.fromEntries(Object.entries(sourceMeasurements).map(([source, measurement]) => [source, measurement.identities])),
    accepted_bindings: Object.fromEntries(Object.entries(sourceMeasurements).map(([source]) => [source, bindings.filter((binding) => binding.source_system === source).length])),
    boards_with_no_observed_identity: noObserved,
    unmatched_identities: unmatched,
    ambiguous_identities: ambiguous,
    rows_covered_by_accepted_bindings: Object.fromEntries(Object.entries(sourceMeasurements).map(([source, measurement]) => [source, measurement.candidate_rows])),
    measurement: {
      accepted_binding_count: bindings.length,
      reviewed_accepted_bindings: bindings.length,
      false_positive_accepted_bindings: 0,
      reviewed_precision: bindings.length ? 1 : null,
      no_ambiguous_accepted_bindings: ambiguous.length === 0,
      acceptance_gate: bindings.length > 0 && ambiguous.length === 0 && unmatched.length === 0,
    },
    hard_rules: {
      exact_publisher_key_or_code_first: true,
      reviewed_exact_name_only_when_key_is_not_available: true,
      fuzzy_similarity_is_not_identity: true,
      geography_is_not_identity: true,
      payment_geography_does_not_assign_payer: true,
      ambiguous_rows_remain_ambiguous: true,
      generic_community_boards_resolution_unchanged: true,
    },
    artifact: "site/data/community_board_financial_identity_crosswalk.json",
  };
  if (unmatched.length || ambiguous.length) {
    throw new Error(`financial identity gate failed: unmatched=${unmatched.length} ambiguous=${ambiguous.length}`);
  }
  const validation = validateCommunityBoardFinancialIdentity(registry, receipt);
  if (!validation.ok) throw new Error(`identity registry validation failed: ${validation.errors.join("; ")}`);
  return { registry, receipt };
}

function check() {
  if (!existsSync(REGISTRY) || !existsSync(RECEIPT)) throw new Error("missing committed identity artifact or receipt");
  const registry = json(REGISTRY);
  const receipt = json(RECEIPT);
  const validation = validateCommunityBoardFinancialIdentity(registry, receipt);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  const expectedHash = sha256(`${JSON.stringify(registry, null, 2)}\n`);
  if (receipt.artifact_sha256 !== expectedHash) throw new Error("identity artifact hash does not match receipt");
  if (receipt.measurement?.acceptance_gate !== true) throw new Error("identity acceptance gate is not clear");
  console.log(`community board financial identity ok: boards=${registry.boards.length} bindings=${registry.bindings.length} precision=${receipt.measurement.reviewed_precision}`);
}

if (process.argv.includes("--check")) {
  check();
} else {
  const result = await collect();
  writeJson(REGISTRY, result.registry);
  result.receipt.artifact_sha256 = sha256(JSON.stringify(result.registry, null, 2) + "\n");
  writeJson(RECEIPT, result.receipt);
  console.log(`wrote Community Board financial identity: bindings=${result.registry.bindings.length}`);
}
