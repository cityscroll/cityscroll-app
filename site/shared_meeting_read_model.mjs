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
  const leftDate = String(left.event_date || "");
  const rightDate = String(right.event_date || "");
  return rightDate.localeCompare(leftDate)
    || String(left.meeting_id || "").localeCompare(String(right.meeting_id || ""));
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
  const rows = [...cityRows, ...boardRows].sort(dateSort);
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
