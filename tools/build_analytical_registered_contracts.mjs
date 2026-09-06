#!/usr/bin/env node
/** Build the precomputed registered-contract analytical projection. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseContractTransactions } from "../worker/src/lib/checkbook_lifecycle.mjs";
import {
  classifyCheckbookCityRecordMatches,
  normalizeCheckbookContractRows,
} from "../warehouse/lib/checkbook_contracts.mjs";
import { ANALYTICAL_PROJECTION_SCHEMA } from "../site/analytical_projection_contract.mjs";
import { buyerHistoryRepairObservation } from "../site/buyer_contracting_history.mjs";
import {
  CHECKBOOK_DIMENSION_PROFILE_FIELDS,
  normalizeAnalyticalContractRow,
  profileDimension,
  registrationTimingSummary,
} from "../site/analytical_projection.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUT = join(ROOT, "warehouse/raw/checkbook-contracts/normalized.json");
const DEFAULT_OUTPUT = join(ROOT, "site/data/analytics_registered_contracts.json");
const DEFAULT_RECEIPT = join(ROOT, "warehouse/receipts/proof/analytics_registered_contracts_population_latest.json");
const DEFAULT_FIXTURE = join(ROOT, "warehouse/fixtures/checkbook-contracts/collector.json");
const DEFAULT_SOURCE_RECEIPT = join(ROOT, "warehouse/receipts/proof/checkbook_contracts_population_latest.json");
const DEFAULT_CITY_RECORD_INPUT = join(ROOT, "site/data/ocp_awards_warehouse_lookup.json");
const DEFAULT_PIN_SOURCE = join(ROOT, "site/data/procurement_browse_rows.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sourcePathLabel(path) {
  const relativePath = relative(ROOT, resolve(path)).replaceAll("\\", "/");
  if (relativePath && relativePath !== ".." && !relativePath.startsWith("../")) return relativePath;
  return `external-input:${basename(path)}`;
}

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    receipt: DEFAULT_RECEIPT,
    sourceReceipt: DEFAULT_SOURCE_RECEIPT,
    cityRecordInput: DEFAULT_CITY_RECORD_INPUT,
    pinSource: DEFAULT_PIN_SOURCE,
    fixture: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") args.input = resolve(argv[++i]);
    else if (arg === "--output") args.output = resolve(argv[++i]);
    else if (arg === "--receipt") args.receipt = resolve(argv[++i]);
    else if (arg === "--source-receipt") args.sourceReceipt = resolve(argv[++i]);
    else if (arg === "--city-record-input") args.cityRecordInput = resolve(argv[++i]);
    else if (arg === "--pin-source") args.pinSource = resolve(argv[++i]);
    else if (arg === "--from-fixture") args.fixture = DEFAULT_FIXTURE;
    else if (arg === "--fixture") args.fixture = resolve(argv[++i]);
    else if (arg === "--check") args.check = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function rowsFromDocument(path) {
  if (!path || !existsSync(path)) return [];
  const value = readJson(path);
  return Array.isArray(value) ? value : Array.isArray(value.rows) ? value.rows : [];
}

function exactContractPins(path) {
  const byId = new Map();
  for (const row of rowsFromDocument(path)) {
    const id = String(row?.prime_contract_id || row?.contract_id || row?.id || "").trim();
    const pin = String(row?.pin || row?.prime_contract_pin || "").trim();
    if (id && pin && !byId.has(id)) byId.set(id, pin);
  }
  return byId;
}

function fixtureRows(path) {
  const fixture = readJson(path);
  return Object.entries(fixture.pages || {}).flatMap(([key, xml]) => {
    const year = key.split(":")[0];
    return parseContractTransactions(xml).map((row) => ({ ...row, sourceFiscalYears: [year] }));
  });
}

// The projection is not its own source. Rebuilding it from a previous copy of
// its own output silently drops every source field the projection does not
// itself carry: the run still reports a complete population, but each field
// added since that copy was written materializes as null for every row. That is
// how the committed population came to hold 26,270 contracts and no start date
// at all. Refuse the input instead of laundering it.
function assertSourcePopulation(input, path) {
  if (input?.schema === "cityscroll.analytics_registered_contracts.v1"
    || input?.projection_contract === ANALYTICAL_PROJECTION_SCHEMA) {
    throw new Error(`${path} is a built analytical projection, not a source population. `
      + "Rebuild from the normalized Checkbook population produced by the acquisition path "
      + "(warehouse/scripts/checkbook_contracts.mjs) or from a collector fixture.");
  }
  if (input?.schema && input.schema !== "cityscroll.checkbook_contracts.normalized.v1") {
    throw new Error(`${path} declares unsupported population schema ${input.schema}`);
  }
}

function sourceRows(args) {
  if (args.fixture) return fixtureRows(args.fixture);
  if (!existsSync(args.input)) {
    throw new Error(`normalized Checkbook population is missing: ${args.input}`);
  }
  const input = readJson(args.input);
  assertSourcePopulation(input, sourcePathLabel(args.input));
  if (!Array.isArray(input.rows)) throw new Error("normalized population must contain rows[]");
  return input.rows;
}

function measureDateRetention(sourceRowList, projectionRows) {
  const projected = new Map(projectionRows.map((row) => [row.prime_contract_id, row]));
  let sourceDated = 0;
  let lost = 0;
  for (const row of Array.isArray(sourceRowList) ? sourceRowList : []) {
    const id = String(row?.prime_contract_id || row?.contract_id || row?.id || "").trim();
    const start = row?.start || row?.start_date || null;
    const registered = row?.registered || row?.registration_date || null;
    if (!id || !start || !registered) continue;
    sourceDated += 1;
    const projectedRow = projected.get(id);
    if (!projectedRow?.start_date || !projectedRow?.registration_date) lost += 1;
  }
  return { source_dated_contract_count: sourceDated, lost_contract_count: lost };
}

function build(args) {
  const raw = sourceRows(args);
  const pinByContractId = exactContractPins(args.pinSource);
  const rawPinIds = new Set(raw
    .filter((row) => row?.pin || row?.prime_contract_pin)
    .map((row) => String(row?.prime_contract_id || row?.contract_id || row?.id || "").trim())
    .filter(Boolean));
  const enrichedRaw = raw.map((row) => {
    const id = String(row?.prime_contract_id || row?.contract_id || row?.id || "").trim();
    if (row?.pin || row?.prime_contract_pin || !pinByContractId.has(id)) return row;
    return { ...row, pin: pinByContractId.get(id) };
  });
  const normalized = args.fixture ? normalizeCheckbookContractRows(enrichedRaw) : {
    rows: enrichedRaw,
    counts: readJson(args.input).counts || { unique_contracts: enrichedRaw.length },
    blocked: readJson(args.input).blocked || {},
  };
  const baseRows = normalized.rows.map(normalizeAnalyticalContractRow).filter(Boolean);
  const cityRecordRows = rowsFromDocument(args.cityRecordInput);
  const rows = classifyCheckbookCityRecordMatches(baseRows, cityRecordRows);
  const recoveredPinCount = rows.filter((row) => row.pin && !rawPinIds.has(row.prime_contract_id)).length;
  const retention = measureDateRetention(normalized.rows, rows);
  // Population properties, never named upstream records: a source row that
  // published both dates must still carry both dates after projection. Losing
  // them is a materialization defect, so the build fails here instead of
  // publishing a population whose timing measure is silently unanswerable.
  if (retention.lost_contract_count) {
    throw new Error(`projection dropped published contract dates for ${retention.lost_contract_count} of `
      + `${retention.source_dated_contract_count} dated source contracts`);
  }
  const ids = new Set(rows.map((row) => row.prime_contract_id));
  if (ids.size !== rows.length) throw new Error("analytical projection contains duplicate prime_contract_id values");
  if (Number(normalized.counts.unique_contracts) !== rows.length) {
    throw new Error(`projection count ${rows.length} does not match normalized receipt ${normalized.counts.unique_contracts}`);
  }
  const timingSummary = registrationTimingSummary(rows);
  const sourceReceipt = existsSync(args.sourceReceipt) ? readJson(args.sourceReceipt) : null;
  const generatedAt = sourceReceipt?.source?.pulled_at || readJson(args.fixture || args.input).generated_at
    || readJson(args.fixture || args.input).observed_at || new Date().toISOString();
  const snapshotDate = String(generatedAt).slice(0, 10);
  const profile = Object.fromEntries(CHECKBOOK_DIMENSION_PROFILE_FIELDS.map((field) => [
    field.id,
    { ...field, ...profileDimension(rows, field.field) },
  ]));
  const payload = {
    schema: "cityscroll.analytics_registered_contracts.v1",
    projection_contract: ANALYTICAL_PROJECTION_SCHEMA,
    generated_at: generatedAt,
    snapshot_date: snapshotDate,
    population_definition: "Normalized Checkbook NYC registered expense contracts; one row per exact prime_contract_id across explicit collection fiscal-year partitions.",
    dimensions: ["agency", "prime_vendor", "registration_fiscal_year", "contract_amount_band", "award_method", "industry", "registration_timing", "city_record_match"],
    measures: ["unique_contract_count", "sum_original_registered_amount", "sum_current_registered_amount", "median_current_registered_amount", "eligible_contract_count", "missing_date_contract_count", "retroactive_contract_count", "retroactive_share", "median_registration_lag_days", "p75_registration_lag_days", "p90_registration_lag_days", "city_record_eligible_contract_count", "city_record_matched_contract_count", "city_record_unmatched_contract_count", "city_record_missing_pin_contract_count"],
    registration_timing_summary: timingSummary,
    city_record_match: {
      join: "existing exact normalized Checkbook PIN ↔ City Record award PIN overlap",
      city_record_input: sourcePathLabel(args.cityRecordInput),
      pin_enrichment: recoveredPinCount ? {
        source: sourcePathLabel(args.pinSource),
        join: "exact prime_contract_id only; used only to recover an omitted PIN field",
        recovered_contract_pins: recoveredPinCount,
      } : null,
      buckets: {
        exact: rows.filter((row) => row.city_record_match === "exact").length,
        none: rows.filter((row) => row.city_record_match === "none").length,
        cannot_evaluate_missing_pin: rows.filter((row) => row.city_record_match === "cannot_evaluate_missing_pin").length,
      },
    },
    source_population: {
      source_tag: "checkbook-contracts",
      observed_at: generatedAt,
      observation_basis: sourceReceipt?.source?.pulled_at
        ? "acquisition receipt pulled_at"
        : "reproducible input observation timestamp",
      normalized_unique_contracts: rows.length,
      source_fiscal_years: sourceReceipt?.source?.fiscal_years || [...new Set(raw.flatMap((row) => row.source_fiscal_years || []))].sort(),
      normalized_receipt: "embedded source_receipt envelope in the committed analytical population receipt",
    },
    rows,
  };
  const receipt = {
    schema: "cityscroll.analytics_registered_contracts_population_receipt.v1",
    status: "complete",
    projection_contract: ANALYTICAL_PROJECTION_SCHEMA,
    snapshot_date: snapshotDate,
    generated_at: generatedAt,
    population_definition: payload.population_definition,
    source: payload.source_population,
    source_receipt: sourceReceipt ? {
      schema: sourceReceipt.schema,
      pulled_at: sourceReceipt.source?.pulled_at || null,
      checksums: sourceReceipt.checksums || {},
      population: sourceReceipt.population || {},
    } : null,
    date_retention: retention,
    materialization_findings: timingSummary.eligible_contract_count === 0 && rows.length
      ? [buyerHistoryRepairObservation({
        reason: "registration-timing-not-materialized",
        contract_count: rows.length,
        snapshot_date: snapshotDate,
        detail: `reproducible input ${sourcePathLabel(args.fixture ? args.fixture : args.input)} published no contract start dates`,
      })]
      : [],
    population: {
      normalized_unique_contracts: rows.length,
      distinct_prime_contract_ids: ids.size,
      duplicate_contract_ids: rows.length - ids.size,
      duplicate_slices_collapsed: normalized.counts.duplicate_slices_collapsed || 0,
      blocked: normalized.blocked,
      registration_timing: timingSummary,
      city_record_match: payload.city_record_match,
    },
    dimension_profile: profile,
    materialization: {
      table: "analytics_registered_contracts",
      site_artifact: "site/data/analytics_registered_contracts.json",
      request_time_database_queries: false,
      reproducible_input: sourcePathLabel(args.fixture ? args.fixture : args.input),
    },
  };
  writeJson(args.output, payload);
  writeJson(args.receipt, receipt);
  return { payload, receipt };
}

function check(args) {
  const payload = readJson(args.output);
  const receipt = readJson(args.receipt);
  const ids = new Set((payload.rows || []).map((row) => row.prime_contract_id));
  if (payload.schema !== "cityscroll.analytics_registered_contracts.v1") throw new Error("wrong projection schema");
  if (ids.size !== payload.rows.length || ids.size !== receipt.population.distinct_prime_contract_ids) {
    throw new Error("projection distinct-contract check failed");
  }
  if (payload.rows.length !== receipt.population.normalized_unique_contracts) throw new Error("projection receipt count mismatch");
  console.log(`analytics registered contracts ok: population=${ids.size} table=analytics_registered_contracts`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node tools/build_analytical_registered_contracts.mjs [--input path] [--output path] [--receipt path] [--city-record-input path] [--pin-source path] [--from-fixture] [--check]");
} else if (args.check) {
  check(args);
} else {
  const { payload } = build(args);
  console.log(`wrote analytics projection: population=${payload.rows.length} output=${args.output}`);
}
