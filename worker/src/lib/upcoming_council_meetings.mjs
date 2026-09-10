// Sanitized upcoming Council-meeting materialization from the authenticated
// NYC Council Legistar Web API.
//
// City Record remains the event-discovery layer for meeting-outcome records.
// This is the distinct first-class materialization for meetings the publisher
// has already announced — including events no City Record notice has matched.
// It is built from the SAME authenticated Events acquisition the
// meeting-outcomes refresh already performs (no second Events request), plus a
// bounded nested EventItems discovery fan-out over a documented upcoming
// horizon. Publisher requests happen only from the scheduled path; resident
// reads never trigger them.
//
// Identity policy: every projection keeps its source-qualified identity
// (meeting:nyc_legistar_events:<EventId>). A City Record notice that satisfies
// the strict exact_date_body_tokens join is carried as link metadata only —
// similar title or date alone never merges, hides, or aliases two records.
//
// Sanitization: projections are built from an explicit field allowlist and are
// asserted free of credential-bearing strings (no `token=`, no authenticated
// webapi.legistar.com URL) before they are materialized.

import { meetingDetailUrl } from "./legistar_join.mjs";
import { EVENT_ITEMS_TOP } from "./legistar_client.mjs";

export const UPCOMING_COUNCIL_MEETINGS_SCHEMA = "cityscroll.upcoming_council_meetings.v1";
export const UPCOMING_COUNCIL_MEETINGS_VIEW_VERSION = 1;
export const UPCOMING_COUNCIL_MEETINGS_KV_KEY = "upcoming-council-meetings:materialized:v1";
/**
 * Documented upcoming horizon: an event is eligible when its published
 * EventDate falls within this many days of the acquisition clock. Publisher
 * local-date markers are compared against the acquisition clock's UTC date.
 */
export const UPCOMING_COUNCIL_MEETINGS_HORIZON_DAYS = 120;
/** Nested EventItems discovery bound: the nearest this many eligible events per run. */
export const UPCOMING_COUNCIL_MEETINGS_ITEM_EVENTS_MAX = 60;
/** Nested EventItems discovery concurrency; a politeness bound, never above six. */
export const UPCOMING_COUNCIL_MEETINGS_ITEM_CONCURRENCY = 6;
/** A snapshot older than this serves as stale rather than current. */
export const UPCOMING_COUNCIL_MEETINGS_MAX_AGE_MS = 36 * 60 * 60 * 1000;
/** The publisher publishes meeting times as New York local wall times. */
export const UPCOMING_COUNCIL_MEETINGS_TIME_ZONE = "America/New_York";

function readFirst(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value === 0 || value === false) return value;
    if (value !== null && value !== undefined) {
      const text = String(value).trim();
      if (text !== "") return text;
    }
  }
  return null;
}

function normalizeText(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

/** Publisher local-date marker (YYYY-MM-DD) sliced from the raw field, TZ-safe. */
export function eventLocalDay(raw = {}) {
  const value = readFirst(raw, ["EventDate", "StartDate", "Date"]);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || ""));
  return match ? match[1] : null;
}

/**
 * Naive wall-clock start from EventDate + EventTime, in the publisher's own
 * time zone (never shifted to UTC). Mirrors the wall-time parse in
 * meeting_outcomes.mjs; keep the two in step.
 */
export function eventWallStart(raw = {}) {
  const day = eventLocalDay(raw);
  const timeValue = readFirst(raw, ["EventTime"]);
  if (day && timeValue) {
    const clock = String(timeValue).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
    if (clock) {
      let hour = Number(clock[1]);
      const suffix = String(clock[4] || "").toUpperCase();
      if (suffix === "AM" && hour === 12) hour = 0;
      if (suffix === "PM" && hour < 12) hour += 12;
      if (hour <= 23) {
        return `${day}T${String(hour).padStart(2, "0")}:${clock[2]}:${clock[3] || "00"}`;
      }
    }
  }
  return day ? `${day}T00:00:00` : null;
}

/** The upcoming eligibility window as UTC dates derived from the (pinned) clock. */
export function upcomingWindow(now = new Date()) {
  const start = new Date(now).toISOString().slice(0, 10);
  const end = new Date(now.getTime() + UPCOMING_COUNCIL_MEETINGS_HORIZON_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  return { start, end };
}

/** An event is eligible when it carries an EventId and its date is inside the window. */
export function isEligibleUpcomingEvent(raw, window = null) {
  const id = readFirst(raw, ["EventId", "eventId", "Event_ID", "id"]);
  if (!id) return false;
  const day = eventLocalDay(raw);
  if (!day) return false;
  const bounds = window || upcomingWindow(new Date());
  return day >= bounds.start && day <= bounds.end;
}

function numericId(raw) {
  const id = readFirst(raw, ["EventId", "eventId", "Event_ID", "id"]);
  const num = Number(id);
  return Number.isFinite(num) ? num : Number.MAX_SAFE_INTEGER;
}

/**
 * Bound the nested EventItems fan-out: nearest eligible events first (date,
 * then id), skipping events whose items this run already holds. Events beyond
 * the cap are deferred, never silently dropped from the projection.
 */
export function selectUpcomingItemTargets(
  eligibleEvents = [],
  alreadyMaterializedIds = new Set(),
  max = UPCOMING_COUNCIL_MEETINGS_ITEM_EVENTS_MAX,
) {
  const sorted = [...eligibleEvents].sort((a, b) => {
    const dayA = eventLocalDay(a) || "";
    const dayB = eventLocalDay(b) || "";
    if (dayA !== dayB) return dayA < dayB ? -1 : 1;
    return numericId(a) - numericId(b);
  });
  const targets = [];
  let alreadyMaterialized = 0;
  let deferred = 0;
  for (const event of sorted) {
    const id = String(readFirst(event, ["EventId", "eventId", "Event_ID", "id"]));
    if (alreadyMaterializedIds.has(id)) {
      alreadyMaterialized += 1;
      continue;
    }
    if (targets.length >= max) {
      deferred += 1;
      continue;
    }
    targets.push(event);
  }
  return {
    targets,
    already_materialized: alreadyMaterialized,
    deferred,
    truncated: deferred > 0,
  };
}

function sanitizeAgendaItem(raw = {}) {
  const matterId = readFirst(raw, ["EventItemMatterId", "MatterId", "MatterID", "Matter_ID"]);
  return {
    agenda_item_id: readFirst(raw, ["EventItemId", "AgendaItemId", "AgendaItemID"]),
    agenda_number: normalizeText(readFirst(raw, ["EventItemAgendaNumber", "AgendaItemNumber"])) || null,
    title: normalizeText(readFirst(raw, ["EventItemTitle", "AgendaItemTitle", "Title"])) || null,
    body_text: normalizeText(readFirst(raw, ["EventItemAgendaNote", "EventItemActionText", "AgendaItemText"])) || null,
    matter: matterId
      ? {
        matter_id: String(matterId),
        matter_file: readFirst(raw, ["EventItemMatterFile", "MatterFile"]) || null,
        matter_name: normalizeText(readFirst(raw, ["EventItemMatterName", "MatterName", "Name"])) || null,
        matter_type: readFirst(raw, ["EventItemMatterType", "MatterType"]) || null,
        matter_status: readFirst(raw, ["EventItemMatterStatus", "Status", "MatterStatus"]) || null,
      }
      : null,
    action: {
      name: normalizeText(readFirst(raw, ["EventItemActionName", "ActionName", "Action"])) || null,
      passed_flag: readFirst(raw, ["EventItemPassedFlagName", "PassedFlagName"]) || null,
    },
  };
}

function agendaSearchText(items = []) {
  const parts = [];
  for (const item of items) {
    for (const value of [item.title, item.body_text, item.matter?.matter_name, item.matter?.matter_file]) {
      const text = normalizeText(value);
      if (text) parts.push(text);
    }
  }
  return parts.length ? [...new Set(parts)].join(" | ") : null;
}

function eventDocuments(raw = {}) {
  const docs = [];
  const agenda = readFirst(raw, ["EventAgendaFile"]);
  const minutes = readFirst(raw, ["EventMinutesFile"]);
  if (agenda) docs.push({ url: String(agenda), name: "Agenda", category: "Agenda" });
  if (minutes) docs.push({ url: String(minutes), name: "Minutes", category: "Minutes" });
  return docs;
}

function sanitizeUpcomingMeeting(raw, { observedAt, cityRecord }) {
  const eventId = String(readFirst(raw, ["EventId", "eventId", "Event_ID", "id"]));
  const insite = readFirst(raw, ["EventInSiteURL", "EventUrl", "EventURL", "url", "link"]);
  const items = (cityRecord.items || []).map(sanitizeAgendaItem);
  let agendaStatus;
  if (cityRecord.fetchError) agendaStatus = "unavailable";
  else if (cityRecord.itemsFetched) {
    if ((cityRecord.items || []).length >= EVENT_ITEMS_TOP) agendaStatus = "truncated";
    else agendaStatus = (cityRecord.items || []).length ? "items" : "empty";
  } else agendaStatus = "not_fetched";
  return {
    meeting_id: `meeting:nyc_legistar_events:${eventId}`,
    identity: {
      source_system: "nyc_legistar_events",
      event_id: eventId,
      event_guid: readFirst(raw, ["EventGuid"]) || null,
    },
    governing_body: {
      name: normalizeText(readFirst(raw, ["EventBodyName", "BodyName", "Body", "committee"])) || null,
      body_id: readFirst(raw, ["EventBodyId", "BodyId"]) ?? null,
    },
    date: eventLocalDay(raw),
    wall_time: eventWallStart(raw),
    time_zone: UPCOMING_COUNCIL_MEETINGS_TIME_ZONE,
    venue: {
      address: normalizeText(readFirst(raw, ["EventLocation", "Location", "VenueAddress"])) || null,
    },
    url: insite ? String(insite) : meetingDetailUrl({ EventId: eventId }),
    agenda_status: readFirst(raw, ["EventAgendaStatusName", "AgendaStatusName"]) || null,
    documents: eventDocuments(raw),
    agenda: {
      status: agendaStatus,
      items,
      search_text: agendaSearchText(items),
    },
    city_record_notice: {
      matched_in_window: Boolean(cityRecord.joined?.request_id),
      request_id: cityRecord.joined?.request_id || null,
      method: cityRecord.joined?.method || null,
    },
    source_receipt: {
      source_system: "nyc_legistar_events",
      observed_at: observedAt,
      row_version: readFirst(raw, ["EventRowVersion"]) || null,
      last_modified_utc: readFirst(raw, ["EventLastModifiedUtc"]) || null,
      agenda_last_published_utc: readFirst(raw, ["EventAgendaLastPublishedUTC"]) || null,
    },
  };
}

/**
 * Pure assembly of the upcoming Council-meetings view from already-acquired
 * rows. `itemsByEventId` maps String(EventId) → { rows, fetchError } gathered
 * by the shared fan-out; `cityRecordByEventId` maps String(EventId) →
 * { request_id, method } from this run's strict join pre-pass (link metadata
 * only). `eventsFetch` carries the shared Events acquisition result so page
 * truncation is disclosed.
 *
 * Returns { publishable, reason, view }. publishable is false when an
 * authenticated acquisition observed no event rows (empty-source refusal) or
 * nothing eligible — in those states the caller retains last-known-good data
 * instead of publishing a successful empty source.
 */
export function buildUpcomingCouncilMeetingsView({
  eventRows = [],
  itemsByEventId = new Map(),
  now = new Date(),
  cityRecordByEventId = new Map(),
  eventsFetch = { ok: true, complete: true, pages: 0 },
} = {}) {
  const generatedAt = new Date(now).toISOString();
  const window = upcomingWindow(now);
  if (!eventRows.length) {
    return { publishable: false, reason: "empty-source", view: null };
  }
  const eligible = eventRows.filter((raw) => isEligibleUpcomingEvent(raw, window));
  if (!eligible.length) {
    return { publishable: false, reason: "no-eligible-events", view: null };
  }

  const attemptedIds = new Set([...itemsByEventId.keys()].map(String));
  let itemsDeferred = 0;
  for (const raw of eligible) {
    const id = String(readFirst(raw, ["EventId", "eventId", "Event_ID", "id"]));
    if (!attemptedIds.has(id)) itemsDeferred += 1;
  }

  let itemsUnavailable = 0;
  let itemsEmpty = 0;
  let itemsTruncated = 0;
  let agendaItems = 0;
  const meetings = eligible.map((raw) => {
    const eventId = String(readFirst(raw, ["EventId", "eventId", "Event_ID", "id"]));
    const bag = itemsByEventId.get(eventId) || null;
    const fetched = bag && !bag.fetchError;
    const meeting = sanitizeUpcomingMeeting(raw, {
      observedAt: generatedAt,
      cityRecord: {
        items: fetched ? bag.rows : [],
        itemsFetched: Boolean(fetched),
        fetchError: bag?.fetchError || null,
        joined: cityRecordByEventId.get(eventId) || null,
      },
    });
    if (meeting.agenda.status === "unavailable") itemsUnavailable += 1;
    else if (meeting.agenda.status === "empty") itemsEmpty += 1;
    else if (meeting.agenda.status === "truncated") itemsTruncated += 1;
    agendaItems += meeting.agenda.items.length;
    return meeting;
  });

  const view = {
    schema: UPCOMING_COUNCIL_MEETINGS_SCHEMA,
    schema_version: UPCOMING_COUNCIL_MEETINGS_VIEW_VERSION,
    generated_at: generatedAt,
    source: {
      name: "NYC Council Legistar (authenticated Web API)",
      dataset: "Events",
      publisher_landing: "https://council.nyc.gov/legislation/api/",
    },
    identity_policy: {
      identity: "meeting:nyc_legistar_events:<EventId>",
      merge: "none",
      city_record_link: "metadata-only; an exact date-and-body notice join links, it never merges or replaces a source identity",
    },
    discovery: {
      basis: "shared authenticated Events acquisition of the daily refresh (no additional Events request)",
      horizon_days: UPCOMING_COUNCIL_MEETINGS_HORIZON_DAYS,
      window_start: window.start,
      window_end: window.end,
      events_pages: eventsFetch?.pages ?? 0,
      events_page_truncated: eventsFetch ? !eventsFetch.complete : null,
      item_events_max: UPCOMING_COUNCIL_MEETINGS_ITEM_EVENTS_MAX,
      item_concurrency: UPCOMING_COUNCIL_MEETINGS_ITEM_CONCURRENCY,
      item_events_attempted: eligible.length - itemsDeferred,
      item_events_deferred: itemsDeferred,
      item_discovery_truncated: itemsDeferred > 0,
    },
    source_health: {
      status: "healthy",
      basis: "authenticated-events-acquisition",
      observed_at: generatedAt,
      events_observed: eventRows.length,
    },
    counts: {
      eligible_events: eligible.length,
      meetings: meetings.length,
      agenda_items: agendaItems,
      events_with_items: meetings.filter((m) => m.agenda.status === "items" || m.agenda.status === "truncated").length,
      events_no_published_items: itemsEmpty,
      events_items_deferred: itemsDeferred,
      events_items_unavailable: itemsUnavailable,
      events_items_truncated: itemsTruncated,
    },
    meetings,
  };
  return { publishable: true, reason: null, view };
}

/**
 * Serving-health assessment for a materialized snapshot: unavailable when no
 * snapshot exists, stale when missing the current schema or older than the
 * maximum age, healthy otherwise. Computed from the artifact, never from a
 * failed refresh's silence.
 */
export function upcomingCouncilMeetingsHealth(parsed, nowMs = Date.now()) {
  if (!parsed || !parsed.generated_at) return { status: "unavailable", reason: "no-snapshot" };
  if (parsed.schema_version !== UPCOMING_COUNCIL_MEETINGS_VIEW_VERSION) {
    return { status: "stale", reason: "schema-version" };
  }
  const age = nowMs - new Date(parsed.generated_at).getTime();
  if (!Number.isFinite(age) || age > UPCOMING_COUNCIL_MEETINGS_MAX_AGE_MS) {
    return { status: "stale", reason: "age" };
  }
  return { status: "healthy", reason: null };
}

function collectStrings(value, out) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const entry of value) collectStrings(entry, out);
  else if (value && typeof value === "object") for (const entry of Object.values(value)) collectStrings(entry, out);
}

/**
 * Fail-closed sanitization gate for the public projection: no string in the
 * materialized view may carry a credential (`token=`) or an authenticated
 * webapi.legistar.com URL. The publisher web API base is deliberately not part
 * of the view, so any occurrence is a leak.
 */
export function assertPublicUpcomingProjection(view) {
  if (!view || view.schema !== UPCOMING_COUNCIL_MEETINGS_SCHEMA) {
    throw new Error("upcoming-council-meetings: projection is missing its schema identity");
  }
  if (!Array.isArray(view.meetings)) {
    throw new Error("upcoming-council-meetings: projection is missing its meetings list");
  }
  const strings = [];
  collectStrings(view, strings);
  for (const text of strings) {
    if (/token=/i.test(text)) {
      throw new Error("upcoming-council-meetings: projection carries a credential-bearing string");
    }
    if (/webapi\.legistar\.com/i.test(text)) {
      throw new Error("upcoming-council-meetings: projection carries an authenticated publisher URL");
    }
  }
  return true;
}
