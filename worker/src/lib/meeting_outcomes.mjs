// Daily materialized meeting-outcome read model for NYC Council.
//
// City Record remains the event-discovery layer for outcome records; the
// authenticated NYC Council Legistar Web API (webapi.legistar.com/v1/nyc,
// secret LEGISTAR_API_TOKEN) enriches outcomes — agenda items, matters, action
// outcomes, roll-call votes, and hearing documents — once a council event is
// strictly joined to a notice. The same acquisition also feeds the distinct
// upcoming-council-meetings materialization (upcoming_council_meetings.mjs),
// which covers eligible announced events with no City Record match.
//
// The strict join (exact_date_body_tokens, measured at 100% on modern notices)
// lives in legistar_join.mjs; this module owns the fetch + assembly + KV cache.

import { normalizeHearing } from "./hearings.mjs";
import {
  buildMeetingDateIndex,
  joinNoticeToCouncilMeeting,
  meetingDetailUrl,
  matterDetailUrl,
} from "./legistar_join.mjs";
import {
  fetchLegistarEventsWindow,
  fetchLegistarEventItems,
  fetchLegistarItemVoteRows,
  projectLegistarAttachmentDocuments,
  summarizeLegistarVotes,
  boundedMap,
  MAX_VOTE_PROBES_PER_EVENT,
  MAX_TOTAL_VOTE_PROBES,
  MAX_EMBEDDED_ATTACHMENTS_PER_EVENT,
  MAX_TOTAL_EMBEDDED_ATTACHMENTS,
} from "./legistar_client.mjs";
import {
  UPCOMING_COUNCIL_MEETINGS_ITEM_CONCURRENCY,
  UPCOMING_COUNCIL_MEETINGS_AGENDA_ITEMS_MAX,
  UPCOMING_COUNCIL_MEETINGS_KV_KEY,
  assertPublicUpcomingProjection,
  buildUpcomingCouncilMeetingsView,
  isEligibleUpcomingEvent,
  selectUpcomingItemTargets,
  upcomingWindow,
} from "./upcoming_council_meetings.mjs";
import { dualWriteLegistarObservations } from "./legistar_source_records.mjs";
import { retainNativeMatterObservations } from "./matter_observation_journal.mjs";
import { linksFromMeetingRecord } from "./subject_registry.mjs";
import { TRANSIENT_UPSTREAM_STATUSES } from "./upstream_failure.mjs";

/** Bump when vote/person mapping or spine assembly changes so young-but-stale KV rebuilds. */
export const MEETING_OUTCOMES_VIEW_VERSION = 4;
export const MEETING_OUTCOMES_KV_KEY = "meeting-outcomes:materialized:v2";
export const MAX_AGE_MS = 36 * 60 * 60 * 1000;

/**
 * Whether the cached meeting-outcomes view should be rebuilt before serving.
 * Age alone is not enough: a young KV snapshot written under an older code path
 * (e.g. pre–person-level vote mapping) would otherwise stick until MAX_AGE.
 */
export function meetingOutcomesViewNeedsRefresh(parsed, nowMs = Date.now()) {
  if (!parsed || !parsed.generated_at) return true;
  const age = nowMs - new Date(parsed.generated_at).getTime();
  if (!Number.isFinite(age) || age > MAX_AGE_MS) return true;
  if (parsed.schema_version !== MEETING_OUTCOMES_VIEW_VERSION) return true;
  return false;
}

/** UTC hour of the primary daily Council refresh window ("0 8 * * *"). */
export const MEETING_OUTCOMES_PRIMARY_UTC_HOUR = 8;

/**
 * Whether the stored view was generated at or after today's primary refresh
 * window. A later same-day window re-attempts the acquisition only when this is
 * false, so a morning that already published is never acquired twice. A missing
 * or unreadable view counts as not published.
 */
export async function meetingOutcomesPublishedSincePrimary(env, now = new Date()) {
  const at = new Date(now);
  const primaryMs = Date.UTC(
    at.getUTCFullYear(),
    at.getUTCMonth(),
    at.getUTCDate(),
    MEETING_OUTCOMES_PRIMARY_UTC_HOUR,
  );
  let generatedAt = null;
  try {
    const raw = await env?.ALERT_STATE?.get?.(MEETING_OUTCOMES_KV_KEY);
    generatedAt = raw ? JSON.parse(raw)?.generated_at || null : null;
  } catch {
    generatedAt = null;
  }
  const generatedMs = Date.parse(generatedAt);
  return {
    published: Number.isFinite(generatedMs) && generatedMs >= primaryMs,
    generated_at: generatedAt,
    since: new Date(primaryMs).toISOString(),
  };
}

// The first two reads (City Record notices, the Legistar Events window) gate the
// whole refresh, and the refresh runs once a day. One transient publisher
// failure there used to discard the day's acquisition. Retry only while the
// source is unwell (gateway/timeout statuses, dropped connections), never a
// rejected request, and never sooner than a publisher's own Retry-After.
export const MEETING_OUTCOMES_READ_RETRY_DELAYS_MS = Object.freeze([1_000, 3_000]);
const TRANSIENT_LEGISTAR_KINDS = new Set(["rate-limited", "timeout", "network"]);

function readRetryPolicy({ delaysMs = MEETING_OUTCOMES_READ_RETRY_DELAYS_MS, waitFn } = {}) {
  return {
    delaysMs,
    waitFn: waitFn || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
}

// Retry-After is resolved against the refresh's own clock, so compare with that clock.
function transientLegistarFailure(result, delayMs, now) {
  if (result.kind === "http") return TRANSIENT_UPSTREAM_STATUSES.has(result.status);
  if (!TRANSIENT_LEGISTAR_KINDS.has(result.kind)) return false;
  if (result.kind !== "rate-limited" || !result.retryAfter) return true;
  return Date.parse(result.retryAfter) - now.getTime() <= delayMs;
}

async function fetchLegistarEventsWindowWithRetry(options, retry) {
  let result;
  for (let attempt = 0; ; attempt += 1) {
    result = await fetchLegistarEventsWindow(options);
    const delayMs = retry.delaysMs[attempt];
    if (result.ok || delayMs == null || !transientLegistarFailure(result, delayMs, new Date(options.now ?? Date.now()))) {
      return result;
    }
    await retry.waitFn(delayMs);
  }
}

export const NOTICE_LIMIT = 500;
export const API_RECORD_LIMIT = 100;

// Fields the public projections and the matter journal actually read. Anything
// else on a publisher row — including unused Legistar columns and unexpected
// attachment bodies — is dropped before the assembled view is built so the
// refresh does not hold a second copy of the window.
const COUNCIL_EVENT_KEYS = new Set([
  "EventId", "eventId", "Event_ID", "id",
  "EventGuid",
  "EventBodyId", "BodyId",
  "EventBodyName", "BodyName", "Body", "committee",
  "EventTitle", "Title", "Name",
  "EventInSiteURL", "EventUrl", "EventURL", "url", "link",
  "EventDate", "StartDate", "Date",
  "EventTime",
  "EventAgendaFile", "EventMinutesFile", "EventVideoStatus",
  "EventLocation", "Location", "VenueAddress",
  "VenueType", "VenueName", "Building", "Room",
  "EventAgendaStatusName", "AgendaStatusName",
  "EventRowVersion", "EventLastModifiedUtc", "EventAgendaLastPublishedUTC",
]);
const COUNCIL_ITEM_KEYS = new Set([
  "EventItemId", "AgendaItemId", "AgendaItemID", "id",
  "EventItemEventId", "EventId", "eventId", "EventID",
  "EventItemAgendaNumber", "AgendaItemNumber",
  "EventItemTitle", "AgendaItemTitle", "Title",
  "EventItemAgendaNote", "EventItemActionText", "AgendaItemText",
  "EventItemMatterId", "MatterId", "MatterID", "Matter_ID",
  "EventItemMatterFile", "MatterFile",
  "EventItemMatterName", "MatterName", "Name",
  "EventItemMatterType", "MatterType",
  "EventItemMatterStatus", "Status", "MatterStatus",
  "EventItemActionName", "ActionName", "Action",
  "EventItemActionId", "ActionId",
  "EventItemPassedFlagName", "PassedFlagName",
  "EventItemRollCallFlag",
  "EventItemMatterUrl", "MatterUrl",
  "EventItemMatterAttachments",
]);
const COUNCIL_VOTE_KEYS = new Set([
  "EventItemId", "EventItemMatterId",
  "VoteId", "VoteGuid", "VoteEventItemId", "VotePersonId", "VotePersonName",
  "VoteValueId", "VoteValueName", "VoteResult", "VoteSort",
  "PersonId", "PersonName", "PersonGuid",
  "ValueId", "ValueName", "Result",
]);

function stripPublisherRows(rows, allowed) {
  for (const row of rows || []) {
    if (!row || typeof row !== "object") continue;
    for (const key of Object.keys(row)) {
      if (!allowed.has(key)) delete row[key];
    }
  }
}

/** Ordered stages of one matter's legislative path on a Council event. */
export const MEETING_VOTE_SPINE_STAGES = Object.freeze([
  "agenda",
  "matter",
  "action",
  "vote",
  "attachment",
]);
export const MEETING_VOTE_SPINE_SCHEMA_VERSION = 1;

const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";

const NOTICE_SELECT = [
  "request_id", "start_date", "agency_name", "type_of_notice_description", "section_name",
  "short_title", "event_date", "building_name", "street_address_1", "street_address_2",
  "city", "state", "zip_code", "additional_description_1", "additional_description_2",
  "additional_description_3", "other_info_1", "other_info_2", "other_info_3",
  "printout_1", "printout_2", "printout_3",
].join(",");

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

function toDateIso(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function toLocaleDate(value) {
  const iso = toDateIso(value);
  return iso ? iso.slice(0, 10) : null;
}

function legistarEventStart(raw = {}) {
  const dateValue = readFirst(raw, ["EventDate", "StartDate", "Date"]);
  const timeValue = readFirst(raw, ["EventTime"]);
  const day = toLocaleDate(dateValue);
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
  return toDateIso(dateValue || timeValue);
}

function normalizeText(value) {
  if (value == null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function clamp(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const value = key(row);
    if (value == null || value === "") continue;
    const bucket = map.get(value);
    if (bucket) bucket.push(row);
    else map.set(value, [row]);
  }
  return map;
}

function normalizeNoticeForOutcomes(row = {}) {
  const base = normalizeHearing(row);
  return {
    request_id: String(base.request_id || ""),
    request_key: String(base.request_id || ""),
    agency: base.agency || normalizeText(row.agency_name),
    title: base.title || normalizeText(row.short_title),
    section_name: row.section_name || base.source_section || null,
    notice_type: row.type_of_notice_description || null,
    event_date: toLocaleDate(row.event_date || base.event_date),
    start_date: row.start_date || null,
    source_url: base.source_url || null,
    meeting_origin: base.meeting_origin || "unknown",
    affected_area: base.affected_area,
    venue: base.venue,
  };
}

function normalizeCouncilLocation(raw = {}) {
  const rawLocation = readFirst(raw, ["EventLocation", "Location", "VenueAddress"]);
  return {
    mode: normalizeText(readFirst(raw, ["VenueType"])) || "in-person",
    address: normalizeText(rawLocation) || null,
    building: normalizeText(readFirst(raw, ["VenueName", "Building", "Room"])) || null,
  };
}

function normalizeCouncilEvent(raw = {}) {
  const eventId = readFirst(raw, ["EventId", "eventId", "Event_ID", "id"]);
  const bodyName = normalizeText(readFirst(raw, ["EventBodyName", "BodyName", "Body", "committee"]));
  return {
    event_id: eventId ? String(eventId) : null,
    title: bodyName || normalizeText(readFirst(raw, ["EventTitle", "Title", "Name"])),
    body_name: bodyName,
    event_url: readFirst(raw, ["EventInSiteURL", "EventUrl", "EventURL", "url", "link"]) || null,
    start_time: legistarEventStart(raw),
    event_date: toLocaleDate(readFirst(raw, ["EventDate", "StartDate", "Date"])),
    agenda_file: readFirst(raw, ["EventAgendaFile"]) || null,
    minutes_file: readFirst(raw, ["EventMinutesFile"]) || null,
    video_status: readFirst(raw, ["EventVideoStatus"]) || null,
    venue: normalizeCouncilLocation(raw),
  };
}

/**
 * Normalize a Legistar EventItem. Items carry inline matter linkage
 * (EventItemMatterFile/Name/Status) and the action outcome
 * (EventItemActionName / EventItemPassedFlagName), so a single item row is both
 * the agenda line and its matter in one.
 */
export function normalizeCouncilAgendaItem(raw = {}) {
  const matterId = readFirst(raw, ["EventItemMatterId", "MatterId", "MatterID", "Matter_ID"]);
  return {
    agenda_item_id: readFirst(raw, ["EventItemId", "AgendaItemId", "AgendaItemID"]),
    event_id: readFirst(raw, ["EventItemEventId", "EventId", "eventId", "EventID"]),
    agenda_number: normalizeText(readFirst(raw, ["EventItemAgendaNumber", "AgendaItemNumber"])) || null,
    title: normalizeText(readFirst(raw, ["EventItemTitle", "AgendaItemTitle", "Title"])) || null,
    body_text: normalizeText(readFirst(raw, ["EventItemAgendaNote", "EventItemActionText", "AgendaItemText"])) || null,
    matter_id: matterId ? String(matterId) : null,
    matter_file: readFirst(raw, ["EventItemMatterFile", "MatterFile"]) || null,
    matter_name: normalizeText(readFirst(raw, ["EventItemMatterName", "MatterName", "Name"])) || null,
    matter_type: readFirst(raw, ["EventItemMatterType", "MatterType"]) || null,
    matter_status: readFirst(raw, ["EventItemMatterStatus", "Status", "MatterStatus"]) || null,
    action_name: normalizeText(readFirst(raw, ["EventItemActionName", "ActionName", "Action"])) || null,
    action_text: normalizeText(readFirst(raw, ["EventItemActionText"])) || null,
    passed_flag: readFirst(raw, ["EventItemPassedFlagName", "PassedFlagName"]) || null,
    roll_call_flag: readFirst(raw, ["EventItemRollCallFlag"]) || null,
  };
}

function eventDocuments(event) {
  const docs = [];
  if (event.agenda_file) docs.push({ url: event.agenda_file, name: "Agenda", category: "Agenda" });
  if (event.minutes_file) docs.push({ url: event.minutes_file, name: "Minutes", category: "Minutes" });
  return docs;
}

/**
 * Project a vote summary (counts + retained persons) onto the agenda matter card.
 * The summary projected here is the one recorded on this agenda item; the
 * caller resolves that, and a card with no roll call keeps an empty list.
 * Person-level rows and votes_on edges are first-class when the publisher
 * retained VotePersonId/VotePersonName (or PersonId/PersonName); aggregate
 * tallies always remain. vote_identity is roll_call vs tally_only.
 */
function projectVoteSummary(voteSummary, item) {
  if (!voteSummary || !voteSummary.counts) return [];
  const byPerson = Array.isArray(voteSummary.by_person) ? voteSummary.by_person : [];
  const officials = Array.isArray(voteSummary.officials) ? voteSummary.officials : [];
  const votesOn = Array.isArray(voteSummary.votes_on) ? voteSummary.votes_on : [];
  return [{
    result: voteSummary.result || item.passed_flag || item.action_name || null,
    counts: voteSummary.counts,
    // Coarse participation split and the publisher's own labels with their own
    // counts, so a surface can say "one member absent" without inferring it
    // from a bucket that also means "abstained".
    participation: voteSummary.participation || null,
    published_vote_values: Array.isArray(voteSummary.published_vote_values)
      ? voteSummary.published_vote_values
      : [],
    // Which meeting and which agenda item this roll call is evidence of.
    event_id: voteSummary.event_id ?? item.event_id ?? null,
    event_item_id: voteSummary.event_item_id ?? item.agenda_item_id ?? null,
    person_count: voteSummary.person_count ?? byPerson.length,
    by_person: byPerson,
    officials,
    votes_on: votesOn,
    person_vote_retention_rate: voteSummary.person_vote_retention_rate ?? null,
    official_votes_on_edge_rate: voteSummary.official_votes_on_edge_rate ?? null,
    vote_identity: voteSummary.vote_identity
      || (byPerson.length ? "roll_call" : "tally_only"),
    source_url: null,
    kind: "vote",
  }];
}

/**
 * One matter-centric vote spine: agenda → matter → action → vote → attachment.
 * The spine is the product object for a matter's path through a single Council event.
 *
 * @param {object} opts
 * @param {object} [opts.item] - agenda item (from assembleAgenda)
 * @param {object} [opts.matter] - matter card on that item
 * @param {object} [opts.event] - council_event
 * @param {object[]} [opts.eventDocuments] - event-level agenda/minutes docs
 */
export function buildMeetingVoteSpine({
  item = {},
  matter = {},
  event = {},
  eventDocuments = [],
} = {}) {
  const agendaMatched = Boolean(item?.agenda_item_id || item?.title);
  const matterMatched = Boolean(matter?.matter_id);
  const actionName =
    matter?.outcome || matter?.passed || matter?.status || item?.action_name || null;
  const actionMatched = Boolean(actionName);
  const votes = Array.isArray(matter?.votes) ? matter.votes : [];
  const voteMatched = votes.length > 0;
  const docs = [
    ...(Array.isArray(matter?.documents) ? matter.documents : []),
    ...(Array.isArray(eventDocuments) ? eventDocuments : []),
  ].filter((d, index, all) => d && d.url && all.findIndex((x) => x && x.url === d.url) === index);
  const attachmentMatched = docs.length > 0;

  const stages = [
    {
      kind: "agenda",
      matched: agendaMatched,
      agenda_item_id: item?.agenda_item_id ?? null,
      agenda_number: item?.agenda_number ?? null,
      title: item?.title ?? null,
      body_text: item?.body_text ?? null,
    },
    {
      kind: "matter",
      matched: matterMatched,
      matter_id: matter?.matter_id ?? null,
      matter_file: matter?.matter_file ?? null,
      // Prefer stamped matter_url; fall back to pure builder so spines stay linkable
      // even when a caller builds a spine without assembleAgenda.
      matter_url: matter?.matter_url || matterDetailUrl(matter?.matter_id) || null,
      title: matter?.title ?? null,
      status: matter?.status ?? null,
    },
    {
      kind: "action",
      matched: actionMatched,
      action_name: actionName,
      action_text: matter?.body_text || item?.body_text || item?.action_text || null,
      passed: matter?.passed ?? null,
    },
    {
      kind: "vote",
      matched: voteMatched,
      votes,
      result: votes[0]?.result ?? null,
      counts: votes[0]?.counts ?? null,
      by_person: votes[0]?.by_person ?? [],
      officials: votes[0]?.officials ?? [],
      votes_on: votes[0]?.votes_on ?? [],
    },
    {
      kind: "attachment",
      matched: attachmentMatched,
      documents: docs,
    },
  ];

  const matchedCount = stages.filter((s) => s.matched).length;
  const gaps = stages
    .filter((s) => !s.matched)
    .map((s) => ({
      slot: s.kind,
      class: matterMatched || s.kind === "agenda" ? "not_yet_ingested" : "not_yet_ingested",
      taxonomy: true,
      source: "NYC Council Legistar",
    }));

  const matterId = matter?.matter_id ?? null;
  const agendaItemId = item?.agenda_item_id ?? null;
  return {
    schema_version: MEETING_VOTE_SPINE_SCHEMA_VERSION,
    subject_ref: matterId
      ? `matter:${matterId}`
      : agendaItemId
        ? `agenda_item:${agendaItemId}`
        : null,
    event_id: event?.event_id ?? item?.event_id ?? null,
    agenda_item_id: agendaItemId,
    matter_id: matterId,
    stages,
    stage_fill: stages.length ? matchedCount / stages.length : 0,
    matched_stages: matchedCount,
    total_stages: stages.length,
    full: matchedCount === stages.length,
    gaps,
  };
}

/**
 * Build matter vote spines for one meeting-outcomes record (matched or not).
 * Unmatched notices yield an empty list.
 */
export function buildMeetingVoteSpines(record) {
  if (!record?.join?.matched) return [];
  const event = record.council_event || {};
  const eventDocs = Array.isArray(event.documents) ? event.documents : [];
  const spines = [];
  for (const item of record.agenda_items || []) {
    const matters = Array.isArray(item.matters) && item.matters.length ? item.matters : [{}];
    for (const matter of matters) {
      spines.push(buildMeetingVoteSpine({
        item,
        matter,
        event,
        eventDocuments: eventDocs,
      }));
    }
  }
  return spines;
}

/**
 * Named product metric: meeting_vote_spine_completeness_rate
 *
 * Mean stage_fill over matter-linked spines (agenda→matter→action→vote→attachment).
 * When no matter spines exist, falls back to all spines so unmatched paths stay measurable.
 *
 * @param {object[]} records - meeting-outcomes records (prefer with `.spines` stamped)
 * @returns {{ metric: string, meeting_vote_spine_completeness_rate: number, full_spine_rate: number, spine_count: number, matter_spine_count: number, stage_rates: object }}
 */
export function measureMeetingVoteSpineCompleteness(records = []) {
  const spines = [];
  for (const record of records || []) {
    const list = Array.isArray(record?.spines) && record.spines.length
      ? record.spines
      : buildMeetingVoteSpines(record);
    for (const spine of list) spines.push(spine);
  }
  const matterSpines = spines.filter((s) => s.matter_id);
  const pool = matterSpines.length ? matterSpines : spines;
  const stageCounts = Object.fromEntries(MEETING_VOTE_SPINE_STAGES.map((k) => [k, 0]));
  let fillSum = 0;
  let full = 0;
  for (const spine of pool) {
    fillSum += Number(spine.stage_fill) || 0;
    if (spine.full) full += 1;
    for (const stage of spine.stages || []) {
      if (stage.matched && Object.prototype.hasOwnProperty.call(stageCounts, stage.kind)) {
        stageCounts[stage.kind] += 1;
      }
    }
  }
  const n = pool.length;
  const stage_rates = {};
  for (const kind of MEETING_VOTE_SPINE_STAGES) {
    stage_rates[kind] = n === 0 ? 0 : stageCounts[kind] / n;
  }
  return {
    metric: "meeting_vote_spine_completeness_rate",
    meeting_vote_spine_completeness_rate: n === 0 ? 0 : fillSum / n,
    full_spine_rate: n === 0 ? 0 : full / n,
    spine_count: n,
    matter_spine_count: matterSpines.length,
    stage_rates,
  };
}

/**
 * Index roll-call summaries by the agenda item they were recorded on.
 *
 * A matter is heard more than once — a hearing in March and an approval in
 * April, or two actions at one meeting — and each of those is a separate roll
 * call, or no roll call at all. Keying summaries by matter alone made the last
 * one observed stand in for every appearance, which shows a reader one meeting's
 * vote under another meeting's date, and turns "no roll call was taken here"
 * into a full roster that was never cast.
 *
 * Resolution is therefore by exact publisher identity:
 *   1. the event item the votes were fetched from;
 *   2. failing that, the event and matter together;
 *   3. and for a summary that carries neither, only when that matter appears on
 *      exactly one item in the whole input, so an unattributable summary can
 *      never be copied across meetings.
 *
 * @param {object[]} voteRows summaries from collectVoteSummaries (or a caller's fixtures)
 * @param {object[]} items normalized agenda items across every event
 */
export function indexVoteSummaries(voteRows = [], items = []) {
  const clean = (value) => String(value ?? "").trim();
  const byEventItem = new Map();
  const byEventMatter = new Map();
  const unbound = new Map();

  const itemCountByMatter = new Map();
  const itemCountByEventMatter = new Map();
  const knownItemIds = new Set();
  for (const item of items || []) {
    const agendaItemId = clean(item?.agenda_item_id);
    if (agendaItemId) knownItemIds.add(agendaItemId);
    const matterId = clean(item?.matter_id);
    if (!matterId) continue;
    itemCountByMatter.set(matterId, (itemCountByMatter.get(matterId) || 0) + 1);
    const eventId = clean(item?.event_id);
    if (!eventId) continue;
    const key = `${eventId}\u0000${matterId}`;
    itemCountByEventMatter.set(key, (itemCountByEventMatter.get(key) || 0) + 1);
  }

  for (const summary of voteRows || []) {
    if (!summary) continue;
    const eventItemId = clean(summary.event_item_id ?? summary.agenda_item_id);
    const eventId = clean(summary.event_id);
    const matterId = clean(summary.matter_id);
    if (eventItemId) byEventItem.set(eventItemId, summary);
    // An item id this input does not carry cannot address anything, so the
    // coarser keys stay available for a summary stamped by an older generation.
    if (eventItemId && knownItemIds.has(eventItemId)) continue;
    if (eventId && matterId) {
      byEventMatter.set(`${eventId}\u0000${matterId}`, summary);
      continue;
    }
    if (matterId) unbound.set(matterId, summary);
  }

  return {
    /**
     * The roll call recorded on this agenda item, or null when none was.
     * @param {object} item normalized agenda item
     */
    resolve(item) {
      const agendaItemId = clean(item?.agenda_item_id);
      if (agendaItemId && byEventItem.has(agendaItemId)) return byEventItem.get(agendaItemId);
      const eventId = clean(item?.event_id);
      const matterId = clean(item?.matter_id);
      // Event and matter together address one appearance only while that
      // meeting acted on the matter once. A meeting that heard it and then
      // laid it over acted twice, and only one of those may carry a roll call.
      if (eventId && matterId && itemCountByEventMatter.get(`${eventId}\u0000${matterId}`) === 1) {
        const hit = byEventMatter.get(`${eventId}\u0000${matterId}`);
        if (hit) return hit;
      }
      // An unattributed summary is attachable only where attachment is
      // unambiguous. Two appearances of one matter make it ambiguous, and an
      // ambiguous summary is dropped rather than duplicated.
      if (matterId && itemCountByMatter.get(matterId) === 1) {
        const hit = unbound.get(matterId);
        if (hit) return hit;
      }
      return null;
    },
  };
}

/**
 * Build matter cards from one event's normalized items, attaching the
 * roll-call vote summary recorded on that item and per-item attachments (plus
 * event docs).
 */
export function assembleAgenda(items, voteIndex, docsByItem = new Map()) {
  const rows = [];
  for (const item of items) {
    const itemDocs = docsByItem.get(String(item.agenda_item_id)) || [];
    const matters = [];
    if (item.matter_id) {
      const voteSummary = voteIndex.resolve(item);
      const votes = projectVoteSummary(voteSummary, item);
      matters.push({
        matter_id: item.matter_id,
        matter_file: item.matter_file,
        // The agenda item and event this card is a projection of. Identity
        // travels with the evidence rather than being re-derived downstream.
        agenda_item_id: item.agenda_item_id ?? null,
        event_id: item.event_id ?? null,
        // Deep outbound when MatterId is numeric (Gateway M=L); null for non-numeric ids.
        matter_url: matterDetailUrl(item.matter_id),
        title: item.matter_name || item.title,
        body_text: item.body_text || item.action_text,
        status: item.matter_status,
        outcome: item.action_name,
        passed: item.passed_flag,
        votes,
        documents: itemDocs,
        join: { matched: true, reason: null },
      });
    } else {
      matters.push({
        matter_id: null,
        agenda_item_id: item.agenda_item_id ?? null,
        event_id: item.event_id ?? null,
        title: item.title,
        body_text: item.body_text,
        status: null,
        outcome: item.action_name || null,
        passed: item.passed_flag || null,
        votes: [],
        documents: itemDocs,
        join: { matched: false, reason: "Agenda item has no linked Council matter yet." },
      });
    }
    rows.push({
      agenda_item_id: item.agenda_item_id,
      agenda_number: item.agenda_number,
      title: item.title,
      body_text: item.body_text,
      matters,
      join: {
        matched: matters.some((m) => m.matter_id),
        reason: null,
      },
    });
  }
  return rows;
}

/**
 * Pure assembly: strict-join City Record notices to Legistar events, then fold
 * inline agenda items / matters / outcomes / votes into per-notice records.
 *
 * @param {object[]} noticeRows   — raw City Record (SODA) notice rows
 * @param {object[]} eventRows    — raw authenticated Legistar Event rows
 * @param {object[]} eventItemRows— raw Legistar EventItem rows (inline matters)
 * @param {object[]} voteRows     — roll-call summaries [{matter_id,event_id,event_item_id,result,counts,by_person?,officials?,votes_on?}]
 * @param {object[]} attachmentRows — [{agenda_item_id, documents: [{url,name,category}]}]
 */
export function buildMeetingOutcomes(noticeRows, eventRows, eventItemRows, voteRows, attachmentRows = [], options = {}) {
  const emitJson = options?.emitJson === true;
  const jsonParts = [];
  const matchedEventIds = new Set();
  let matchedCount = 0;
  let agendaItemCount = 0;
  let matterCount = 0;
  let voteCount = 0;
  let matterDocCount = 0;
  let eventDocCount = 0;
  const spineMatter = { n: 0, fill: 0, full: 0, stages: Object.fromEntries(MEETING_VOTE_SPINE_STAGES.map((kind) => [kind, 0])) };
  const spineAll = { n: 0, fill: 0, full: 0, stages: Object.fromEntries(MEETING_VOTE_SPINE_STAGES.map((kind) => [kind, 0])) };
  const noteSpine = (spine) => {
    const pools = spine?.matter_id ? [spineMatter, spineAll] : [spineAll];
    for (const pool of pools) {
      pool.n += 1;
      pool.fill += Number(spine.stage_fill) || 0;
      if (spine.full) pool.full += 1;
      for (const stage of spine.stages || []) {
        if (stage.matched && Object.prototype.hasOwnProperty.call(pool.stages, stage.kind)) {
          pool.stages[stage.kind] += 1;
        }
      }
    }
  };
  const notices = (noticeRows || []).map(normalizeNoticeForOutcomes).filter((n) => n.request_id);
  const events = (eventRows || []).map(normalizeCouncilEvent).filter((e) => e.event_id);
  const items = (eventItemRows || []).map(normalizeCouncilAgendaItem).filter((i) => i.event_id);
  const voteIndex = indexVoteSummaries(voteRows, items);
  const docsByItem = new Map();
  for (const row of (attachmentRows || [])) {
    if (!row?.agenda_item_id) continue;
    docsByItem.set(String(row.agenda_item_id), Array.isArray(row.documents) ? row.documents : []);
  }

  const itemsByEvent = groupBy(items, (i) => String(i.event_id));
  const eventsById = new Map(events.map((e) => [String(e.event_id), e]));
  const byDate = buildMeetingDateIndex(eventRows);

  const matchedRecords = [];
  const unmatchedNotices = [];
  const keepRecord = (record, matched) => {
    if (matched) {
      matchedCount += 1;
      if (record.council_event?.event_id) matchedEventIds.add(String(record.council_event.event_id));
      agendaItemCount += record.agenda_items?.length || 0;
      eventDocCount += record.council_event?.documents?.length || 0;
      for (const item of record.agenda_items || []) {
        for (const matter of item.matters || []) {
          if (matter?.matter_id) matterCount += 1;
          voteCount += matter?.votes?.length || 0;
          matterDocCount += matter?.documents?.length || 0;
        }
      }
      for (const spine of record.spines || []) noteSpine(spine);
    }
    if (emitJson) jsonParts.push(JSON.stringify(record));
    else if (matched) matchedRecords.push(record);
    else unmatchedNotices.push(record);
  };

  for (const notice of notices) {
    const hit = joinNoticeToCouncilMeeting(
      { event_date: notice.event_date, short_title: notice.title, title: notice.title },
      byDate,
    );
    if (!hit) {
      const unmatched = {
        request_id: notice.request_id,
        join: {
          matched: false,
          method: null,
          reason: "No Council event matched this City Record notice on the strict date + body join.",
        },
        notice: { ...notice },
        council_event: null,
        agenda_items: [],
        spines: [],
      };
      const subjects = linksFromMeetingRecord(unmatched);
      unmatched.subject_refs = subjects.subject_refs;
      unmatched.subject_links = subjects.subject_links;
      keepRecord(unmatched, false);
      continue;
    }
    const event = eventsById.get(String(hit.event_id));
    if (!event) {
      const unmatched = {
        request_id: notice.request_id,
        join: { matched: false, method: null, reason: "Joined event id not present in the event set." },
        notice: { ...notice },
        council_event: null,
        agenda_items: [],
        spines: [],
      };
      const subjects = linksFromMeetingRecord(unmatched);
      unmatched.subject_refs = subjects.subject_refs;
      unmatched.subject_links = subjects.subject_links;
      keepRecord(unmatched, false);
      continue;
    }
    const docs = eventDocuments(event);
    const eventItems = itemsByEvent.get(String(event.event_id)) || [];
    const agenda = eventItems.length
      ? assembleAgenda(eventItems, voteIndex, docsByItem)
      : [{
        agenda_item_id: null,
        title: null,
        body_text: null,
        matters: [{
          matter_id: null,
          title: null,
          status: null,
          outcome: null,
          votes: [],
          documents: [],
          join: { matched: false, reason: "Council event exists but has no agenda items published yet." },
        }],
        join: { matched: false, reason: "No agenda items returned for this event yet." },
      }];

    const matchedRecord = {
      request_id: notice.request_id,
      join: {
        matched: true,
        method: hit.method,
        reason: null,
      },
      notice: {
        request_id: notice.request_id,
        agency: notice.agency,
        title: notice.title,
        section_name: notice.section_name,
        notice_type: notice.notice_type,
        start_date: notice.start_date,
        event_date: notice.event_date,
        source_url: notice.source_url,
        meeting_origin: notice.meeting_origin,
        affected_area: notice.affected_area,
        venue: notice.venue,
      },
      council_event: {
        event_id: event.event_id,
        title: event.title,
        body_name: event.body_name,
        event_url: event.event_url || meetingDetailUrl({ EventId: event.event_id }),
        start_time: event.start_time,
        event_date: event.event_date,
        venue: event.venue,
        documents: docs,
      },
      agenda_items: agenda,
    };
    // Matter-centric legislative path: agenda → matter → action → vote → attachment.
    matchedRecord.spines = buildMeetingVoteSpines(matchedRecord);
    // Subject registry: notice ↔ legistar-event only when join resolved (no invent).
    const matchedSubjects = linksFromMeetingRecord(matchedRecord);
    matchedRecord.subject_refs = matchedSubjects.subject_refs;
    matchedRecord.subject_links = matchedSubjects.subject_links;
    keepRecord(matchedRecord, true);
  }

  const unmatchedEvents = events
    .filter((e) => !matchedEventIds.has(String(e.event_id)))
    .map((e) => ({
      event_id: e.event_id,
      title: e.title,
      event_date: e.event_date,
      join: { matched: false, reason: "No City Record notice matched this Council event in the look-back window." },
    }));

  const spinePool = spineMatter.n ? spineMatter : spineAll;
  const spineStageRates = {};
  for (const kind of MEETING_VOTE_SPINE_STAGES) {
    spineStageRates[kind] = spinePool.n === 0 ? 0 : spinePool.stages[kind] / spinePool.n;
  }
  const streamedSpineMetric = {
    meeting_vote_spine_completeness_rate: spinePool.n === 0 ? 0 : spinePool.fill / spinePool.n,
    full_spine_rate: spinePool.n === 0 ? 0 : spinePool.full / spinePool.n,
    spine_count: spinePool.n,
    stage_rates: spineStageRates,
  };
  const retainedSpineMetric = emitJson ? null : measureMeetingVoteSpineCompleteness(matchedRecords);
  const spineMetric = retainedSpineMetric || streamedSpineMetric;
  const retainedMatters = emitJson
    ? null
    : matchedRecords.flatMap((record) => record.agenda_items.flatMap((item) => item.matters));
  const counts = {
    notices: notices.length,
    matched_notices: emitJson ? matchedCount : matchedRecords.length,
    unmatched_notices: emitJson ? jsonParts.length - matchedCount : unmatchedNotices.length,
    unmatched_events: unmatchedEvents.length,
    agenda_items: emitJson
      ? agendaItemCount
      : matchedRecords.reduce((sum, record) => sum + record.agenda_items.length, 0),
    matters: emitJson
      ? matterCount
      : retainedMatters.filter((matter) => matter.matter_id).length,
    votes: emitJson
      ? voteCount
      : retainedMatters.reduce((sum, matter) => sum + (matter.votes?.length || 0), 0),
    documents: emitJson
      ? matterDocCount + eventDocCount
      : retainedMatters.reduce((sum, matter) => sum + (matter.documents?.length || 0), 0)
        + matchedRecords.reduce((sum, record) => sum + (record.council_event?.documents?.length || 0), 0),
    spines: spineMetric.spine_count,
    full_spines: Math.round(spineMetric.full_spine_rate * spineMetric.spine_count),
    records: emitJson ? jsonParts.length : matchedRecords.length + unmatchedNotices.length,
    event_rows: events.length,
  };
  const source = {
    primary: {
      name: "City Record Online",
      dataset: "dg92-zbpx",
      url: "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx",
    },
    enrichment: {
      name: "NYC Council Legistar (authenticated Web API)",
      base_url: "https://webapi.legistar.com/v1/nyc",
    },
  };
  const metrics = {
    meeting_vote_spine_completeness_rate: spineMetric.meeting_vote_spine_completeness_rate,
    full_spine_rate: spineMetric.full_spine_rate,
    stage_rates: spineMetric.stage_rates,
  };
  const joinPolicy = {
    strategy: "exact_date_body_tokens",
    required_fields: ["event_date", "short_title"],
    note: "Strict join: notice event_date equals EventDate AND the meeting body is uniquely named in the notice title.",
  };
  const generatedAt = new Date().toISOString();
  if (emitJson) {
    const head = JSON.stringify({
      schema_version: MEETING_OUTCOMES_VIEW_VERSION,
      generated_at: generatedAt,
      source,
      counts,
      metrics,
    });
    const tail = JSON.stringify({ unmatched_events: unmatchedEvents, join_policy: joinPolicy });
    return {
      schema_version: MEETING_OUTCOMES_VIEW_VERSION,
      generated_at: generatedAt,
      source,
      counts,
      metrics,
      unmatched_events: unmatchedEvents,
      join_policy: joinPolicy,
      json: `${head.slice(0, -1)},"records":[${jsonParts.join(",")}],${tail.slice(1)}`,
    };
  }

  return {
    schema_version: MEETING_OUTCOMES_VIEW_VERSION,
    generated_at: generatedAt,
    source,
    counts,
    metrics,
    records: [...matchedRecords, ...unmatchedNotices],
    unmatched_events: unmatchedEvents,
    join_policy: joinPolicy,
  };
}

async function buildNoticeRows(
  fetchImpl,
  now = new Date(),
  { lookbackDays = 180, noticeLimit = NOTICE_LIMIT, retry = readRetryPolicy() } = {},
) {
  const boundedLookbackDays = Math.max(1, Math.min(3660, Number.parseInt(String(lookbackDays), 10) || 180));
  const boundedNoticeLimit = Math.max(1, Math.min(5000, Number.parseInt(String(noticeLimit), 10) || NOTICE_LIMIT));
  const since = new Date(now.getTime() - boundedLookbackDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    $select: NOTICE_SELECT,
    $where: `(section_name='Public Hearings and Meetings' OR (section_name='Agency Rules' AND type_of_notice_description='Public Hearings' AND event_date IS NOT NULL)) AND event_date >= '${since}T00:00:00'`,
    $order: "event_date DESC",
    $limit: String(boundedNoticeLimit),
  });
  for (let attempt = 0; ; attempt += 1) {
    const delayMs = retry.delaysMs[attempt];
    let response;
    try {
      response = await fetchImpl(`${SODA}?${params}`);
    } catch (error) {
      if (delayMs == null) throw error;
      await retry.waitFn(delayMs);
      continue;
    }
    if (response.ok) {
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error("City Record notices response is not an array");
      return payload;
    }
    const error = new Error(`City Record notices ${response.status}`);
    if (delayMs == null || !TRANSIENT_UPSTREAM_STATUSES.has(response.status)) throw error;
    // Release the failed body before the next attempt takes another connection.
    await response.body?.cancel?.();
    await retry.waitFn(delayMs);
  }
}

/**
 * Collect best-effort roll-call vote summaries for matter-bearing items flagged
 * for roll call. Bounded per-event and per-run so the materialization stays polite.
 * Also returns publisher-raw person vote rows (EventItemId stamped) for dual-write.
 */
async function collectVoteSummaries({ eventItemRows, token, fetchImpl }) {
  const flagged = eventItemRows.filter(
    (it) => it && it.EventItemMatterId && (it.EventItemRollCallFlag || it.EventItemPassedFlagName),
  );
  const byEvent = groupBy(flagged, (it) => String(it.EventItemEventId));
  const summaries = [];
  const rawVotes = [];
  let total = 0;
  for (const [, evItems] of byEvent) {
    let perEvent = 0;
    for (const it of evItems) {
      if (perEvent >= MAX_VOTE_PROBES_PER_EVENT || total >= MAX_TOTAL_VOTE_PROBES) break;
      perEvent += 1;
      total += 1;
      try {
        const rows = await fetchLegistarItemVoteRows({
          itemId: it.EventItemId,
          token,
          fetchImpl,
        });
        if (!rows.length) continue;
        for (const row of rows) {
          rawVotes.push({
            ...row,
            EventItemId: it.EventItemId,
            EventItemMatterId: it.EventItemMatterId,
          });
        }
        const summary = summarizeLegistarVotes(rows, {
          matterId: String(it.EventItemMatterId),
          agendaItemId: String(it.EventItemId),
          eventItemId: it.EventItemId,
          eventId: it.EventItemEventId,
        });
        if (summary) {
          // A roll call belongs to one agenda item at one meeting. Carrying that
          // identity out of collection is what stops one meeting's vote from
          // being shown against another appearance of the same matter.
          summaries.push({
            matter_id: String(it.EventItemMatterId),
            event_id: String(it.EventItemEventId ?? ""),
            event_item_id: String(it.EventItemId ?? ""),
            ...summary,
          });
        }
      } catch {
        // Best-effort: a single vote fetch failure is non-fatal.
      }
    }
  }
  return { summaries, rawVotes };
}

/**
 * Project attachment metadata already embedded in EventItem rows. Legistar's
 * published API exposes matter attachments on EventItems; it does not expose a
 * nested EventItems/{id}/Attachments route. Keeping this projection local also
 * prevents hundreds of guaranteed-failing serial requests before KV publish.
 */
function collectEmbeddedAttachments({ eventItemRows }) {
  const out = [];
  const rawAttachments = [];
  const retainedByEvent = new Map();
  let retainedTotal = 0;
  for (const item of eventItemRows) {
    if (!item?.EventItemId || !item?.EventItemMatterId) continue;
    const eventId = String(item.EventItemEventId ?? "");
    const retainedForEvent = retainedByEvent.get(eventId) || 0;
    const available = Math.min(
      MAX_EMBEDDED_ATTACHMENTS_PER_EVENT - retainedForEvent,
      MAX_TOTAL_EMBEDDED_ATTACHMENTS - retainedTotal,
    );
    if (available <= 0) continue;
    const rows = Array.isArray(item.EventItemMatterAttachments)
      ? item.EventItemMatterAttachments.filter(Boolean)
        .slice(0, available)
      : [];
    if (!rows.length) continue;
    retainedByEvent.set(eventId, retainedForEvent + rows.length);
    retainedTotal += rows.length;
    for (const row of rows) {
      rawAttachments.push({
        ...row,
        EventItemId: item.EventItemId,
      });
    }
    const documents = projectLegistarAttachmentDocuments(rows);
    if (documents.length) {
      out.push({ agenda_item_id: String(item.EventItemId), documents });
    }
  }
  return { attachmentRows: out, rawAttachments };
}

/**
 * Fetch + assemble the full meeting-outcomes view. When no token is configured
 * the view degrades to notices-only with explicit "not yet ingested" gaps.
 *
 * When `env` is provided and LEGISTAR_SOURCE_RECORD_DUAL_WRITE is on, raw
 * Events / EventItems / Votes / Attachments are fail-soft dual-written into
 * source_records without changing the public KV view. Each publisher page is
 * written and then reduced to the fields the projections read, before the
 * public view is assembled, so the isolate does not hold the publisher window
 * and the assembled records at the same time. `deferShadowWrites` remains
 * accepted for callers that used to postpone that work; shadow writes now
 * finish before assembly either way.
 */
export async function buildMeetingOutcomesView({
  token = null,
  fetchImpl = fetch,
  now = new Date(),
  env = null,
  deferShadowWrites = false,
  emitJson = false,
  lookbackDays = 180,
  noticeLimit = NOTICE_LIMIT,
  readRetry = {},
} = {}) {
  const retry = readRetryPolicy(readRetry);
  const noticeRows = await buildNoticeRows(fetchImpl, now, { lookbackDays, noticeLimit, retry });
  const assemblyOptions = emitJson ? { emitJson: true } : {};

  if (!token) {
    const view = buildMeetingOutcomes(noticeRows, [], [], [], [], assemblyOptions);
    return {
      ...view,
      upcoming: { publishable: false, reason: "token-absent", view: null },
    };
  }

  const acquiredAt = new Date(now).toISOString();
  const shadowResults = [];
  const publisherSpills = [];
  let spillSeq = 0;
  const shadowBags = async (bags) => {
    if (!env) return;
    if (deferShadowWrites) {
      // Park each publisher batch outside the live object graph. The refresh
      // replays these values only after the public snapshot is stored. Without
      // a database there is no shadow write to replay, so the batch is dropped.
      if (!env.DB || !env.ALERT_STATE?.put) return;
      for (const [kind, rows] of Object.entries(bags)) {
        if (!Array.isArray(rows) || rows.length === 0) continue;
        const key = `meeting-outcomes:publisher-spill:v1:${kind}:${spillSeq}`;
        spillSeq += 1;
        await env.ALERT_STATE.put(key, JSON.stringify(rows), { expirationTtl: 60 * 60 });
        publisherSpills.push({ key, kind });
      }
      return;
    }
    shadowResults.push(await dualWriteLegistarObservations(env, bags, acquiredAt));
  };

  // One shared authenticated Events acquisition serves both materializations
  // (no second Events request). A failure — rate limiting, malformed payload,
  // transport — fails the whole refresh so last-known-good KV snapshots for
  // both read models are retained. Each page is persisted and stripped before
  // the next page is retained.
  const eventsFetch = await fetchLegistarEventsWindowWithRetry({
    token,
    fetchImpl,
    now,
    lookbackDays,
    onPage: async (pageRows) => {
      await shadowBags({ events: pageRows });
      stripPublisherRows(pageRows, COUNCIL_EVENT_KEYS);
    },
  }, retry);
  if (!eventsFetch.ok) {
    await discardPublisherSpills(env, publisherSpills);
    throw new Error(`legistar-events-${eventsFetch.kind}${eventsFetch.status ? `-${eventsFetch.status}` : ""}`);
  }
  const eventRows = eventsFetch.rows;

  // Strict join first so outcome EventItems are fetched for matched events;
  // the upcoming-council-meetings materialization extends the same bounded
  // fan-out to eligible upcoming events — no City Record notice required.
  const byDate = buildMeetingDateIndex(eventRows);
  const matchedEventIds = new Set();
  const cityRecordByEventId = new Map();
  for (const row of noticeRows) {
    const notice = normalizeNoticeForOutcomes(row);
    if (!notice.request_id) continue;
    const hit = joinNoticeToCouncilMeeting(
      { event_date: notice.event_date, short_title: notice.title, title: notice.title },
      byDate,
    );
    if (!hit) continue;
    matchedEventIds.add(String(hit.event_id));
    // The first joined notice per event supplies link metadata only; it never
    // merges or replaces the event's source-qualified identity.
    if (!cityRecordByEventId.has(String(hit.event_id))) {
      cityRecordByEventId.set(String(hit.event_id), {
        request_id: notice.request_id,
        method: hit.method,
      });
    }
  }

  const matchedEvents = eventRows.filter((e) => matchedEventIds.has(String(e.EventId)));
  const upcomingBounds = upcomingWindow(now);
  const eligibleUpcoming = eventRows.filter((raw) => isEligibleUpcomingEvent(raw, upcomingBounds));
  const upcomingTargets = selectUpcomingItemTargets(eligibleUpcoming, matchedEventIds).targets;
  const itemBatches = await boundedMap(
    [...matchedEvents, ...upcomingTargets],
    async (ev) => {
      try {
        const eventId = String(ev.EventId);
        const upcomingOnly = !matchedEventIds.has(eventId);
        const rows = await fetchLegistarEventItems({
          eventId: ev.EventId,
          token,
          fetchImpl,
          ...(upcomingOnly ? { top: UPCOMING_COUNCIL_MEETINGS_AGENDA_ITEMS_MAX } : {}),
        });
        // Meeting outcomes need every item for strictly joined historical
        // events. Upcoming-only events ask the publisher for a bounded resident
        // preview so six publisher-max response bodies cannot overlap while
        // sixty full arrays accumulate in one isolate. Keep the slice as a
        // defense for fixture clients that do not honor the requested top.
        const retainedRows = upcomingOnly
          ? rows.slice(0, UPCOMING_COUNCIL_MEETINGS_AGENDA_ITEMS_MAX)
          : rows;
        const embedded = collectEmbeddedAttachments({ eventItemRows: retainedRows });
        await shadowBags({ eventItems: retainedRows, attachments: embedded.rawAttachments });
        // Strip the whole response, including rows the upcoming cap did not keep.
        stripPublisherRows(rows, COUNCIL_ITEM_KEYS);
        return {
          event_id: eventId,
          rows: retainedRows,
          observed_rows: retainedRows.length,
          truncated: upcomingOnly && rows.length >= UPCOMING_COUNCIL_MEETINGS_AGENDA_ITEMS_MAX,
          fetchError: null,
        };
      } catch (error) {
        return {
          event_id: String(ev.EventId),
          rows: [],
          observed_rows: 0,
          truncated: false,
          fetchError: String(error?.message || error),
        };
      }
    },
    UPCOMING_COUNCIL_MEETINGS_ITEM_CONCURRENCY,
  );
  const itemsByEventId = new Map(itemBatches.map((batch) => [batch.event_id, batch]));
  const eventItemRows = itemBatches.flatMap((batch) => batch.rows);

  const attachmentBag = collectEmbeddedAttachments({ eventItemRows });
  const voteBag = await collectVoteSummaries({ eventItemRows, token, fetchImpl });
  await shadowBags({ votes: voteBag.rawVotes });
  stripPublisherRows(voteBag.rawVotes, COUNCIL_VOTE_KEYS);

  // Journal after the publisher payloads have been reduced and before the
  // public records exist. Source-record inserts here are ignored when the
  // per-page dual-write already stored the full publisher row.
  const matterJournal = env && !deferShadowWrites
    ? await retainNativeMatterObservations(env, {
      events: eventRows,
      eventItems: eventItemRows,
      votes: voteBag.rawVotes,
    }, { acquiredAt })
    : null;
  const dualWrite = shadowResults.length
    ? {
      written: shadowResults.reduce((sum, result) => sum + (result?.written || 0), 0),
      failed: shadowResults.some((result) => result?.failed),
      skipped: shadowResults.every((result) => !result?.written)
        ? (shadowResults.find((result) => result?.skipped)?.skipped || null)
        : null,
      streams: shadowResults.flatMap((result) => result?.streams || []),
    }
    : null;
  if (
    token
    && eventRows.length > 0
    && dualWrite
    && dualWrite.skipped !== "flag-off"
    && dualWrite.skipped !== "no-db"
    && dualWrite.skipped !== "no-schema"
    && (dualWrite.written || 0) <= 0
  ) {
    console.error(
      "legistar source_records dual-write wrote 0 rows after authenticated fetch:",
      JSON.stringify(dualWrite),
    );
  }

  const view = buildMeetingOutcomes(
    noticeRows,
    eventRows,
    eventItemRows,
    voteBag.summaries,
    attachmentBag.attachmentRows,
    assemblyOptions,
  );

  // Distinct first-class materialization: sanitized upcoming Council meetings
  // (eligible events inside the documented horizon, matched or not).
  const upcoming = buildUpcomingCouncilMeetingsView({
    eventRows,
    itemsByEventId,
    now,
    cityRecordByEventId,
    eventsFetch,
  });

  return {
    ...view,
    upcoming,
    dual_write: dualWrite,
    matter_journal: matterJournal,
    ...(deferShadowWrites ? { _publisher_spills: publisherSpills, _acquired_at: acquiredAt } : {}),
  };
}

export async function refreshMeetingOutcomes(env, fetchImpl = fetch, now = new Date(), { readRetry } = {}) {
  if (!env?.ALERT_STATE) return { status: "skipped", reason: "no-kv" };
  const token = env?.LEGISTAR_API_TOKEN || null;
  const view = await buildMeetingOutcomesView({
    token,
    fetchImpl,
    now,
    env,
    emitJson: true,
    deferShadowWrites: true,
    readRetry,
  });
  // dual_write, matter_journal, and the upcoming build state are run-scoped —
  // strip the first two so public clients never see them; the upcoming view is
  // materialized under its own read-model key, not folded into this one.
  const {
    dual_write: dualWrite,
    matter_journal: matterJournal,
    upcoming,
    json,
    _publisher_spills: publisherSpills,
    _acquired_at: acquiredAt,
    ...publicView
  } = view;

  // Sanitization gate before any KV write: a credential-bearing projection
  // fails the refresh with both read models' last-known-good snapshots intact.
  if (upcoming?.publishable) assertPublicUpcomingProjection(upcoming.view);

  const publicJson = json || JSON.stringify(publicView);
  let upcomingJson = null;
  let upcomingCounts = null;
  if (upcoming?.publishable) {
    upcomingCounts = upcoming.view.counts;
    upcomingJson = JSON.stringify(upcoming.view);
    upcoming.view = null;
  }

  await env.ALERT_STATE.put(MEETING_OUTCOMES_KV_KEY, publicJson);

  // Token absence or an empty-source refusal retains the last-known-good
  // upcoming snapshot; the state is published as unavailable (never as a
  // successful empty source).
  let upcomingWrite = { status: "unavailable", reason: "token-absent" };
  if (upcomingJson) {
    await env.ALERT_STATE.put(UPCOMING_COUNCIL_MEETINGS_KV_KEY, upcomingJson);
    upcomingWrite = { status: "success", ...upcomingCounts };
  } else if (upcoming) {
    upcomingWrite = { status: "unavailable", reason: upcoming.reason };
  }

  // Publisher spills are replayed only after both public snapshots are stored,
  // and one batch at a time so the assembled view is not live beside them.
  const shadow = await replayPublisherSpills(env, publisherSpills, acquiredAt || publicView.generated_at);

  return {
    status: token ? "success" : "no-token",
    enrichment: token ? "authenticated" : "unavailable",
    ...publicView.counts,
    upcoming: upcomingWrite,
    dual_write: shadow.dualWrite || dualWrite || null,
    matter_journal: shadow.matterJournal || matterJournal || null,
  };
}

async function discardPublisherSpills(env, spills) {
  for (const spill of spills || []) {
    await env?.ALERT_STATE?.delete?.(spill.key);
  }
}

async function replayPublisherSpills(env, spills, acquiredAt) {
  const list = Array.isArray(spills) ? spills : [];
  if (!env || list.length === 0) return { dualWrite: null, matterJournal: null };
  const results = [];
  const journalBags = { events: [], eventItems: [], votes: [], attachments: [] };
  for (const spill of list) {
    const stored = await env.ALERT_STATE?.get?.(spill.key);
    if (typeof stored === "string" && stored) {
      let rows = [];
      try {
        rows = JSON.parse(stored);
      } catch {
        rows = [];
      }
      if (Array.isArray(rows) && rows.length && Object.prototype.hasOwnProperty.call(journalBags, spill.kind)) {
        results.push(await dualWriteLegistarObservations(env, { [spill.kind]: rows }, acquiredAt));
        journalBags[spill.kind].push(...rows);
      }
    }
    await env.ALERT_STATE?.delete?.(spill.key);
  }
  const matterJournal = await retainNativeMatterObservations(env, journalBags, { acquiredAt });
  const dualWrite = results.length
    ? {
      written: results.reduce((sum, result) => sum + (result?.written || 0), 0),
      failed: results.some((result) => result?.failed),
      skipped: results.every((result) => !result?.written)
        ? (results.find((result) => result?.skipped)?.skipped || null)
        : null,
      streams: results.flatMap((result) => result?.streams || []),
    }
    : null;
  return { dualWrite, matterJournal };
}

export function applyApiLimits(rows, params = {}) {
  const limit = clamp(params.limit, 1, API_RECORD_LIMIT, API_RECORD_LIMIT);
  const offset = Math.max(0, Number.parseInt(String(params.offset || "0"), 10) || 0);
  const parsed = Array.isArray(rows) ? rows : [];
  const slice = parsed.slice(offset, offset + limit);
  return {
    limit,
    offset,
    requested: Number.parseInt(String(params.limit || ""), 10),
    total: parsed.length,
    returned: slice.length,
    rows: slice,
  };
}
