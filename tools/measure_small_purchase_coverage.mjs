#!/usr/bin/env node
/**
 * Repeatable, read-only census of publicly observable small-purchase source rows.
 *
 * Live mode acquires bounded official-source populations and writes only aggregate
 * measurements. `--check` is offline: it validates the committed receipt, its
 * checksum, its required dimensions, and its drift-tolerant scout comparison.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_DATA_URL,
  RFX_DATA_URL,
  parseContractsDump,
  parseRfxDump,
} from "../worker/src/lib/passport_parse.mjs";
import { normId } from "../worker/src/lib/passport_join.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = resolve(ROOT, "warehouse/evaluation/small_purchase_coverage.json");
const USER_AGENT = "CityScrollSmallPurchaseCensus/1.0 (+https://cityscroll.org)";
const CHECKBOOK_ENDPOINT = "https://www.checkbooknyc.com/api";
const CITY_RECORD_ENDPOINT = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const OCP_AWARDS_ENDPOINT = "https://data.cityofnewyork.us/resource/qyyg-4tf5.json";
const CHECKBOOK_PAGE_SIZE = 999;
const SOCRATA_PAGE_SIZE = 50_000;
const CHECKBOOK_MIN_DELAY_MS = 1_200;
const MAX_CHECKBOOK_ROWS = 100_000;
const MAX_SOCRATA_ROWS = 250_000;
const DEFAULT_FISCAL_YEARS = [2025, 2026, 2027];
const SOURCE_NAMES = [
  "passport_contracts",
  "passport_rfx",
  "checkbook_contracts",
  "ocp_awards",
  "city_record_procurement",
];

const SCOUT_BASELINE = Object.freeze({
  observed_at: "2026-08-18T19:46:32Z",
  provenance: "data/scout-non-crol-small-purchase-coverage/report.md sections 3-6",
  counts: {
    passport_contracts_all_values: 5_616,
    checkbook_contracts_le_100k: 11_043,
    ocp_awards_all_values: 0,
  },
});

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sortedEntries = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));

function increment(map, key) {
  const label = clean(key) || "unknown";
  map.set(label, (map.get(label) || 0) + 1);
}

function rate(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function parseMoney(value) {
  if (value == null || clean(value) === "" || clean(value) === "-") return null;
  const parsed = Number.parseFloat(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value) {
  const text = clean(value);
  if (!text) return null;
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return { year: Number(match[1]), month: Number(match[2]) };
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (match) return { year: Number(match[3]), month: Number(match[1]) };
  return null;
}

export function fiscalYear(value) {
  const date = parseDate(value);
  if (!date) return null;
  return date.month >= 7 ? date.year + 1 : date.year;
}

export function valueBand(value) {
  if (value == null || clean(value) === "") return "missing";
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "missing";
  if (amount <= 0) return "$0_or_less";
  if (amount <= 5_000) return "$0.01-$5k";
  if (amount <= 20_000) return ">$5k-$20k";
  if (amount <= 35_000) return ">$20k-$35k";
  if (amount <= 100_000) return ">$35k-$100k";
  if (amount <= 250_000) return ">$100k-$250k";
  if (amount <= 500_000) return ">$250k-$500k";
  if (amount <= 1_000_000) return ">$500k-$1m";
  if (amount <= 1_500_000) return ">$1m-$1.5m";
  return ">$1.5m";
}

/** Only publisher labels containing one of the governed fragments are admitted. */
export function classifyMethodFamily(value) {
  const label = clean(value).toUpperCase();
  const searchable = label.replace(/[^A-Z0-9$/]+/g, " ").replace(/\s+/g, " ").trim();
  const admitted = searchable.includes("SMALL PURCHASE")
    || searchable.includes("SMALL PURCH")
    || searchable.includes("SM PURCH")
    || searchable.includes("MICROPURCHASE");
  if (!admitted) return null;
  if (/M\s*\/\s*WBE|\bMWBE\b/.test(label)) return "mwbe_small_purchase";
  if (label.includes("MICROPURCHASE") || /UNDER\s+\$?5,?000/.test(label)) {
    return "micropurchase";
  }
  return "ordinary_small_purchase";
}

function exactId(value) {
  return normId(clean(value));
}

function idsFor(row) {
  return {
    request_id: exactId(row?.ids?.request_id),
    pin_epin: exactId(row?.ids?.pin_epin),
    contract_id: exactId(row?.ids?.contract_id),
  };
}

function rowHasExactMatch(row, targetSets) {
  const ids = idsFor(row);
  const matchedBy = [];
  for (const key of ["request_id", "pin_epin", "contract_id"]) {
    if (ids[key] && targetSets[key].has(ids[key])) matchedBy.push(key);
  }
  return matchedBy;
}

function exactSets(rows) {
  const sets = {
    request_id: new Set(),
    pin_epin: new Set(),
    contract_id: new Set(),
  };
  for (const row of rows) {
    const ids = idsFor(row);
    for (const key of Object.keys(sets)) if (ids[key]) sets[key].add(ids[key]);
  }
  return sets;
}

export function exactOverlapRows(fromRows, targetRows) {
  const target = exactSets(targetRows);
  const byKey = { request_id: 0, pin_epin: 0, contract_id: 0 };
  let matchedRows = 0;
  for (const row of fromRows) {
    const keys = rowHasExactMatch(row, target);
    if (keys.length) matchedRows += 1;
    for (const key of keys) byKey[key] += 1;
  }
  return {
    from_rows: fromRows.length,
    matched_rows: matchedRows,
    rate: rate(matchedRows, fromRows.length),
    matched_by_exact_key: byKey,
  };
}

function distribution(rows, field) {
  const counts = new Map();
  for (const row of rows) increment(counts, field(row));
  return sortedEntries(counts);
}

function quantile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * (index - lower));
}

function identifierDistribution(rows) {
  const result = {};
  for (const key of ["request_id", "pin_epin", "contract_id", "publisher_record_id", "document_code", "oca_number"]) {
    const present = rows.filter((row) => clean(row?.ids?.[key])).length;
    result[key] = { present, missing: rows.length - present, rate: rate(present, rows.length) };
  }
  return result;
}

function summarizePopulation(allRows, censusRows, populationDefinition) {
  const values = censusRows.map((row) => row.value).filter(Number.isFinite);
  return {
    population_definition: populationDefinition,
    acquired_rows: allRows.length,
    publisher_small_like_rows: allRows.filter((row) => row.method_family).length,
    census_rows: censusRows.length,
    fiscal_year: distribution(censusRows, (row) => row.fiscal_year == null ? "unknown" : `FY${row.fiscal_year}`),
    method_family: distribution(censusRows, (row) => row.method_family),
    publisher_method_label: distribution(censusRows, (row) => row.method_label),
    value_band: distribution(censusRows, (row) => valueBand(row.value)),
    value_summary: {
      measured_rows: values.length,
      missing_rows: censusRows.length - values.length,
      median: quantile(values, 0.5),
      p90: quantile(values, 0.9),
      p95: quantile(values, 0.95),
      maximum: values.length ? Math.max(...values) : null,
    },
    identifiers: identifierDistribution(censusRows),
  };
}

async function fetchWithReceipt(url, options = {}, label = url) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, ...(options.headers || {}) },
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`${label} HTTP ${response.status}`);
      return {
        body,
        receipt: {
          url: String(url),
          fetched_at: new Date().toISOString(),
          http_status: response.status,
          bytes: Buffer.byteLength(body),
          sha256: sha256(body),
          etag: response.headers.get("etag"),
          last_modified: response.headers.get("last-modified"),
        },
      };
    } catch (error) {
      lastError = error;
      if (attempt === 1) await wait(1_500);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function acquirePassport() {
  const [contracts, rfx] = await Promise.all([
    fetchWithReceipt(CONTRACT_DATA_URL, {}, "PASSPort contracts"),
    fetchWithReceipt(RFX_DATA_URL, {}, "PASSPort RFx"),
  ]);
  const parsedContractRows = parseContractsDump(contracts.body).map((row) => ({
    source_key: `passport-contract:${clean(row.ctr_id)}`,
    ids: {
      request_id: null,
      pin_epin: row.epin,
      contract_id: row.contract_id,
      publisher_record_id: row.ctr_id,
      document_code: clean(row.contract_id).split("-")[0] || null,
      oca_number: null,
    },
    method_label: clean(row.procurement_method),
    method_family: classifyMethodFamily(row.procurement_method),
    value: row.award_amount,
    paid_value: row.paid_amount,
    fiscal_year: fiscalYear(row.registration_date || row.start_date),
    date: clean(row.registration_date || row.start_date) || null,
    notice_role: "transaction",
    excluded_test_row: clean(row.vendor) === "Test Vendor PASSPort Organization"
      && clean(row.title) === "Public Hearing Test"
      && !clean(row.contract_id)
      && clean(row.start_date).includes("2098"),
  }));
  const excludedTestRows = parsedContractRows.filter((row) => row.excluded_test_row).length;
  const contractRows = parsedContractRows.filter((row) => !row.excluded_test_row);
  const rfxRows = parseRfxDump(rfx.body).map((row) => ({
    source_key: `passport-rfx:${clean(row.rfp_id)}`,
    ids: {
      request_id: null,
      pin_epin: row.epin,
      contract_id: null,
      publisher_record_id: row.rfp_id,
      document_code: null,
      oca_number: null,
    },
    method_label: clean(row.procurement_method),
    method_family: classifyMethodFamily(row.procurement_method),
    value: null,
    paid_value: null,
    fiscal_year: fiscalYear(row.release_date),
    date: clean(row.release_date) || null,
    notice_role: "opportunity",
  }));
  return {
    passport_contracts: {
      rows: contractRows,
      acquisition: { ...contracts.receipt, status: "complete", parsed_rows: contractRows.length, excluded_exact_test_rows: excludedTestRows },
    },
    passport_rfx: {
      rows: rfxRows,
      acquisition: { ...rfx.receipt, status: "complete", parsed_rows: rfxRows.length },
    },
  };
}

function xmlText(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!match) return "";
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return match[1].replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
    const lower = entity.toLowerCase();
    if (lower in named) return named[lower];
    const point = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    try { return String.fromCodePoint(point); } catch { return whole; }
  }).trim();
}

function checkbookRequest(fiscalYear, offset) {
  return `<request><type_of_data>Contracts</type_of_data><records_from>${offset}</records_from>`
    + `<max_records>${CHECKBOOK_PAGE_SIZE}</max_records><search_criteria>`
    + "<criteria><name>status</name><type>value</type><value>registered</value></criteria>"
    + "<criteria><name>category</name><type>value</type><value>expense</value></criteria>"
    + `<criteria><name>fiscal_year</name><type>value</type><value>${fiscalYear}</value></criteria>`
    + "</search_criteria></request>";
}

function parseCheckbookPage(xml, fiscalYear) {
  if (!/<status>[\s\S]*?<result>success<\/result>/.test(xml)) throw new Error("Checkbook response was not successful");
  const countMatch = xml.match(/<record_count>(\d+)<\/record_count>/);
  if (!countMatch) throw new Error("Checkbook response omitted record_count");
  const rows = [];
  for (const match of xml.matchAll(/<transaction>([\s\S]*?)<\/transaction>/g)) {
    const tx = match[1];
    rows.push({
      contract_id: xmlText(tx, "prime_contract_id"),
      pin: xmlText(tx, "prime_contract_pin") || xmlText(tx, "pin"),
      method: xmlText(tx, "prime_contract_award_method"),
      document_code: xmlText(tx, "document_code"),
      oca_number: xmlText(tx, "prime_oca_number"),
      vendor_record_type: xmlText(tx, "vendor_record_type"),
      original: parseMoney(xmlText(tx, "prime_contract_original_amount")),
      current: parseMoney(xmlText(tx, "prime_contract_current_amount")),
      spent: parseMoney(xmlText(tx, "prime_vendor_spent_to_date")),
      registration_date: xmlText(tx, "prime_contract_registration_date"),
      source_fiscal_year: fiscalYear,
    });
  }
  return { recordCount: Number(countMatch[1]), rows };
}

function collapseCheckbookRows(rawRows) {
  const groups = new Map();
  for (const row of rawRows) {
    const key = exactId(row.contract_id);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const rows = [];
  for (const slices of groups.values()) {
    const prime = slices.filter((row) => clean(row.vendor_record_type).toLowerCase() === "prime vendor");
    const candidates = prime.length ? prime : slices;
    const best = candidates.slice().sort((a, b) =>
      (Math.max(b.original || 0, b.current || 0, b.spent || 0)
        - Math.max(a.original || 0, a.current || 0, a.spent || 0)),
    )[0];
    const unique = (field) => [...new Set(candidates.map((row) => clean(row[field])).filter(Boolean))].sort();
    const methods = unique("method");
    const pins = unique("pin");
    const documentCodes = unique("document_code");
    const ocaNumbers = unique("oca_number");
    const sourceYears = [...new Set(slices.map((row) => row.source_fiscal_year))].sort((a, b) => a - b);
    const methodLabel = methods.find((method) => classifyMethodFamily(method)) || methods[0] || "";
    rows.push({
      source_key: `checkbook-contract:${clean(best.contract_id)}`,
      ids: {
        request_id: null,
        pin_epin: pins.length === 1 ? pins[0] : null,
        contract_id: best.contract_id,
        publisher_record_id: best.contract_id,
        document_code: documentCodes.length === 1 ? documentCodes[0] : null,
        oca_number: ocaNumbers.length === 1 ? ocaNumbers[0] : null,
      },
      method_label: methodLabel,
      method_family: classifyMethodFamily(methodLabel),
      value: best.original,
      current_value: best.current,
      paid_value: best.spent,
      fiscal_year: sourceYears.length === 1 ? sourceYears[0] : fiscalYear(best.registration_date),
      source_fiscal_years: sourceYears,
      date: clean(best.registration_date) || null,
      notice_role: "transaction",
      ambiguity: {
        method_labels: methods.length > 1 ? methods : null,
        pins: pins.length > 1 ? pins : null,
        document_codes: documentCodes.length > 1 ? documentCodes : null,
        oca_numbers: ocaNumbers.length > 1 ? ocaNumbers : null,
      },
    });
  }
  return rows.sort((a, b) => a.source_key.localeCompare(b.source_key));
}

async function acquireCheckbook(fiscalYears) {
  const rawRows = [];
  const pages = [];
  const populationCounts = {};
  let lastRequestAt = 0;
  for (const fiscalYearValue of fiscalYears) {
    let expectedCount = null;
    for (let offset = 1; expectedCount == null || offset <= expectedCount; offset += CHECKBOOK_PAGE_SIZE) {
      const elapsed = Date.now() - lastRequestAt;
      if (lastRequestAt && elapsed < CHECKBOOK_MIN_DELAY_MS) await wait(CHECKBOOK_MIN_DELAY_MS - elapsed);
      const response = await fetchWithReceipt(CHECKBOOK_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: checkbookRequest(fiscalYearValue, offset),
      }, `Checkbook FY${fiscalYearValue} offset ${offset}`);
      lastRequestAt = Date.now();
      const parsed = parseCheckbookPage(response.body, fiscalYearValue);
      if (expectedCount != null && parsed.recordCount !== expectedCount) {
        throw new Error(`Checkbook FY${fiscalYearValue} count drifted during acquisition: ${expectedCount} -> ${parsed.recordCount}`);
      }
      expectedCount = parsed.recordCount;
      populationCounts[String(fiscalYearValue)] = expectedCount;
      if (Object.values(populationCounts).reduce((sum, count) => sum + count, 0) > MAX_CHECKBOOK_ROWS) {
        throw new Error(`Checkbook census refused more than ${MAX_CHECKBOOK_ROWS} raw rows`);
      }
      if (!parsed.rows.length && offset <= expectedCount) throw new Error(`Checkbook returned an empty interior page at ${offset}`);
      rawRows.push(...parsed.rows);
      pages.push({
        fiscal_year: fiscalYearValue,
        offset,
        rows: parsed.rows.length,
        record_count: parsed.recordCount,
        fetched_at: response.receipt.fetched_at,
        sha256: response.receipt.sha256,
      });
    }
  }
  const expectedRows = Object.values(populationCounts).reduce((sum, count) => sum + count, 0);
  if (rawRows.length !== expectedRows) throw new Error(`Checkbook parsed ${rawRows.length} of ${expectedRows} declared rows`);
  const rows = collapseCheckbookRows(rawRows);
  return {
    rows,
    acquisition: {
      status: "complete",
      url: CHECKBOOK_ENDPOINT,
      fetched_at: pages.at(-1)?.fetched_at || new Date().toISOString(),
      fiscal_years: fiscalYears,
      paging: {
        strategy: "complete fiscal-year partitions; 1-based records_from; fixed page size; record_count must remain stable within each partition",
        page_size: CHECKBOOK_PAGE_SIZE,
        pages: pages.length,
        population_counts: populationCounts,
        raw_rows: rawRows.length,
        normalized_exact_contract_ids: rows.length,
        page_manifest_sha256: sha256(JSON.stringify(pages)),
      },
    },
  };
}

function socrataUrl(endpoint, params) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

async function acquireSocrata({ endpoint, label, where, select }) {
  const countQuery = { "$select": "count(*) as count" };
  if (where) countQuery.$where = where;
  const before = await fetchWithReceipt(socrataUrl(endpoint, countQuery), {}, `${label} count`);
  const declared = Number(JSON.parse(before.body)?.[0]?.count);
  if (!Number.isInteger(declared) || declared < 0) throw new Error(`${label} returned an invalid count`);
  if (declared > MAX_SOCRATA_ROWS) throw new Error(`${label} refused ${declared} rows above bound ${MAX_SOCRATA_ROWS}`);
  const rows = [];
  const pages = [];
  for (let offset = 0; offset < declared; offset += SOCRATA_PAGE_SIZE) {
    const query = {
      "$select": select.join(","),
      "$limit": SOCRATA_PAGE_SIZE,
      "$offset": offset,
      "$order": "request_id ASC",
    };
    if (where) query.$where = where;
    const page = await fetchWithReceipt(socrataUrl(endpoint, query), {}, `${label} offset ${offset}`);
    const pageRows = JSON.parse(page.body);
    if (!Array.isArray(pageRows)) throw new Error(`${label} page ${offset} was not tabular JSON`);
    if (!pageRows.length && offset < declared) throw new Error(`${label} returned an empty interior page at ${offset}`);
    rows.push(...pageRows);
    pages.push({ offset, rows: pageRows.length, fetched_at: page.receipt.fetched_at, sha256: page.receipt.sha256 });
  }
  const after = await fetchWithReceipt(socrataUrl(endpoint, countQuery), {}, `${label} final count`);
  const finalCount = Number(JSON.parse(after.body)?.[0]?.count);
  if (finalCount !== declared) throw new Error(`${label} count drifted during acquisition: ${declared} -> ${finalCount}`);
  if (rows.length !== declared) throw new Error(`${label} acquired ${rows.length} of ${declared} rows`);
  return {
    rows,
    acquisition: {
      status: "complete",
      url: endpoint,
      fetched_at: pages.at(-1)?.fetched_at || before.receipt.fetched_at,
      query: { where: where || null, select, order: "request_id ASC" },
      paging: {
        strategy: "bounded SODA offset pages bracketed by equal count queries",
        page_size: SOCRATA_PAGE_SIZE,
        pages: pages.length,
        rows: rows.length,
        page_manifest_sha256: sha256(JSON.stringify(pages)),
        count_before: declared,
        count_after: finalCount,
      },
    },
  };
}

function normalizeNoticeRow(source, row) {
  const type = clean(row.type_of_notice_description);
  const lowerType = type.toLowerCase();
  return {
    source_key: `${source}:${clean(row.request_id)}`,
    ids: {
      request_id: row.request_id,
      pin_epin: row.pin,
      contract_id: null,
      publisher_record_id: row.request_id,
      document_code: null,
      oca_number: null,
    },
    method_label: clean(row.selection_method_description),
    method_family: classifyMethodFamily(row.selection_method_description),
    value: parseMoney(row.contract_amount),
    paid_value: null,
    fiscal_year: fiscalYear(row.start_date),
    date: clean(row.start_date) || null,
    notice_role: lowerType.includes("solicitation")
      ? "opportunity"
      : lowerType.includes("award")
        ? "transaction"
        : "other_publication",
  };
}

async function acquireNoticeSources() {
  const fields = [
    "request_id",
    "start_date",
    "type_of_notice_description",
    "selection_method_description",
    "section_name",
    "pin",
    "contract_amount",
  ];
  const [city, ocp] = await Promise.all([
    acquireSocrata({
      endpoint: CITY_RECORD_ENDPOINT,
      label: "City Record Procurement",
      where: "section_name='Procurement'",
      select: fields,
    }),
    acquireSocrata({
      endpoint: OCP_AWARDS_ENDPOINT,
      label: "OCP Recent Contract Awards",
      where: null,
      select: fields,
    }),
  ]);
  return {
    city_record_procurement: {
      acquisition: city.acquisition,
      rows: city.rows.map((row) => normalizeNoticeRow("city-record", row)),
    },
    ocp_awards: {
      acquisition: ocp.acquisition,
      rows: ocp.rows.map((row) => normalizeNoticeRow("ocp-award", row)),
    },
  };
}

function sourcePopulations(sources) {
  const small = (name) => sources[name].rows.filter((row) => row.method_family);
  return {
    passport_contracts: small("passport_contracts"),
    passport_rfx: small("passport_rfx"),
    checkbook_contracts: small("checkbook_contracts").filter((row) => Number.isFinite(row.value) && row.value <= 100_000),
    ocp_awards: small("ocp_awards"),
    city_record_procurement: small("city_record_procurement"),
  };
}

function overlapsFor(populations, sources) {
  const result = {};
  for (const from of SOURCE_NAMES) {
    result[from] = {};
    for (const target of SOURCE_NAMES) {
      if (from === target) continue;
      result[from][target] = exactOverlapRows(populations[from], sources[target].rows);
    }
  }
  return result;
}

function negativePopulation(rows, cityRows, otherSources) {
  const citySets = exactSets(cityRows);
  const negatives = rows.filter((row) => rowHasExactMatch(row, citySets).length === 0);
  const overlaps = {};
  for (const [name, sourceRows] of Object.entries(otherSources)) {
    overlaps[name] = exactOverlapRows(negatives, sourceRows);
  }
  return {
    source_rows: rows.length,
    city_record_not_yet_found_by_exact_key: negatives.length,
    rate: rate(negatives.length, rows.length),
    method_family: distribution(negatives, (row) => row.method_family),
    fiscal_year: distribution(negatives, (row) => row.fiscal_year == null ? "unknown" : `FY${row.fiscal_year}`),
    value_band: distribution(negatives, (row) => valueBand(row.value)),
    exact_non_city_record_overlap: overlaps,
    interpretation: "City Record not yet found by exact request_id or exact normalized PIN/EPIN; not a claim that no notice was published.",
  };
}

function visibilityFor(name, rows, sources) {
  const rfxSets = exactSets(sources.passport_rfx.rows);
  const cityOpportunityRows = sources.city_record_procurement.rows.filter((row) => row.notice_role === "opportunity");
  const cityOpportunitySets = exactSets(cityOpportunityRows);
  let rfx = 0;
  let city = 0;
  let either = 0;
  for (const row of rows) {
    const rfxMatch = rowHasExactMatch(row, rfxSets).length > 0;
    const cityMatch = rowHasExactMatch(row, cityOpportunitySets).length > 0;
    if (rfxMatch) rfx += 1;
    if (cityMatch) city += 1;
    if (rfxMatch || cityMatch) either += 1;
  }
  const paidKnown = name === "passport_contracts" || name === "checkbook_contracts";
  const positivePaid = paidKnown ? rows.filter((row) => Number(row.paid_value) > 0).length : null;
  return {
    rows: rows.length,
    opportunity_visibility: {
      exact_passport_rfx: rfx,
      exact_city_record_solicitation: city,
      exact_public_opportunity_union: either,
      rate: rate(either, rows.length),
    },
    transaction_visibility: {
      source_observation_rows: rows.length,
      positive_paid_or_spent_rows: positivePaid,
      positive_paid_or_spent_rate: positivePaid == null ? null : rate(positivePaid, rows.length),
      interpretation: "A later contract/award/payment observation does not imply a generally public pre-award opportunity.",
    },
  };
}

function driftEntry(actual, expected) {
  const absolute = actual - expected;
  const relative = expected === 0 ? (actual === 0 ? 0 : null) : absolute / expected;
  const tolerance = expected === 0 ? 0 : Math.max(500, Math.ceil(expected * 0.35));
  return {
    scout_count: expected,
    current_count: actual,
    absolute_change: absolute,
    relative_change: relative,
    tolerance_rows: tolerance,
    within_fresh_source_tolerance: Math.abs(absolute) <= tolerance,
  };
}

function validateReceipt(receipt) {
  const errors = [];
  if (receipt?.schema !== "cityscroll.small_purchase_coverage_census.v1") errors.push("wrong schema");
  if (receipt?.status !== "complete") errors.push("receipt is not complete");
  for (const source of SOURCE_NAMES) {
    const entry = receipt?.sources?.[source];
    if (entry?.acquisition?.status !== "complete") errors.push(`${source} acquisition is not complete`);
    for (const dimension of ["fiscal_year", "method_family", "publisher_method_label", "value_band", "identifiers"]) {
      if (!entry?.distribution || !(dimension in entry.distribution)) errors.push(`${source} missing ${dimension}`);
    }
  }
  for (const source of ["passport_contracts_all_values", "passport_contracts_le_100k", "checkbook_contracts_le_100k", "ocp_awards_all_values"]) {
    if (!receipt?.city_record_negative?.[source]) errors.push(`missing City Record-negative population ${source}`);
  }
  if (receipt?.purchase_order_population?.status !== "UNKNOWN" || receipt?.purchase_order_population?.rows !== null) {
    errors.push("purchase-order population must remain explicit UNKNOWN with null rows");
  }
  if (receipt?.identity_policy?.join_keys?.join(",") !== "request_id,PIN/EPIN,contract_id") errors.push("identity join-key policy changed");
  if (!String(receipt?.identity_policy?.prohibited || "").includes("name")) errors.push("identity policy does not prohibit name joins");
  for (const [name, drift] of Object.entries(receipt?.source_drift?.comparisons || {})) {
    if (!drift.within_fresh_source_tolerance) errors.push(`${name} exceeds fresh-source tolerance`);
  }
  const clone = structuredClone(receipt);
  const digest = clone.receipt_sha256;
  delete clone.receipt_sha256;
  if (digest !== sha256(JSON.stringify(clone))) errors.push("receipt checksum mismatch");
  return errors;
}

function buildReceipt(sources, fiscalYears) {
  const populations = sourcePopulations(sources);
  const cityRows = sources.city_record_procurement.rows;
  const passportUnder100k = populations.passport_contracts.filter((row) => Number.isFinite(row.value) && row.value <= 100_000);
  const negative = {
    passport_contracts_all_values: negativePopulation(populations.passport_contracts, cityRows, {
      checkbook_contracts: sources.checkbook_contracts.rows,
      ocp_awards: sources.ocp_awards.rows,
      passport_rfx: sources.passport_rfx.rows,
    }),
    passport_contracts_le_100k: negativePopulation(passportUnder100k, cityRows, {
      checkbook_contracts: sources.checkbook_contracts.rows,
      ocp_awards: sources.ocp_awards.rows,
      passport_rfx: sources.passport_rfx.rows,
    }),
    checkbook_contracts_le_100k: negativePopulation(populations.checkbook_contracts, cityRows, {
      passport_contracts: sources.passport_contracts.rows,
      ocp_awards: sources.ocp_awards.rows,
      passport_rfx: sources.passport_rfx.rows,
    }),
    ocp_awards_all_values: negativePopulation(populations.ocp_awards, cityRows, {
      passport_contracts: sources.passport_contracts.rows,
      checkbook_contracts: sources.checkbook_contracts.rows,
      passport_rfx: sources.passport_rfx.rows,
    }),
  };
  const definitions = {
    passport_contracts: "all non-test PASSPort contracts whose publisher method label contains Small Purchase, SM Purch, or Micropurchase",
    passport_rfx: "all PASSPort RFx rows whose publisher method label contains Small Purchase, SM Purch, or Micropurchase",
    checkbook_contracts: `exact contract_id groups in registered expense Contracts for FY${fiscalYears.join("-FY")}; admitted publisher labels; original value <= $100,000`,
    ocp_awards: "all OCP Recent Contract Awards rows whose publisher method label contains Small Purchase, SM Purch, or Micropurchase",
    city_record_procurement: "all City Record Procurement rows whose publisher method label contains Small Purchase, SM Purch, or Micropurchase",
  };
  const sourceOutput = {};
  for (const name of SOURCE_NAMES) {
    sourceOutput[name] = {
      acquisition: sources[name].acquisition,
      distribution: summarizePopulation(sources[name].rows, populations[name], definitions[name]),
    };
  }
  const comparisons = {
    passport_contracts_all_values: driftEntry(
      negative.passport_contracts_all_values.city_record_not_yet_found_by_exact_key,
      SCOUT_BASELINE.counts.passport_contracts_all_values,
    ),
    checkbook_contracts_le_100k: driftEntry(
      negative.checkbook_contracts_le_100k.city_record_not_yet_found_by_exact_key,
      SCOUT_BASELINE.counts.checkbook_contracts_le_100k,
    ),
    ocp_awards_all_values: driftEntry(
      negative.ocp_awards_all_values.city_record_not_yet_found_by_exact_key,
      SCOUT_BASELINE.counts.ocp_awards_all_values,
    ),
  };
  const receipt = {
    schema: "cityscroll.small_purchase_coverage_census.v1",
    status: "complete",
    generated_at: new Date().toISOString(),
    measurement_kind: "source-row coverage census; source rows are not canonical procurements",
    scope: {
      fiscal_years: fiscalYears,
      admitted_publisher_label_fragments: ["Small Purchase", "SM Purch", "Micropurchase"],
      method_families: ["ordinary_small_purchase", "micropurchase", "mwbe_small_purchase"],
      value_rule: "Checkbook census uses publisher original contract value <= $100,000; PASSPort and OCP report all admitted values plus explicit <=$100,000 cuts where relevant.",
      source_row_rule: "No statistical estimates; counts are acquired source rows or exact-key derivations.",
    },
    identity_policy: {
      join_keys: ["request_id", "PIN/EPIN", "contract_id"],
      normalization: "trim, uppercase, remove non-alphanumeric characters, then require equality; no prefixes or partial matches",
      prohibited: "fuzzy joins, vendor/agency/title/name joins, or inferred identifiers",
      negative_meaning: "not yet found in the complete acquired City Record Procurement snapshot by an allowed exact key",
    },
    sources: sourceOutput,
    exact_cross_source_overlap: overlapsFor(populations, sources),
    city_record_negative: negative,
    opportunity_vs_transaction_visibility: {
      passport_contracts_all_values: visibilityFor("passport_contracts", populations.passport_contracts, sources),
      passport_contracts_le_100k: visibilityFor("passport_contracts", passportUnder100k, sources),
      checkbook_contracts_le_100k: visibilityFor("checkbook_contracts", populations.checkbook_contracts, sources),
      ocp_awards_all_values: visibilityFor("ocp_awards", populations.ocp_awards, sources),
    },
    purchase_order_population: {
      status: "UNKNOWN",
      rows: null,
      observed_document_codes: sourceOutput.checkbook_contracts.distribution.identifiers.document_code.present
        ? distribution(populations.checkbook_contracts, (row) => row.ids.document_code)
        : {},
      interpretation: "This bounded Checkbook Contracts pull is not a citywide purchase-order/direct-order census. No observed PO/DO code would be an API-surface miss, not a zero world fact.",
    },
    source_drift: {
      baseline: SCOUT_BASELINE,
      policy: "Report measured change. A nonzero baseline passes the order-of-magnitude gate within max(500 rows, 35%); a zero baseline must remain zero. Counts are never substituted from the baseline.",
      comparisons,
    },
  };
  receipt.receipt_sha256 = sha256(JSON.stringify(receipt));
  return receipt;
}

function parseArgs(argv) {
  const args = { check: false, output: DEFAULT_OUTPUT, fiscalYears: DEFAULT_FISCAL_YEARS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") args.check = true;
    else if (arg === "--output") args.output = resolve(argv[++index]);
    else if (arg === "--fiscal-years") args.fiscalYears = clean(argv[++index]).split(",").map(Number);
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  args.fiscalYears = [...new Set(args.fiscalYears)].sort((a, b) => a - b);
  if (!args.fiscalYears.length || args.fiscalYears.length > 5
    || args.fiscalYears.some((year) => !Number.isInteger(year) || year < 2000 || year > 2100)) {
    throw new Error("--fiscal-years must contain 1..5 valid comma-separated years");
  }
  return args;
}

function checkCommitted(output) {
  const receipt = JSON.parse(readFileSync(output, "utf8"));
  const errors = validateReceipt(receipt);
  if (errors.length) throw new Error(`small-purchase coverage receipt failed:\n- ${errors.join("\n- ")}`);
  const drift = receipt.source_drift.comparisons;
  console.log(
    `small-purchase coverage ok: PASSPort-negative=${drift.passport_contracts_all_values.current_count} `
      + `Checkbook-negative=${drift.checkbook_contracts_le_100k.current_count} `
      + `OCP-negative=${drift.ocp_awards_all_values.current_count}`,
  );
}

export async function measureSmallPurchaseCoverage({ fiscalYears = DEFAULT_FISCAL_YEARS } = {}) {
  const [passport, checkbook, notices] = await Promise.all([
    acquirePassport(),
    acquireCheckbook(fiscalYears),
    acquireNoticeSources(),
  ]);
  return buildReceipt({ ...passport, checkbook_contracts: checkbook, ...notices }, fiscalYears);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node tools/measure_small_purchase_coverage.mjs [--check] [--output PATH] [--fiscal-years 2025,2026,2027]");
    return;
  }
  if (args.check) return checkCommitted(args.output);
  const receipt = await measureSmallPurchaseCoverage({ fiscalYears: args.fiscalYears });
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`wrote ${args.output}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
