// Reader for the retained materialization of published city-agency entity records.
//
// Three answers are deliberately distinct here, because a reader needs to tell
// them apart: this agency has a published record, this agency is outside the
// published set, and this agency has a published record that could not be read.
// The third is never reported as the second, and neither is ever an empty
// record or a zero.
//
// The officer reader below keeps a fourth answer separate again: the sources
// name no officer for this agency. "Not recorded" and "could not be read" are
// different facts about the world, and a reader deciding whether to go looking
// elsewhere needs to know which one they got. Neither is ever served as a
// leader with an empty name, and neither drops the leadership question.

import committedPublication from "../data/agency_entity_publication.json" with { type: "json" };

export const AGENCY_ENTITY_PUBLICATION = committedPublication;
export const AGENCY_ENTITY_PUBLICATION_SCHEMA = "cityscroll.agency_entity_publication.v1";

/** The answers this reader can give about who leads an agency. */
export const AGENCY_OFFICER_STATUS = Object.freeze({
  PUBLISHED: "published",
  NOT_RECORDED: "not_recorded",
  UNREADABLE: "unreadable",
});

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

function completeOfficerProvenance(provenance) {
  return Boolean(provenance
    && clean(provenance.observed_at)
    && clean(provenance.source?.system)
    && clean(provenance.source?.id)
    && Array.isArray(provenance.source_fields)
    && provenance.source_fields.length);
}

function completeConsultedSource(source) {
  return Boolean(source
    && clean(source.system)
    && clean(source.id)
    && clean(source.observed_at));
}

/**
 * Read the published officer statement for one canonical agency id.
 *
 * Four answers, each of which a reader can act on differently:
 *   null                     this id is outside the published set
 *   { status: "published" }  a person, with the dataset and the date it reports
 *   { status: "not_recorded" } the datasets that were read name no officer
 *   { status: "unreadable" } a statement is stored but cannot be used
 *
 * A statement that is missing its person, its dataset or its observation date
 * is unreadable rather than not recorded, because a record we cannot read is
 * not evidence that nobody publishes an officer.
 */
export function readPublishedAgencyOfficer(publication, canonicalEntityId) {
  const entityId = clean(canonicalEntityId);
  if (!entityId) return null;
  if (publication?.schema !== AGENCY_ENTITY_PUBLICATION_SCHEMA) {
    return { status: AGENCY_OFFICER_STATUS.UNREADABLE, reason: "publication-schema-unrecognized" };
  }
  const officers = publication.officers;
  if (!officers || typeof officers !== "object" || Array.isArray(officers)) {
    return { status: AGENCY_OFFICER_STATUS.UNREADABLE, reason: "officer-statements-unreadable" };
  }
  if (!Object.hasOwn(officers, entityId)) return null;
  const officer = officers[entityId];
  if (!officer || typeof officer !== "object" || Array.isArray(officer)) {
    return { status: AGENCY_OFFICER_STATUS.UNREADABLE, reason: "officer-statement-unreadable" };
  }
  if (officer.status === AGENCY_OFFICER_STATUS.PUBLISHED) {
    if (!clean(officer.person) || !completeOfficerProvenance(officer.provenance)
        || !clean(officer.confidence?.status) || !clean(officer.confidence?.basis)) {
      return { status: AGENCY_OFFICER_STATUS.UNREADABLE, reason: "officer-statement-incomplete" };
    }
    return { status: AGENCY_OFFICER_STATUS.PUBLISHED, officer };
  }
  if (officer.status === AGENCY_OFFICER_STATUS.NOT_RECORDED) {
    const consulted = Array.isArray(officer.consulted_sources) ? officer.consulted_sources : [];
    if (!consulted.length || !consulted.every(completeConsultedSource) || !clean(officer.note)) {
      return { status: AGENCY_OFFICER_STATUS.UNREADABLE, reason: "officer-statement-incomplete" };
    }
    return { status: AGENCY_OFFICER_STATUS.NOT_RECORDED, officer };
  }
  return { status: AGENCY_OFFICER_STATUS.UNREADABLE, reason: "officer-status-unrecognized" };
}

/**
 * The leadership answer a public surface serves, or null when this id has no
 * published officer statement at all.
 *
 * Every branch names the question it answers, so a caller rendering this block
 * cannot accidentally render an agency with a blank leader: there is always
 * either a person or a stated reason there is not one.
 */
export function agencyLeadershipAnswer(canonicalEntityId, publication = committedPublication) {
  const read = readPublishedAgencyOfficer(publication, canonicalEntityId);
  if (!read) return null;
  if (read.status === AGENCY_OFFICER_STATUS.PUBLISHED) {
    const { officer } = read;
    return {
      question: "Who leads this agency?",
      status: AGENCY_OFFICER_STATUS.PUBLISHED,
      person: clean(officer.person),
      title: clean(officer.title) || null,
      person_entity_id: clean(officer.person_entity_id) || null,
      classification: clean(officer.classification) || null,
      source: {
        system: clean(officer.provenance.source.system),
        id: clean(officer.provenance.source.id),
        url: clean(officer.provenance.source.url) || null,
      },
      source_fields: [...officer.provenance.source_fields],
      observed_at: clean(officer.provenance.observed_at),
      confidence: {
        status: clean(officer.confidence.status),
        basis: clean(officer.confidence.basis),
      },
      note: null,
    };
  }
  if (read.status === AGENCY_OFFICER_STATUS.NOT_RECORDED) {
    const { officer } = read;
    return {
      question: "Who leads this agency?",
      status: AGENCY_OFFICER_STATUS.NOT_RECORDED,
      person: null,
      title: null,
      consulted_sources: officer.consulted_sources.map((source) => ({
        system: clean(source.system),
        id: clean(source.id),
        url: clean(source.url) || null,
        observed_at: clean(source.observed_at),
      })),
      note: clean(officer.note),
    };
  }
  return {
    question: "Who leads this agency?",
    status: AGENCY_OFFICER_STATUS.UNREADABLE,
    person: null,
    title: null,
    reason: clean(read.reason) || "officer-statement-unreadable",
    note: "An officer statement is published for this agency, but it could not be read on this request. This is a fault on our side, not a statement that no officer is recorded.",
  };
}

/** Bound reader over the committed publication. */
export function publishedAgencyOfficer(canonicalEntityId, publication = committedPublication) {
  return readPublishedAgencyOfficer(publication, canonicalEntityId);
}
