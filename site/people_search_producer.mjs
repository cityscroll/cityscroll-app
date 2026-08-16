/**
 * Canonical People SearchDocument producer over person_hub_lookup.
 *
 * The person hub owns identity and source joins. This projection admits only
 * exact publisher PersonIds and limits recall text to declared reader fields.
 */

import { PERSON_HUB_SOURCE } from "./person_hub.mjs";
import {
  SEARCH_DOCUMENT_SCHEMA,
  SEARCH_TEXT_MAX_LENGTH,
  admitSearchDocument,
  rankSearchDocuments,
} from "./search_document_contract.mjs";

export const PEOPLE_SEARCH_PRODUCER_SCHEMA = "cityscroll.people_search_producer.v1";
export const PEOPLE_SEARCH_COVERAGE_STATES = Object.freeze([
  "matched",
  "empty",
  "partial",
  "not_indexed",
]);

const DECLARED_SEARCH_TEXT_FIELDS = Object.freeze([
  "display_name",
  "aliases",
  "role_labels",
  "agency_labels",
  "district_labels",
]);

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function uniqueText(values, max = 240) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const candidate = clean(value, max);
    const key = candidate.toLocaleUpperCase("en-US");
    if (!candidate || seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function validDay(value) {
  const valueDay = clean(value, 20).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(valueDay) ? valueDay : null;
}

function personId(row) {
  const id = clean(row?.person_id, 80);
  return /^\d+$/.test(id) ? id : null;
}

function sourceObservationRefs(row, id) {
  const refs = [];
  for (const term of Array.isArray(row?.terms) ? row.terms : []) {
    const termStart = validDay(term?.term_start);
    if (!termStart) continue;
    refs.push(`nyc_council_members:council-member:${id}:${termStart}`);
  }
  return [...new Set(refs)].sort().slice(0, 100);
}

function lifecycleFor(row, retrievedAt) {
  const asOf = validDay(retrievedAt);
  const terms = (Array.isArray(row?.terms) ? row.terms : [])
    .map((term) => ({
      term_start: validDay(term?.term_start),
      term_end: validDay(term?.term_end),
      district: clean(term?.district, 80) || null,
    }))
    .filter((term) => term.term_start || term.term_end);
  const active = Boolean(asOf && terms.some((term) => (
    (!term.term_start || term.term_start <= asOf)
    && (!term.term_end || term.term_end >= asOf)
  )));
  return {
    state: asOf ? (active ? "active" : "archive") : "unknown",
    as_of: asOf,
    current_term_start: validDay(row?.current_term?.term_start),
    current_term_end: validDay(row?.current_term?.term_end),
  };
}

/** The complete allowlist of fields that may affect person retrieval. */
export function peopleSearchMatchFields(row = {}) {
  const displayName = clean(row.person_name, 500);
  const displayKey = displayName.toLocaleUpperCase("en-US");
  const aliases = uniqueText([
    ...(Array.isArray(row.names) ? row.names : []),
    ...(Array.isArray(row.name_keys) ? row.name_keys : []),
  ], 500).filter((name) => name.toLocaleUpperCase("en-US") !== displayKey);
  const roleLabels = uniqueText([
    ...(Array.isArray(row.role_labels) ? row.role_labels : []),
    ...(Array.isArray(row.roles) ? row.roles : []),
    "Council member",
  ], 240);
  const agencyLabels = uniqueText([
    ...(Array.isArray(row.agency_labels) ? row.agency_labels : []),
    ...(Array.isArray(row.agencies) ? row.agencies : []),
    "New York City Council",
  ], 240);
  const districtLabels = uniqueText([
    ...(Array.isArray(row.districts) ? row.districts : []),
    row.district,
  ], 80)
    .map((district) => `Council District ${district}`);
  return Object.freeze({
    display_name: displayName,
    aliases: Object.freeze(aliases),
    role_labels: Object.freeze(roleLabels),
    agency_labels: Object.freeze(agencyLabels),
    district_labels: Object.freeze(districtLabels),
  });
}

function projection(outcome, reason, object = null, refs = []) {
  return Object.freeze({
    schema: PEOPLE_SEARCH_PRODUCER_SCHEMA,
    outcome,
    object: object ? Object.freeze(object) : null,
    source_observation_refs: Object.freeze(refs),
    receipt: Object.freeze({ reason }),
  });
}

/** Resolve one person-hub row before search admission. */
export function projectPeopleSearchObject(row = {}, {
  sourceContract = null,
  sourcePromoted = false,
} = {}) {
  if (!sourcePromoted) {
    return projection("not_indexed", "person_hub_publication_gate_not_promoted");
  }
  if (sourceContract !== PERSON_HUB_SOURCE) {
    return projection("not_indexed", "unregistered_person_hub_source_contract");
  }

  const id = personId(row);
  if (!id || clean(row.official_id, 120) !== `official:${id}`) {
    return projection("unclassified", "unresolved_exact_person_identity");
  }
  if (!clean(row.person_name, 500)) {
    return projection("unclassified", "missing_person_display_name");
  }
  const refs = sourceObservationRefs(row, id);
  if (!refs.length) {
    return projection("not_indexed", "missing_person_source_observation");
  }

  return projection("indexed", "exact_council_member_id_person_hub", {
    object_ref: `person:${id}`,
    object_type: "person",
    domain: "people",
    canonical_href: `/officials/${encodeURIComponent(id)}/`,
    process_role: null,
  }, refs);
}

/** Produce one admitted SearchDocument, or null for a fail-closed row. */
export function materializePeopleSearchDocument(row = {}, {
  sourceContract = null,
  retrievedAt = null,
  sourceProvenance = null,
  sourcePromoted = false,
} = {}) {
  const projected = projectPeopleSearchObject(row, { sourceContract, sourcePromoted });
  if (projected.outcome !== "indexed") return null;

  const fields = peopleSearchMatchFields(row);
  const searchText = clean([
    fields.display_name,
    ...fields.aliases,
    ...fields.role_labels,
    ...fields.agency_labels,
    ...fields.district_labels,
  ].join(" "), SEARCH_TEXT_MAX_LENGTH);
  const summary = clean([
    ...fields.role_labels,
    ...fields.agency_labels,
    ...fields.district_labels,
  ].join(" · "), 1_200) || null;
  const admitted = admitSearchDocument({
    schema: SEARCH_DOCUMENT_SCHEMA,
    ...projected.object,
    title: fields.display_name,
    summary,
    search_text: searchText,
    source_family: "nyc_council_members_person_hub",
    source_observation_refs: projected.source_observation_refs,
    classification: {
      method: "exact_person_hub_projection",
      basis: "council_member_id=Legistar PersonId; promoted person_hub_lookup",
    },
    provenance: {
      producer: "people_search_document.v1",
      source_contract: sourceContract,
      source_retrieved_at: clean(retrievedAt, 80) || null,
      source_projection: sourceProvenance,
      projection_receipt: projected.receipt,
      lifecycle: lifecycleFor(row, retrievedAt),
      search_text_fields: DECLARED_SEARCH_TEXT_FIELDS,
      match_fields: fields,
    },
  }, { outcome: "indexed" });
  if (!admitted.document) return null;
  return Object.freeze({
    ...admitted.document,
    outcome: admitted.outcome,
    coverage_state: "matched",
  });
}

function coverage(state, reason, sourceCount, indexedCount, rejectedCount) {
  return Object.freeze({
    producer: "people",
    domain: "people",
    state,
    reason,
    source_count: sourceCount,
    indexed_count: indexedCount,
    rejected_count: rejectedCount,
  });
}

/** Build a deterministic person corpus plus an explicit producer coverage receipt. */
export function buildPeopleSearchDocuments(lookup = {}) {
  const rows = Object.values(
    lookup?.by_person_id && typeof lookup.by_person_id === "object"
      ? lookup.by_person_id
      : {},
  );
  const options = {
    sourceContract: lookup?.source_contract,
    retrievedAt: lookup?.retrieved_at,
    sourceProvenance: lookup?.provenance,
    sourcePromoted: lookup?.gate?.promoted === true,
  };

  if (!options.sourcePromoted) {
    return Object.freeze({
      schema: PEOPLE_SEARCH_PRODUCER_SCHEMA,
      documents: Object.freeze([]),
      coverage: coverage(
        "not_indexed",
        "person_hub_publication_gate_not_promoted",
        rows.length,
        0,
        rows.length,
      ),
    });
  }
  if (options.sourceContract !== PERSON_HUB_SOURCE) {
    return Object.freeze({
      schema: PEOPLE_SEARCH_PRODUCER_SCHEMA,
      documents: Object.freeze([]),
      coverage: coverage(
        "not_indexed",
        "unregistered_person_hub_source_contract",
        rows.length,
        0,
        rows.length,
      ),
    });
  }
  if (!rows.length) {
    return Object.freeze({
      schema: PEOPLE_SEARCH_PRODUCER_SCHEMA,
      documents: Object.freeze([]),
      coverage: coverage("empty", "available_person_hub_has_no_people", 0, 0, 0),
    });
  }

  const documents = [];
  let rejected = 0;
  for (const row of rows) {
    const document = materializePeopleSearchDocument(row, options);
    if (document) documents.push(document);
    else rejected += 1;
  }
  documents.sort((left, right) => left.object_ref.localeCompare(right.object_ref, "en-US"));
  const state = rejected ? (documents.length ? "partial" : "not_indexed") : "matched";
  const reason = state === "matched"
    ? "person_hub_corpus_indexed"
    : state === "partial"
      ? "one_or_more_person_rows_failed_admission"
      : "no_person_rows_passed_admission";
  return Object.freeze({
    schema: PEOPLE_SEARCH_PRODUCER_SCHEMA,
    documents: Object.freeze(documents),
    coverage: coverage(state, reason, rows.length, documents.length, rejected),
  });
}

function normalizedQuery(value) {
  return clean(value, 240).toLocaleLowerCase("en-US");
}

/** Deterministic lexical ranking over already admitted person documents. */
export function rankPeopleSearchDocuments(documents = [], query = "", { limit = 40 } = {}) {
  const needle = normalizedQuery(query);
  if (!needle || !Array.isArray(documents)) return Object.freeze([]);
  const tokens = needle.split(/\s+/).filter(Boolean);
  const scores = new Map();
  const matched = documents.filter((document) => {
    const fields = document?.provenance?.match_fields || {};
    const display = normalizedQuery(fields.display_name);
    const aliases = Array.isArray(fields.aliases) ? fields.aliases.map(normalizedQuery) : [];
    const haystack = normalizedQuery(document?.search_text);
    if (!tokens.every((token) => haystack.includes(token))) return false;
    let score = 20;
    if (haystack.includes(needle)) score += 10;
    if (display.startsWith(needle)) score += 60;
    if (aliases.some((alias) => alias.startsWith(needle))) score += 50;
    if (aliases.includes(needle)) score += 20;
    if (display === needle) score += 30;
    scores.set(document.object_ref, score);
    return true;
  });
  return Object.freeze(
    rankSearchDocuments(matched, (document) => scores.get(document.object_ref) || 0)
      .slice(0, Math.max(0, Number(limit) || 0)),
  );
}
