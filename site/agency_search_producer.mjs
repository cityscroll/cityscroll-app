/**
 * SearchDocument producer for the bounded agency constellation read model.
 *
 * Agency identity and routing are settled before search admission. This
 * adapter contributes lexical fields and coverage receipts; it never asks
 * ranking to infer an agency from a relationship label.
 */

import { resolveAgencyIdentity } from "./agency_identity.mjs";
import {
  SEARCH_DOCUMENT_SCHEMA,
  SEARCH_TEXT_MAX_LENGTH,
  admitSearchDocument,
} from "./search_document_contract.mjs";

export const AGENCY_SEARCH_PRODUCER = "agency_search_document.v1";
export const AGENCY_READ_MODEL_SCHEMA = "cityscroll.agency_constellation.v1";

const ACCEPTED_IDENTITY_CLASSIFICATIONS = new Set([
  "canonical_read_model",
  "canonical_route",
  "publisher_crosswalk",
  "publisher_crosswalk_canonical",
  "legitimate_non_crosswalk_entity",
]);

function clean(value, max = 500) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function unique(values, limit = 100) {
  return [...new Set(values.map((value) => clean(value)).filter(Boolean))].slice(0, limit);
}

function freeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freeze));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, freeze(nested)]),
  ));
}

function routeAliases(lookup, agencyId) {
  return Object.entries(lookup?.aliases || {})
    .filter(([, canonicalId]) => canonicalId === agencyId)
    .map(([aliasId]) => aliasId);
}

function relationReceipts(row) {
  return (Array.isArray(row?.edge_summary) ? row.edge_summary : [])
    .map((edge) => ({
      state: clean(edge?.state, 40) || "unknown",
      label: clean(edge?.label, 300) || clean(edge?.relation_label, 300),
    }))
    .filter((edge) => edge.label)
    .slice(0, 100);
}

function matchedConstellationLabels(row, relations) {
  const categories = Object.entries(row?.categories || {})
    .filter(([, category]) => category?.status === "matched")
    .map(([categoryId]) => categoryId.replace(/[_-]+/g, " "));
  return unique([
    ...categories,
    ...relations.filter((relation) => relation.state === "matched").map((relation) => relation.label),
  ]);
}

function identityFor(agencyId, options = {}) {
  if (options.identity) return options.identity;
  const reportCase = (options.identityReport?.cases || [])
    .find((row) => row?.source_id === agencyId);
  if (reportCase) return reportCase;
  const resolved = resolveAgencyIdentity(agencyId);
  if (resolved.route_classification === "unresolved") {
    return {
      classification: "unresolved",
      basis: "agency identity registry marks this route unresolved",
    };
  }
  return {
    classification: resolved.route_classification || "canonical_read_model",
    basis: "canonical identity retained by the agency constellation read model",
    variants: resolved.variants,
  };
}

function failed(outcome, reason, errors = []) {
  return freeze({ outcome, document: null, reason, errors });
}

/** Project one trusted agency read-model row through the shared admission boundary. */
export function projectAgencySearchDocument(agencyIdValue, row = {}, options = {}) {
  const lookup = options.lookup || {};
  const agencyId = clean(agencyIdValue, 160);
  if (lookup.schema !== AGENCY_READ_MODEL_SCHEMA) {
    return failed("not_indexed", "unsupported_agency_read_model", ["read_model_schema"]);
  }
  if (!agencyId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agencyId)) {
    return failed("unclassified", "invalid_agency_identifier", ["agency_id"]);
  }

  const identity = identityFor(agencyId, options);
  if (identity?.classification === "unresolved") {
    return failed("unclassified", "unresolved_agency_identity", ["identity"]);
  }
  if (!ACCEPTED_IDENTITY_CLASSIFICATIONS.has(
    identity?.classification || "canonical_read_model",
  )) {
    return failed("unclassified", "unsupported_agency_identity", ["identity"]);
  }

  const objectRef = `agency:id:${agencyId}`;
  const canonicalHref = `/agencies/${agencyId}/`;
  if (row?.subject_ref !== objectRef || row?.path !== canonicalHref) {
    return failed("not_indexed", "inconsistent_agency_identity", ["object_ref", "canonical_href"]);
  }
  const title = clean(row?.display_name, 500);
  if (!title) return failed("not_indexed", "missing_agency_name", ["title"]);

  const resolved = resolveAgencyIdentity(agencyId);
  const aliases = unique([
    ...(Array.isArray(identity?.variants) ? identity.variants : []),
    ...(Array.isArray(resolved?.variants) ? resolved.variants : []),
    ...routeAliases(lookup, agencyId),
  ]);
  const relations = relationReceipts(row);
  const constellationLabels = matchedConstellationLabels(row, relations);
  const searchText = unique([
    title,
    agencyId,
    objectRef,
    ...aliases,
    ...constellationLabels,
  ]).join(" ").slice(0, SEARCH_TEXT_MAX_LENGTH);
  const matchedCategories = Number(row?.matched_categories);
  const summary = Number.isFinite(matchedCategories)
    ? `Agency with public records in ${matchedCategories} connected ${matchedCategories === 1 ? "category" : "categories"}.`
    : null;
  const basis = clean([
    lookup.er_match_basis,
    identity?.basis,
  ].filter(Boolean).join(":"), 600) || "canonical agency constellation identity";

  const admitted = admitSearchDocument({
    schema: SEARCH_DOCUMENT_SCHEMA,
    object_ref: objectRef,
    object_type: "agency",
    domain: "people",
    canonical_href: canonicalHref,
    title,
    summary,
    search_text: searchText,
    source_family: "agency_constellation",
    source_observation_refs: [`agency_constellation:${agencyId}`],
    process_role: null,
    classification: {
      method: "canonical_agency_read_model",
      basis,
    },
    provenance: {
      producer: AGENCY_SEARCH_PRODUCER,
      read_model_schema: lookup.schema,
      read_model_method: lookup.method || null,
      read_model_generated_at: lookup.generated_at || null,
      source_freshness: lookup.provenance || {},
      identity_classification: identity.classification || "canonical_read_model",
      identity_aliases: aliases,
      constellation_relations: relations,
      searchable_constellation_labels: constellationLabels,
    },
  }, { outcome: "indexed" });

  if (!admitted.document) {
    return failed(admitted.outcome, "search_document_contract_rejected", admitted.errors);
  }
  return freeze({
    outcome: admitted.outcome,
    document: admitted.document,
    reason: "canonical_agency_identity",
    errors: admitted.errors,
  });
}

function coverage(state, reason, totalCount, indexedCount, notIndexedCount) {
  return freeze({
    producer: AGENCY_SEARCH_PRODUCER,
    object_type: "agency",
    domain: "people",
    state,
    reason,
    total_count: totalCount,
    indexed_count: indexedCount,
    not_indexed_count: notIndexedCount,
  });
}

/** Materialize the bounded corpus with an explicit producer coverage receipt. */
export function buildAgencySearchDocuments(lookup = {}, options = {}) {
  if (lookup?.schema !== AGENCY_READ_MODEL_SCHEMA || !lookup?.by_id || Array.isArray(lookup.by_id)) {
    return freeze({
      documents: [],
      outcomes: [],
      coverage: coverage("not_indexed", "unsupported_agency_read_model", 0, 0, 0),
    });
  }
  const rows = Object.entries(lookup.by_id).sort(([left], [right]) => left.localeCompare(right));
  if (rows.length === 0) {
    return freeze({
      documents: [],
      outcomes: [],
      coverage: coverage("empty", "agency_read_model_has_no_entries", 0, 0, 0),
    });
  }

  const outcomes = rows.map(([agencyId, row]) => {
    const result = projectAgencySearchDocument(agencyId, row, { ...options, lookup });
    return freeze({ agency_id: agencyId, ...result });
  });
  const documents = outcomes.map((result) => result.document).filter(Boolean);
  const notIndexedCount = outcomes.length - documents.length;
  const state = documents.length === 0 ? "not_indexed" : notIndexedCount ? "partial" : "matched";
  const reason = state === "matched"
    ? "agency_read_model_indexed"
    : state === "partial"
      ? "some_agency_entries_not_indexed"
      : "no_agency_entries_admitted";
  return freeze({
    documents,
    outcomes,
    coverage: coverage(state, reason, outcomes.length, documents.length, notIndexedCount),
  });
}
