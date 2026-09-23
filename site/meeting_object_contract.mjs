/**
 * Shared first-class meeting object contract.
 *
 * City Record, community-board, and NYC Council Legistar Events publishers have
 * different source keys. The source-qualified meeting id is deliberately not a
 * dedupe key: an exact publisher join may relate two objects later, but
 * title/date similarity never creates one.
 */

import { resolveMeetingFamily } from "./meeting_process_profile.mjs";
import { projectMeetingSchedule } from "./meeting_temporal_evidence.mjs";
import {
  buildMeetingLocationAssertions,
  projectVenueFromAssertions,
} from "./meeting_location_assertions.mjs";

export const MEETING_OBJECT_SCHEMA = "cityscroll.meeting_object.v1";

export const MEETING_SOURCE_SYSTEMS = Object.freeze([
  "city_record",
  "community_board",
  "nyc_legistar_events",
  "pdc_calendar",
  "bsa_calendar",
  "oath_trial_calendar",
  "public_body_calendar",
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
  pdc_calendar: "pdc_event_id",
  bsa_calendar: "bsa_session_id",
  oath_trial_calendar: "oath_trial_session_id",
  public_body_calendar: "contract_scoped_publisher_event_id",
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

function sourceKey(source, sourceId, row = {}) {
  if (source === "public_body_calendar") {
    const contractId = requiredText(row.source_contract_id, "source_contract_id");
    const publisherIdentifier = requiredText(sourceId, "publisher identifier");
    return {
      source_system: source,
      key_type: SOURCE_KEY_TYPES[source],
      value: `${contractId}:${publisherIdentifier}`,
      source_contract_id: contractId,
      publisher_identifier: publisherIdentifier,
    };
  }
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
  if (source === "pdc_calendar") return row.pdc_event_id || row.event_id || row.source_record_id || row.record_id;
  if (source === "bsa_calendar") return row.bsa_session_id || row.session_id || row.source_record_id || row.record_id;
  if (source === "oath_trial_calendar") {
    return row.oath_trial_session_id || row.session_id || row.source_record_id || row.record_id;
  }
  if (source === "public_body_calendar") {
    return row.publisher_identifier || row.publisher_event_id || row.publisher_key || row.event_id
      || row.source_record_id || row.record_id;
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
  const result = {
    agency_ref: source === "community_board" ? null : agencyRef,
    board_ref: boardRef,
  };
  if (source === "public_body_calendar") result.institution_ref = optionalText(refs.institution_ref || row.institution_ref);
  return result;
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

const MEETING_ACTIVITIES = Object.freeze(["observe", "attend", "speak"]);
const SPEAKING_RIGHTS = Object.freeze(["allowed", "not_allowed", "requires_registration", "unknown"]);

function normalizeActivity(value, source) {
  const activity = optionalText(value)?.toLowerCase();
  if (activity && MEETING_ACTIVITIES.includes(activity)) return activity;
  return ["pdc_calendar", "oath_trial_calendar"].includes(source) ? "observe" : null;
}

function normalizeSpeakingRights(value) {
  const rights = optionalText(value)?.toLowerCase();
  return rights && SPEAKING_RIGHTS.includes(rights) ? rights : "unknown";
}

function normalizeAccessSteps(value) {
  if (!Array.isArray(value)) return [];
  return value.map((step) => {
    if (!step || typeof step !== "object") return null;
    const destination = optionalText(step.destination || step.url || step.href);
    const sourceUrl = safeHttps(step.source_url || step.evidence_url || step.url);
    if (!destination && !sourceUrl) return null;
    return {
      kind: optionalText(step.kind || step.type) || "observer_instructions",
      destination: destination || sourceUrl,
      required: step.required !== false,
      effort: optionalText(step.effort) || "open_details",
      source_url: sourceUrl,
    };
  }).filter(Boolean).slice(0, 8);
}

function normalizeObserverAccess(value) {
  if (!value || typeof value !== "object") return null;
  const watchUrl = safeHttps(value.watch_url || value.watchUrl);
  const remoteJoinUrl = safeHttps(value.remote_join_url || value.remoteJoinUrl || value.join_url);
  if (!watchUrl && !remoteJoinUrl) return null;
  return { watch_url: watchUrl, remote_join_url: remoteJoinUrl };
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
export function meetingIdForSource(sourceSystemValue, sourceId, publisherIdentifier = null) {
  const source = sourceSystem(sourceSystemValue);
  const value = source === "public_body_calendar" && publisherIdentifier != null
    ? `${requiredText(sourceId, "source_contract_id")}:${requiredText(publisherIdentifier, "publisher identifier")}`
    : requiredText(sourceId, SOURCE_KEY_TYPES[source]);
  return `meeting:${source}:${value}`;
}

/**
 * Normalize either producer into the shared meeting object shape.
 */
export function normalizeMeetingObject(row = {}) {
  const source = sourceSystem(row.source_system);
  const sourceId = row.publisher_identifier
    || row.source_id
    || publisherIdFor(source, row);
  const key = optionalText(sourceId) ? sourceKey(source, sourceId, row) : null;
  const meetingId = key ? meetingIdForSource(source, key.value) : null;
  const sourceHref = sourceUrl(row);
  const requestId = source === "city_record" ? key?.value || null : null;
  const boardId = optionalText(row.board_id);
  const incomingVenue = row.venue && typeof row.venue === "object" ? row.venue : null;
  const locationAssertions = Array.isArray(row.location_assertions) && row.location_assertions.length
    ? row.location_assertions
    : buildMeetingLocationAssertions({
      ...row,
      meeting_id: meetingId,
      venue: incomingVenue || (row.address || row.venue_name ? {
        name: row.venue_name || null,
        address: row.address || null,
        mode: row.mode || null,
        components: row.location_components || null,
      } : null),
      location_components: row.location_components || row.address_components || incomingVenue?.components || null,
      location_wrapper: row.location_wrapper || null,
    }, {
      meeting_id: meetingId,
      record_id: optionalText(row.record_id || row.source_record_id),
      source_field: row.location_wrapper ? "LOCATION" : (row.location_components ? "location.address" : null),
      incidental_addresses: row.incidental_location_addresses || [],
    });
  const venue = projectVenueFromAssertions(locationAssertions, incomingVenue);
  const fields = {
    title: row.title || row.short_title,
    committee: row.committee,
    description: row.description || row.source_body,
    address: venue?.address || row.address,
    venue_name: venue?.name || row.venue_name,
  };
  const meetingFamily = resolveMeetingFamily(row);
  const schedule = projectMeetingSchedule({
    ...row,
    source_url: sourceHref || row.source_url,
    source_receipt: sourceReceipt(row),
    source_system: source,
  });

  return {
    ...retainedNoticeFields(row),
    object_type: "meeting",
    schema: MEETING_OBJECT_SCHEMA,
    meeting_id: meetingId,
    source_keys: key ? [key] : [],
    publisher_identifier: source === "public_body_calendar"
      ? optionalText(sourceId)
      : source === "community_board"
      && row.meeting_origin === "official_community_board_calendar"
      ? optionalText(row.publisher_identifier)
      : (key?.value || null),
    title: optionalText(row.title || row.short_title) || "Meeting",
    event_date: optionalText(row.event_date || row.date),
    event_end: optionalText(row.event_end || row.end_at),
    schedule,
    meeting_family: meetingFamily,
    activity: normalizeActivity(row.activity, source),
    attendance_mode: optionalText(row.attendance_mode),
    speaking_rights: normalizeSpeakingRights(row.speaking_rights),
    observer_access: normalizeObserverAccess(row.observer_access),
    access_steps: normalizeAccessSteps(row.access_steps || row.observer_access?.steps),
    venue,
    location_assertions: locationAssertions,
    participation: normalizeParticipation(row.participation),
    committee: normalizeCommittee(row.committee),
    agency: optionalText(row.agency_name || row.agency),
    board_name: optionalText(row.board_name),
    description: optionalText(row.description || row.source_body),
    search_text: searchableText(row, fields),
    affected_area: row.affected_area || null,
    ...(source === "bsa_calendar" && Array.isArray(row.agenda_items) ? { agenda_items: row.agenda_items } : {}),
    ...(source === "bsa_calendar" && Array.isArray(row.phases) ? { phases: row.phases } : {}),
    ...(source === "bsa_calendar" && row.schedule_relation ? { schedule_relation: row.schedule_relation } : {}),
    ...(source === "bsa_calendar" && optionalText(row.agenda_url) ? { agenda_url: optionalText(row.agenda_url) } : {}),
    ...(source === "pdc_calendar" && row.quorum_notice && typeof row.quorum_notice === "object"
      ? { quorum_notice: { status: optionalText(row.quorum_notice.status), votes: Array.isArray(row.quorum_notice.votes) ? row.quorum_notice.votes : [] } }
      : {}),
    meeting_documents: Array.isArray(row.meeting_documents) ? row.meeting_documents : [],
    source_url: sourceHref,
    source_system: source,
    ...(source === "public_body_calendar" ? {
      source_contract_id: optionalText(row.source_contract_id),
      temporal_basis: optionalText(row.temporal_basis),
      relationship_classification: optionalText(row.relationship_classification || row.authority_relationship),
      source_raw_timezone: optionalText(row.source_raw_timezone || row.raw_timezone || row.publisher_timezone),
    } : {}),
    meeting_origin: optionalText(row.meeting_origin) || "unknown",
    source_receipt: sourceReceipt(row),
    ...(row.source_raw_values && typeof row.source_raw_values === "object"
      ? { source_raw_values: row.source_raw_values } : {}),
    ...(optionalText(row.source_revision) ? { source_revision: optionalText(row.source_revision) } : {}),
    ...(source === "oath_trial_calendar" && optionalText(row.oath_index)
      ? { oath_index: optionalText(row.oath_index) } : {}),
    ...(source === "oath_trial_calendar" && optionalText(row.source_index)
      ? { source_index: optionalText(row.source_index) } : {}),
    ...(source === "oath_trial_calendar" && optionalText(row.proceeding_type)
      ? { proceeding_type: optionalText(row.proceeding_type) } : {}),
    ...(source === "oath_trial_calendar" && optionalText(row.start_time)
      ? { start_time: optionalText(row.start_time) } : {}),
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
    source_record_id: source === "public_body_calendar"
      ? optionalText(row.source_record_id || sourceId)
      : source === "community_board" || source === "nyc_legistar_events"
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
    publisher_identifier: row.publisher_identifier
      || (row.meeting_origin === "official_community_board_calendar" ? null : row.source_record_id || row.record_id),
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

export function normalizePdcCalendarMeeting(row = {}) {
  return normalizeMeetingObject({
    ...row,
    source_system: "pdc_calendar",
    publisher_identifier: row.publisher_identifier || row.pdc_event_id || row.event_id || row.source_record_id,
    source_url: row.source_url || row.record_url,
    activity: "observe",
    ...(row.quorum_notice && typeof row.quorum_notice === "object"
      ? { quorum_notice: row.quorum_notice }
      : {}),
  });
}

export function normalizeBsaCalendarMeeting(row = {}) {
  const hasAccessEvidence = Boolean(
    row.observer_access
    || row.remote_registration_url
    || row.participation
    || row.access_steps,
  );
  return normalizeMeetingObject({
    ...row,
    source_system: "bsa_calendar",
    publisher_identifier: row.publisher_identifier || row.bsa_session_id || row.session_id || row.source_record_id,
    source_url: row.source_url || row.record_url,
    activity: row.activity || (hasAccessEvidence ? "observe" : null),
    observer_access: row.observer_access || (hasAccessEvidence ? {
      watch_url: "https://www.youtube.com/@NYCBSA",
      remote_join_url: row.remote_registration_url || null,
    } : null),
    participation: row.participation || (hasAccessEvidence ? {
      links: [{ label: "BSA attendance procedures", url: "https://www.nyc.gov/site/bsa/public-hearings/procedures-for-attendance.page" }],
    } : null),
    access_steps: row.access_steps || (hasAccessEvidence ? [{
      kind: "observer_instructions",
      destination: "https://www.nyc.gov/site/bsa/public-hearings/public-hearing-format.page",
      source_url: "https://www.nyc.gov/site/bsa/public-hearings/public-hearing-format.page",
    }] : null),
  });
}

export function normalizeOathTrialCalendarMeeting(row = {}) {
  return normalizeMeetingObject({
    ...row,
    source_system: "oath_trial_calendar",
    publisher_identifier: row.publisher_identifier || row.oath_trial_session_id || row.session_id || row.source_record_id,
    source_url: row.source_url || row.record_url,
    activity: "observe",
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
