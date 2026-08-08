#!/usr/bin/env node
/**
 * Materialize ontology-delta view (Living Civic Graph · first praxis wave).
 *
 *   node tools/build_ontology_delta.mjs
 *   node tools/build_ontology_delta.mjs --check
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ONTOLOGY_DELTA_SCHEMA,
  ONTOLOGY_DELTA_SHARE_PATH,
  buildOntologyDeltaLookup,
  renderOntologyDeltaDocument,
} from "../site/ontology_delta.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const LOOKUP_OUT = join(SITE, "data/ontology_delta_lookup.json");
const DOC_OUT = join(SITE, "graph/ontology-delta/index.html");
const BASELINE = join(SITE, "data/ontology_inventory_baseline.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadSources() {
  const optional = (rel) => {
    const path = join(SITE, rel);
    return existsSync(path) ? readJson(path) : null;
  };
  if (!existsSync(BASELINE)) {
    throw new Error("Missing site/data/ontology_inventory_baseline.json");
  }
  return {
    baseline: readJson(BASELINE),
    entityIntelligence: optional("data/entity_intelligence_lookup.json"),
    constellation: optional("data/agency_constellation_lookup.json"),
    obligations: optional("data/agency_obligations_lookup.json"),
  };
}

export function writeOntologyDeltaArtifacts({ check = false } = {}) {
  const sources = loadSources();
  // Prefer the newest source stamp for the public "inventory as of" line.
  const stamps = [
    sources.entityIntelligence?.generated_at,
    sources.constellation?.generated_at,
    sources.obligations?.generated_at,
  ].filter(Boolean).sort();
  const generatedAt = stamps[stamps.length - 1] || new Date().toISOString();

  const lookup = buildOntologyDeltaLookup({
    ...sources,
    generatedAt,
  });
  if (lookup.schema !== ONTOLOGY_DELTA_SCHEMA) {
    throw new Error(`unexpected schema ${lookup.schema}`);
  }

  // Drop full agency list from public lookup payload size (keep ids + added rows).
  const publicLookup = {
    ...lookup,
    inventory: {
      schema: lookup.inventory?.schema,
      role: "current",
      generated_at: lookup.inventory?.generated_at,
      source: lookup.inventory?.source,
      root_kinds: lookup.inventory?.root_kinds,
      domains: lookup.inventory?.domains,
      object_kinds: lookup.inventory?.object_kinds,
      edge_types: lookup.inventory?.edge_types,
      agency_ids: lookup.inventory?.agency_ids,
      vendor_count: lookup.inventory?.vendor_count,
      constellation_categories: lookup.inventory?.constellation_categories,
      deliverable_types: lookup.inventory?.deliverable_types,
      // agencies full list omitted from committed lookup (available via extract)
      agency_count: lookup.inventory?.agency_ids?.length || 0,
    },
  };

  const lookupJson = `${JSON.stringify(publicLookup, null, 2)}\n`;
  const documentHtml = renderOntologyDeltaDocument(lookup, { assetPrefix: "/" });

  let stale = 0;
  const writeIfChanged = (path, content) => {
    const prev = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (prev === content) return;
    stale += 1;
    if (!check) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  };

  writeIfChanged(LOOKUP_OUT, lookupJson);
  writeIfChanged(DOC_OUT, documentHtml);

  if (check && stale) {
    console.error(
      "ontology-delta artifacts are stale; rebuild with node tools/build_ontology_delta.mjs",
    );
    process.exit(1);
  }

  const summary = `ontology_delta total_added=${lookup.total_added} edges=${lookup.counts.edge_types} kinds=${lookup.counts.object_kinds} agencies=${lookup.counts.agencies} categories=${lookup.counts.constellation_categories} deliverables=${lookup.counts.deliverable_types} path=${ONTOLOGY_DELTA_SHARE_PATH}`;
  console.log(check ? `ok ${summary}` : `built ${summary}`);
  return { lookup: publicLookup, stale, documentHtml };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeOntologyDeltaArtifacts({ check: process.argv.includes("--check") });
}
