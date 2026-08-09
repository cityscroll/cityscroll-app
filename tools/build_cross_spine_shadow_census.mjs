#!/usr/bin/env node
/** Build a redacted, read-only census of the four mandate cross-spine bridges. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildMandateContractsBridgeView, isProcurementMandate } from "../site/mandate_contracts_bridge.mjs";
import { buildMandateLandUseView, mandateLandUseKinds } from "../site/mandate_land_use_bridge.mjs";
import { buildMandateMeetingsView, mandateRequiresMeeting } from "../site/mandate_meetings_bridge.mjs";
import { buildMandateRulesBridgeView } from "../site/mandate_rules_bridge.mjs";

const ROOT = resolve(join(fileURLToPath(new URL(".", import.meta.url)), ".."));
export const OUTPUT = join(ROOT, "site/data/cross_spine_shadow_census.json");
export const CENSUS_SCHEMA = "cityscroll.cross_spine_shadow_census.v1";

const INPUTS = Object.freeze({
  obligations: "site/data/agency_obligations_lookup.json",
  intelligence: "site/data/entity_intelligence_lookup.json",
  meetings: "site/data/meetings_domain_observations.json",
  rules: "site/data/rules_domain_observations.json",
  processConformance: "site/data/process_conformance_lookup.json",
  land: "site/data/zap_projects_warehouse_lookup.json",
  gate: "site/data/cross_spine_edge_gate.json",
});

const RELATIONS = Object.freeze({
  mandate_meeting: { source: "meetings", sourceSystem: "city_record", left: mandateRequiresMeeting },
  mandate_land_use: { source: "land", sourceSystem: "Zoning Application Portal projects (Open Data)", left: (row) => mandateLandUseKinds(row).length > 0 },
  mandate_contract: { source: "contracts", sourceSystem: "city_record", left: isProcurementMandate },
  mandate_rule: { source: "rules", sourceSystem: "city_record", left: (row) => String(row?.deliverable_type || "").toLowerCase() === "rulemaking" },
});

const readJson = (relative) => JSON.parse(readFileSync(join(ROOT, relative), "utf8"));
const sortedObject = (value) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));

function sourceRowsFor(relation, sources, dossier) {
  if (relation === "mandate_contract") return dossier?.domains?.money?.objects || [];
  return sources[RELATIONS[relation].source]?.rows || [];
}

function rulesConformanceItems(id, sources) {
  const observations = sources.processConformance?.by_agency?.[id]?.observations || {};
  return Object.entries(observations).map(([mandate_id, observation]) => ({ mandate_id, observation }));
}

function buildView(relation, id, sources, dossier) {
  const common = { obligationsLookup: sources.obligations, crossSpineGate: sources.gate };
  if (relation === "mandate_meeting") return buildMandateMeetingsView(id, { ...common, meetingsDomain: sources.meetings });
  if (relation === "mandate_land_use") return buildMandateLandUseView(id, { ...common, entityIntelligence: sources.intelligence, landProjects: sources.land });
  if (relation === "mandate_contract") return buildMandateContractsBridgeView(id, { ...common, intelligenceDossier: dossier });
  return buildMandateRulesBridgeView(id, {
    obligationsLookup: sources.obligations,
    rulesItems: sources.rules.rows,
    rulesCount: sources.rules.row_count,
    conformanceItems: rulesConformanceItems(id, sources),
  });
}

function addRoute(aggregate, tier, reason, agencyId, sourceSystem) {
  aggregate.by_tier[tier] = (aggregate.by_tier[tier] || 0) + 1;
  if (reason) aggregate.by_reason[reason] = (aggregate.by_reason[reason] || 0) + 1;
  if (agencyId) {
    const agency = aggregate.by_agency[agencyId] ||= { public_inferred: 0, evidence_only: 0, reason_counts: {} };
    agency[tier] = (agency[tier] || 0) + 1;
    if (reason) agency.reason_counts[reason] = (agency.reason_counts[reason] || 0) + 1;
  }
  if (sourceSystem) aggregate.by_source_system[sourceSystem] = (aggregate.by_source_system[sourceSystem] || 0) + 1;
}

function addReason(aggregate, reason, agencyId) {
  if (!reason) return;
  aggregate.by_reason[reason] = (aggregate.by_reason[reason] || 0) + 1;
  if (agencyId) {
    const agency = aggregate.by_agency[agencyId] ||= { public_inferred: 0, evidence_only: 0, reason_counts: {} };
    agency.reason_counts[reason] = (agency.reason_counts[reason] || 0) + 1;
  }
}

export function buildCrossSpineShadowCensus(sources = Object.fromEntries(Object.entries(INPUTS).map(([key, path]) => [key, readJson(path)]))) {
  const obligations = sources.obligations || { by_agency: {} };
  const agencyIds = Object.keys(obligations.by_agency || {}).sort();
  const relations = {};
  for (const [relation, spec] of Object.entries(RELATIONS)) {
    const aggregate = {
      totals: { public_inferred: 0, evidence_only: 0 },
      by_tier: {},
      by_reason: {},
      by_agency: {},
      by_source_system: {},
      denominators: { eligible_left_rows: 0, source_rows: 0, pre_route_pairs: 0 },
    };
    const agencyDenominators = {};
    for (const id of agencyIds) {
      const bucket = obligations.by_agency[id] || {};
      const leftRows = (bucket.obligations || []).filter(spec.left);
      const dossier = sources.intelligence?.by_ref?.[`agency:id:${id}`] || null;
      const sourceRows = sourceRowsFor(relation, sources, dossier);
      const denominator = {
        eligible_left_rows: leftRows.length,
        source_rows: sourceRows.length,
        pre_route_pairs: leftRows.length * sourceRows.length,
      };
      aggregate.denominators.eligible_left_rows += denominator.eligible_left_rows;
      aggregate.denominators.source_rows += denominator.source_rows;
      aggregate.denominators.pre_route_pairs += denominator.pre_route_pairs;
      agencyDenominators[id] = denominator;
      const view = buildView(relation, id, sources, dossier);
      for (const edge of view?.edges || []) {
        const policy = edge.edge_policy || {};
        const sourceSystem = edge.provenance?.source_system || edge.meeting?.source_system || edge.land_action?.source_system || edge.procurement_record?.source_system || spec.sourceSystem;
        addRoute(aggregate, policy.tier || "public_inferred", policy.reason, id, sourceSystem);
        aggregate.totals.public_inferred += 1;
      }
      for (const shadow of view?.shadow_edges || []) {
        const policy = shadow.edge_policy || shadow.entity_link || {};
        const reasons = Array.isArray(shadow.reason) ? shadow.reason : [shadow.reason || policy.reason];
        const sourceSystem = shadow.meeting?.source_system || shadow.land_action?.source_system || shadow.procurement_record?.source_system || spec.sourceSystem;
        addRoute(aggregate, "evidence_only", null, id, sourceSystem);
        for (const reason of reasons) addReason(aggregate, reason, id);
        aggregate.totals.evidence_only += 1;
      }
      if (relation === "mandate_rule") {
        for (const item of view?.mandates || []) {
          if (item.observed_record) {
            addRoute(aggregate, "public_inferred", item.observed_record.publication, id, item.observed_record.source || spec.sourceSystem);
            aggregate.totals.public_inferred += 1;
          }
        }
      }
    }
    aggregate.by_agency = Object.fromEntries(Object.keys(agencyDenominators).sort().map((id) => [id, {
      denominators: agencyDenominators[id],
      ...(aggregate.by_agency[id] || { public_inferred: 0, evidence_only: 0, reason_counts: {} }),
    }]));
    relations[relation] = {
      totals: aggregate.totals,
      denominators: aggregate.denominators,
      by_tier: sortedObject(aggregate.by_tier),
      by_reason: sortedObject(aggregate.by_reason),
      by_agency: aggregate.by_agency,
      by_source_system: sortedObject(aggregate.by_source_system),
    };
  }
  return {
    schema: CENSUS_SCHEMA,
    census_version: "cross_spine_shadow_census_v1",
    input_ids: Object.fromEntries(Object.entries(sources).filter(([key]) => INPUTS[key]).map(([key, value]) => [key, value?.schema || value?.schema_version || "unknown"])),
    agencies: agencyIds.length,
    relations,
  };
}

function main(argv = process.argv) {
  const check = argv.includes("--check");
  const output = argv.includes("--out") ? resolve(argv[argv.indexOf("--out") + 1]) : OUTPUT;
  const rendered = `${JSON.stringify(buildCrossSpineShadowCensus(), null, 2)}\n`;
  if (check) {
    if (!existsSync(output) || readFileSync(output, "utf8") !== rendered) throw new Error(`census receipt drift vs ${output}`);
    return;
  }
  writeFileSync(output, rendered);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
