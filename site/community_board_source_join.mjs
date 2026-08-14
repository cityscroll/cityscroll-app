/**
 * Exact join contract for a City Record board meeting and a native board
 * source record. A candidate is either official under every gate or remains
 * an explicit unknown; there is no title/address fallback.
 */

import { sourceRecordStatus } from "./community_board_source_adapters.mjs";

export const COMMUNITY_BOARD_SOURCE_JOIN_SCHEMA = "cityscroll.community_board_source_join.v1";
export const COMMUNITY_BOARD_SOURCE_JOIN_METHOD = "exact_board_date_publisher_identifier";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function date(value) {
  const match = clean(value, 80).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function values(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function identifiers(value = {}) {
  return [...new Set([
    ...values(value.publisher_identifier),
    ...values(value.publisher_event_id),
    ...values(value.event_id),
    ...values(value.document_id),
    ...values(value.video_id),
    ...values(value.publisher_matter_ids),
    ...values(value.matter_ids),
    ...values(value.matter_tokens),
  ].map((item) => clean(item, 240).toUpperCase()).filter(Boolean))];
}

function exactBodyId(value = {}) {
  return clean(value.board_id || value.body_id, 100) || null;
}

function bodyEvidenceMatches(value, bodyId) {
  if (!value?.body_evidence) return true;
  const evidence = value.body_evidence;
  const evidenceId = clean(evidence.board_id || evidence.body_id, 100);
  return Boolean(evidenceId && evidenceId === bodyId);
}

function unknown(notice, record, reason, extra = {}) {
  return {
    schema: COMMUNITY_BOARD_SOURCE_JOIN_SCHEMA,
    status: "unknown",
    official: false,
    reason,
    board_id: exactBodyId(notice) || exactBodyId(record),
    meeting_date: date(notice?.event_date || notice?.meeting_date || record?.date || record?.meeting_date),
    source_url: record?.source_url || null,
    source_record_id: record?.source_record_id || record?.record_id || null,
    record_kind: record?.record_kind || null,
    category: record?.category || null,
    join: { matched: false, method: COMMUNITY_BOARD_SOURCE_JOIN_METHOD, reason },
    provenance: record?.observed_receipt ? { observed_receipt: record.observed_receipt } : null,
    ...extra,
  };
}

function candidateReason(notice, record, options = {}) {
  const noticeBody = exactBodyId(notice);
  const recordBody = exactBodyId(record);
  if (!noticeBody || !recordBody) return "board_identity_missing";
  if (noticeBody !== recordBody) return "board_identity_mismatch";
  if (!bodyEvidenceMatches(notice, noticeBody) || !bodyEvidenceMatches(record, recordBody)) return "body_evidence_mismatch";
  const noticeDate = date(notice?.event_date || notice?.meeting_date);
  const recordDate = date(record?.date || record?.meeting_date || record?.start_at);
  if (!noticeDate || !recordDate) return "date_missing";
  if (noticeDate !== recordDate) return "date_mismatch";
  const status = sourceRecordStatus(record, options);
  if (status.state !== "observed") return status.reason;
  const left = identifiers(notice);
  const right = identifiers(record);
  if (!left.length || !right.length) return "publisher_identifier_missing";
  if (!left.some((item) => right.includes(item))) return "publisher_identifier_mismatch";
  return null;
}

export function joinCommunityBoardSourceRecord(notice = {}, record = {}, options = {}) {
  const reason = candidateReason(notice, record, options);
  if (reason) return unknown(notice, record, reason);
  const boardId = exactBodyId(notice);
  const meetingDate = date(notice.event_date || notice.meeting_date);
  const matched = identifiers(notice).find((item) => identifiers(record).includes(item));
  return {
    schema: COMMUNITY_BOARD_SOURCE_JOIN_SCHEMA,
    status: "official",
    official: true,
    reason: null,
    board_id: boardId,
    meeting_date: meetingDate,
    source_url: record.source_url || null,
    source_record_id: record.source_record_id || record.record_id || null,
    record_kind: record.record_kind || null,
    category: record.category || null,
    title: record.title || null,
    join: {
      matched: true,
      method: COMMUNITY_BOARD_SOURCE_JOIN_METHOD,
      board_id: boardId,
      event_date: meetingDate,
      publisher_identifier: matched,
      evidence: ["exact_board_identity", "exact_date", "publisher_identifier"],
    },
    provenance: {
      source_url: record.source_url || null,
      source_record_id: record.source_record_id || record.record_id || null,
      observed_receipt: record.observed_receipt || null,
      format: record.format || null,
    },
  };
}

export function joinCommunityBoardSourceRecords(notice = {}, records = [], options = {}) {
  const candidates = (Array.isArray(records) ? records : [])
    .filter((record) => exactBodyId(record) === exactBodyId(notice))
    .filter((record) => date(record?.date || record?.meeting_date || record?.start_at) === date(notice?.event_date || notice?.meeting_date));
  const results = candidates.map((record) => joinCommunityBoardSourceRecord(notice, record, options));
  const official = results.filter((result) => result.official);
  if (official.length === 1) return official[0];
  if (official.length > 1) return unknown(notice, null, "ambiguous_source_records", { candidates: official.map((row) => row.source_record_id).filter(Boolean) });
  if (results.length) return results[0];
  return unknown(notice, null, "source_record_missing");
}

export function buildCommunityBoardMeetingEdge(join = {}) {
  const accepted = join?.official === true && join?.status === "official";
  return {
    schema: "cityscroll.community_board_source_edge.v1",
    edge_type: "hosts_meeting",
    from: join.board_id ? `community-board:${join.board_id}` : null,
    to: join.source_record_id ? `board-record:${join.source_record_id}` : null,
    status: accepted ? "official" : "unknown",
    href: accepted ? join.source_url || null : null,
    target_name: join.title || "Board meeting record",
    provenance: join.provenance || null,
    join: join.join || null,
  };
}

export const joinBoardMeetingSource = joinCommunityBoardSourceRecord;
export const joinBoardMeetingSources = joinCommunityBoardSourceRecords;
