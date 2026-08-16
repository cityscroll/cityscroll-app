/**
 * Canonical Meeting SearchDocument projection.
 *
 * The shared meeting read model owns source coverage and source-qualified
 * identity. This adapter preserves both while projecting every accepted row
 * through the source-independent search contract. It never compares titles,
 * dates, or other descriptive fields for identity.
 */

import {
  MEETING_OBJECT_SCHEMA,
  MEETING_SOURCE_SYSTEMS,
  meetingCanonicalHref,
  meetingIdForSource,
} from "./meeting_object_contract.mjs";
import { meetingProcessProjection } from "./meeting_process_profile.mjs";
import {
  SHARED_MEETING_READ_MODEL_SCHEMA,
  meetingReadModelRows,
} from "./shared_meeting_read_model.mjs";
import {
  SEARCH_DOCUMENT_SCHEMA,
  SEARCH_TEXT_MAX_LENGTH,
  admitSearchDocument,
} from "./search_document_contract.mjs";

export const MEETING_SEARCH_PRODUCER_SCHEMA = "cityscroll.meeting_search_producer.v1";

function compactText(values, max) {
  return values
    .map((value) => String(value ?? "").replace(/<[^>]*>/g, " "))
    .join(" ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sourceIdentity(row) {
  const sourceSystem = String(row?.source_system || "").trim();
  if (!MEETING_SOURCE_SYSTEMS.includes(sourceSystem)) return null;
  const sourceKeys = Array.isArray(row?.source_keys) ? row.source_keys : [];
  const sourceKey = sourceKeys.find((key) => (
    key?.source_system === sourceSystem
    && String(key?.key_type || "").trim()
    && String(key?.value || "").trim()
  ));
  if (!sourceKey) return null;

  let expectedMeetingId;
  try {
    expectedMeetingId = meetingIdForSource(sourceSystem, sourceKey.value);
  } catch {
    return null;
  }
  if (row.meeting_id !== expectedMeetingId) return null;

  const observationRef = `${sourceSystem}:${sourceKey.value}`;
  if (observationRef.length > 240) return null;
  return { sourceSystem, sourceKeys, observationRef };
}

function summaryFor(row) {
  return compactText([
    row?.description,
    row?.agency,
    row?.board_name,
    row?.committee?.name,
    row?.event_date,
  ], 1_200) || null;
}

/** Project one canonical shared-model row into an admitted SearchDocument. */
export function materializeMeetingSearchDocument(row = {}) {
  const identity = sourceIdentity(row);
  if (!identity) return null;

  const title = compactText([row.title || "Meeting"], 500);
  const summary = summaryFor(row);
  const searchText = compactText([
    row.search_text,
    title,
    summary,
  ], SEARCH_TEXT_MAX_LENGTH) || title;
  const process = meetingProcessProjection(row);
  const admitted = admitSearchDocument({
    schema: SEARCH_DOCUMENT_SCHEMA,
    object_ref: row.meeting_id,
    object_type: "meeting",
    domain: "meetings",
    canonical_href: meetingCanonicalHref(row),
    title,
    summary,
    search_text: searchText,
    source_family: "shared_meeting_read_model",
    source_observation_refs: [identity.observationRef],
    process_role: process.process_role,
    classification: {
      method: "canonical_meeting_projection",
      basis: `${MEETING_OBJECT_SCHEMA}:exact_source_qualified_meeting_id`,
    },
    provenance: {
      producer: "shared_meeting_search_document.v1",
      read_model_schema: SHARED_MEETING_READ_MODEL_SCHEMA,
      source_system: identity.sourceSystem,
      source_keys: identity.sourceKeys,
      source_record: row.source_record || null,
      source_receipt: row.source_receipt || row.source_record?.receipt || null,
      meeting_family: process.meeting_family,
      process_profile: process.process_profile,
    },
  });
  if (!admitted.document) return null;
  return Object.freeze({
    ...admitted.document,
    outcome: admitted.outcome,
    coverage_state: "matched",
  });
}

function sourceCoverage(readModel, sourceSystem, stats) {
  const source = readModel?.sources?.[sourceSystem] || {};
  const status = String(source.status || "unavailable");
  return Object.freeze({
    source_system: sourceSystem,
    status,
    available: status === "available",
    generated_at: source.generated_at || null,
    reason: source.reason || null,
    source_row_count: Number.isInteger(source.row_count)
      ? source.row_count : stats.observed,
    indexed_count: stats.indexed,
    not_indexed_count: stats.notIndexed,
    exact_duplicate_count: stats.duplicates,
    source_coverage: source.coverage || null,
  });
}

/**
 * Project a complete shared read model and retain its per-source coverage.
 * Exact repeated meeting ids collapse; all other rows remain independent.
 */
export function buildMeetingSearchDocuments(readModel = {}) {
  const rows = readModel?.schema === SHARED_MEETING_READ_MODEL_SCHEMA
    ? meetingReadModelRows(readModel) : [];
  const documents = [];
  const seenMeetingIds = new Set();
  const stats = Object.fromEntries(MEETING_SOURCE_SYSTEMS.map((source) => [source, {
    observed: 0,
    indexed: 0,
    notIndexed: 0,
    duplicates: 0,
  }]));

  for (const row of rows) {
    const source = MEETING_SOURCE_SYSTEMS.includes(row?.source_system)
      ? row.source_system : null;
    if (source) stats[source].observed += 1;
    const meetingId = String(row?.meeting_id || "").trim();
    if (meetingId && seenMeetingIds.has(meetingId)) {
      if (source) stats[source].duplicates += 1;
      continue;
    }
    if (meetingId) seenMeetingIds.add(meetingId);

    const document = materializeMeetingSearchDocument(row);
    if (!document) {
      if (source) stats[source].notIndexed += 1;
      continue;
    }
    documents.push(document);
    stats[document.provenance.source_system].indexed += 1;
  }

  const coverage = Object.freeze(Object.fromEntries(MEETING_SOURCE_SYSTEMS.map((source) => [
    source,
    sourceCoverage(readModel, source, stats[source]),
  ])));
  return Object.freeze({
    schema: MEETING_SEARCH_PRODUCER_SCHEMA,
    generated_at: readModel?.generated_at || null,
    documents: Object.freeze(documents),
    coverage,
    counts: Object.freeze({
      total: documents.length,
      city_record: stats.city_record.indexed,
      community_board: stats.community_board.indexed,
      not_indexed: Object.values(stats).reduce((sum, value) => sum + value.notIndexed, 0),
      exact_duplicates: Object.values(stats).reduce((sum, value) => sum + value.duplicates, 0),
    }),
  });
}

export const projectSharedMeetingSearchDocuments = buildMeetingSearchDocuments;
