/**
 * Shared first-class meeting object contract.
 *
 * City Record, community-board, and NYC Council Legistar Events publishers have
 * different source keys. The source-qualified meeting id is deliberately not a
 * dedupe key: an exact publisher join may relate two objects later, but
 * title/date similarity never creates one.
 */

import { resolveMeetingFamily } from "./meeting_process_profile.mjs";

export const MEETING_OBJECT_SCHEMA = "cityscroll.meeting_object.v1";

export const MEETING_SOURCE_SYSTEMS = Object.freeze([
  "city_record",
  "community_board",
  "nyc_legistar_events",
]);

export const MEETING_JOIN_STATUSES = Object.freeze([
  "not_applicable",
  "unknown",
  "matched",
  "held",
  "ambiguous",
]);

const SOURCE_KEY_TYPES = Object.freeze({
  city_record: "request_id",
  community_board: "publisher_event_id",
  nyc_legistar_events: "event_id",
});

function requiredText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  return text;
}

function optionalText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function sourceSystem(value) {
  const normalized = requiredText(value, "source_system").toLowerCase();
  if (!MEETING_SOURCE_SYSTEMS.includes(normalized)) {
    throw new TypeError(`unsupported meeting source system: ${normalized}`);
  }
  return normalized;
}

function sourceKey(source, sourceId) {
  return {
    source_system: source,
    key_type: SOURCE_KEY_TYPES[source],
    value: requiredText(sourceId, SOURCE_KEY_TYPES[source]),
  };
}

function sourceReceipt(row) {
  return row.source_receipt
    || row.observed_receipt
    || row.source_provenance?.observed_receipt
    || null;
}

function joinStatus(row, source) {
  const value = optionalText(row.join_status || row.meeting_join?.status)
    || (source === "city_record" ? "not_applicable" : "unknown");
  if (!MEETING_JOIN_STATUSES.includes(value)) {
    throw new TypeError(`unsupported meeting join status: ${value}`);
  }
  return value;
}

function publisherIdFor(source, row) {
  if (source === "city_record") return row.request_id;
  if (source === "nyc_legistar_events") {
    return row.event_id
      || row.EventId
      || row.identity?.event_id
      || row.source_record_id
      || row.record_id;
  }
  return row.source_record_id || row.record_id;
}

function publisherCrossReferences(row) {
  if (Array.isArray(row.publisher_cross_references) && row.publisher_cross_references.length) {
    return row.publisher_cross_references;
  }
  const insite = row.insite_calendar;
  if (!insite || typeof insite !== "object") return null;
  const meetingId = optionalText(insite.meeting_id);
  const meetingGuid = optionalText(insite.meeting_guid);
  const url = safeHttps(insite.url);
  if (!meetingId && !meetingGuid && !url) return null;
  return [{
    kind: "insite_calendar",
    meeting_id: meetingId,
    meeting_guid: meetingGuid,
    url,
    note: optionalText(insite.note)
      || "Measured public InSite calendar identity; the Events feed EventId remains the publisher key.",
  }];
}

function institutionRefs(row, source) {
  const refs = row.institution_refs && typeof row.institution_refs === "object"
    ? row.institution_refs : {};
  const agencyRef = optionalText(refs.agency_ref || row.agency_ref);
  const boardId = optionalText(refs.board_id || row.board_id);
  const boardRef = optionalText(refs.board_ref)
    || (boardId ? `community-board:${boardId}` : null);
  return {
    agency_ref: source === "community_board" ? null : agencyRef,
    board_ref: boardRef,
  };
}

function sourceUrl(row) {
  return optionalText(row.source_url || row.record_url || row.source?.url);
}

function safeHttps(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeCommittee(value) {
  if (typeof value === "string") return optionalText(value) ? { name: optionalText(value), href: null } : null;
  if (!value || typeof value !== "object") return null;
  const name = optionalText(value.name || value.title || value.label);
  if (!name) return null;
  return { name, href: safeHttps(value.href || value.url) };
}

function normalizeParticipation(value) {
  if (!value || typeof value !== "object") return null;
  const links = (Array.isArray(value.links) ? value.links : [])
    .map((link) => ({
      label: optionalText(link?.label) || "Participation link",
      url: safeHttps(link?.url || link?.href),
    }))
    .filter((link) => link.url)
    .slice(0, 4);
  return {
    links,
    remote_join_url: safeHttps(value.remote_join_url || value.join_url),
    emails: [...new Set((Array.isArray(value.emails) ? value.emails : []).map(optionalText).filter(Boolean))].slice(0, 4),
    phones: [...new Set((Array.isArray(value.phones) ? value.phones : []).map(optionalText).filter(Boolean))].slice(0, 4),
    source_url: safeHttps(value.source_url),
  };
}

function searchableText(row, fields = {}) {
  return optionalText(row.search_text || [
    fields.title,
    fields.committee?.name || fields.committee,
    fields.description,
    fields.address,
    fields.venue_name,
    row.board_name,
    row.agency_name || row.agency,
  ].filter(Boolean).join(" "))?.slice(0, 6_000) || null;
}

const CITY_RECORD_NOTICE_FIELDS = Object.freeze([
  "type_of_notice_description", "section_name",
  "additional_description_1", "additional_description_2", "additional_description_3",
  "other_info_1", "other_info_2", "other_info_3",
  "street_address_1", "street_address_2", "building_name", "city", "state", "zip_code",
  "contact_name", "contact_phone", "email", "address_to_request",
  "category_description", "selection_method_description", "source_links", "document_links",
]);

function retainedNoticeFields(row) {
  return Object.fromEntries(CITY_RECORD_NOTICE_FIELDS
    .filter((field) => Object.hasOwn(row, field))
    .map((field) => [field, row[field]]));
}

/**
 * Return the stable id for one publisher's source key.
 *
 * The exact key is retained separately in source_keys, so ids remain
 * inspectable even when a source identifier contains URL-significant text.
 */
export function meetingIdForSource(sourceSystemValue, sourceId) {
  const source = sourceSystem(sourceSystemValue);
  return `meeting:${source}:${requiredText(sourceId, SOURCE_KEY_TYPES[source])}`;
}

/**
 * Normalize either producer into the shared meeting object shape.
 */
export function normalizeMeetingObject(row = {}) {
  const source = sourceSystem(row.source_system);
  const sourceId = row.publisher_identifier
    || row.source_id
    || publisherIdFor(source, row);
  const key = optionalText(sourceId) ? sourceKey(source, sourceId) : null;
  const meetingId = key ? meetingIdForSource(source, key.value) : null;
  const sourceHref = sourceUrl(row);
  const requestId = source === "city_record" ? key?.value || null : null;
  const boardId = optionalText(row.board_id);
  const venue = row.venue && typeof row.venue === "object" ? row.venue : null;
  const fields = {
    title: row.title || row.short_title,
    committee: row.committee,
    description: row.description || row.source_body,
    address: venue?.address || row.address,
    venue_name: venue?.name || row.venue_name,
  };
  const meetingFamily = resolveMeetingFamily(row);

  return {
    ...retainedNoticeFields(row),
    object_type: "meeting",
    schema: MEETING_OBJECT_SCHEMA,
    meeting_id: meetingId,
    source_keys: key ? [key] : [],
    publisher_identifier: key?.value || null,
    title: optionalText(row.title || row.short_title) || "Meeting",
    event_date: optionalText(row.event_date || row.date),
    event_end: optionalText(row.event_end || row.end_at),
    meeting_family: meetingFamily,
    venue,
    participation: normalizeParticipation(row.participation),
    committee: normalizeCommittee(row.committee),
    agency: optionalText(row.agency_name || row.agency),
    board_name: optionalText(row.board_name),
    description: optionalText(row.description || row.source_body),
    search_text: searchableText(row, fields),
    affected_area: row.affected_area || null,
    meeting_documents: Array.isArray(row.meeting_documents) ? row.meeting_documents : [],
    source_url: sourceHref,
    source_system: source,
    meeting_origin: optionalText(row.meeting_origin) || "unknown",
    source_receipt: sourceReceipt(row),
    join_status: joinStatus(row, source),
    institution_refs: institutionRefs(row, source),
    compatibility: {
      legacy_notice_href: requestId ? `/notices/${encodeURIComponent(requestId)}` : null,
      legacy_fragment_href: requestId ? `#notice/${encodeURIComponent(requestId)}` : null,
      publisher_href: sourceHref,
    },
    // These aliases keep the existing hearing lens readable while migration
    // to meeting_id proceeds. They are not identity fields.
    request_id: requestId,
    source_record_id: source === "community_board" || source === "nyc_legistar_events"
      ? optionalText(row.source_record_id || row.record_id || key?.value) : null,
    board_id: boardId,
    ...(source === "nyc_legistar_events" ? { event_id: key?.value || null } : {}),
    ...(source === "nyc_legistar_events"
      ? { publisher_cross_references: publisherCrossReferences(row) }
      : {}),
    ...(row.same_proceeding && typeof row.same_proceeding === "object"
      ? { same_proceeding: row.same_proceeding }
      : {}),
    ...(optionalText(row.collection_visibility)
      ? { collection_visibility: optionalText(row.collection_visibility) }
      : {}),
  };
}

export function normalizeCityRecordMeeting(row = {}) {
  return normalizeMeetingObject({
    ...row,
    source_system: "city_record",
    publisher_identifier: row.publisher_identifier || row.request_id,
    source_url: row.source_url || (row.request_id
      ? `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(row.request_id)}`
      : null),
  });
}

export function normalizeCommunityBoardMeeting(row = {}) {
  return normalizeMeetingObject({
    ...row,
    source_system: "community_board",
    publisher_identifier: row.publisher_identifier || row.source_record_id || row.record_id,
    source_url: row.source_url || row.record_url,
  });
}

function legistarPublisherDate(row) {
  const explicit = optionalText(row.event_date || row.wall_time);
  if (explicit) return explicit;
  const day = String(row.EventDate || row.date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const timeValue = optionalText(row.EventTime);
  if (!timeValue) return day;
  const clock = timeValue.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!clock) return day;
  let hour = Number(clock[1]);
  const suffix = String(clock[4] || "").toUpperCase();
  if (suffix === "AM" && hour === 12) hour = 0;
  if (suffix === "PM" && hour < 12) hour += 12;
  if (hour > 23) return day;
  return `${day}T${String(hour).padStart(2, "0")}:${clock[2]}:${clock[3] || "00"}`;
}

function legistarTitle(row) {
  return optionalText(row.title)
    || optionalText(row.EventBodyName)
    || optionalText(row.governing_body?.name)
    || optionalText(row.committee?.name)
    || "Meeting";
}

/**
 * Normalize one NYC Council Legistar Events record into the shared meeting
 * object. The publisher key is the authenticated Events feed EventId, never a
 * public InSite calendar meeting number recorded as a cross-reference.
 */
export function normalizeNycLegistarEventsMeeting(row = {}) {
  const eventId = row.publisher_identifier
    || row.event_id
    || row.EventId
    || row.identity?.event_id
    || row.source_id
    || row.source_record_id
    || row.record_id;
  const sourceUrl = row.source_url
    || row.url
    || row.EventInSiteURL
    || (optionalText(eventId)
      ? `https://nyc.legistar.com/MeetingDetail.aspx?LEGID=${encodeURIComponent(String(eventId).trim())}`
      : null);
  const venue = row.venue && typeof row.venue === "object"
    ? row.venue
    : (optionalText(row.EventLocation) ? { address: optionalText(row.EventLocation) } : null);
  const committee = row.committee
    || row.governing_body
    || (optionalText(row.EventBodyName) ? { name: optionalText(row.EventBodyName) } : null);
  return normalizeMeetingObject({
    ...row,
    source_system: "nyc_legistar_events",
    publisher_identifier: eventId,
    source_url: sourceUrl,
    title: legistarTitle(row),
    event_date: legistarPublisherDate(row),
    venue,
    committee,
    description: row.description || row.agenda?.search_text || row.EventComment,
    meeting_origin: row.meeting_origin || "nyc_legistar_events_observed",
  });
}

export function meetingCanonicalHref(recordOrId) {
  const id = typeof recordOrId === "object" ? recordOrId?.meeting_id : recordOrId;
  return id ? `/meetings/${encodeURIComponent(String(id))}` : null;
}

export function meetingRouteLinks(record) {
  const normalized = record?.meeting_id ? record : normalizeMeetingObject(record);
  return {
    canonical_href: meetingCanonicalHref(normalized),
    legacy_notice_href: normalized.compatibility?.legacy_notice_href || null,
    legacy_fragment_href: normalized.compatibility?.legacy_fragment_href || null,
    publisher_href: normalized.source_url || normalized.compatibility?.publisher_href || null,
  };
}

function routeParts(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw, "https://cityscroll.org"); } catch { return null; }
  const fragment = url.hash.replace(/^#/, "");
  const fragmentNotice = fragment.match(/^notice\/([^/?#]+)$/);
  const notice = url.pathname.match(/^\/notices\/([^/?#]+)\/?$/);
  const meeting = url.pathname.match(/^\/meetings\/([^/?#]+)\/?$/);
  return {
    source: raw,
    meetingId: meeting ? decodeURIComponent(meeting[1]) : null,
    noticeId: notice?.[1] || (fragmentNotice ? decodeURIComponent(fragmentNotice[1]) : null),
  };
}

function sourceMatches(record, value) {
  const candidate = String(value || "").trim();
  if (!candidate) return false;
  return [record.source_url, record.record_url, record.compatibility?.publisher_href]
    .filter(Boolean).some((url) => String(url) === candidate);
}

/**
 * Resolve canonical and legacy/provenance routes against a bounded meeting
 * catalog. Unknown routes remain unknown; no title/date fallback is allowed.
 */
export function resolveMeetingRoute(value, records = []) {
  const parts = routeParts(value);
  if (!parts) return null;
  const catalog = Array.isArray(records) ? records : [];
  let record = parts.meetingId
    ? catalog.find((item) => item?.meeting_id === parts.meetingId)
    : null;
  if (!record && parts.noticeId) {
    record = catalog.find((item) => item?.request_id === parts.noticeId
      || item?.source_keys?.some((key) => key.key_type === "request_id" && key.value === parts.noticeId));
  }
  if (!record && !parts.noticeId) {
    record = catalog.find((item) => sourceMatches(item, parts.source)) || null;
  }
  if (!record) return null;
  const links = meetingRouteLinks(record);
  return {
    route_kind: parts.noticeId
      ? "legacy"
      : (parts.meetingId === record.meeting_id ? "canonical" : "publisher"),
    meeting_id: record.meeting_id,
    canonical_href: links.canonical_href,
    compatibility_href: parts.source,
    source_url: links.publisher_href,
  };
}
