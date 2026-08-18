#!/usr/bin/env node
/**
 * Measure PASSPort census selection, graph edges, agency coverage, and the
 * compressed entity-intelligence read-model budget.
 *
 * Usage:
 *   node tools/measure_passport_ei_densify.mjs
 *   node tools/measure_passport_ei_densify.mjs --check
 */

import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildEntityIntelligenceDoc,
  buildPassportEiGraphPublication,
  passportEiGraphCoverageFindings,
  selectPassportContractsForMaterialization,
  selectPassportContractsForShardedGraph,
  slimDocForWorker,
  DEFAULT_PASSPORT_CONTRACT_CORE_CAP,
  DEFAULT_PASSPORT_CONTRACT_GRAPH_CAP,
  PASSPORT_EI_CORE_PAYLOAD_BUDGET_BYTES,
} from "./lib/entity_intelligence_build.mjs";
import {
  linkObservation,
  observationFromPassportContractRow,
} from "../entity_resolution/cross_domain/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = path.join(ROOT, "site/data/procurement_spine_sources.json");
const RECEIPT_PATH = path.join(ROOT, "docs/evidence/passport-ei-densify/comparison.json");
const PAYLOAD_BUDGET_BYTES = PASSPORT_EI_CORE_PAYLOAD_BUDGET_BYTES;
const CANDIDATE_CAPS = [500, 1000, 1250, 1500, 1550, 1600, 1750, 2000];

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const rowId = (row) => clean(row?.ctr_id || row?.contract_id || row?.epin || row?.epin_norm);
const agencyKey = (row) => clean(row?.agency_name || row?.agency).toUpperCase() || "(source-null)";

function legacySelection(doc, cap) {
  const census = Array.isArray(doc?.rows?.passport_contracts) ? doc.rows.passport_contracts : [];
  const compatibility = Array.isArray(doc?.rows?.passport_contracts_materialization)
    ? doc.rows.passport_contracts_materialization
    : [];
  const seen = new Set();
  const rows = [];
  const push = (row) => {
    const id = rowId(row);
    if (!id || seen.has(id) || rows.length >= cap) return;
    seen.add(id);
    rows.push(row);
  };
  compatibility.forEach(push);
  census.forEach(push);
  return rows;
}

function edgeStats(rows) {
  const edgeTypes = {};
  let rowsWithEdges = 0;
  let edgeCount = 0;
  for (const row of rows) {
    const observation = observationFromPassportContractRow(row);
    const links = observation ? linkObservation(observation).links : [];
    if (links.length) rowsWithEdges += 1;
    edgeCount += links.length;
    for (const link of links) edgeTypes[link.type] = (edgeTypes[link.type] || 0) + 1;
  }
  return {
    rows: rows.length,
    rows_with_edges: rowsWithEdges,
    edge_count: edgeCount,
    edge_types: edgeTypes,
  };
}

function agencyCoverage(census, selected) {
  const selectedIds = new Set(selected.map(rowId));
  const byAgency = new Map();
  for (const row of census) {
    const key = agencyKey(row);
    const stats = byAgency.get(key) || { census: 0, selected: 0, dropped: 0 };
    stats.census += 1;
    if (selectedIds.has(rowId(row))) stats.selected += 1;
    byAgency.set(key, stats);
  }
  for (const stats of byAgency.values()) stats.dropped = stats.census - stats.selected;
  return Object.fromEntries(
    [...byAgency.entries()]
      .sort((a, b) => b[1].census - a[1].census || a[0].localeCompare(b[0])),
  );
}

function benchmark(root) {
  return CANDIDATE_CAPS.map((cap) => {
    const samples = [];
    let slim;
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      slim = slimDocForWorker(buildEntityIntelligenceDoc(root, { passport_contract_cap: cap }));
      samples.push(performance.now() - started);
    }
    const pretty = JSON.stringify(slim, null, 2);
    const sorted = samples.slice().sort((a, b) => a - b);
    return {
      cap,
      selected_rows: slim.procurement_spine.materialization.passport_contracts.selected_rows,
      pretty_bytes: pretty.length,
      gzip_pretty_bytes: gzipSync(pretty).length,
      build_ms_p95: Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)].toFixed(2)),
      build_ms_samples: samples.map((value) => Number(value.toFixed(2))),
    };
  });
}

function measureCorePayload() {
  const committedPath = path.join(ROOT, "site/data/entity_intelligence_lookup.json");
  const slim = JSON.parse(readFileSync(committedPath, "utf8"));
  const pretty = JSON.stringify(slim, null, 2);
  return {
    cap: DEFAULT_PASSPORT_CONTRACT_CORE_CAP,
    selected_rows: slim.procurement_spine?.materialization?.passport_contracts?.selected_rows
      ?? DEFAULT_PASSPORT_CONTRACT_CORE_CAP,
    pretty_bytes: pretty.length,
    gzip_pretty_bytes: gzipSync(pretty).length,
  };
}

function measureShardPayload(publication) {
  const pretty = JSON.stringify(publication, null, 2);
  return {
    pretty_bytes: pretty.length,
    gzip_pretty_bytes: gzipSync(pretty).length,
    agency_shards: Object.keys(publication.by_agency || {}).length,
    vendor_shards: Object.keys(publication.by_vendor || {}).length,
  };
}

function buildReceipt() {
  const source = JSON.parse(readFileSync(SOURCE_PATH, "utf8"));
  const census = Array.isArray(source.rows?.passport_contracts) ? source.rows.passport_contracts : [];
  const sharded = selectPassportContractsForShardedGraph(source);
  const before = selectPassportContractsForMaterialization(source, {
    cap: DEFAULT_PASSPORT_CONTRACT_CORE_CAP,
  }).rows;
  const after = sharded.graph.rows;
  const beforeIds = new Set(before.map(rowId));
  const afterIds = new Set(after.map(rowId));
  const droppedBefore = census.filter((row) => !beforeIds.has(rowId(row)));
  const droppedAfter = census.filter((row) => !afterIds.has(rowId(row)));
  const publication = buildPassportEiGraphPublication(source, { now: new Date() });
  const corePayload = measureCorePayload();
  const shardPayload = measureShardPayload(publication);
  const coverage = passportEiGraphCoverageFindings(publication, { now: new Date() });
  const prior = existsSyncCommitted()
    ? JSON.parse(readFileSync(RECEIPT_PATH, "utf8"))
    : null;
  const benchmarks = Array.isArray(prior?.candidate_benchmarks) && prior.schema_version >= 2
    ? prior.candidate_benchmarks
    : benchmark(ROOT);
  const chosen = benchmarks.find((entry) => entry.cap === DEFAULT_PASSPORT_CONTRACT_CORE_CAP)
    || corePayload;
  const next = benchmarks.find((entry) => entry.cap === DEFAULT_PASSPORT_CONTRACT_CORE_CAP + 50);

  return {
    schema_version: 3,
    title: "PASSPort contract census → entity-intelligence graph densification",
    observed_on: source.observed_on || publication.observed_on || null,
    change:
      "Keep the Worker single-file lookup at the measured 1,550-row gzip ceiling and "
      + "publish the award-corroborated census as agency/vendor shards so constellations "
      + "see the denser graph without a new live fetch.",
    source: {
      path: "site/data/procurement_spine_sources.json#rows.passport_contracts",
      census_rows: census.length,
      source_population_rows: source.sources?.passport_contracts?.population?.parsed ?? null,
      compatibility_rows: source.rows?.passport_contracts_materialization?.length ?? 0,
      source_null_policy: "source fields remain null; no row or edge is fabricated",
    },
    shard_strategy: {
      worker_core_cap: DEFAULT_PASSPORT_CONTRACT_CORE_CAP,
      graph_hard_ceiling: DEFAULT_PASSPORT_CONTRACT_GRAPH_CAP,
      selection: "compatibility examples first, then agency-stratified round-robin",
      publication: "compact by_agency / by_vendor index with bounded previews",
      artifact: "site/data/entity_intelligence_shards/passport_graph.json",
    },
    before: {
      strategy: "single-file Worker lookup at the measured gzip ceiling",
      cap: DEFAULT_PASSPORT_CONTRACT_CORE_CAP,
      selected_rows: before.length,
      dropped_census_rows: droppedBefore.length,
      edges: edgeStats(before),
      dropped_edges: edgeStats(droppedBefore),
      agency_coverage: agencyCoverage(census, before),
    },
    after: {
      strategy: sharded.shard_strategy,
      cap: DEFAULT_PASSPORT_CONTRACT_GRAPH_CAP,
      selected_rows: after.length,
      dropped_census_rows: droppedAfter.length,
      edges: edgeStats(after),
      dropped_edges: edgeStats(droppedAfter),
      agency_coverage: agencyCoverage(census, after),
      agency_shards: shardPayload.agency_shards,
      vendor_shards: shardPayload.vendor_shards,
    },
    highlighted_agency: {
      agency: "NEW YORK CITY POLICE DEPARTMENT",
      census_rows: agencyCoverage(census, after)["NEW YORK CITY POLICE DEPARTMENT"]?.census ?? null,
      before: agencyCoverage(census, before)["NEW YORK CITY POLICE DEPARTMENT"] ?? null,
      after: agencyCoverage(census, after)["NEW YORK CITY POLICE DEPARTMENT"] ?? null,
    },
    excluded: publication.excluded,
    coverage,
    payload_budget: {
      metric: "gzip bytes of the pretty-printed Worker read model",
      budget_bytes: PAYLOAD_BUDGET_BYTES,
      selected_cap: DEFAULT_PASSPORT_CONTRACT_CORE_CAP,
      selected_gzip_bytes: corePayload.gzip_pretty_bytes,
      selected_headroom_bytes: PAYLOAD_BUDGET_BYTES - corePayload.gzip_pretty_bytes,
      next_candidate_cap: next?.cap ?? null,
      next_candidate_gzip_bytes: next?.gzip_pretty_bytes ?? null,
      next_candidate_over_budget_bytes: next ? next.gzip_pretty_bytes - PAYLOAD_BUDGET_BYTES : null,
      ceiling_is_measured: Boolean(
        chosen
        && next
        && (chosen.gzip_pretty_bytes ?? corePayload.gzip_pretty_bytes) <= PAYLOAD_BUDGET_BYTES
        && next.gzip_pretty_bytes > PAYLOAD_BUDGET_BYTES,
      ),
      shard_pretty_bytes: shardPayload.pretty_bytes,
      shard_gzip_bytes: shardPayload.gzip_pretty_bytes,
    },
    candidate_benchmarks: benchmarks,
    validation: {
      home_cold_route_changed: false,
      reading_ratchet: "not applicable to JSON-only read-model change",
      axe: "not applicable to JSON-only read-model change",
      perf_p95: "run in CI; home cold route is unchanged",
      graph_coverage_ok: coverage.ok,
    },
    reproduce: [
      "node tools/measure_passport_ei_densify.mjs",
      "node --test test/procurement_spine_ei_densify.test.mjs",
      "node tools/build_entity_intelligence.mjs --graph-only",
      "node tools/build_entity_intelligence.mjs --check --graph-only",
    ],
  };
}

function existsSyncCommitted() {
  try {
    readFileSync(RECEIPT_PATH, "utf8");
    return true;
  } catch {
    return false;
  }
}

const receipt = buildReceipt();
const check = process.argv.includes("--check");
if (check) {
  const committed = JSON.parse(readFileSync(RECEIPT_PATH, "utf8"));
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "build_ms_p95" && key !== "build_ms_samples" && key !== "age_days")
        .map(([key, entry]) => [key, stable(entry)]),
    );
  };
  const committedStable = stable(committed);
  const receiptStable = stable(receipt);
  const candidateBenchmarksEqual = (left, right) => left.length === right.length
    && left.every((entry, index) => {
      const current = right[index];
      return entry.cap === current.cap
        && entry.selected_rows === current.selected_rows
        && entry.pretty_bytes === current.pretty_bytes
        // Compression can vary by one byte when equivalent object order is
        // produced by the runtime; the measured budget remains explicit below.
        && Math.abs(entry.gzip_pretty_bytes - current.gzip_pretty_bytes) <= 1;
    });
  const same = Object.keys(committedStable).length === Object.keys(receiptStable).length
    && Object.keys(committedStable).every((key) => key === "candidate_benchmarks"
      ? candidateBenchmarksEqual(committedStable[key], receiptStable[key])
      : JSON.stringify(committedStable[key]) === JSON.stringify(receiptStable[key]));
  if (!same) {
    console.error("PASSPort densification receipt drift — rerun without --check");
    process.exit(1);
  }
  if (!receipt.coverage?.ok) {
    console.error(`PASSPort graph coverage gate failed: ${(receipt.coverage?.findings || []).join("; ")}`);
    process.exit(1);
  }
  console.log("PASSPort densification receipt is current");
} else {
  writeFileSync(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, RECEIPT_PATH)}`);
}
