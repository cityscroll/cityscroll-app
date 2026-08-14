/**
 * Exact join contract for a City Record board meeting and a native board
 * source record. A candidate is either official under every gate or remains
 * an explicit unknown; there is no title/address fallback.
 */

import { sourceRecordStatus } from "./community_board_source_adapters.mjs";
import { meetingCanonicalHref, normalizeCityRecordMeeting } from "./meeting_object_contract.mjs";
import { communityBoardPageHref } from "./community_board_links.mjs";

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

export const COMMUNITY_BOARD_HOSTS_MEETING_EDGE_SCHEMA = "cityscroll.community_board_hosts_meeting_edge.v1";
const COMMUNITY_BOARD_HOSTS_MEETING_CONTRACT = Object.freeze({
  schema: "cityscroll.community_board_hosts_meeting_source_contract.v1",
  edge_schema: COMMUNITY_BOARD_HOSTS_MEETING_EDGE_SCHEMA,
  relation: "hosts_meeting",
  inverse_relation: "hosted_by_community_board",
  required_evidence: Object.freeze([
    "exact_board_identity",
    "exact_publisher_identifier",
    "exact_meeting_date",
    "retained_source_url",
    "observed_receipt",
    "verified_source_join",
  ]),
});

function meetingTarget(meeting = {}, join = {}) {
  if (join.meeting_id) return String(join.meeting_id).trim() || null;
  if (meeting.meeting_id) return String(meeting.meeting_id).trim() || null;
  if (meeting.source_system === "city_record" || meeting.request_id) {
    return normalizeCityRecordMeeting(meeting).meeting_id;
  }
  if (meeting.source_system === "community_board" && (meeting.publisher_identifier || meeting.source_record_id || meeting.record_id)) {
    return `meeting:community_board:${meeting.publisher_identifier || meeting.source_record_id || meeting.record_id}`;
  }
  return null;
}

function meetingTargetName(meeting = {}, join = {}) {
  return String(meeting.title || meeting.short_title || join.title || "Community board meeting").trim() || "Community board meeting";
}

function observationParts(observation = {}) {
  const directJoin = observation?.schema === COMMUNITY_BOARD_SOURCE_JOIN_SCHEMA
    || (observation?.join?.method === COMMUNITY_BOARD_SOURCE_JOIN_METHOD && observation?.status);
  return {
    meeting: observation.meeting || observation.notice || observation.target || (directJoin ? {} : observation),
    record: observation.source_record || observation.record || observation.board_record || (directJoin ? {} : observation),
    join: directJoin ? observation : observation.join,
  };
}

function receiptFor(record = {}, join = {}) {
  return join.provenance?.observed_receipt
    || join.observed_receipt
    || record.observed_receipt
    || null;
}

function sourceUrlFor(record = {}, join = {}) {
  return join.source_url || join.provenance?.source_url || record.source_url || record.record_url || null;
}

function acceptedJoin(join = {}, record = {}) {
  const receipt = receiptFor(record, join);
  const evidence = new Set(join.join?.evidence || []);
  return join.official === true
    && join.status === "official"
    && join.join?.matched === true
    && evidence.has("exact_board_identity")
    && evidence.has("exact_date")
    && evidence.has("publisher_identifier")
    && Boolean(sourceUrlFor(record, join))
    && receipt?.status === "ok"
    && Boolean(receipt?.observed_at);
}

function edgeStatus(join, record) {
  return acceptedJoin(join, record) ? "promoted" : "held";
}

/**
 * Materialize the board institution relation without inventing a meeting
 * destination. The target is always a source-qualified meeting id; held
 * evidence may retain that id for diagnostics but never receives a link.
 */
export function promoteCommunityBoardHostsMeetingEdge(observation = {}, options = {}) {
  const { meeting, record } = observationParts(observation);
  const join = observationParts(observation).join
    || joinCommunityBoardSourceRecord(meeting, record, options);
  const boardId = String(join?.board_id || record?.board_id || record?.body_id || meeting?.board_id || "").trim().toLowerCase() || null;
  const targetId = meetingTarget(meeting, join || {});
  const targetHref = targetId ? meetingCanonicalHref(targetId) : null;
  const accepted = acceptedJoin(join || {}, record || {}) && Boolean(boardId && targetId && targetHref);
  const sourceUrl = sourceUrlFor(record || {}, join || {});
  const receipt = receiptFor(record || {}, join || {});
  const reason = accepted ? null
    : join?.reason
      || (!targetId ? "meeting_identity_missing" : !boardId ? "board_identity_missing" : "evidence_held");
  return {
    schema: COMMUNITY_BOARD_HOSTS_MEETING_EDGE_SCHEMA,
    contract: COMMUNITY_BOARD_HOSTS_MEETING_CONTRACT.schema,
    edge_type: "hosts_meeting",
    relation: "hosts_meeting",
    status: accepted ? "promoted" : "held",
    promoted: accepted,
    reason,
    from: boardId ? `community-board:${boardId}` : null,
    to: targetId || null,
    target_kind: "meeting",
    target_id: targetId,
    target_name: meetingTargetName(meeting, join || {}),
    canonical_href: accepted ? targetHref : null,
    href: accepted ? targetHref : null,
    board_href: boardId ? communityBoardPageHref(boardId) : null,
    source_url: sourceUrl,
    source_record_id: join?.source_record_id || record?.source_record_id || record?.record_id || null,
    source_receipt: receipt,
    provenance: join?.provenance || (sourceUrl || receipt ? {
      source_url: sourceUrl,
      source_record_id: join?.source_record_id || record?.source_record_id || record?.record_id || null,
      observed_receipt: receipt,
      join_method: COMMUNITY_BOARD_SOURCE_JOIN_METHOD,
    } : null),
    join: join?.join || null,
    evidence: accepted ? [...COMMUNITY_BOARD_HOSTS_MEETING_CONTRACT.required_evidence] : [],
  };
}

export function buildCommunityBoardMeetingEdge(join = {}, meeting = {}, options = {}) {
  return promoteCommunityBoardHostsMeetingEdge({ join, meeting, source_record: options.source_record || {} }, options);
}

export function materializeCommunityBoardMeetingEdge(observation = {}, options = {}) {
  return promoteCommunityBoardHostsMeetingEdge(observation, options);
}

export function buildCommunityBoardInstitutionEdges(observations = [], options = {}) {
  if (!Array.isArray(observations) && observations && typeof observations === "object") {
    if (Array.isArray(observations.observations)) return buildCommunityBoardInstitutionEdges(observations.observations, options);
    if (Array.isArray(observations.meetings)) {
      const records = observations.sourceRecords || observations.records || [];
      const recordRows = Array.isArray(records)
        ? records
        : Object.values(records).flatMap((value) => Array.isArray(value) ? value : []);
      return observations.meetings.flatMap((meeting) => {
        const board = meeting.board_id || meeting.body_id;
        const candidates = recordRows.filter((record) => !board || record.board_id === board || record.body_id === board);
        const join = joinCommunityBoardSourceRecords(meeting, candidates, options);
        return [promoteCommunityBoardHostsMeetingEdge({ meeting, source_record: candidates[0] || {}, join }, options)];
      });
    }
  }
  const rows = Array.isArray(observations) ? observations : [];
  return rows.map((observation) => promoteCommunityBoardHostsMeetingEdge(observation, options));
}

/** Return the explicitly materialized institution edge carried by a meeting row. */
export function communityBoardMeetingEdgeFromRow(row = {}) {
  const candidates = [
    row.institution_edge,
    row.community_board_edge,
    row.hosts_meeting_edge,
    row.hosts_meeting,
  ];
  const edge = candidates.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));
  if (edge) return edge;
  if (Array.isArray(row.institution_edges)) return row.institution_edges[0] || null;
  return null;
}

export function communityBoardMeetingEdgeAccepted(edge = {}) {
  return edge?.promoted === true || edge?.status === "promoted" || edge?.status === "official";
}

export const COMMUNITY_BOARD_HOSTS_MEETING_EDGE_CONTRACT = COMMUNITY_BOARD_HOSTS_MEETING_CONTRACT;

export const joinBoardMeetingSource = joinCommunityBoardSourceRecord;
export const joinBoardMeetingSources = joinCommunityBoardSourceRecords;
