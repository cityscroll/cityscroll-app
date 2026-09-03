#!/usr/bin/env node
/**
 * SEQRA-01: source inventory and population profiler.
 *
 * `--refresh` performs the live, bounded measurement pass over the Tier-1
 * SODA sources and the discovery probes, writing a retained observation
 * fixture plus per-query raw artifacts (gitignored bulk under warehouse/raw,
 * same convention as every other warehouse collector). The default mode
 * (no flag) rebuilds the receipt deterministically from that retained
 * observation, so two consecutive runs against the same inputs are
 * byte-identical apart from `generated_at`. `--check` rebuilds and diffs
 * against the committed receipt, the same shape as
 * tools/build_ceqr_project_milestone_reconciliation.mjs.
 *
 * Every SODA query here is a bounded aggregate (count/group/min-max), never
 * a full-table download -- this measures exact fetched counts without
 * pulling bulk rows, matching the warehouse's CPU-discipline convention.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SEQRA_SOURCE_REGISTRY } from "../warehouse/lib/seqra_source_registry.mjs";
import { SEQRA_SODA_SOURCE_CONFIG, SEQRA_SODA_SOURCE_IDS } from "../warehouse/lib/seqra_soda_source_config.mjs";
import {
  buildDiscoverySourceProfile,
  buildSeqraInventoryReceipt,
  buildSodaSourceProfile,
  buildTargetPopulationEstimates,
} from "../warehouse/lib/seqra_source_inventory.mjs";
import { summarizeScopeClassification } from "../warehouse/lib/seqra_scope_classifier.mjs";
import { SEQRA_JURISDICTION_FIXTURE_BATCH } from "../warehouse/fixtures/seqra-inventory/jurisdiction_fixture_batch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OBSERVATION = path.join(ROOT, "warehouse/fixtures/seqra-inventory/observation.v1.json");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/seqra_source_inventory_latest.json");
const RAW_ROOT = path.join(ROOT, "warehouse/raw/seqra-inventory");
const RECONCILIATION_RECEIPT = path.join(ROOT, "warehouse/receipts/proof/ceqr_project_milestone_reconciliation_latest.json");

const USER_AGENT = "CityScrollSeqraSourceInventory/1.0 (+https://cityscroll.org; SEQRA-01 feasibility inventory)";
const BREAKDOWN_LIMIT = 1000;
const DUPLICATE_GROUP_LIMIT = 5000;
const SCHEMA_SAMPLE_LIMIT = 5;
const POLITE_DELAY_MS = 250;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function stringify(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}
function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let fetchCounter = 0;
function nextFetchId(sourceId) {
  fetchCounter += 1;
  return `seqra01-fetch-${sourceId}-${String(fetchCounter).padStart(4, "0")}`;
}

/** Perform one bounded HTTP GET, retain the raw response, and build its fetch receipt. */
async function fetchAndReceipt({ sourceId, purpose, url, rawSlug, sourceVintage }) {
  const fetchId = nextFetchId(sourceId);
  const requestedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  const latencyMs = Date.now() - startedAtMs;
  const text = await response.text();
  const retrievedAt = new Date().toISOString();
  const byteCount = Buffer.byteLength(text, "utf8");
  const contentHash = `sha256:${sha256Hex(text)}`;
  const contentType = response.headers.get("content-type") || null;

  const rawRelPath = path.posix.join("warehouse/raw/seqra-inventory", sourceId, `${rawSlug}.json`);
  const rawAbsPath = path.join(ROOT, rawRelPath);
  mkdirSync(path.dirname(rawAbsPath), { recursive: true });
  writeFileSync(rawAbsPath, text);

  let json = null;
  const warnings = [];
  if (response.ok) {
    try {
      json = JSON.parse(text);
    } catch {
      warnings.push("response body was not valid JSON");
    }
  } else {
    warnings.push(`non-2xx http_status ${response.status}`);
  }

  const rowOrDocumentCount = Array.isArray(json) ? json.length : json == null ? 0 : 1;

  const fetch_ = {
    fetch_id: fetchId,
    source_id: sourceId,
    requested_at: requestedAt,
    request_url_or_query: url,
    http_status: response.status,
    retrieved_at: retrievedAt,
    source_vintage: sourceVintage ?? retrievedAt,
    content_type: contentType,
    byte_count: byteCount,
    content_hash: contentHash,
    raw_object_path: rawRelPath,
    row_or_document_count: rowOrDocumentCount,
    pagination_complete: true,
    parser_version: "seqra_source_inventory.v1",
    warnings,
    latency_ms: latencyMs,
    purpose,
  };
  return { json, fetch: fetch_, ok: response.ok };
}

function soqlUrl(domain, datasetId, params) {
  const search = new URLSearchParams(params).toString();
  return `https://${domain}/resource/${datasetId}.json?${search}`;
}

async function acquireDatasetMetadata(domain, datasetId) {
  const url = `https://${domain}/api/views/${datasetId}`;
  const { json, fetch: fetchReceipt } = await fetchAndReceipt({
    sourceId: datasetId,
    purpose: "dataset_metadata",
    url,
    rawSlug: "dataset_metadata",
  });
  await sleep(POLITE_DELAY_MS);
  if (!json) return { metadata: null, fetch: fetchReceipt };
  return {
    metadata: {
      name: json.name ?? null,
      rows_updated_at: Number.isFinite(Number(json.rowsUpdatedAt))
        ? new Date(Number(json.rowsUpdatedAt) * 1000).toISOString()
        : null,
      metadata_updated_at: Number.isFinite(Number(json.metadataUpdatedAt))
        ? new Date(Number(json.metadataUpdatedAt) * 1000).toISOString()
        : null,
      columns: (json.columns ?? []).map(({ name, fieldName, dataTypeName }) => ({
        name,
        field_name: fieldName,
        data_type: dataTypeName,
      })),
    },
    fetch: fetchReceipt,
  };
}

/** Run the full bounded aggregate-query set for one Tier-1 SODA source. */
async function fetchSodaSourceObservation(sourceId) {
  const config = SEQRA_SODA_SOURCE_CONFIG[sourceId];
  const { metadata, fetch: metadataFetch } = await acquireDatasetMetadata(config.domain, config.datasetId);
  const sourceVintage = metadata?.rows_updated_at ?? null;
  const queries = { dataset_metadata_fetch: metadataFetch };

  async function run(purpose, params, rawSlug) {
    const { json, fetch: fetchReceipt } = await fetchAndReceipt({
      sourceId,
      purpose,
      url: soqlUrl(config.domain, config.datasetId, params),
      rawSlug,
      sourceVintage,
    });
    await sleep(POLITE_DELAY_MS);
    return { json, fetch: fetchReceipt };
  }

  const total = await run("total_count", { $select: "count(*) as n" }, "total_count");
  queries.total_count = { value: Number(total.json?.[0]?.n ?? NaN), fetch: total.fetch };

  if (config.yearField) {
    const yr = await run(
      "year_breakdown",
      {
        $select: `date_extract_y(${config.yearField}) as year, count(*) as n`,
        $group: "year",
        $order: "year",
        $limit: String(BREAKDOWN_LIMIT),
      },
      "year_breakdown",
    );
    yr.fetch.pagination_complete = (yr.json?.length ?? 0) < BREAKDOWN_LIMIT;
    queries.year_breakdown = { rows: (yr.json ?? []).map((row) => ({ year: row.year, n: Number(row.n) })), fetch: yr.fetch };
  }

  if (config.agencyField) {
    const ag = await run(
      "agency_breakdown",
      { $select: `${config.agencyField} as agency, count(*) as n`, $group: "agency", $order: "n DESC", $limit: String(BREAKDOWN_LIMIT) },
      "agency_breakdown",
    );
    ag.fetch.pagination_complete = (ag.json?.length ?? 0) < BREAKDOWN_LIMIT;
    queries.agency_breakdown = { rows: (ag.json ?? []).map((row) => ({ agency: row.agency, n: Number(row.n) })), fetch: ag.fetch };
  }

  if (config.eventTypeField) {
    const ev = await run(
      "event_type_breakdown",
      { $select: `${config.eventTypeField} as event_type, count(*) as n`, $group: "event_type", $order: "n DESC", $limit: String(BREAKDOWN_LIMIT) },
      "event_type_breakdown",
    );
    ev.fetch.pagination_complete = (ev.json?.length ?? 0) < BREAKDOWN_LIMIT;
    queries.event_type_breakdown = { rows: (ev.json ?? []).map((row) => ({ event_type: row.event_type, n: Number(row.n) })), fetch: ev.fetch };
  }

  if (config.reviewStatusField) {
    const st = await run(
      "review_status_breakdown",
      { $select: `${config.reviewStatusField} as review_status, count(*) as n`, $group: "review_status", $order: "n DESC", $limit: String(BREAKDOWN_LIMIT) },
      "review_status_breakdown",
    );
    st.fetch.pagination_complete = (st.json?.length ?? 0) < BREAKDOWN_LIMIT;
    queries.review_status_breakdown = { rows: (st.json ?? []).map((row) => ({ review_status: row.review_status, n: Number(row.n) })), fetch: st.fetch };
  }

  if (config.regimeLabelField) {
    const rl = await run(
      "regime_label_sample",
      { $select: `${config.regimeLabelField} as label, count(*) as n`, $group: "label", $order: "n DESC", $limit: "50" },
      "regime_label_sample",
    );
    queries.regime_label_sample = { rows: (rl.json ?? []).map((row) => ({ label: row.label, n: Number(row.n) })), fetch: rl.fetch };
  }

  queries.missingness = {};
  for (const field of config.missingnessFields) {
    const ms = await run("missingness", { $select: "count(*) as n", $where: `${field} IS NULL` }, `missingness_${field}`);
    queries.missingness[field] = { value: Number(ms.json?.[0]?.n ?? NaN), fetch: ms.fetch };
  }

  if (config.dateField) {
    const dr = await run(
      "date_range",
      { $select: `min(${config.dateField}) as min_date, max(${config.dateField}) as max_date` },
      "date_range",
    );
    queries.date_range = { min_date: dr.json?.[0]?.min_date ?? null, max_date: dr.json?.[0]?.max_date ?? null, fetch: dr.fetch };
  }

  const dupSelect = config.dedupeKeyFields.map((field) => field).join(", ");
  const dup = await run(
    "duplicate_keys",
    {
      $select: `${dupSelect}, count(*) as n`,
      $group: dupSelect,
      $having: "count(*) > 1",
      $order: "n DESC",
      $limit: String(DUPLICATE_GROUP_LIMIT),
    },
    "duplicate_keys",
  );
  const dupRows = (dup.json ?? []).map((row) => ({
    key_values: config.dedupeKeyFields.map((field) => row[field]),
    n: Number(row.n),
  }));
  const duplicateGroupQueryComplete = dupRows.length < DUPLICATE_GROUP_LIMIT;
  dup.fetch.pagination_complete = duplicateGroupQueryComplete;

  // A single-column key also gets an exact, unbounded duplicate-row count via
  // count(distinct key) -- this is immune to the $having listing's pagination
  // cap, so it stays exact even when a source has more duplicate groups than
  // the cap (as NYS DEC DART does on application_id).
  let exactDuplicateRowCount = null;
  let distinctKeyFetch = null;
  if (config.dedupeKeyFields.length === 1) {
    const distinctKeyField = config.dedupeKeyFields[0];
    const distinct = await run(
      "distinct_key_count",
      { $select: `count(distinct ${distinctKeyField}) as n` },
      "distinct_key_count",
    );
    const distinctKeyCount = Number(distinct.json?.[0]?.n ?? NaN);
    if (Number.isFinite(distinctKeyCount)) {
      exactDuplicateRowCount = queries.total_count.value - distinctKeyCount;
    }
    distinctKeyFetch = distinct.fetch;
  }

  queries.duplicate_keys = {
    duplicate_key_groups_count: dupRows.length,
    duplicate_row_count_from_groups: dupRows.reduce((sum, row) => sum + (row.n - 1), 0),
    duplicate_row_count_exact: exactDuplicateRowCount,
    group_listing_pagination_complete: duplicateGroupQueryComplete,
    sample_groups: dupRows.slice(0, 50),
    fetch: dup.fetch,
    distinct_key_fetch: distinctKeyFetch,
  };

  const sample = await run(
    "schema_sample",
    { $select: "*", $limit: String(SCHEMA_SAMPLE_LIMIT) },
    "schema_sample",
  );
  queries.schema_sample = { rows: sample.json ?? [], fetch: sample.fetch };

  return { sourceId, datasetMetadata: metadata, queries };
}

async function fetchDiscoveryProbe(sourceId, url) {
  if (!url || url === "unknown") return null;
  try {
    const { fetch: fetchReceipt } = await fetchAndReceipt({
      sourceId,
      purpose: "discovery_probe",
      url,
      rawSlug: "discovery_probe",
    });
    await sleep(POLITE_DELAY_MS);
    return {
      http_status: fetchReceipt.http_status,
      content_type: fetchReceipt.content_type,
      byte_count: fetchReceipt.byte_count,
      fetch: fetchReceipt,
    };
  } catch (error) {
    return {
      http_status: null,
      content_type: null,
      byte_count: null,
      fetch: { source_id: sourceId, request_url_or_query: url, warnings: [`request failed: ${error.message}`] },
    };
  }
}

async function refreshObservation() {
  const sodaObservations = {};
  for (const sourceId of SEQRA_SODA_SOURCE_IDS) {
    sodaObservations[sourceId] = await fetchSodaSourceObservation(sourceId);
  }

  const discoveryProbeSourceIds = SEQRA_SOURCE_REGISTRY.filter((entry) => entry.access_type === "discovery_probe").map((entry) => entry.source_id);
  const discoveryObservations = {};
  for (const sourceId of discoveryProbeSourceIds) {
    const entry = SEQRA_SOURCE_REGISTRY.find((candidate) => candidate.source_id === sourceId);
    discoveryObservations[sourceId] = await fetchDiscoveryProbe(sourceId, entry.base_url);
  }

  return {
    schema: "cityscroll.seqra_source_inventory_observation.v1",
    materialized_at: new Date().toISOString(),
    soda_observations: sodaObservations,
    discovery_observations: discoveryObservations,
  };
}

function loadReconciliationBaseline() {
  try {
    const receipt = JSON.parse(readFileSync(RECONCILIATION_RECEIPT, "utf8"));
    return {
      source_receipt: "warehouse/receipts/proof/ceqr_project_milestone_reconciliation_latest.json",
      exact_project_joins: receipt?.reconciliation?.exact_project_matches ?? null,
      exact_match_rate: receipt?.reconciliation?.exact_match_rate ?? null,
      joined_milestone_rows: receipt?.reconciliation?.joined_milestone_rows ?? null,
      projects_with_incremental_milestones: receipt?.reconciliation?.projects_with_incremental_milestones ?? null,
      resident_ingestion_committed: receipt?.gate?.resident_ingestion_committed ?? null,
    };
  } catch {
    return null;
  }
}

function build(observation) {
  const sourceProfiles = [];
  for (const sourceId of SEQRA_SODA_SOURCE_IDS) {
    const observed = observation.soda_observations[sourceId];
    sourceProfiles.push(
      buildSodaSourceProfile(sourceId, observed.queries, { datasetMetadata: observed.datasetMetadata }),
    );
  }
  const profilesBySourceId = Object.fromEntries(sourceProfiles.map((profile) => [profile.source_id, profile]));

  const discoveryOrOnlySources = SEQRA_SOURCE_REGISTRY.filter((entry) => !SEQRA_SODA_SOURCE_IDS.includes(entry.source_id));
  const coverageWarnings = [];
  for (const entry of discoveryOrOnlySources) {
    const discoveryResult = observation.discovery_observations?.[entry.source_id] ?? null;
    sourceProfiles.push(buildDiscoverySourceProfile(entry.source_id, discoveryResult));
    coverageWarnings.push(`${entry.source_id}: ${entry.known_gaps[0]}`);
  }

  const scopeSummary = summarizeScopeClassification(SEQRA_JURISDICTION_FIXTURE_BATCH);
  const targetPopulationEstimates = buildTargetPopulationEstimates(profilesBySourceId);

  return buildSeqraInventoryReceipt({
    generatedAt: observation.materialized_at,
    sourceProfiles,
    scopeClassificationSummary: scopeSummary,
    targetPopulationEstimates,
    coverageWarnings,
    reconciliationBaseline: loadReconciliationBaseline(),
  });
}

const args = new Set(process.argv.slice(2));
const validFlags = new Set(["--refresh", "--check"]);
for (const arg of args) {
  if (!validFlags.has(arg)) throw new Error("Usage: node tools/build_seqra_source_inventory.mjs [--refresh|--check]");
}
if (args.has("--check") && args.has("--refresh")) throw new Error("Choose --refresh or --check, not both");

let observation;
if (args.has("--refresh")) {
  observation = await refreshObservation();
  mkdirSync(path.dirname(OBSERVATION), { recursive: true });
  writeFileSync(OBSERVATION, stringify(observation));
  console.log(`wrote ${path.relative(ROOT, OBSERVATION)}`);
} else {
  observation = JSON.parse(readFileSync(OBSERVATION, "utf8"));
}

const next = stringify(build(observation));
if (args.has("--check")) {
  const current = readFileSync(RECEIPT, "utf8");
  if (current !== next) throw new Error(`${path.relative(ROOT, RECEIPT)} is stale; run the builder`);
  console.log(`SEQRA source inventory receipt OK (${JSON.parse(next).gate.result})`);
} else {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, next);
  console.log(`wrote ${path.relative(ROOT, RECEIPT)}`);
}
