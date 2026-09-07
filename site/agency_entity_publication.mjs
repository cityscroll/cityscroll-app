/** Retained materialization of published city-agency entity records.
 *
 * Four public read surfaces answer questions about an organization: the entity
 * dossier, the relationship graph, the organizations browse and the exact
 * person-or-organization get. The browse and the get already read a committed
 * read model. The dossier and the graph read the entity-resolution store, which
 * holds procurement-shaped entities and no agency of its own, so a reader
 * asking what the public record holds about a city agency got a not-yet-public
 * answer for an organization the corpus does describe.
 *
 * This module materializes that missing half: for each agency the identity
 * crosswalk covers, the source observations a dossier is built from and the
 * typed relationships a graph is built from, in exactly the row and graph
 * shapes the existing publication serializers already consume. Nothing here
 * invents a field. Every value carries the dataset it came from and the date
 * that dataset was observed, and a column a source does not publish is left
 * out rather than filled in from a neighbouring source.
 */

import {
  buildPersonLeaderEntity,
  PERSON_LEADER_ENTITY_TYPE,
} from "../entity_resolution/leaders/index.mjs";

export const AGENCY_ENTITY_PUBLICATION_SCHEMA = "cityscroll.agency_entity_publication.v1";
export const AGENCY_ENTITY_PUBLICATION_METHOD = "agency_entity_publication_v1";
export const AGENCY_ENTITY_TYPE = "agency";

/** Datasets whose columns this publication is allowed to carry. */
export const AGENCY_IDENTITY_SOURCE_SYSTEM = "nyc_open_data";
export const AGENCY_ROSTER_DATASET = "t3jq-9nkf";
export const AGENCY_BUDGET_DATASET = "mwzb-yiwb";
export const AGENCY_CONTRACT_SOURCE_SYSTEM = "passport-public-contracts";

/** Cap on the contract observations published per agency in the graph. */
export const AGENCY_GRAPH_CONTRACT_LIMIT = 12;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function entityIdFor(agencyId) {
  const id = clean(agencyId).replace(/^agency:id:/, "");
  return id ? `agency:id:${id}` : null;
}

function isoDay(value) {
  const text = clean(value);
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function isoInstant(value) {
  const day = isoDay(value);
  return day ? `${day}T00:00:00.000Z` : null;
}

function datasetSource(provenance, datasetId) {
  const list = Array.isArray(provenance?.sources) ? provenance.sources : [];
  return list.find((source) => clean(source?.id) === datasetId) || null;
}

/** The date a dataset itself reports its rows were last updated. */
function datasetObservedOn(provenance, datasetId) {
  const source = datasetSource(provenance, datasetId);
  return isoDay(source?.updated) || isoDay(provenance?.downloaded) || null;
}

function datasetUrl(provenance, datasetId) {
  const url = clean(datasetSource(provenance, datasetId)?.url);
  return url.startsWith("https://") ? url : null;
}

function snapshotWithValues(fields) {
  const snapshot = {};
  for (const [field, value] of Object.entries(fields)) {
    if (value == null) continue;
    const text = typeof value === "number" ? value : clean(value);
    if (text === "" || text == null) continue;
    snapshot[field] = text;
  }
  return snapshot;
}

function dossierRow({ entityId, displayName, datasetId, sourceUrl, observedOn, fields }) {
  const snapshot = snapshotWithValues(fields);
  if (!Object.keys(snapshot).length) return null;
  const ingestedAt = isoInstant(observedOn);
  if (!ingestedAt) return null;
  return {
    entity_id: entityId,
    entity_type: AGENCY_ENTITY_TYPE,
    display_name: displayName,
    source_system: AGENCY_IDENTITY_SOURCE_SYSTEM,
    source_system_id: datasetId,
    // The serializer reads source_url out of the snapshot, so the dataset page
    // travels with the observation rather than being reconstructed downstream.
    raw_snapshot: JSON.stringify({ ...(sourceUrl ? { source_url: sourceUrl } : {}), ...snapshot }),
    ingested_at: ingestedAt,
    link_confidence_score: null,
  };
}

/** Source observations for one agency, one row per publishing dataset. */
export function agencyDossierRows(agencyId, entry, provenance) {
  const entityId = entityIdFor(agencyId);
  const displayName = clean(entry?.canonical_name);
  if (!entityId || !displayName) return [];
  const rosterObserved = datasetObservedOn(provenance, AGENCY_ROSTER_DATASET);
  const budgetObserved = datasetObservedOn(provenance, AGENCY_BUDGET_DATASET);
  const website = clean(entry?.url);
  const rows = [
    dossierRow({
      entityId,
      displayName,
      datasetId: AGENCY_ROSTER_DATASET,
      sourceUrl: datasetUrl(provenance, AGENCY_ROSTER_DATASET),
      observedOn: rosterObserved,
      fields: {
        name: displayName,
        agency_acronym: entry?.acronym,
        organization_type: entry?.org_type,
        agency_website: website.startsWith("https://") || website.startsWith("http://") ? website : null,
        principal_officer: entry?.head_name,
        principal_officer_title: entry?.head_title,
        reports_to: entry?.reports_to,
      },
    }),
    dossierRow({
      entityId,
      displayName,
      datasetId: AGENCY_BUDGET_DATASET,
      sourceUrl: datasetUrl(provenance, AGENCY_BUDGET_DATASET),
      observedOn: budgetObserved,
      fields: {
        budget_code: entry?.budget_code,
        adopted_budget: entry?.budget_adopted,
        budget_fiscal_year: entry?.budget_fy,
      },
    }),
  ].filter(Boolean);
  return rows.sort((left, right) => left.ingested_at.localeCompare(right.ingested_at)
    || left.source_system_id.localeCompare(right.source_system_id));
}

function provenanceFor(source, observedAt, sourceFields) {
  return {
    source,
    source_fields: [...new Set(sourceFields.map(clean).filter(Boolean))].sort(),
    observed_at: clean(observedAt),
  };
}

function leadershipGraph(agencyId, entry, provenance) {
  const entityId = entityIdFor(agencyId);
  const observedOn = datasetObservedOn(provenance, AGENCY_ROSTER_DATASET);
  const leader = buildPersonLeaderEntity({
    agencyId: entityId,
    agencyName: entry?.canonical_name,
    headName: entry?.head_name,
    headTitle: entry?.head_title,
  });
  if (!leader || !observedOn) return { nodes: [], edges: [] };
  const source = {
    system: AGENCY_IDENTITY_SOURCE_SYSTEM,
    id: AGENCY_ROSTER_DATASET,
    ...(datasetUrl(provenance, AGENCY_ROSTER_DATASET)
      ? { url: datasetUrl(provenance, AGENCY_ROSTER_DATASET) }
      : {}),
  };
  const evidence = provenanceFor(source, observedOn, ["head_name", "head_title"]);
  return {
    nodes: [{
      id: leader.id,
      type: PERSON_LEADER_ENTITY_TYPE,
      name: leader.display_name,
      ...(leader.role ? { role: leader.role } : {}),
      classification: "publisher_assertion",
      provenance: evidence,
      confidence: leader.confidence,
    }],
    edges: [{
      type: "agency_led_by",
      from: entityId,
      to: leader.id,
      confidence: leader.confidence,
      provenance: evidence,
    }],
  };
}

function contractGraph(agencyId, agencyRows) {
  const entityId = entityIdFor(agencyId);
  const nodes = [];
  const edges = [];
  for (const row of agencyRows.slice(0, AGENCY_GRAPH_CONTRACT_LIMIT)) {
    const subjectRef = clean(row?.subject_ref);
    const observedAt = isoDay(row?.provenance?.observed_at) || isoDay(row?.when);
    const sourceSystem = clean(row?.provenance?.source_system);
    const sourceRecordId = clean(row?.provenance?.source_record_id);
    if (!subjectRef.startsWith("contract:") || !observedAt || !sourceRecordId) continue;
    if (sourceSystem !== AGENCY_CONTRACT_SOURCE_SYSTEM) continue;
    if (clean(row?.link_type) !== "published_by_agency") continue;
    const contractId = clean(row?.contract_id);
    const source = { system: sourceSystem, id: sourceRecordId };
    const fields = Array.isArray(row?.provenance?.source_fields) ? row.provenance.source_fields : [];
    const evidence = provenanceFor(source, observedAt, fields);
    nodes.push({
      id: subjectRef,
      type: "contract",
      name: contractId ? `Contract ${contractId}` : subjectRef,
      classification: "source_observation",
      provenance: evidence,
      confidence: { status: "not_scored", basis: "publisher_record" },
    });
    edges.push({
      type: "published_by_agency",
      from: subjectRef,
      to: entityId,
      provenance: evidence,
    });
  }
  return { nodes, edges };
}

/** Typed public relationships for one agency, root node included. */
export function agencyPublishedGraph(agencyId, entry, { provenance, contractRows = [] } = {}) {
  const entityId = entityIdFor(agencyId);
  const displayName = clean(entry?.canonical_name);
  if (!entityId || !displayName) return null;
  const leadership = leadershipGraph(agencyId, entry, provenance);
  const contracts = contractGraph(agencyId, contractRows);
  return {
    nodes: [
      { id: entityId, type: AGENCY_ENTITY_TYPE, name: displayName },
      ...leadership.nodes,
      ...contracts.nodes,
    ],
    edges: [...leadership.edges, ...contracts.edges],
  };
}

function constellationName(constellation, agencyId) {
  return clean(constellation?.by_id?.[agencyId]?.display_name);
}

/**
 * Build the published agency entity records.
 *
 * An agency enters the publication only when the identity crosswalk carries a
 * canonical name for it and at least one dataset observation survives. Every
 * other agency is deliberately absent, and callers report that absence as
 * "not covered by this publication" rather than as an empty record.
 */
export function buildAgencyEntityPublication({
  crosswalk = {},
  constellation = null,
  contractGraph: passportGraph = null,
  generatedAt = null,
} = {}) {
  const provenance = crosswalk?._provenance || {};
  const entries = crosswalk?.entries && typeof crosswalk.entries === "object" ? crosswalk.entries : {};
  const byAgency = passportGraph?.by_agency && typeof passportGraph.by_agency === "object"
    ? passportGraph.by_agency
    : {};
  const agencies = {};
  for (const agencyId of Object.keys(entries).sort()) {
    const entry = entries[agencyId];
    const entityId = entityIdFor(agencyId);
    const displayName = clean(entry?.canonical_name);
    if (!entityId || !displayName) continue;
    const rows = agencyDossierRows(agencyId, entry, provenance);
    if (!rows.length) continue;
    const graph = agencyPublishedGraph(agencyId, entry, {
      provenance,
      contractRows: Array.isArray(byAgency[agencyId]?.preview) ? byAgency[agencyId].preview : [],
    });
    agencies[entityId] = {
      entity: { id: entityId, type: AGENCY_ENTITY_TYPE, name: displayName },
      agency_id: agencyId,
      ...(constellationName(constellation, agencyId)
        ? { constellation_display_name: constellationName(constellation, agencyId) }
        : {}),
      dossier_rows: rows,
      graph,
    };
  }
  const rosterObserved = datasetObservedOn(provenance, AGENCY_ROSTER_DATASET);
  const budgetObserved = datasetObservedOn(provenance, AGENCY_BUDGET_DATASET);
  const entityIds = Object.keys(agencies);
  return {
    schema: AGENCY_ENTITY_PUBLICATION_SCHEMA,
    method: AGENCY_ENTITY_PUBLICATION_METHOD,
    generated_at: clean(generatedAt) || null,
    sources: [
      {
        system: AGENCY_IDENTITY_SOURCE_SYSTEM,
        id: AGENCY_ROSTER_DATASET,
        name: datasetSource(provenance, AGENCY_ROSTER_DATASET)?.name || null,
        attribution: datasetSource(provenance, AGENCY_ROSTER_DATASET)?.attribution || null,
        url: datasetUrl(provenance, AGENCY_ROSTER_DATASET),
        observed_on: rosterObserved,
        provides: [
          "name",
          "agency_acronym",
          "organization_type",
          "agency_website",
          "principal_officer",
          "principal_officer_title",
          "reports_to",
        ],
      },
      {
        system: AGENCY_IDENTITY_SOURCE_SYSTEM,
        id: AGENCY_BUDGET_DATASET,
        name: datasetSource(provenance, AGENCY_BUDGET_DATASET)?.name || null,
        attribution: datasetSource(provenance, AGENCY_BUDGET_DATASET)?.attribution || null,
        url: datasetUrl(provenance, AGENCY_BUDGET_DATASET),
        observed_on: budgetObserved,
        provides: ["budget_code", "adopted_budget", "budget_fiscal_year"],
      },
      {
        system: AGENCY_CONTRACT_SOURCE_SYSTEM,
        id: "by_agency.preview",
        name: "Award-corroborated public contract census",
        attribution: null,
        url: null,
        observed_on: isoDay(passportGraph?.observed_on),
        provides: ["published_by_agency"],
      },
    ],
    coverage: {
      published_agency_count: entityIds.length,
      crosswalk_agency_count: Object.keys(entries).length,
      graph_contract_limit: AGENCY_GRAPH_CONTRACT_LIMIT,
      basis: "agency identity crosswalk rows with at least one dataset observation",
      absence_note: "An agency id absent from this publication is not covered by it. Absence here is not evidence that the agency does not exist or that no public record names it.",
    },
    agencies,
  };
}
