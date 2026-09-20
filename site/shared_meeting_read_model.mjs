/**
 * The bounded meeting read model shared by static documents, the Worker, and
 * the Meetings explorer.
 *
 * Source records remain source-qualified objects. This module combines them
 * without using title/date similarity as identity and carries source
 * freshness alongside the rows so a missing or old board snapshot cannot look
 * like an empty, complete feed. Exact same-proceeding joins never overwrite a
 * publisher identity; collection visibility is a separate flag.
 */

import {
  normalizeCityRecordMeeting,
  normalizeCommunityBoardMeeting,
  normalizeNycLegistarEventsMeeting,
  normalizeBsaCalendarMeeting,
  normalizePdcCalendarMeeting,
  normalizeOathTrialCalendarMeeting,
} from "./meeting_object_contract.mjs";
import {
  buildPublicBodyCalendarCoverage,
  normalizePublicBodyCalendarMeeting,
} from "./public_body_calendar_contract.mjs";
import {
  attachMeetingDocuments,
  normalizeMeetingDocument,
} from "./meeting_document.mjs";
import {
  applySameProceedingJoins,
  collectionVisibilityOf,
  MEETING_COLLECTION_SUPPRESSED,
} from "./meeting_same_proceeding.mjs";

export const SHARED_MEETING_READ_MODEL_SCHEMA = "cityscroll.shared_meeting_read_model.v1";
export const MEETING_READ_MODEL_SCHEMA = SHARED_MEETING_READ_MODEL_SCHEMA;
export const SHARED_MEETING_READ_MODEL_VERSION = 1;
export const COMMUNITY_BOARD_MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const NYC_LEGISTAR_EVENTS_MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const PDC_CALENDAR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const BSA_CALENDAR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const OATH_TRIAL_CALENDAR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
  if (source === "community_board") return null;
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
  const timed = source !== "city_record" && source !== "public_body_calendar";
  const status = source === "public_body_calendar"
    ? (index?.status || publicBodyCalendarStatus(index?.coverage || index?.contracts))
    : index?.status || (timed
    ? (!index ? "unavailable" : freshnessStatus(generatedAt, now, maxAgeMs))
    : (rows.length ? "available" : "available"));
  return {
    source_system: source,
    status,
    available: status === "available" || status === "fresh" || status === "fresh-empty",
    generated_at: generatedAt || null,
    max_age_ms: timed ? maxAgeMs : null,
    row_count: rows.length,
    reason: reason || (!index && timed ? "snapshot_missing" : null),
    coverage: index?.coverage || null,
    contract_coverage: source === "public_body_calendar" ? (index?.coverage || index?.contracts || null) : null,
    // Per-board coverage travels with the envelope so a reader asking about one
    // board can be told whether that board's source was read, read and empty,
    // unreadable, or never published — rather than inferring any of those from
    // an empty result set.
    board_coverage: Array.isArray(index?.board_coverage) ? index.board_coverage : null,
  };
}

function publicBodyCalendarStatus(coverage) {
  const statuses = Array.isArray(coverage)
    ? coverage.map((entry) => entry?.status).filter(Boolean)
    : [];
  if (!statuses.length) return "unobserved";
  if (statuses.every((status) => status === "unobserved")) return "unobserved";
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "stale")) return "stale";
  if (statuses.some((status) => status === "fresh")) return "fresh";
  if (statuses.every((status) => status === "fresh-empty")) return "fresh-empty";
  return "available";
}

function meetingOutcomeFor(row, source, meetingOutcomes) {
  if (source !== "city_record" || !meetingOutcomes?.by_notice) return null;
  const requestId = text(row.request_id);
  const outcome = requestId ? meetingOutcomes.by_notice[requestId] : null;
  if (!outcome) return null;
  return {
    ...outcome,
    // `present` is emitted only after the strict join in
    // worker/src/lib/meeting_outcomes.mjs. Keep that method explicit at the
    // shared read boundary for downstream Action Path consumers.
    join: outcome.snapshot_state === "present"
      ? { matched: true, method: "exact_date_body_tokens" }
      : { matched: false, method: "exact_date_body_tokens" },
  };
}

function normalizeProducer(row, source) {
  if (source === "city_record") return normalizeCityRecordMeeting(row);
  if (source === "nyc_legistar_events") return normalizeNycLegistarEventsMeeting(row);
  if (source === "bsa_calendar") return normalizeBsaCalendarMeeting(row);
  if (source === "pdc_calendar") return normalizePdcCalendarMeeting(row);
  if (source === "oath_trial_calendar") return normalizeOathTrialCalendarMeeting(row);
  if (source === "public_body_calendar") return normalizePublicBodyCalendarMeeting(row);
  return normalizeCommunityBoardMeeting(row);
}

function normalizeRecord(row, source, observedAt, meetingOutcomes) {
  const normalized = normalizeProducer(row, source);
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
  const meetingOutcome = meetingOutcomeFor({ ...row, ...normalized }, source, meetingOutcomes);
  if (meetingOutcome) record.meeting_outcome = meetingOutcome;
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
 * Normalize and combine admitted meeting producers into one bounded read model.
 * `communityBoardIndex` is deliberately optional: absence becomes an
 * explicit unavailable source state and never causes a broad fallback query.
 * `nycLegistarEventsIndex` is the upcoming Council calendar snapshot. Callers
 * that omit it keep the prior two-source envelope; production snapshots pass
 * the materialized index (or null) so the source is present or unavailable.
 */
export function buildSharedMeetingReadModel({
  cityRecordRows = [],
  communityBoardIndex = null,
  nycLegistarEventsIndex = undefined,
  bsaCalendarIndex = undefined,
  pdcCalendarIndex = undefined,
  oathTrialCalendarIndex = undefined,
  publicBodyCalendarIndex = undefined,
  meetingOutcomes = null,
  generatedAt = null,
  now = generatedAt || new Date().toISOString(),
  communityBoardMaxAgeMs = COMMUNITY_BOARD_MAX_AGE_MS,
  nycLegistarEventsMaxAgeMs = NYC_LEGISTAR_EVENTS_MAX_AGE_MS,
} = {}) {
  const cityRows = dedupeRows(asRows(cityRecordRows).map((row) => normalizeRecord(row, "city_record", generatedAt || now, meetingOutcomes)));
  const boardRows = dedupeRows(asRows(communityBoardIndex?.rows)
    .filter((row) => row.source_system === "community_board" || !row.source_system)
    .map((row) => normalizeRecord(row, "community_board", communityBoardIndex?.generated_at || generatedAt || now)));
  const includeLegistar = nycLegistarEventsIndex !== undefined;
  const includeOath = oathTrialCalendarIndex !== undefined;
  const includePublicBody = publicBodyCalendarIndex !== undefined;
  const rawLegistarRows = includeLegistar
    ? dedupeRows(asRows(nycLegistarEventsIndex?.rows || nycLegistarEventsIndex?.meetings)
      .map((row) => normalizeRecord(row, "nyc_legistar_events", nycLegistarEventsIndex?.generated_at || generatedAt || now)))
    : [];
  const includeBsa = bsaCalendarIndex !== undefined;
  const bsaRows = includeBsa
    ? dedupeRows(asRows(bsaCalendarIndex?.rows || bsaCalendarIndex?.sessions)
      .map((row) => normalizeRecord(row, "bsa_calendar", bsaCalendarIndex?.generated_at || generatedAt || now)))
    : [];
  const includePdc = pdcCalendarIndex !== undefined;
  const pdcRows = includePdc
    ? dedupeRows(asRows(pdcCalendarIndex?.rows || pdcCalendarIndex?.records || pdcCalendarIndex?.sessions)
      .map((row) => normalizeRecord(row, "pdc_calendar", pdcCalendarIndex?.generated_at || generatedAt || now)))
    : [];
  const publicRows = includePublicBody
    ? dedupeRows(asRows(publicBodyCalendarIndex?.rows || publicBodyCalendarIndex?.meetings)
      .map((row) => normalizeRecord(row, "public_body_calendar", publicBodyCalendarIndex?.generated_at || generatedAt || now)))
    : [];
  const joined = includeLegistar
    ? applySameProceedingJoins(cityRows, rawLegistarRows)
    : { cityRows, legistarRows: rawLegistarRows, relations: [] };
  const joinedCityRows = joined.cityRows;
  const legistarRows = joined.legistarRows;
  const oathRows = includeOath
    ? dedupeRows(asRows(oathTrialCalendarIndex?.rows || oathTrialCalendarIndex?.records)
      .map((row) => normalizeRecord(row, "oath_trial_calendar", oathTrialCalendarIndex?.generated_at || generatedAt || now)))
    : [];
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
    rows: joinedCityRows,
    index: null,
  });
  const legistarGeneratedAt = includeLegistar ? (nycLegistarEventsIndex?.generated_at || null) : null;
  const legistarStatus = includeLegistar
    ? sourceEnvelope({
      source: "nyc_legistar_events",
      generatedAt: legistarGeneratedAt,
      now,
      maxAgeMs: nycLegistarEventsMaxAgeMs,
      rows: legistarRows,
      index: nycLegistarEventsIndex,
    })
    : null;
  const bsaStatus = includeBsa ? sourceEnvelope({
    source: "bsa_calendar",
    generatedAt: bsaCalendarIndex?.generated_at || null,
    now,
    maxAgeMs: BSA_CALENDAR_MAX_AGE_MS,
    rows: bsaRows,
    index: bsaCalendarIndex,
  }) : null;
  const pdcStatus = includePdc ? sourceEnvelope({
    source: "pdc_calendar",
    generatedAt: pdcCalendarIndex?.generated_at || null,
    now,
    maxAgeMs: PDC_CALENDAR_MAX_AGE_MS,
    rows: pdcRows,
    index: pdcCalendarIndex,
  }) : null;
  const oathStatus = includeOath ? sourceEnvelope({
    source: "oath_trial_calendar",
    generatedAt: oathTrialCalendarIndex?.generated_at || null,
    now,
    maxAgeMs: OATH_TRIAL_CALENDAR_MAX_AGE_MS,
    rows: oathRows,
    index: oathTrialCalendarIndex,
  }) : null;
  const publicCoverage = includePublicBody
    ? (publicBodyCalendarIndex?.coverage
      || buildPublicBodyCalendarCoverage({
        observations: publicBodyCalendarIndex?.observations || [],
        now,
      }).contracts)
    : null;
  const publicStatus = includePublicBody ? sourceEnvelope({
    source: "public_body_calendar",
    generatedAt: publicBodyCalendarIndex?.generated_at || null,
    now,
    maxAgeMs: null,
    rows: publicRows,
    index: { ...publicBodyCalendarIndex, coverage: publicCoverage },
  }) : null;
  const catalogRows = [...joinedCityRows, ...boardRows, ...legistarRows, ...bsaRows, ...pdcRows, ...oathRows, ...publicRows];
  const suppliedDocuments = [
    ...joinedCityRows.flatMap((row) => row.meeting_documents || []),
    ...(Array.isArray(communityBoardIndex?.meeting_documents)
      ? communityBoardIndex.meeting_documents
      : boardRows.flatMap((row) => row.meeting_documents || [])),
    ...legistarRows.flatMap((row) => row.meeting_documents || []),
    ...bsaRows.flatMap((row) => row.meeting_documents || []),
    ...pdcRows.flatMap((row) => row.meeting_documents || []),
    ...oathRows.flatMap((row) => row.meeting_documents || []),
    ...publicRows.flatMap((row) => row.meeting_documents || []),
  ];
  const documentJoin = attachMeetingDocuments(catalogRows, suppliedDocuments, { asOf: now });
  const rows = documentJoin.meetings.map((row) => materializeMeetingDetails(row, now)).sort(dateSort);
  const generated = generatedAt || boardGeneratedAt || legistarGeneratedAt || null;
  const freshnessSources = {
    city_record: cityStatus.status,
    community_board: boardStatus.status,
    ...(legistarStatus ? { nyc_legistar_events: legistarStatus.status } : {}),
    ...(bsaStatus ? { bsa_calendar: bsaStatus.status } : {}),
    ...(pdcStatus ? { pdc_calendar: pdcStatus.status } : {}),
    ...(oathStatus ? { oath_trial_calendar: oathStatus.status } : {}),
    ...(publicStatus ? { public_body_calendar: publicStatus.status } : {}),
  };
  const sources = {
    city_record: cityStatus,
    community_board: boardStatus,
    ...(legistarStatus ? { nyc_legistar_events: legistarStatus } : {}),
    ...(bsaStatus ? { bsa_calendar: bsaStatus } : {}),
    ...(pdcStatus ? { pdc_calendar: pdcStatus } : {}),
    ...(oathStatus ? { oath_trial_calendar: oathStatus } : {}),
    ...(publicStatus ? { public_body_calendar: publicStatus } : {}),
  };
  const counts = {
    total: rows.length,
    city_record: joinedCityRows.length,
    community_board: boardRows.length,
    ...(includeOath ? { oath_trial_calendar: oathRows.length } : {}),
    meeting_documents: documentJoin.documents.length,
    attached_meeting_documents: documentJoin.attached_documents.length,
    ...(includeBsa ? { bsa_calendar: bsaRows.length } : {}),
    ...(includePdc ? { pdc_calendar: pdcRows.length } : {}),
    ...(includePublicBody ? { public_body_calendar: publicRows.length } : {}),
    ...(includeLegistar ? {
      nyc_legistar_events: legistarRows.length,
      collection: rows.filter((row) => collectionVisibilityOf(row) !== MEETING_COLLECTION_SUPPRESSED).length,
      suppressed: rows.filter((row) => collectionVisibilityOf(row) === MEETING_COLLECTION_SUPPRESSED).length,
      same_proceeding: joined.relations.length,
    } : {}),
  };
  return {
    schema: SHARED_MEETING_READ_MODEL_SCHEMA,
    version: SHARED_MEETING_READ_MODEL_VERSION,
    generated_at: generated,
    freshness: {
      generated_at: generated,
      checked_at: now,
      sources: freshnessSources,
    },
    sources,
    counts,
    ...(includeLegistar ? { same_proceeding: joined.relations } : {}),
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

/**
 * Collection projection: one representative per exact same-proceeding join.
 * Every source-qualified meeting_id remains in `rows` for permalinks.
 */
export function meetingCollectionRows(value) {
  return meetingReadModelRows(value)
    .filter((row) => collectionVisibilityOf(row) !== MEETING_COLLECTION_SUPPRESSED);
}

export { CITY_RECORD_SOURCE_URL };
