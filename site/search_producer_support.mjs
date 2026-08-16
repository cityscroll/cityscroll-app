/** Small, presentation-neutral helpers shared by canonical search producers. */

import {
  SEARCH_DOCUMENT_SCHEMA,
  admitSearchDocument,
} from "./search_document_contract.mjs";

export function cleanSearchText(value, max = 500) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function uniqueSearchText(values, max = 500) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const item = cleanSearchText(value, max);
    const key = item.toLocaleUpperCase("en-US");
    if (!item || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

export function freezeSearchValue(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeSearchValue));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, freezeSearchValue(nested)]),
  ));
}

export function failedSearchProjection(outcome, reason, errors = []) {
  return freezeSearchValue({ outcome, document: null, reason, errors });
}

export function admitProjectedSearchDocument(candidate, reason) {
  const admitted = admitSearchDocument({ schema: SEARCH_DOCUMENT_SCHEMA, ...candidate }, {
    outcome: "indexed",
  });
  if (!admitted.document) {
    return failedSearchProjection(admitted.outcome, "search_document_contract_rejected", admitted.errors);
  }
  return freezeSearchValue({
    outcome: admitted.outcome,
    document: {
      ...admitted.document,
      outcome: admitted.outcome,
      coverage_state: "matched",
    },
    reason,
    errors: admitted.errors,
  });
}

export function searchProducerCoverage({
  producer,
  objectType,
  domain,
  state,
  reason,
  totalCount = 0,
  indexedCount = 0,
  notIndexedCount = 0,
}) {
  return freezeSearchValue({
    producer,
    object_type: objectType,
    domain,
    state,
    reason,
    total_count: totalCount,
    indexed_count: indexedCount,
    not_indexed_count: notIndexedCount,
  });
}

export function searchProducerCorpus({
  schema,
  producer,
  objectType,
  domain,
  outcomes,
  reasons,
}) {
  const rows = Array.isArray(outcomes) ? outcomes : [];
  const documents = rows.map((row) => row.document).filter(Boolean);
  const rejected = rows.length - documents.length;
  const state = rows.length === 0
    ? "empty"
    : documents.length === 0
      ? "not_indexed"
      : rejected
        ? "partial"
        : "matched";
  return freezeSearchValue({
    schema,
    documents,
    outcomes: rows,
    coverage: searchProducerCoverage({
      producer,
      objectType,
      domain,
      state,
      reason: reasons[state],
      totalCount: rows.length,
      indexedCount: documents.length,
      notIndexedCount: rejected,
    }),
  });
}

export function unavailableSearchProducerCorpus({
  schema,
  producer,
  objectType,
  domain,
  reason,
  totalCount = 0,
}) {
  return freezeSearchValue({
    schema,
    documents: [],
    outcomes: [],
    coverage: searchProducerCoverage({
      producer,
      objectType,
      domain,
      state: "not_indexed",
      reason,
      totalCount,
      indexedCount: 0,
      notIndexedCount: totalCount,
    }),
  });
}
