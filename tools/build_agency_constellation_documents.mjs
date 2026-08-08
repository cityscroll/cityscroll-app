#!/usr/bin/env node
/**
 * Materialize static agency constellation documents + lookup artifact.
 *
 * Consumes last-known-good entity-intelligence and exam-certification
 * materializations (daily freshness contract). Does not invent joins.
 *
 * Policy: per-agency HTML under site/agencies/<id>/index.html is a
 * build/deploy artifact (gitignored). Commit only the lookup JSON and the
 * directory index (site/agencies/index.html via build_agency_documents.mjs).
 * Cloudflare Pages runs this tool inside tools/build_cloudflare_pages.mjs
 * so production still ships the pages without storing them in git.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AGENCY_GROUPS,
  agencyCanonicalId,
  resolveAgencyIdentity,
} from "../site/agency_identity.mjs";
import {
  AGENCY_CONSTELLATION_ER_BASIS,
  AGENCY_CONSTELLATION_METHOD,
  AGENCY_CONSTELLATION_SCHEMA,
  buildAgencyConstellationView,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const LOOKUP = join(SITE, "data/agency_constellation_lookup.json");
const DEMO_IDS = Object.freeze(["parks-and-recreation", "housing-preservation-and-development"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadSources() {
  const intelligencePath = join(SITE, "data/entity_intelligence_lookup.json");
  const certificationPath = join(SITE, "data/exam_certification_constellation.json");
  const obligationsPath = join(SITE, "data/agency_obligations_lookup.json");
  const processConformancePath = join(SITE, "data/process_conformance_lookup.json");
  const rulesDomainPath = join(SITE, "data/rules_domain_observations.json");
  const meetingsDomainPath = join(SITE, "data/meetings_domain_observations.json");
  const landProjectsPath = join(SITE, "data/zap_projects_warehouse_lookup.json");
  if (!existsSync(intelligencePath)) {
    throw new Error("Missing site/data/entity_intelligence_lookup.json");
  }
  return {
    intelligence: readJson(intelligencePath),
    certification: existsSync(certificationPath) ? readJson(certificationPath) : null,
    obligations: existsSync(obligationsPath) ? readJson(obligationsPath) : null,
    process_conformance: existsSync(processConformancePath) ? readJson(processConformancePath) : null,
    rules_domain: existsSync(rulesDomainPath) ? readJson(rulesDomainPath) : null,
    meetings_domain: existsSync(meetingsDomainPath) ? readJson(meetingsDomainPath) : null,
    land_projects: existsSync(landProjectsPath) ? readJson(landProjectsPath) : null,
  };
}

function candidateAgencyIds(sources) {
  const ids = new Set(Object.keys(AGENCY_GROUPS).map(agencyCanonicalId));
  for (const ref of Object.keys(sources.intelligence?.by_ref || {})) {
    const match = String(ref).match(/^agency:id:(.+)$/);
    if (match) ids.add(resolveAgencyIdentity(match[1]).canonical_id);
  }
  for (const row of sources.certification?.by_agency || []) {
    if (row?.agency_id) ids.add(row.agency_id);
  }
  for (const demo of DEMO_IDS) ids.add(demo);
  return [...ids].sort();
}

export function buildAgencyConstellationMaterialization(sources = loadSources()) {
  // Stable across rebuilds when inputs are unchanged (deploy --check gate).
  const generatedAt = [
    sources.intelligence?.generated_at,
    sources.certification?.generated_at,
    sources.obligations?.generated_at,
    sources.process_conformance?.generated_at,
  ].filter(Boolean).sort().join("|") || "unknown";
  const byId = {};
  const documents = [];

  for (const id of candidateAgencyIds(sources)) {
    const view = buildAgencyConstellationView(id, {
      ...sources,
      generated_at: generatedAt,
    });
    if (!view) continue;
    // Keep pages for agencies with at least one matched category, plus demos.
    if (view.summary.matched_categories === 0 && !DEMO_IDS.includes(id)) continue;
    byId[id] = {
      subject_ref: view.subject_ref,
      display_name: view.display_name,
      path: view.path,
      matched_categories: view.summary.matched_categories,
      categories: Object.fromEntries(
        view.categories.map((category) => [category.id, {
          status: category.status,
          count: category.count,
          method: category.method,
        }]),
      ),
    };
    documents.push([
      join(SITE, "agencies", id, "index.html"),
      renderAgencyConstellationDocument(view),
    ]);
  }

  const lookup = {
    schema: AGENCY_CONSTELLATION_SCHEMA,
    method: AGENCY_CONSTELLATION_METHOD,
    er_match_basis: AGENCY_CONSTELLATION_ER_BASIS,
    generated_at: generatedAt,
    iteration: "v1",
    demo_ids: [...DEMO_IDS],
    agency_count: Object.keys(byId).length,
    multi_category_count: Object.values(byId).filter((row) => row.matched_categories >= 2).length,
    verified_demo: "agency:id:parks-and-recreation",
    by_id: byId,
    provenance: {
      intelligence_generated_at: sources.intelligence?.generated_at || null,
      certification_generated_at: sources.certification?.generated_at || null,
      obligations_generated_at: sources.obligations?.generated_at || null,
      process_conformance_generated_at: sources.process_conformance?.generated_at || null,
      note: "Precomputed last-known-good rollup over entity-intelligence, exam certification edges, mandates, and process-conformance expected-vs-observed.",
    },
  };

  return { lookup, documents };
}

export function writeAgencyConstellationArtifacts({ check = false } = {}) {
  const { lookup, documents } = buildAgencyConstellationMaterialization();
  const lookupJson = `${JSON.stringify(lookup, null, 2)}\n`;
  let stale = 0;

  if (!existsSync(LOOKUP) || readFileSync(LOOKUP, "utf8") !== lookupJson) {
    stale += 1;
    if (!check) {
      mkdirSync(dirname(LOOKUP), { recursive: true });
      writeFileSync(LOOKUP, lookupJson);
    }
  }

  for (const [path, content] of documents) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
      stale += 1;
      if (!check) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, content);
      }
    }
  }

  if (check && stale) {
    console.error(`${stale} agency constellation artifact(s) are stale; rebuild with node tools/build_agency_constellation_documents.mjs`);
    process.exit(1);
  }

  console.log(
    check
      ? `Agency constellation documents are current (${documents.length} pages, ${lookup.agency_count} agencies)`
      : `Agency constellation documents built (${documents.length} pages, ${lookup.agency_count} agencies)`,
  );
  return { lookup, documents, stale };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeAgencyConstellationArtifacts({ check: process.argv.includes("--check") });
}
