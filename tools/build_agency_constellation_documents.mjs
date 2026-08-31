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
  reconcileAgencyIdentity,
} from "../site/agency_identity.mjs";
import { AGENCY_ROUTE_CLASSIFICATIONS } from "./lib/agency_route_classifications.mjs";
import { agencyPublisherCollisions, publisherAgencyRows } from "./lib/agency_publisher_crosswalk.mjs";
import {
  AGENCY_CONSTELLATION_ER_BASIS,
  AGENCY_CONSTELLATION_METHOD,
  AGENCY_CONSTELLATION_SCHEMA,
  buildAgencyConstellationView,
  renderAgencyConstellationDeferredFragment,
  renderAgencyConstellationDocument,
} from "../site/agency_constellation.mjs";
import { buildAgencyVendorRollups } from "../site/agency_vendor_rollup.mjs";
import { ACCEPTED_IDENTITY_CLASSIFICATIONS } from "../site/agency_search_producer.mjs";
import { buildAgencyIdentityEvidence } from "./lib/agency_identity_evidence.mjs";
import { accountabilitySourcesFromLookup } from "../site/civic_institution_accountability.mjs";
import defaultProceedings from "../site/data/council_committee_proceedings.json" with { type: "json" };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const LOOKUP = join(SITE, "data/agency_constellation_lookup.json");
const IDENTITY_REPORT = join(SITE, "data/agency_route_identity_report.json");
const DEMO_IDS = Object.freeze(["parks-and-recreation", "housing-preservation-and-development"]);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadSources() {
  const intelligencePath = join(SITE, "data/entity_intelligence_lookup.json");
  const procurementAwardsPath = join(SITE, "data/ocp_awards_warehouse_lookup.json");
  const certificationPath = join(SITE, "data/exam_certification_constellation.json");
  const staffingExamsPath = join(SITE, "data/staffing_exams.json");
  const obligationsPath = join(SITE, "data/agency_obligations_lookup.json");
  const processConformancePath = join(SITE, "data/process_conformance_lookup.json");
  const agencyLifecycleConformancePath = join(SITE, "data/agency_lifecycle_conformance_lookup.json");
  const fiscalContextPath = join(SITE, "data/agency_fiscal_context.json");
  const rulesDomainPath = join(SITE, "data/rules_domain_observations.json");
  const regulatoryAgendaPath = join(SITE, "data/regulatory_agenda.json");
  const meetingsDomainPath = join(SITE, "data/meetings_domain_observations.json");
  const moneyOpenPath = join(SITE, "data/money_default_open.json");
  const procurementBrowsePath = join(SITE, "data/procurement_browse_rows.json");
  const landProjectsPath = join(SITE, "data/zap_projects_warehouse_lookup.json");
  const crossSpineGatePath = join(SITE, "data/cross_spine_edge_gate.json");
  const ocpAwardsPath = join(SITE, "data/ocp_awards_warehouse_lookup.json");
  const publisherCrosswalkPath = join(ROOT, "worker/src/data/agency_crosswalk.json");
  const passportGraphPath = join(SITE, "data/entity_intelligence_shards/passport_graph.json");
  if (!existsSync(intelligencePath)) {
    throw new Error("Missing site/data/entity_intelligence_lookup.json");
  }
  const procurementBrowse = existsSync(procurementBrowsePath) ? readJson(procurementBrowsePath) : null;
  const authorityRows = (procurementBrowse?.rows || []).filter((row) =>
    (row?.source_systems || []).some((system) => (
      /^mta_/.test(String(system || "")) || system === "nys_contract_reporter"
    )));
  return {
    intelligence: readJson(intelligencePath),
    passport_graph: existsSync(passportGraphPath) ? readJson(passportGraphPath) : null,
    procurement_awards: existsSync(procurementAwardsPath) ? readJson(procurementAwardsPath) : null,
    certification: existsSync(certificationPath) ? readJson(certificationPath) : null,
    // Staffing-guide corpus gates which certification exams become public links.
    // Without it, historical civil-service list rows would link to missing /exams/:id/ pages.
    staffing_exams: existsSync(staffingExamsPath) ? readJson(staffingExamsPath) : null,
    obligations: existsSync(obligationsPath) ? readJson(obligationsPath) : null,
    process_conformance: existsSync(processConformancePath) ? readJson(processConformancePath) : null,
    agency_lifecycle_conformance: existsSync(agencyLifecycleConformancePath) ? readJson(agencyLifecycleConformancePath) : null,
    fiscal_context: existsSync(fiscalContextPath) ? readJson(fiscalContextPath) : null,
    rules_domain: existsSync(rulesDomainPath) ? readJson(rulesDomainPath) : null,
    regulatory_agenda: existsSync(regulatoryAgendaPath) ? readJson(regulatoryAgendaPath) : null,
    meetings_domain: existsSync(meetingsDomainPath) ? readJson(meetingsDomainPath) : null,
    money_open: existsSync(moneyOpenPath) ? readJson(moneyOpenPath) : null,
    procurement_browse: existsSync(procurementBrowsePath) ? readJson(procurementBrowsePath) : null,
    cross_spine_gate: existsSync(crossSpineGatePath) ? readJson(crossSpineGatePath) : null,
    authority_procurement: authorityRows.length
      ? { ...procurementBrowse, open_as_of: procurementBrowse.generated_at || null, notices: authorityRows }
      : null,
    land_projects: existsSync(landProjectsPath) ? readJson(landProjectsPath) : null,
    land_default: existsSync(join(SITE, "data/land_default_ulurp.json"))
      ? readJson(join(SITE, "data/land_default_ulurp.json"))
      : null,
    zap_bbl: existsSync(join(SITE, "data/zap_bbl_warehouse_lookup.json"))
      ? readJson(join(SITE, "data/zap_bbl_warehouse_lookup.json"))
      : null,
    ocp_awards: existsSync(ocpAwardsPath) ? readJson(ocpAwardsPath) : null,
    publisher_crosswalk: readJson(publisherCrosswalkPath),
    committee_graph: existsSync(join(SITE, "data/committee_graph_lookup.json"))
      ? readJson(join(SITE, "data/committee_graph_lookup.json"))
      : (existsSync(join(ROOT, "worker/src/data/committee_graph_lookup.json"))
        ? readJson(join(ROOT, "worker/src/data/committee_graph_lookup.json"))
        : null),
    council_committee_proceedings: existsSync(join(SITE, "data/council_committee_proceedings.json"))
      ? readJson(join(SITE, "data/council_committee_proceedings.json"))
      : defaultProceedings,
    meeting_outcomes: existsSync(join(SITE, "data/meeting_outcomes_snapshot.json"))
      ? readJson(join(SITE, "data/meeting_outcomes_snapshot.json"))
      : null,
  };
}

function committeeRoleSourcesFor(id, sources) {
  if (id !== "city-council") return null;
  return {
    committeeGraph: sources.committee_graph || null,
    proceedings: sources.council_committee_proceedings || defaultProceedings,
    meetingOutcomes: sources.meeting_outcomes || null,
    generatedAt: sources.committee_graph?.generated_at,
  };
}

function developmentRoleSourcesFor(id, sources) {
  if (id !== "economic-development-corporation" && id !== "small-business-services") return null;
  const projects = sources.land_default?.projects || sources.land_default?.rows || sources.land_projects?.rows || [];
  const project = projects.find((row) => String(row?.project_id || "").trim() === "2024Q0135") || null;
  const procurementRows = sources.procurement_browse?.rows || [];
  const procurement = procurementRows.find((row) => String(row?.pin || "").trim() === "80125S0021001") || null;
  const meetings = sources.meetings_domain?.meetings || sources.meetings_domain?.rows || sources.meetings_domain || [];
  const meetingList = Array.isArray(meetings) ? meetings : [];
  const boroughBoardMeeting = meetingList.find((row) => String(row?.request_id || "").trim() === "20260518003") || null;
  const bblRows = sources.zap_bbl?.rows || sources.zap_bbl?.projects || (Array.isArray(sources.zap_bbl) ? sources.zap_bbl : []);
  const bblHit = bblRows.find((row) => String(row?.project_id || "").trim() === "2024Q0135");
  return {
    project,
    procurement,
    procurementObservations: procurement ? [{
      source_observation_ref: "passport_public_contracts:contract:80125S0021001:5503551",
      source_system: "passport_public_contracts",
      snapshot: {
        epin: procurement.pin,
        agency: procurement.agency_name,
        vendor: procurement.vendor_name,
        title: procurement.short_title,
      },
      ingested_at: procurement.start_date,
    }] : [],
    boroughBoardMeeting,
    projectBbls: Array.isArray(bblHit?.bbls) ? bblHit.bbls : [],
  };
}

function agencySourceIdentity(id, name, publisherRows) {
  const routed = reconcileAgencyIdentity(id, publisherRows);
  if (routed.route_classification) return routed;
  const named = reconcileAgencyIdentity(name || id, publisherRows);
  return named.matched ? named : routed;
}

function mergeDomainBlocks(blocks) {
  const present = blocks.filter(Boolean);
  if (!present.length) return null;
  const objects = [];
  const seen = new Set();
  for (const block of present) {
    for (const object of Array.isArray(block?.objects) ? block.objects : []) {
      const key = [object?.subject_ref, object?.link_type, object?.request_id, object?.contract_id].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      objects.push(object);
    }
  }
  const matched = present.some((block) => block?.status === "matched");
  const pending = present.some((block) => block?.status === "not_yet_ingested");
  return {
    ...present[0],
    status: matched ? "matched" : (pending ? "not_yet_ingested" : "empty"),
    gap_class: matched ? null : (present.find((block) => block?.gap_class)?.gap_class || "empty_in_corpus"),
    note: matched ? null : (present.find((block) => block?.note)?.note || null),
    objects,
    count: objects.length || Math.max(0, ...present.map((block) => Number(block?.count) || 0)),
  };
}

function mergeIntelligenceDossiers(dossiers, identity) {
  const ref = `agency:id:${identity.canonical_id}`;
  const domains = {};
  const domainIds = new Set(dossiers.flatMap((dossier) => Object.keys(dossier?.domains || {})));
  for (const domain of domainIds) {
    domains[domain] = mergeDomainBlocks(dossiers.map((dossier) => dossier?.domains?.[domain]));
  }
  const links = [];
  const seenLinks = new Set();
  for (const dossier of dossiers) {
    const oldRef = dossier?.root?.ref;
    for (const link of Array.isArray(dossier?.links) ? dossier.links : []) {
      const normalized = {
        ...link,
        from: link?.from === oldRef ? ref : link?.from,
        to: link?.to === oldRef ? ref : link?.to,
      };
      const key = [normalized.type, normalized.from, normalized.to, normalized.method].join("|");
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);
      links.push(normalized);
    }
  }
  return {
    ...dossiers[0],
    root: {
      ...(dossiers[0]?.root || {}),
      ref,
      id: `id:${identity.canonical_id}`,
      canonical_id: identity.canonical_id,
      canonical_name: identity.canonical_name,
      display_name: identity.canonical_name,
    },
    domains,
    links,
  };
}

function reconcileIntelligence(intelligence, publisherRows) {
  if (!intelligence?.by_ref) return intelligence;
  const grouped = new Map();
  const byRef = {};
  for (const [ref, dossier] of Object.entries(intelligence.by_ref)) {
    const match = ref.match(/^agency:id:(.+)$/);
    if (!match) {
      byRef[ref] = dossier;
      continue;
    }
    const identity = agencySourceIdentity(
      match[1],
      dossier?.root?.canonical_name || dossier?.root?.display_name,
      publisherRows,
    );
    const canonicalRef = `agency:id:${identity.canonical_id}`;
    if (!grouped.has(canonicalRef)) grouped.set(canonicalRef, { identity, dossiers: [] });
    grouped.get(canonicalRef).dossiers.push(dossier);
  }
  for (const [ref, group] of grouped) {
    byRef[ref] = mergeIntelligenceDossiers(group.dossiers, group.identity);
  }
  return {
    ...intelligence,
    by_ref: byRef,
    by_subject_ref: { ...(intelligence.by_subject_ref || {}), ...byRef },
  };
}

function reconcileCertification(certification, publisherRows) {
  if (!certification) return certification;
  const identityBySourceId = new Map();
  for (const row of Array.isArray(certification.by_agency) ? certification.by_agency : []) {
    identityBySourceId.set(
      String(row?.agency_id || ""),
      agencySourceIdentity(row?.agency_id, row?.agency_name, publisherRows),
    );
  }
  const edges = [];
  const seenEdges = new Set();
  for (const edge of Array.isArray(certification.edges) ? certification.edges : []) {
    const match = String(edge?.to || "").match(/^agency:id:(.+)$/);
    if (!match) {
      edges.push(edge);
      continue;
    }
    const identity = identityBySourceId.get(match[1]) || agencySourceIdentity(match[1], null, publisherRows);
    const to = `agency:id:${identity.canonical_id}`;
    const normalized = {
      ...edge,
      to,
      id: `${edge.from}|${to}`,
    };
    const key = [normalized.type, normalized.from, normalized.to].join("|");
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push(normalized);
  }
  const rowsById = new Map();
  for (const row of Array.isArray(certification.by_agency) ? certification.by_agency : []) {
    const identity = identityBySourceId.get(String(row?.agency_id || ""));
    const id = identity.canonical_id;
    if (!rowsById.has(id)) {
      rowsById.set(id, {
        ...row,
        ref: `agency:id:${id}`,
        agency_id: id,
        agency_name: identity.canonical_name,
        edge_refs: [],
      });
    }
  }
  for (const [id, row] of rowsById) {
    const ref = `agency:id:${id}`;
    const agencyEdges = edges.filter((edge) => edge?.to === ref && edge?.type === "certified_to_agency");
    row.edge_count = agencyEdges.length;
    row.edge_refs = agencyEdges.map((edge) => edge.id);
  }
  return { ...certification, edges, by_agency: [...rowsById.values()] };
}

export function reconcileAgencyConstellationSources(sources, publisherRows = publisherAgencyRows(sources?.publisher_crosswalk)) {
  return {
    ...sources,
    publisher_agency_rows: publisherRows,
    intelligence: reconcileIntelligence(sources?.intelligence, publisherRows),
    certification: reconcileCertification(sources?.certification, publisherRows),
  };
}

function candidateAgencyIds(sources) {
  const ids = new Set(Object.keys(AGENCY_GROUPS).map((name) =>
    reconcileAgencyIdentity(name, sources.publisher_agency_rows).canonical_id));
  for (const ref of Object.keys(sources.intelligence?.by_ref || {})) {
    const match = String(ref).match(/^agency:id:(.+)$/);
    if (match) ids.add(reconcileAgencyIdentity(match[1], sources.publisher_agency_rows).canonical_id);
  }
  for (const row of sources.certification?.by_agency || []) {
    if (row?.agency_id) ids.add(reconcileAgencyIdentity(row.agency_id, sources.publisher_agency_rows).canonical_id);
  }
  for (const agencyId of Object.keys(sources.fiscal_context?.by_agency || {})) {
    ids.add(reconcileAgencyIdentity(agencyId, sources.publisher_agency_rows).canonical_id);
  }
  for (const row of sources.authority_procurement?.notices || []) {
    for (const ref of Array.isArray(row?.entity_refs_all) ? row.entity_refs_all : []) {
      const match = String(ref).match(/^agency:id:(.+)$/);
      if (match) ids.add(reconcileAgencyIdentity(match[1], sources.publisher_agency_rows).canonical_id);
    }
    if (row?.agency_name) ids.add(reconcileAgencyIdentity(row.agency_name, sources.publisher_agency_rows).canonical_id);
  }
  for (const demo of DEMO_IDS) ids.add(reconcileAgencyIdentity(demo, sources.publisher_agency_rows).canonical_id);
  return [...ids].sort();
}

function activeAgencySources(sources) {
  const rows = new Map();
  for (const [ref, dossier] of Object.entries(sources.intelligence?.by_ref || {})) {
    const match = String(ref).match(/^agency:id:(.+)$/);
    if (!match) continue;
    const active = Object.values(dossier?.domains || {}).some((domain) =>
      domain?.status === "matched" && (Number(domain?.count) > 0 || domain?.objects?.length));
    if (!active) continue;
    rows.set(match[1], {
      source_id: match[1],
      names: [dossier?.root?.canonical_name || dossier?.root?.display_name].filter(Boolean),
      sources: ["entity_intelligence"],
    });
  }
  for (const row of sources.certification?.by_agency || []) {
    if (!row?.agency_id || !(Number(row.edge_count) > 0)) continue;
    const current = rows.get(row.agency_id) || { source_id: row.agency_id, names: [], sources: [] };
    current.names = [...new Set([...current.names, row.agency_name].filter(Boolean))];
    current.sources = [...new Set([...current.sources, "exam_certification"])];
    rows.set(row.agency_id, current);
  }
  return [...rows.values()].sort((left, right) => left.source_id.localeCompare(right.source_id));
}

export function buildAgencyRouteIdentityReport(rawSources, publisherRows, generatedAt = "unknown") {
  const publisherIds = new Set(publisherRows.map((row) => row.canonical_id));
  const decisions = new Map(AGENCY_ROUTE_CLASSIFICATIONS.map((row) => [row.source_id, row]));
  // Route identity is the residual over the durable intelligence/certification
  // census. Browse snapshots drive category membership, but must not make a
  // previously reviewed route disappear merely because its current open
  // snapshot is empty.
  const identitySources = { ...rawSources, money_open: null };
  const cases = activeAgencySources(rawSources)
    .filter((row) => !publisherIds.has(row.source_id))
    // The residual is defined over public constellation candidates, not every
    // tentative agency root in the wider intelligence artifact. Explicitly
    // reviewed cases stay in the census even after their resolver collapses.
    .filter((row) => decisions.has(row.source_id)
      || (buildAgencyConstellationView(row.source_id, identitySources)?.summary?.matched_categories || 0) > 0)
    .map((row) => {
      const decision = decisions.get(row.source_id);
      const identity = agencySourceIdentity(row.source_id, row.names[0], publisherRows);
      const classification = decision?.classification
        || (publisherIds.has(identity.canonical_id) ? "alias_to_canonical" : "unresolved");
      return {
        ...row,
        classification,
        canonical_id: identity.canonical_id,
        canonical_name: identity.canonical_name,
        canonical_path: `/agencies/${identity.canonical_id}/`,
        redirect_from: classification === "alias_to_canonical" ? `/agencies/${row.source_id}/` : null,
        basis: decision?.basis || "no exact publisher-crosswalk identity",
      };
    });
  const counts = Object.fromEntries(
    ["alias_to_canonical", "legitimate_non_crosswalk_entity", "unresolved"]
      .map((classification) => [classification, cases.filter((row) => row.classification === classification).length]),
  );
  const collapsed = new Map();
  for (const row of cases.filter((entry) => entry.classification === "alias_to_canonical")) {
    if (!collapsed.has(row.canonical_id)) collapsed.set(row.canonical_id, []);
    collapsed.get(row.canonical_id).push(row.source_id);
  }
  const aliases = cases
    .filter((row) => row.classification === "alias_to_canonical")
    .map((row) => ({ from: row.redirect_from, to: row.canonical_path, source_id: row.source_id, canonical_id: row.canonical_id }));
  const publisherCollisions = agencyPublisherCollisions(publisherRows);
  return {
    schema: "cityscroll.agency_route_identity_report.v1",
    generated_at: generatedAt,
    method: "exact_publisher_crosswalk_with_reviewed_route_dispositions_v1",
    publisher_canonical_count: publisherIds.size,
    constellation_only_source_count: cases.length,
    classification_counts: counts,
    cases,
    aliases,
    collisions: {
      ambiguous_publisher_keys: publisherCollisions,
      collapsed_route_groups: [...collapsed.entries()]
        .filter(([, sourceIds]) => sourceIds.length > 1)
        .map(([canonical_id, source_ids]) => ({ canonical_id, source_ids: source_ids.sort() })),
    },
    policy: "Only exact publisher variants and reviewed aliases collapse. Ambiguous and external bodies remain separate.",
  };
}

export function buildAgencyConstellationMaterialization(sources = loadSources()) {
  // Stable across rebuilds when inputs are unchanged (deploy --check gate).
  const generatedAt = [
    sources.intelligence?.generated_at,
    sources.certification?.generated_at,
    sources.obligations?.generated_at,
    sources.process_conformance?.generated_at,
    sources.money_open?.generated_at,
    sources.money_open?.open_as_of,
    sources.procurement_browse?.generated_at,
    sources.meetings_domain?.retrieved_at,
    sources.ocp_awards?.materialized_at,
    sources.passport_graph?.observed_on,
    sources.passport_graph?.published_graph?.selected_rows,
    sources.fiscal_context?.generated_at,
    sources.authority_procurement?.generated_at,
  ].filter(Boolean).sort().join("|") || "unknown";
  const publisherRows = publisherAgencyRows(sources.publisher_crosswalk);
  const vendorRollups = buildAgencyVendorRollups(sources.ocp_awards?.rows || [], {
    asOf: sources.ocp_awards?.materialized_at,
    publisherRows,
    limit: 8,
  });
  const identityReport = buildAgencyRouteIdentityReport(sources, publisherRows, generatedAt);
  const reconciledSources = reconcileAgencyConstellationSources(sources, publisherRows);
  const byId = {};
  const documents = [];

  for (const id of candidateAgencyIds(reconciledSources)) {
    const view = buildAgencyConstellationView(id, {
      ...reconciledSources,
      vendor_rollups: vendorRollups,
      fiscal_context: sources.fiscal_context,
      procurement_browse: sources.procurement_browse,
      native_procurements: sources.procurement_browse,
      authority_procurement: sources.authority_procurement,
      generated_at: generatedAt,
    });
    if (!view) continue;
    const identity = reconcileAgencyIdentity(id, publisherRows);
    view.identity_evidence = buildAgencyIdentityEvidence({
      identity,
      publisherRow: sources.publisher_crosswalk?.entries?.[id] || null,
      view,
      generatedAt,
      developmentRoleSources: developmentRoleSourcesFor(id, sources),
      accountabilitySources: accountabilitySourcesFromLookup(sources.obligations),
      committeeRoleSources: committeeRoleSourcesFor(id, sources),
    });
    // Keep pages for agencies with at least one matched category, plus demos.
    if (view.summary.matched_categories === 0 && !DEMO_IDS.includes(id)) continue;
    // A denser PASSPort graph can light up unmatched route spellings. Public
    // pages stay on identities the SearchDocument producer can admit.
    const matched = (view.categories || []).filter((category) => category.status === "matched");
    const onlyGraphContracts = matched.length > 0
      && matched.every((category) => category.id === "contracts" && category.method === "passport_ei_graph_v1");
    if (
      !DEMO_IDS.includes(id)
      && !ACCEPTED_IDENTITY_CLASSIFICATIONS.has(identity.route_classification)
      && onlyGraphContracts
    ) {
      continue;
    }
    byId[id] = {
      subject_ref: view.subject_ref,
      display_name: view.display_name,
      path: view.path,
      identity_evidence: {
        schema: view.identity_evidence?.schema || null,
        institution_ref: view.identity_evidence?.institution?.id || null,
        status: view.identity_evidence?.status || "unknown",
        source_observation_count: view.identity_evidence?.coverage?.source_observation_count || 0,
      },
      matched_categories: view.summary.matched_categories,
      categories: Object.fromEntries(
        view.categories.map((category) => [category.id, {
          status: category.status,
          count: category.count,
          method: category.method,
        }]),
      ),
      fiscal_context_status: view.fiscal_context?.status || "unknown",
      fiscal_context_method: view.fiscal_context?.provenance?.join_method || null,
      edge_summary: view.edge_summary,
      top_vendors: view.categories.find((category) => category.id === "vendors")?.items || [],
    };
    const deferredDataHref = `/agencies/${id}/relationships.json`;
    const deferredViewHref = `/agencies/${id}/relationships-data.json`;
    documents.push([
      join(SITE, "agencies", id, "index.html"),
      renderAgencyConstellationDocument(view, { deferredDataHref, deferredViewHref }),
    ]);
    documents.push([
      join(SITE, "agencies", id, "relationships.json"),
      `${JSON.stringify({
        schema: "cityscroll.agency_relationships.v1",
        subject_ref: view.subject_ref,
        generated_at: generatedAt,
        html: renderAgencyConstellationDeferredFragment(view),
        view_href: deferredViewHref,
      })}\n`,
    ]);
    documents.push([
      join(SITE, "agencies", id, "relationships-data.json"),
      `${JSON.stringify({
        schema: "cityscroll.agency_relationships_data.v1",
        subject_ref: view.subject_ref,
        generated_at: generatedAt,
        view,
      })}\n`,
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
    aliases: Object.fromEntries(identityReport.aliases.map((row) => [row.source_id, row.canonical_id])),
    by_id: byId,
    provenance: {
      intelligence_generated_at: sources.intelligence?.generated_at || null,
      certification_generated_at: sources.certification?.generated_at || null,
      obligations_generated_at: sources.obligations?.generated_at || null,
      process_conformance_generated_at: sources.process_conformance?.generated_at || null,
      vendor_rollup_as_of: vendorRollups.as_of,
      vendor_rollup_window_start: vendorRollups.window_start,
      passport_graph_observed_on: sources.passport_graph?.observed_on || null,
      passport_graph_selected_rows: sources.passport_graph?.published_graph?.selected_rows || 0,
      fiscal_context_generated_at: sources.fiscal_context?.generated_at || null,
      note: "Precomputed last-known-good rollup over entity-intelligence, exam certification edges, 12-month vendor awards, mandates, process-conformance expected-vs-observed, and the sharded PASSPort EI graph.",
    },
  };

  return { lookup, documents, identityReport };
}

export function writeAgencyConstellationArtifacts({ check = false } = {}) {
  const { lookup, documents, identityReport } = buildAgencyConstellationMaterialization();
  const lookupJson = `${JSON.stringify(lookup, null, 2)}\n`;
  const identityReportJson = `${JSON.stringify(identityReport, null, 2)}\n`;
  let stale = 0;

  if (!existsSync(LOOKUP) || readFileSync(LOOKUP, "utf8") !== lookupJson) {
    stale += 1;
    if (!check) {
      mkdirSync(dirname(LOOKUP), { recursive: true });
      writeFileSync(LOOKUP, lookupJson);
    }
  }

  if (!existsSync(IDENTITY_REPORT) || readFileSync(IDENTITY_REPORT, "utf8") !== identityReportJson) {
    stale += 1;
    if (!check) {
      mkdirSync(dirname(IDENTITY_REPORT), { recursive: true });
      writeFileSync(IDENTITY_REPORT, identityReportJson);
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
