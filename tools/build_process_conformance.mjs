#!/usr/bin/env node
/**
 * Materialize agency mandate process-conformance (expected vs observed).
 *
 *   node tools/build_process_conformance.mjs
 *   node tools/build_process_conformance.mjs --check
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PROCESS_CONFORMANCE_SCHEMA,
  buildAgencyConformanceView,
  buildProcessConformanceLookup,
} from "../site/process_conformance.mjs";
import { buildMandateMeetingsView } from "../site/mandate_meetings_bridge.mjs";
import { buildMandateContractsBridgeView } from "../site/mandate_contracts_bridge.mjs";
import { buildMandateLandUseView } from "../site/mandate_land_use_bridge.mjs";
import {
  mandateBridgeConformanceGroups,
  mergeMandateCategoryConformance,
} from "../site/mandate_category_conformance.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const OUT = join(SITE, "data/process_conformance_lookup.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadSources() {
  const obligationsPath = join(SITE, "data/agency_obligations_lookup.json");
  if (!existsSync(obligationsPath)) {
    throw new Error("Missing site/data/agency_obligations_lookup.json; build obligations first");
  }
  const optional = (rel) => {
    const path = join(SITE, rel);
    return existsSync(path) ? readJson(path) : null;
  };
  return {
    obligationsLookup: readJson(obligationsPath),
    rulesDomain: optional("data/rules_domain_observations.json"),
    meetingsDomain: optional("data/meetings_domain_observations.json"),
    reportsDomain: optional("data/reports_domain_observations.json"),
    entityIntelligence: optional("data/entity_intelligence_lookup.json"),
    procurementAwards: optional("data/ocp_awards_warehouse_lookup.json"),
    landProjects: optional("data/zap_projects_warehouse_lookup.json"),
    crossSpineGate: optional("data/cross_spine_edge_gate.json"),
  };
}

export function writeProcessConformanceArtifacts({ check = false } = {}) {
  const sources = loadSources();
  // Stable across rebuilds when inputs are unchanged (deploy --check gate).
  const generatedAt = [
    sources.obligationsLookup?.generated_at,
    sources.rulesDomain?.generated_at,
    sources.meetingsDomain?.generated_at,
    sources.reportsDomain?.retrieved_at || sources.reportsDomain?.generated_at,
    sources.entityIntelligence?.generated_at,
    sources.procurementAwards?.generated_at || sources.procurementAwards?.materialized_at,
    sources.landProjects?.generated_at || sources.landProjects?.materialized_at,
    sources.crossSpineGate?.generated_at || sources.crossSpineGate?.observed_on,
  ].filter(Boolean).sort().join("|") || "unknown";
  const generatedDates = generatedAt.match(/\d{4}-\d{2}-\d{2}/g) || [];
  const asOf = generatedDates.sort().at(-1) || sources.obligationsLookup?.as_of || null;
  const agencyConformanceViews = Object.create(null);
  for (const agencyId of Object.keys(sources.obligationsLookup?.by_agency || {})) {
    const base = buildAgencyConformanceView(agencyId, {
      ...sources,
      asOf,
      limit: 500,
    });
    if (!base) continue;
    const dossier = sources.entityIntelligence?.by_ref?.[`agency:id:${agencyId}`]
      || sources.entityIntelligence?.by_subject_ref?.[`agency:id:${agencyId}`]
      || null;
    const meetingsView = buildMandateMeetingsView(agencyId, {
      obligationsLookup: sources.obligationsLookup,
      meetingsDomain: sources.meetingsDomain,
      crossSpineGate: sources.crossSpineGate,
      generatedAt,
    });
    const contractsView = buildMandateContractsBridgeView(agencyId, {
      obligationsLookup: sources.obligationsLookup,
      intelligenceDossier: dossier,
      procurementAwards: sources.procurementAwards,
      crossSpineGate: sources.crossSpineGate,
    });
    const landUseView = buildMandateLandUseView(agencyId, {
      obligationsLookup: sources.obligationsLookup,
      entityIntelligence: sources.entityIntelligence,
      landProjects: sources.landProjects,
      crossSpineGate: sources.crossSpineGate,
      generatedAt,
    });
    const groups = mandateBridgeConformanceGroups({
      obligationsLookup: sources.obligationsLookup,
      agencyId,
      meetingsView,
      contractsView,
      landUseView,
      meetingsSourceAvailable: sources.meetingsDomain != null,
      contractsSourceAvailable: dossier != null && sources.procurementAwards != null,
      zoningSourceAvailable: sources.entityIntelligence != null && sources.landProjects != null,
      asOf,
    });
    agencyConformanceViews[agencyId] = mergeMandateCategoryConformance(base, groups, { asOf });
  }
  const lookup = buildProcessConformanceLookup({
    ...sources,
    asOf,
    agencyConformanceViews,
    generatedAt,
  });
  if (lookup.schema !== PROCESS_CONFORMANCE_SCHEMA) {
    throw new Error(`unexpected schema ${lookup.schema}`);
  }
  const json = `${JSON.stringify(lookup, null, 2)}\n`;
  let stale = 0;
  if (!existsSync(OUT) || readFileSync(OUT, "utf8") !== json) {
    stale = 1;
    if (!check) {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, json);
    }
  }
  if (check && stale) {
    console.error("process_conformance_lookup.json is stale; rebuild with node tools/build_process_conformance.mjs");
    process.exit(1);
  }
  const parks = lookup.by_agency?.["parks-and-recreation"];
  console.log(
    check
      ? `ok process_conformance agencies=${lookup.summary.agency_count} mandates=${lookup.summary.mandate_count} observed=${lookup.summary.observed_count}`
      : `built process_conformance agencies=${lookup.summary.agency_count} mandates=${lookup.summary.mandate_count} observed=${lookup.summary.observed_count} parks=${parks?.counts?.total ?? 0}`,
  );
  return { lookup, stale };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeProcessConformanceArtifacts({ check: process.argv.includes("--check") });
}
