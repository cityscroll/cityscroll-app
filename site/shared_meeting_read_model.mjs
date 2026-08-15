/**
 * The bounded meeting read model shared by static documents, the Worker, and
 * the Meetings explorer.
 *
 * Source records remain source-qualified objects. This module combines them
 * without using title/date similarity as identity and carries source
 * freshness alongside the rows so a missing or old board snapshot cannot look
 * like an empty, complete feed.
 */

import {
  normalizeCityRecordMeeting,
  normalizeCommunityBoardMeeting,
} from "./meeting_object_contract.mjs";
import {
  attachMeetingDocuments,
  normalizeMeetingDocument,
} from "./meeting_document.mjs";

export const SHARED_MEETING_READ_MODEL_SCHEMA = "cityscroll.shared_meeting_read_model.v1";
export const MEETING_READ_MODEL_SCHEMA = SHARED_MEETING_READ_MODEL_SCHEMA;
export const SHARED_MEETING_READ_MODEL_VERSION = 1;
export const COMMUNITY_BOARD_MAX_AGE_MS = 36 * 60 * 60 * 1000;

const CITY_RECORD_SOURCE_URL = "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx";

function text(value) {
  const valueText = String(value ?? "").trim();
  return valueText || null;
}

function asRows(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function time(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceReceipt(record, source, observedAt) {
  if (record.source_receipt || record.observed_receipt) {
    return record.source_receipt || record.observed_receipt;
  }
  if (source !== "city_record") return null;
  return {
    schema: "cityscroll.meeting_source_receipt.v1",
    source_url: record.source_url || null,
    observed_at: observedAt || null,
    status: "ok",
    fetch_status: "snapshot",
    reason: null,
  };
}

function sourceRecord(record, source, receipt) {
  const id = text(record.source_record_id)
    || text(record.record_id)
    || (source === "city_record" ? text(record.request_id) : text(record.publisher_identifier));
  return {
    source_system: source,
    identifier: id,
    url: text(record.record_url) || text(record.source_url) || null,
    receipt: receipt || null,
  };
}

function freshnessStatus(generatedAt, now, maxAgeMs) {
  const generated = time(generatedAt);
  const current = time(now) ?? Date.now();
  if (generated == null) return "unavailable";
  return current - generated > maxAgeMs ? "stale" : "available";
}

function sourceEnvelope({ source, generatedAt, now, maxAgeMs, rows, index, reason }) {
  const status = source === "community_board"
    ? (!index ? "unavailable" : freshnessStatus(generatedAt, now, maxAgeMs))
    : (rows.length ? "available" : "available");
  return {
    source_system: source,
    status,
    available: status === "available",
    generated_at: generatedAt || null,
    max_age_ms: source === "community_board" ? maxAgeMs : null,
    row_count: rows.length,
    reason: reason || (!index && source === "community_board" ? "snapshot_missing" : null),
    coverage: index?.coverage || null,
  };
}

function normalizeRecord(row, source, observedAt) {
  const normalized = source === "city_record"
    ? normalizeCityRecordMeeting(row)
    : normalizeCommunityBoardMeeting(row);
  const receipt = sourceReceipt({ ...row, ...normalized }, source, observedAt);
  const record = {
    ...row,
    ...normalized,
    source_receipt: receipt,
    source_record_id: normalized.source_record_id
      || row.source_record_id
      || row.record_id
      || (source === "city_record" ? normalized.request_id : normalized.publisher_identifier),
    source_record: sourceRecord({ ...row, ...normalized }, source, receipt),
  };
  record.meeting_documents = (Array.isArray(row.meeting_documents) ? row.meeting_documents : [])
    .map((document) => normalizeMeetingDocument(document));
  if (source === "community_board") {
    record.source_record = {
      ...record.source_record,
      board_id: text(row.board_id),
      role: text(row.source_role) || "upcoming_meetings",
    };
  }
  return record;
}

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const id = text(row.meeting_id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function dateSort(left, right) {
  // Keep the established source-key order for board events on the same day.
  // Their newly retained wall times belong to readers and calendar output;
  // Meetings explorer projections own time-of-day ordering.
  const leftDate = String(left.event_date || "");
  const rightDate = String(right.event_date || "");
  const leftKey = left.source_system === "community_board" ? leftDate.slice(0, 10) : leftDate;
  const rightKey = right.source_system === "community_board" ? rightDate.slice(0, 10) : rightDate;
  return rightKey.localeCompare(leftKey)
    || String(left.meeting_id || "").localeCompare(String(right.meeting_id || ""));
}

function meetingMinutesProjection(row, checkedAt) {
  const documents = Array.isArray(row.meeting_documents) ? row.meeting_documents : [];
  const minutes = documents
    .filter((document) => document?.attachment_status === "attached" && document.role === "minutes")
    .map((document) => document.meeting_date || document.publication_date || document.date)
    .filter(Boolean)
    .sort();
  return {
    status: minutes.length ? "published" : "not_published",
    latest_date: minutes.at(-1) || null,
    checked_at: checkedAt || row.source_receipt?.observed_at || null,
  };
}

function searchableMeetingText(row) {
  const documents = Array.isArray(row.meeting_documents) ? row.meeting_documents : [];
  return [...new Set([
    row.search_text,
    row.title,
    row.description,
    row.type_of_notice_description,
    row.section_name,
    row.additional_description_1,
    row.additional_description_2,
    row.additional_description_3,
    row.other_info_1,
    row.other_info_2,
    row.other_info_3,
    row.street_address_1,
    row.street_address_2,
    row.building_name,
    row.city,
    row.state,
    row.zip_code,
    row.contact_name,
    row.contact_phone,
    row.email,
    row.committee?.name,
    row.board_name,
    row.agency,
    row.venue?.name,
    row.venue?.address,
    row.affected_area?.boroughs?.join(" "),
    row.affected_area?.community_districts?.join(" "),
    row.affected_area?.council_districts?.join(" "),
    ...documents.filter((document) => document?.attachment_status === "attached").map((document) => document.title),
  ].filter(Boolean).map((value) => String(value).replace(/\s+/g, " ").trim()).filter(Boolean))].join(" ").slice(0, 6_000) || null;
}

function materializeMeetingDetails(row, checkedAt) {
  const minutesFreshness = meetingMinutesProjection(row, checkedAt);
  return {
    ...row,
    minutes_freshness: minutesFreshness,
    search_text: searchableMeetingText(row),
  };
}

/**
 * Normalize and combine both meeting producers into one bounded read model.
 * `communityBoardIndex` is deliberately optional: absence becomes an
 * explicit unavailable source state and never causes a broad fallback query.
 */
export function buildSharedMeetingReadModel({
  cityRecordRows = [],
  communityBoardIndex = null,
  generatedAt = null,
  now = generatedAt || new Date().toISOString(),
  communityBoardMaxAgeMs = COMMUNITY_BOARD_MAX_AGE_MS,
} = {}) {
  const cityRows = dedupeRows(asRows(cityRecordRows).map((row) => normalizeRecord(row, "city_record", generatedAt || now)));
  const boardRows = dedupeRows(asRows(communityBoardIndex?.rows)
    .filter((row) => row.source_system === "community_board" || !row.source_system)
    .map((row) => normalizeRecord(row, "community_board", communityBoardIndex?.generated_at || generatedAt || now)));
  const boardGeneratedAt = communityBoardIndex?.generated_at || null;
  const boardStatus = sourceEnvelope({
    source: "community_board",
    generatedAt: boardGeneratedAt,
    now,
    maxAgeMs: communityBoardMaxAgeMs,
    rows: boardRows,
    index: communityBoardIndex,
  });
  const cityStatus = sourceEnvelope({
    source: "city_record",
    generatedAt,
    now,
    maxAgeMs: null,
    rows: cityRows,
    index: null,
  });
  const suppliedDocuments = [
    ...cityRows.flatMap((row) => row.meeting_documents || []),
    ...(Array.isArray(communityBoardIndex?.meeting_documents)
      ? communityBoardIndex.meeting_documents
      : boardRows.flatMap((row) => row.meeting_documents || [])),
  ];
  const documentJoin = attachMeetingDocuments([...cityRows, ...boardRows], suppliedDocuments, { asOf: now });
  const rows = documentJoin.meetings.map((row) => materializeMeetingDetails(row, now)).sort(dateSort);
  const generated = generatedAt || boardGeneratedAt || null;
  return {
    schema: SHARED_MEETING_READ_MODEL_SCHEMA,
    version: SHARED_MEETING_READ_MODEL_VERSION,
    generated_at: generated,
    freshness: {
      generated_at: generated,
      checked_at: now,
      sources: {
        city_record: cityStatus.status,
        community_board: boardStatus.status,
      },
    },
    sources: {
      city_record: cityStatus,
      community_board: boardStatus,
    },
    counts: {
      total: rows.length,
      city_record: cityRows.length,
      community_board: boardRows.length,
      meeting_documents: documentJoin.documents.length,
      attached_meeting_documents: documentJoin.attached_documents.length,
    },
    rows,
    // `hearings` keeps the existing Worker/feed payload vocabulary while the
    // canonical rows and source envelope remain the shared contract.
    hearings: rows,
  };
}

export function meetingReadModelRows(value) {
  return asRows(value?.rows || value?.hearings);
}

export function meetingReadModelSourceStatus(value, source = "community_board") {
  return value?.sources?.[source]?.status || "unavailable";
}

export function isMeetingReadModelFresh(value, source = "community_board") {
  return meetingReadModelSourceStatus(value, source) === "available";
}

export { CITY_RECORD_SOURCE_URL };
