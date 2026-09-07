#!/usr/bin/env node

/**
 * Acquire the community board budget request register from its publisher and
 * freeze each publication as a retained fixture.
 *
 * One publication is one frozen population. Nothing downstream reads the
 * publisher; the builder and every test read the fixtures written here, so a
 * resident read never depends on the publisher being up.
 *
 * Three rules make a replay safe to schedule unattended:
 *
 *  1. A publication is written only when it is complete. Every page is counted
 *     and the total is checked against the publisher's own count for that
 *     publication, taken in a separate query. A short read is a failed fetch,
 *     never a smaller population.
 *  2. A failed fetch never touches a retained fixture. The previous
 *     materialization stays exactly as it was, and the run writes a failure
 *     receipt naming the attempts and the exact error instead.
 *  3. Rows that were retained and are no longer published are reported as
 *     publisher deletions, with their codes, and only after a complete read
 *     proved the population was fully seen. This is the difference the operator
 *     surface has to be able to tell: a publisher withdrew a request, or this
 *     machine could not finish reading.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  COMMUNITY_BOARD_BUDGET_REGISTER_DATASET_ID,
  RETAINED_OBSERVATION_FIELDS,
  publicationDay,
} from "../warehouse/lib/community_board_budget_register.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_DIRECTORY = join(ROOT, "warehouse/fixtures/community-board-budget-register");
export const MANIFEST_PATH = join(FIXTURE_DIRECTORY, "manifest.json");
export const RECEIPT_PATH = join(ROOT, "warehouse/receipts/proof/community_board_budget_register_latest.json");
export const SOURCE_CONTRACT_ID = "omb-community-board-budget-requests";

export const FIXTURE_MANIFEST_SCHEMA = "cityscroll.community_board_budget_register_fixtures.v1";
export const ACQUISITION_RECEIPT_SCHEMA = "cityscroll.source_acquisition_receipt.v1";

const DATASET = COMMUNITY_BOARD_BUDGET_REGISTER_DATASET_ID;
const RESOURCE = `https://data.cityofnewyork.us/resource/${DATASET}.json`;
const PAGE_SIZE = 1000;
const MAX_ATTEMPTS = 4;

/** How many publications a scheduled replay keeps current without being told. */
export const RETAINED_PUBLICATION_WINDOW = 2;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/**
 * Where one acquisition reads and writes, and how it reaches the publisher.
 *
 * Defaulted to the repository and the network so the command needs no
 * arguments, and named so a test can run a complete acquisition — including a
 * publisher that fails mid-population — against a temporary directory.
 */
export function acquisitionContext({
  directory = FIXTURE_DIRECTORY,
  receiptPath = RECEIPT_PATH,
  fetchImpl = fetch,
  now = null,
  retryDelayMs = 500,
} = {}) {
  return { directory, receiptPath, fetchImpl, now, retryDelayMs };
}

export function fixturePath(publication, context = acquisitionContext()) {
  return join(context.directory, `publication-${publication}.jsonl`);
}

export function manifestPath(context = acquisitionContext()) {
  return join(context.directory, "manifest.json");
}

/**
 * One publisher row reduced to the fields the register retains, with keys in a
 * fixed order so a replay of the same publication produces the same bytes.
 */
export function frozenRow(row) {
  const frozen = {};
  for (const field of RETAINED_OBSERVATION_FIELDS) {
    const value = row?.[field];
    if (value === undefined || value === null || value === "") continue;
    frozen[field] = String(value);
  }
  return frozen;
}

/** The fixture text for one publication: sorted rows, one JSON object per line. */
export function fixtureText(rows) {
  return `${rows
    .map(frozenRow)
    .sort((a, b) => String(a.tracking_code).localeCompare(String(b.tracking_code)))
    .map((row) => JSON.stringify(row))
    .join("\n")}\n`;
}

export function readFixture(publication, context = acquisitionContext()) {
  const path = fixturePath(publication, context);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function readManifest(context = acquisitionContext()) {
  const path = manifestPath(context);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

async function requestJson(url, { attempts = MAX_ATTEMPTS, log = [], context = acquisitionContext() } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = new Date().toISOString();
    try {
      const response = await context.fetchImpl(url, {
        headers: { "User-Agent": "CityScroll community board budget register materializer" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const payload = await response.json();
      log.push({ url: String(url), attempt, at: startedAt, status: "succeeded" });
      return payload;
    } catch (error) {
      lastError = error;
      log.push({ url: String(url), attempt, at: startedAt, status: "failed", error: String(error?.message || error) });
      if (attempt < attempts) await new Promise((wake) => { setTimeout(wake, context.retryDelayMs * attempt); });
    }
  }
  throw new Error(`${url}: ${lastError?.message || lastError}`);
}

function resourceUrl(params) {
  const url = new URL(RESOURCE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

/** The publications the publisher currently offers, with its own row counts. */
export async function fetchPublicationIndex({ log = [], context = acquisitionContext() } = {}) {
  const rows = await requestJson(resourceUrl({
    $select: "publication,count(*) AS published_row_count",
    $group: "publication",
    $order: "publication",
    $limit: "1000",
  }), { log, context });
  return rows
    .map((row) => ({
      publication: String(row.publication),
      published_row_count: Number(row.published_row_count),
    }))
    .filter((row) => /^\d{8}$/.test(row.publication) && Number.isFinite(row.published_row_count))
    .sort((a, b) => a.publication.localeCompare(b.publication));
}

/**
 * Every row of one publication, proven complete against the publisher's own
 * count for that publication before it is returned.
 */
export async function fetchPublication(publication, { expectedRowCount = null, log = [], context = acquisitionContext() } = {}) {
  const declared = expectedRowCount ?? Number((await requestJson(resourceUrl({
    $select: "count(*) AS published_row_count",
    $where: `publication='${publication}'`,
  }), { log, context }))?.[0]?.published_row_count);
  if (!Number.isFinite(declared) || declared <= 0) {
    throw new Error(`publication ${publication}: publisher reported no usable row count`);
  }

  const rows = [];
  let pages = 0;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await requestJson(resourceUrl({
      $select: "*",
      $where: `publication='${publication}'`,
      // A stable total order is what makes offset paging safe to resume; the
      // code is unique inside a publication, so no row can be skipped or seen
      // twice between pages.
      $order: "tracking_code",
      $limit: String(PAGE_SIZE),
      $offset: String(offset),
    }), { log, context });
    pages += 1;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    if (rows.length > declared) break;
  }

  if (rows.length !== declared) {
    throw new Error(`publication ${publication}: read ${rows.length} rows but the publisher reports ${declared}`);
  }
  const codes = new Set(rows.map((row) => String(row.tracking_code || "")));
  if (codes.size !== rows.length) {
    throw new Error(`publication ${publication}: ${rows.length} rows carry only ${codes.size} distinct tracking codes`);
  }
  return { publication, rows, pages, published_row_count: declared };
}

/**
 * Which publications a scheduled replay refreshes when it is not told.
 *
 * Every publication already retained stays retained, plus the most recent
 * publications the publisher has actually released. A publication dated after
 * today is left alone here; the builder retains it as a diagnostic if it is
 * ever acquired deliberately, but a scheduled run does not go looking for one.
 */
export function scheduledPublications(index, { retained = [], asOf = null, window = RETAINED_PUBLICATION_WINDOW } = {}) {
  const day = asOf || new Date().toISOString().slice(0, 10);
  const released = index
    .map((row) => row.publication)
    .filter((publication) => {
      const published = publicationDay(publication);
      return published && published <= day;
    });
  return [...new Set([...retained, ...released.slice(-window)])].sort();
}

function comparePopulations(previousRows, rows) {
  const before = new Set((previousRows || []).map((row) => String(row.tracking_code)));
  const after = new Set(rows.map((row) => String(row.tracking_code)));
  return {
    withdrawn_by_publisher: [...before].filter((code) => !after.has(code)).sort(),
    newly_published: [...after].filter((code) => !before.has(code)).sort(),
  };
}

function receipt({ status, observedAt, publications, log, error = null, previousReceipt = null }) {
  const succeeded = status === "complete";
  return {
    schema: ACQUISITION_RECEIPT_SCHEMA,
    source_contract_id: SOURCE_CONTRACT_ID,
    run_id: `${SOURCE_CONTRACT_ID}:${observedAt}`,
    status: succeeded ? "succeeded" : "failed",
    observed_at: observedAt,
    publisher_clock_basis: succeeded ? "publisher_publication_date" : null,
    // The newest publication the publisher had actually released when it was
    // read. A forward-dated release is retained but is not a publisher clock:
    // a source cannot have been updated after the moment it was observed.
    publisher_updated_at: succeeded
      ? [...publications]
        .map((entry) => publicationDay(entry.publication))
        .filter((day) => day && `${day}T00:00:00.000Z` <= observedAt)
        .sort()
        .map((day) => `${day}T00:00:00.000Z`)
        .at(-1) || null
      : null,
    dataset_id: DATASET,
    source_url: `https://data.cityofnewyork.us/d/${DATASET}`,
    publications: publications.map((entry) => ({
      publication: entry.publication,
      publication_date: publicationDay(entry.publication),
      rows: entry.rows,
      published_row_count: entry.published_row_count,
      pages: entry.pages,
      pagination_complete: entry.rows === entry.published_row_count,
      distinct_tracking_codes: entry.distinct_tracking_codes,
      fixture: entry.fixture,
      sha256: entry.sha256,
      unchanged_since_last_acquisition: entry.unchanged,
      withdrawn_by_publisher: entry.withdrawn_by_publisher,
      newly_published: entry.newly_published,
    })),
    request_log: log,
    attempts: log.length,
    retried_requests: log.filter((entry) => entry.attempt > 1).length,
    failed_requests: log.filter((entry) => entry.status === "failed").length,
    exact_error: succeeded ? null : String(error?.message || error || "acquisition failed"),
    // A failed run leaves the retained fixtures untouched. Naming the run that
    // last succeeded keeps the operator surface honest about what is being
    // served while this source is failing.
    last_successful_acquisition: succeeded
      ? { observed_at: observedAt, run_id: `${SOURCE_CONTRACT_ID}:${observedAt}` }
      : previousReceipt?.last_successful_acquisition
        || (previousReceipt?.status === "succeeded"
          ? { observed_at: previousReceipt.observed_at, run_id: previousReceipt.run_id }
          : null),
    preserved_materialization_on_failure: !succeeded,
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readReceipt(context) {
  if (!existsSync(context.receiptPath)) return null;
  try { return JSON.parse(readFileSync(context.receiptPath, "utf8")); } catch { return null; }
}

/**
 * Verify the retained fixtures against their manifest without touching the
 * publisher, so required CI can prove the frozen populations are intact.
 */
export function checkFixtures(context = acquisitionContext()) {
  const manifest = readManifest(context);
  if (!manifest) throw new Error("no community board budget register fixture manifest");
  if (manifest.schema !== FIXTURE_MANIFEST_SCHEMA) throw new Error("unexpected fixture manifest schema");
  if (!manifest.publications?.length) throw new Error("fixture manifest names no publications");
  for (const entry of manifest.publications) {
    const path = fixturePath(entry.publication, context);
    if (!existsSync(path)) throw new Error(`missing fixture ${relative(ROOT, path)}`);
    const text = readFileSync(path, "utf8");
    if (sha256(text) !== entry.sha256) throw new Error(`${relative(ROOT, path)} does not match its manifest digest`);
    const rows = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    if (rows.length !== entry.rows) throw new Error(`${relative(ROOT, path)} holds ${rows.length} rows, manifest says ${entry.rows}`);
    if (rows.length !== entry.published_row_count) {
      throw new Error(`${relative(ROOT, path)} is not a complete read of publication ${entry.publication}`);
    }
    const codes = new Set(rows.map((row) => row.tracking_code));
    if (codes.size !== rows.length) throw new Error(`${relative(ROOT, path)} repeats a tracking code`);
  }
  console.log(`community board budget register fixtures are intact (${manifest.publications.length} publications, ${manifest.publications.reduce((total, entry) => total + entry.rows, 0)} rows)`);
  return manifest;
}

export async function acquire({ publications = null, asOf = null, context = acquisitionContext() } = {}) {
  const log = [];
  const observedAt = context.now || new Date().toISOString();
  const previousReceipt = readReceipt(context);
  const manifest = readManifest(context);
  const retained = (manifest?.publications || []).map((entry) => entry.publication);
  try {
    const index = await fetchPublicationIndex({ log, context });
    const wanted = publications?.length
      ? [...new Set(publications)].sort()
      : scheduledPublications(index, { retained, asOf });
    const declared = new Map(index.map((row) => [row.publication, row.published_row_count]));

    const acquired = [];
    for (const publication of wanted) {
      if (!declared.has(publication)) throw new Error(`publication ${publication} is not offered by the publisher`);
      const population = await fetchPublication(publication, { expectedRowCount: declared.get(publication), log, context });
      const text = fixtureText(population.rows);
      const previousRows = readFixture(publication, context);
      const previousText = previousRows ? readFileSync(fixturePath(publication, context), "utf8") : null;
      const { withdrawn_by_publisher: withdrawn, newly_published: added } = comparePopulations(previousRows, population.rows);
      acquired.push({
        publication,
        rows: population.rows.length,
        published_row_count: population.published_row_count,
        pages: population.pages,
        distinct_tracking_codes: new Set(population.rows.map((row) => String(row.tracking_code))).size,
        fixture: relative(ROOT, fixturePath(publication, context)),
        sha256: sha256(text),
        unchanged: previousText === text,
        withdrawn_by_publisher: withdrawn,
        newly_published: previousRows ? added : [],
        text,
      });
    }

    // Nothing has been written yet: every publication was read completely
    // before the first byte lands, so a publisher failure part-way through
    // leaves the previous populations exactly as they were.
    mkdirSync(context.directory, { recursive: true });
    for (const entry of acquired) writeFileSync(fixturePath(entry.publication, context), entry.text);
    writeJson(manifestPath(context), {
      schema: FIXTURE_MANIFEST_SCHEMA,
      dataset_id: DATASET,
      source_url: `https://data.cityofnewyork.us/d/${DATASET}`,
      publisher: "New York City Office of Management and Budget",
      publications: acquired.map((entry) => ({
        publication: entry.publication,
        publication_date: publicationDay(entry.publication),
        rows: entry.rows,
        published_row_count: entry.published_row_count,
        distinct_tracking_codes: entry.distinct_tracking_codes,
        sha256: entry.sha256,
      })),
    });
    writeJson(context.receiptPath, receipt({ status: "complete", observedAt, publications: acquired, log }));
    console.log(acquired
      .map((entry) => `${entry.publication}: ${entry.rows} rows (${entry.pages} pages)${entry.withdrawn_by_publisher.length ? `, ${entry.withdrawn_by_publisher.length} withdrawn` : ""}`)
      .join("\n"));
    return acquired;
  } catch (error) {
    writeJson(context.receiptPath, receipt({ status: "failed", observedAt, publications: [], log, error, previousReceipt }));
    throw error;
  }
}

async function main(argv = process.argv.slice(2)) {
  const publications = [];
  let asOf = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") { checkFixtures(); return; }
    if (arg === "--publication") { publications.push(String(argv[++index])); continue; }
    if (arg === "--as-of") { asOf = String(argv[++index]); continue; }
    throw new Error(`unknown argument ${arg}`);
  }
  await acquire({ publications: publications.length ? publications : null, asOf });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
