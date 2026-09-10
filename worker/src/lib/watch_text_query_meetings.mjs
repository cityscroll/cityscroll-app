/**
 * General-meeting adapter for precise-watch evaluation.
 *
 * Scope predicates (board, geography, agency, upcoming-event window) still
 * compile first. The shared v1 predicate then narrows already-scoped rows
 * using title and retained body as separate fields. Exact Council-matter
 * watches never enter this path. No publisher fetch.
 */

import meetingNoticeMaterialization from "../../../site/data/meeting_notice_materialization.json" with { type: "json" };
import {
  MEETING_BODY_STATUS,
  PROCUREMENT_TEXT_QUERY_EVAL,
  TEXT_QUERY_EVAL_STATUS,
  collectExcludedMeetingRecords,
  evaluateMeetingRecords,
  meetingBodyStatus,
  meetingRecordIdentity,
  projectMeetingNoticeFields,
} from "../../../site/watch_text_query_eval.mjs";
import { textQueryEvaluationSupported } from "../../../site/watch_text_query.mjs";
import { compileSub, rowsForCompiledQuery, scopedMeetingWatchRows } from "./compile.mjs";

export const PRECISE_MEETING_ADAPTER = Object.freeze({
  notices: "meeting-notice-materialization",
  route: "meeting-route-read-model",
  unavailable: "unavailable",
});

const NOTICE_BY_ID = new Map(
  (Array.isArray(meetingNoticeMaterialization?.rows) ? meetingNoticeMaterialization.rows : [])
    .map((row) => [String(row.request_id), row]),
);

export function cityRecordNoticeId(row = {}) {
  const direct = String(row.notice_id || "").trim();
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(direct) && !direct.includes(":")) return direct;
  for (const candidate of [row.request_id, row.meeting_id, row.id]) {
    const value = String(candidate || "");
    const fromMeeting = value.match(/^meeting:city_record:([A-Za-z0-9][A-Za-z0-9_-]{0,80})$/);
    if (fromMeeting) return fromMeeting[1];
    if (/^[0-9]{8,14}$/.test(value)) return value;
  }
  return null;
}

export function meetingRowsFromNoticeMaterialization(notices = meetingNoticeMaterialization.rows) {
  return (Array.isArray(notices) ? notices : []).map((notice) => ({
    meeting_id: `meeting:city_record:${notice.request_id}`,
    request_id: notice.request_id,
    notice_id: notice.request_id,
    source_system: "city_record",
    meeting_origin: "city_record_notice",
    title: notice.short_title,
    short_title: notice.short_title,
    agency: notice.agency_name,
    agency_name: notice.agency_name,
    event_date: notice.event_date,
    start_date: notice.start_date,
    additional_description_1: notice.additional_description_1 ?? null,
    street_address_1: notice.street_address_1 || null,
    street_address_2: notice.street_address_2 || null,
    city: notice.city || null,
    state: notice.state || null,
    zip_code: notice.zip_code || null,
    source_url: `https://a856-cityrecord.nyc.gov/RequestDetail/${notice.request_id}`,
    source_links: Array.isArray(notice.source_links) ? [...notice.source_links] : [],
    type_of_notice_description: notice.type_of_notice_description,
    section_name: notice.section_name,
  }));
}

function unavailable(reason, clock, extra = {}) {
  return {
    status: TEXT_QUERY_EVAL_STATUS.unavailable,
    reason,
    adapter: PRECISE_MEETING_ADAPTER.unavailable,
    retrieval: "none",
    rows: [],
    scanned: 0,
    continuation: null,
    markSeenIds: [],
    clock,
    excludedRows: [],
    publisher_fetch: false,
    fields: projectMeetingNoticeFields({}),
    ...extra,
  };
}

export function attachMeetingNoticeBody(row, noticesById = NOTICE_BY_ID) {
  if (!row || typeof row !== "object") return row;
  const eventDate = row.event_date;
  const location = {
    street_address_1: row.street_address_1,
    street_address_2: row.street_address_2,
    city: row.city,
    state: row.state,
    zip_code: row.zip_code,
    venue: row.venue,
  };
  const identity = {
    meeting_id: row.meeting_id,
    request_id: row.request_id,
    source_url: row.source_url,
    source_links: row.source_links,
  };
  if (meetingBodyStatus(row) === MEETING_BODY_STATUS.failed) {
    return { ...row, ...identity, event_date: eventDate, ...location, body_status: MEETING_BODY_STATUS.failed };
  }
  if (row.additional_description_1 != null || row.description != null || row.body != null) {
    return { ...row, ...identity, event_date: eventDate, body_status: meetingBodyStatus(row) };
  }
  const noticeId = cityRecordNoticeId(row);
  const notice = noticeId ? noticesById.get(noticeId) : null;
  if (notice?.additional_description_1 != null) {
    return {
      ...row,
      ...identity,
      event_date: eventDate || notice.event_date,
      additional_description_1: notice.additional_description_1,
      short_title: row.short_title || row.title || notice.short_title,
      title: row.title || row.short_title || notice.short_title,
      source_links: row.source_links || notice.source_links || [],
      body_status: MEETING_BODY_STATUS.present,
    };
  }
  return { ...row, ...identity, event_date: eventDate, body_status: MEETING_BODY_STATUS.missing };
}

export async function evaluateMeetingTextQueryWatch({
  env = {},
  sub,
  todayISO,
  limit = PROCUREMENT_TEXT_QUERY_EVAL.resultLimit,
  scanBudget = PROCUREMENT_TEXT_QUERY_EVAL.scanBudget,
  cursor = null,
  clock = null,
  sourceRows = null,
  fetchImpl = null,
} = {}) {
  void fetchImpl;
  const expression = sub?.filter?.text_query;
  if (expression == null) return unavailable("missing_expression", clock);
  if (sub?.filter?.matter_ref) return unavailable("exact_identity", clock);
  if (!textQueryEvaluationSupported(sub?.lens) || sub?.lens !== "meetings") {
    return unavailable("unsupported_lens", clock);
  }

  let scoped;
  try {
    if (Array.isArray(sourceRows)) {
      scoped = scopedMeetingWatchRows(sub.filter, todayISO, sourceRows);
    } else {
      const compiled = compileSub(sub, todayISO);
      if (!compiled) return unavailable("uncompilable_scope", clock);
      scoped = await rowsForCompiledQuery(compiled, env);
      if (compiled.postFilter) scoped = scoped.filter(compiled.postFilter);
    }
  } catch (error) {
    return unavailable("missing_materialization", clock, { error: String(error?.message || error) });
  }

  if (!Array.isArray(scoped)) return unavailable("missing_materialization", clock);

  const projected = scoped.map((row) => attachMeetingNoticeBody(row));
  const evaluated = evaluateMeetingRecords(projected, {
    expression,
    limit,
    scanBudget,
    cursor,
    clock,
  });
  const excluded = collectExcludedMeetingRecords(projected, {
    expression,
    limit: 8,
    scanBudget: projected.length,
  });
  return {
    ...evaluated,
    adapter: Array.isArray(sourceRows) ? PRECISE_MEETING_ADAPTER.notices : PRECISE_MEETING_ADAPTER.route,
    retrieval: Array.isArray(sourceRows) ? "meeting-notice-materialization" : "meeting-route-read-model",
    excludedRows: excluded.rows,
    publisher_fetch: false,
    soda: false,
    fts: false,
    fields: projectMeetingNoticeFields({}),
    markSeenIds: (evaluated.rows || []).map(meetingRecordIdentity).filter(Boolean),
  };
}

export { PROCUREMENT_TEXT_QUERY_EVAL, TEXT_QUERY_EVAL_STATUS };
