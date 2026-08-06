#!/usr/bin/env node
// Rank obtainable civic-data key spaces before adding a source to the depot.
// Catalog metadata is evidence for a candidate only; this tool never measures
// or publishes row-level joins.
//
//   node tools/depot_catalog_sweep.mjs
//   node tools/depot_catalog_sweep.mjs --output path/to/receipt.json

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEPOT_RECEIPT_DIR,
  loadGapTaxonomy,
  rankObtainableCatalogCandidates,
} from "./depot.mjs";

const CATALOG_URL = "https://api.us.socrata.com/api/catalog/v1";
const DOMAIN = "data.cityofnewyork.us";

function parseArgs(argv) {
  const args = {
    domain: DOMAIN,
    limit: 5000,
    output: null,
    input: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--domain") args.domain = argv[++i];
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--output") args.output = argv[++i];
    else if (arg === "--input") args.input = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

async function loadCatalog(args) {
  if (args.input) return JSON.parse(readFileSync(args.input, "utf8"));
  const url = new URL(CATALOG_URL);
  url.searchParams.set("domains", args.domain);
  url.searchParams.set("limit", String(args.limit));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`catalog request failed: HTTP ${response.status}`);
  return response.json();
}

function asCatalogRows(payload) {
  return Array.isArray(payload) ? payload : payload.results || [];
}

export function buildCatalogSweepReceipt(payload, registry, { observedOn } = {}) {
  const rows = asCatalogRows(payload);
  const candidates = rankObtainableCatalogCandidates(rows, { sources: registry.sources || [] });
  const validationIds = ["a9md-ynri", "kpav-sd4t"];
  const validation = validationIds.map((dataset_id) => {
    const candidate = candidates.find((row) => row.dataset_id === dataset_id);
    return {
      dataset_id,
      surfaced: Boolean(candidate),
      rank: candidate ? candidates.indexOf(candidate) + 1 : null,
      score: candidate?.score ?? null,
      key_spaces: candidate?.key_spaces || [],
      candidate_status: candidate?.candidate_status || "not_found",
    };
  });

  return {
    schema_version: 1,
    kind: "depot_catalog_sweep",
    observed_on: observedOn || new Date().toISOString().slice(0, 10),
    catalog: {
      domain: DOMAIN,
      result_set_size: payload.resultSetSize ?? rows.length,
      returned: rows.length,
      source: "Socrata catalog API",
    },
    ranking: {
      method: "obtainable_key_spaces_v1",
      coverage_policy: "Catalog column metadata identifies candidates only; row-level join coverage remains unknown until reviewed.",
      candidate_count: candidates.length,
    },
    validation,
    top_candidates: candidates.slice(0, 25),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node tools/depot_catalog_sweep.mjs [--output path] [--input fixture.json] [--limit 5000]");
    return;
  }

  const payload = await loadCatalog(args);
  const registry = loadGapTaxonomy();
  const receipt = buildCatalogSweepReceipt(payload, registry);
  const output = args.output || join(DEPOT_RECEIPT_DIR, `catalog_sweep_${receipt.observed_on}.json`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(join(DEPOT_RECEIPT_DIR, "catalog_latest.json"), `${JSON.stringify(receipt, null, 2)}\n`);

  console.log(`catalog: ${receipt.catalog.returned}/${receipt.catalog.result_set_size} resources`);
  console.log(`candidates: ${receipt.ranking.candidate_count}`);
  for (const row of receipt.validation) {
    console.log(`  ${row.dataset_id}: ${row.surfaced ? `rank=${row.rank} score=${row.score}` : "not surfaced"}`);
  }
  console.log("top candidates:");
  for (const candidate of receipt.top_candidates.slice(0, 10)) {
    console.log(`  - ${candidate.dataset_id} score=${candidate.score} keys=${candidate.key_spaces.map((key) => key.id).join(",")}`);
  }
  console.log(`wrote ${output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
