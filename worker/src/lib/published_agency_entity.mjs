// Reader for the retained materialization of published city-agency entity records.
//
// Three answers are deliberately distinct here, because a reader needs to tell
// them apart: this agency has a published record, this agency is outside the
// published set, and this agency has a published record that could not be read.
// The third is never reported as the second, and neither is ever an empty
// record or a zero.

import committedPublication from "../data/agency_entity_publication.json" with { type: "json" };

export const AGENCY_ENTITY_PUBLICATION = committedPublication;
export const AGENCY_ENTITY_PUBLICATION_SCHEMA = "cityscroll.agency_entity_publication.v1";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function completeNode(node) {
  return Boolean(node && clean(node.id) && clean(node.type) && clean(node.name));
}

function completeEdge(edge) {
  return Boolean(edge
    && clean(edge.type)
    && clean(edge.from)
    && clean(edge.to)
    && clean(edge.provenance?.observed_at)
    && clean(edge.provenance?.source?.system)
    && clean(edge.provenance?.source?.id));
}

function completeRow(row) {
  if (!row || clean(row.entity_id) === "" || clean(row.entity_type) === "") return false;
  if (clean(row.display_name) === "" || clean(row.ingested_at) === "") return false;
  if (clean(row.source_system) === "" || clean(row.source_system_id) === "") return false;
  try {
    const snapshot = JSON.parse(String(row.raw_snapshot ?? ""));
    return Boolean(snapshot) && typeof snapshot === "object" && !Array.isArray(snapshot);
  } catch {
    return false;
  }
}

/** Coverage statement a caller can quote when an id falls outside the set. */
export function agencyPublicationCoverage(publication = committedPublication) {
  const coverage = publication?.coverage || {};
  return {
    published_agency_count: Number(coverage.published_agency_count) || 0,
    observed_sources: (Array.isArray(publication?.sources) ? publication.sources : [])
      .map((source) => ({
        system: clean(source?.system) || null,
        id: clean(source?.id) || null,
        observed_on: clean(source?.observed_on) || null,
      })),
    absence_note: clean(coverage.absence_note) || null,
  };
}

/**
 * Look one canonical agency id up in the publication.
 *
 * Returns null when the id is outside the published set, a published record
 * when the materialization is complete, and an unreadable verdict when the
 * record is present but its stored rows or graph cannot be used.
 */
export function readPublishedAgency(publication, canonicalEntityId) {
  const entityId = clean(canonicalEntityId);
  if (!entityId) return null;
  if (publication?.schema !== AGENCY_ENTITY_PUBLICATION_SCHEMA) {
    return { status: "unreadable", reason: "publication-schema-unrecognized" };
  }
  const agencies = publication.agencies;
  if (!agencies || typeof agencies !== "object" || Array.isArray(agencies)) {
    return { status: "unreadable", reason: "publication-body-unreadable" };
  }
  if (!Object.hasOwn(agencies, entityId)) return null;
  const record = agencies[entityId];
  const rows = Array.isArray(record?.dossier_rows) ? record.dossier_rows : null;
  if (!rows || !rows.length || !rows.every(completeRow)) {
    return { status: "unreadable", reason: "record-observations-unreadable" };
  }
  const nodes = Array.isArray(record?.graph?.nodes) ? record.graph.nodes : null;
  const edges = Array.isArray(record?.graph?.edges) ? record.graph.edges : null;
  if (!nodes || !edges || !nodes.every(completeNode) || !edges.every(completeEdge)) {
    return { status: "unreadable", reason: "record-relationships-unreadable" };
  }
  if (!nodes.some((node) => clean(node.id) === entityId)) {
    return { status: "unreadable", reason: "record-relationships-unreadable" };
  }
  return { status: "published", record, rows, graph: { nodes, edges } };
}

/** Bound reader over the committed publication. */
export function publishedAgency(canonicalEntityId, publication = committedPublication) {
  return readPublishedAgency(publication, canonicalEntityId);
}
