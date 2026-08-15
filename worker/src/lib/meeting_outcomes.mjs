// Daily materialized meeting-outcome read model for NYC Council.
//
// City Record remains the event-discovery layer; the authenticated NYC Council
// Legistar Web API (webapi.legistar.com/v1/nyc, secret LEGISTAR_API_TOKEN)
// enriches outcomes — agenda items, matters, action outcomes, roll-call votes,
// and hearing documents — once a council event is strictly joined to a notice.
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
  fetchLegistarEvents,
  fetchLegistarEventItems,
  fetchLegistarItemVoteRows,
  fetchLegistarItemAttachmentRows,
  projectLegistarAttachmentDocuments,
  summarizeLegistarVotes,
  boundedMap,
  MAX_VOTE_PROBES_PER_EVENT,
  MAX_TOTAL_VOTE_PROBES,
  MAX_ATTACHMENT_PROBES_PER_EVENT,
  MAX_TOTAL_ATTACHMENT_PROBES,
} from "./legistar_client.mjs";
import { dualWriteLegistarObservations } from "./legistar_source_records.mjs";
import { linksFromMeetingRecord } from "./subject_registry.mjs";

/** Bump when vote/person mapping or spine assembly changes so young-but-stale KV rebuilds. */
export const MEETING_OUTCOMES_VIEW_VERSION = 3;
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
export const NOTICE_LIMIT = 500;
export const API_RECORD_LIMIT = 100;

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
    start_time: toDateIso(readFirst(raw, ["EventDate", "StartDate", "EventTime"])),
    event_date: toLocaleDate(readFirst(raw, ["EventDate", "StartDate", "Date"])),
    agenda_file: readFirst(raw, ["EventAgendaFile"]) || null,
    minutes_file: readFirst(raw, ["EventMinutesFile"]) || null,
    video_status: readFirst(raw, ["EventVideoStatus"]) || null,
    venue: normalizeCouncilLocation(raw),
    raw,
  };
}

/**
 * Normalize a Legistar EventItem. Items carry inline matter linkage
 * (EventItemMatterFile/Name/Status) and the action outcome
 * (EventItemActionName / EventItemPassedFlagName), so a single item row is both
 * the agenda line and its matter in one.
 */
function normalizeCouncilAgendaItem(raw = {}) {
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
    raw,
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
 * Build matter cards from one event's normalized items, attaching the
 * best-effort roll-call vote summary and per-item attachments (plus event docs).
 */
function assembleAgenda(items, voteByMatter, docsByItem = new Map()) {
  const rows = [];
  for (const item of items) {
    const itemDocs = docsByItem.get(String(item.agenda_item_id)) || [];
    const matters = [];
    if (item.matter_id) {
      const voteSummary = voteByMatter.get(String(item.matter_id));
      const votes = projectVoteSummary(voteSummary, item);
      matters.push({
        matter_id: item.matter_id,
        matter_file: item.matter_file,
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
 * @param {object[]} voteRows     — roll-call summaries [{matter_id,result,counts,by_person?,officials?,votes_on?}]
 * @param {object[]} attachmentRows — [{agenda_item_id, documents: [{url,name,category}]}]
 */
export function buildMeetingOutcomes(noticeRows, eventRows, eventItemRows, voteRows, attachmentRows = []) {
  const notices = (noticeRows || []).map(normalizeNoticeForOutcomes).filter((n) => n.request_id);
  const events = (eventRows || []).map(normalizeCouncilEvent).filter((e) => e.event_id);
  const items = (eventItemRows || []).map(normalizeCouncilAgendaItem).filter((i) => i.event_id);
  const voteByMatter = new Map();
  for (const v of (voteRows || [])) {
    if (v && v.matter_id) voteByMatter.set(String(v.matter_id), v);
  }
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
      unmatchedNotices.push(unmatched);
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
      unmatchedNotices.push(unmatched);
      continue;
    }
    const docs = eventDocuments(event);
    const eventItems = itemsByEvent.get(String(event.event_id)) || [];
    const agenda = eventItems.length
      ? assembleAgenda(eventItems, voteByMatter, docsByItem)
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
    matchedRecords.push(matchedRecord);
  }

  const matchedEventIds = new Set(matchedRecords.map((r) => r.council_event?.event_id).filter(Boolean));
  const unmatchedEvents = events
    .filter((e) => !matchedEventIds.has(String(e.event_id)))
    .map((e) => ({
      event_id: e.event_id,
      title: e.title,
      event_date: e.event_date,
      join: { matched: false, reason: "No City Record notice matched this Council event in the look-back window." },
    }));

  const allMatters = matchedRecords.flatMap((r) => r.agenda_items.flatMap((i) => i.matters));
  const totalVotes = allMatters.reduce((sum, m) => sum + (m.votes?.length || 0), 0);
  const matterDocs = allMatters.reduce((sum, m) => sum + (m.documents?.length || 0), 0);
  const eventDocs = matchedRecords.reduce((sum, r) => sum + (r.council_event?.documents?.length || 0), 0);
  const totalDocs = matterDocs + eventDocs;
  const spineMetric = measureMeetingVoteSpineCompleteness(matchedRecords);

  return {
    schema_version: MEETING_OUTCOMES_VIEW_VERSION,
    generated_at: new Date().toISOString(),
    source: {
      primary: {
        name: "City Record Online",
        dataset: "dg92-zbpx",
        url: "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx",
      },
      enrichment: {
        name: "NYC Council Legistar (authenticated Web API)",
        base_url: "https://webapi.legistar.com/v1/nyc",
      },
    },
    counts: {
      notices: notices.length,
      matched_notices: matchedRecords.length,
      unmatched_notices: unmatchedNotices.length,
      unmatched_events: unmatchedEvents.length,
      agenda_items: matchedRecords.reduce((sum, r) => sum + r.agenda_items.length, 0),
      matters: allMatters.filter((m) => m.matter_id).length,
      votes: totalVotes,
      documents: totalDocs,
      spines: spineMetric.spine_count,
      full_spines: Math.round(spineMetric.full_spine_rate * spineMetric.spine_count),
      records: matchedRecords.length + unmatchedNotices.length,
      event_rows: events.length,
    },
    metrics: {
      meeting_vote_spine_completeness_rate: spineMetric.meeting_vote_spine_completeness_rate,
      full_spine_rate: spineMetric.full_spine_rate,
      stage_rates: spineMetric.stage_rates,
    },
    records: [...matchedRecords, ...unmatchedNotices],
    unmatched_events: unmatchedEvents,
    join_policy: {
      strategy: "exact_date_body_tokens",
      required_fields: ["event_date", "short_title"],
      note: "Strict join: notice event_date equals EventDate AND the meeting body is uniquely named in the notice title.",
    },
  };
}

async function buildNoticeRows(
  fetchImpl,
  now = new Date(),
  { lookbackDays = 180, noticeLimit = NOTICE_LIMIT } = {},
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
  const response = await fetchImpl(`${SODA}?${params}`);
  if (!response.ok) throw new Error(`City Record notices ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("City Record notices response is not an array");
  return payload;
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
        });
        if (summary) {
          summaries.push({ matter_id: String(it.EventItemMatterId), ...summary });
        }
      } catch {
        // Best-effort: a single vote fetch failure is non-fatal.
      }
    }
  }
  return { summaries, rawVotes };
}

/**
 * Collect best-effort attachments for matter-bearing agenda items. Bounded like votes.
 * Also returns publisher-raw attachment rows (EventItemId stamped) for dual-write.
 */
async function collectAttachments({ eventItemRows, token, fetchImpl }) {
  const candidates = eventItemRows.filter((it) => it && it.EventItemId && it.EventItemMatterId);
  const byEvent = groupBy(candidates, (it) => String(it.EventItemEventId));
  const out = [];
  const rawAttachments = [];
  let total = 0;
  for (const [, evItems] of byEvent) {
    let perEvent = 0;
    for (const it of evItems) {
      if (perEvent >= MAX_ATTACHMENT_PROBES_PER_EVENT || total >= MAX_TOTAL_ATTACHMENT_PROBES) break;
      perEvent += 1;
      total += 1;
      try {
        const rows = await fetchLegistarItemAttachmentRows({
          itemId: it.EventItemId,
          token,
          fetchImpl,
        });
        if (!rows.length) continue;
        for (const row of rows) {
          rawAttachments.push({
            ...row,
            EventItemId: it.EventItemId,
          });
        }
        const documents = projectLegistarAttachmentDocuments(rows);
        if (documents.length) {
          out.push({ agenda_item_id: String(it.EventItemId), documents });
        }
      } catch {
        // Best-effort: a single attachment fetch failure is non-fatal.
      }
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
 * source_records without changing the public KV view.
 */
export async function buildMeetingOutcomesView({
  token = null,
  fetchImpl = fetch,
  now = new Date(),
  env = null,
  lookbackDays = 180,
  noticeLimit = NOTICE_LIMIT,
} = {}) {
  const noticeRows = await buildNoticeRows(fetchImpl, now, { lookbackDays, noticeLimit });

  if (!token) {
    return buildMeetingOutcomes(noticeRows, [], [], []);
  }

  const eventRows = await fetchLegistarEvents({ token, fetchImpl, now, lookbackDays });

  // Strict join first so EventItems are fetched ONLY for matched events.
  const byDate = buildMeetingDateIndex(eventRows);
  const matchedEventIds = new Set();
  for (const row of noticeRows) {
    const notice = normalizeNoticeForOutcomes(row);
    if (!notice.request_id) continue;
    const hit = joinNoticeToCouncilMeeting(
      { event_date: notice.event_date, short_title: notice.title, title: notice.title },
      byDate,
    );
    if (hit) matchedEventIds.add(String(hit.event_id));
  }

  const matchedEvents = eventRows.filter((e) => matchedEventIds.has(String(e.EventId)));
  const itemBatches = await boundedMap(
    matchedEvents,
    (ev) => fetchLegistarEventItems({ eventId: ev.EventId, token, fetchImpl }).catch(() => []),
    6,
  );
  const eventItemRows = itemBatches.flat();

  const [voteBag, attachmentBag] = await Promise.all([
    collectVoteSummaries({ eventItemRows, token, fetchImpl }),
    collectAttachments({ eventItemRows, token, fetchImpl }),
  ]);

  const view = buildMeetingOutcomes(
    noticeRows,
    eventRows,
    eventItemRows,
    voteBag.summaries,
    attachmentBag.attachmentRows,
  );

  // Shadow dual-write: never block the public meeting-outcomes materialization.
  let dualWrite = null;
  if (env) {
    dualWrite = await dualWriteLegistarObservations(
      env,
      {
        events: eventRows,
        eventItems: eventItemRows,
        votes: voteBag.rawVotes,
        attachments: attachmentBag.rawAttachments,
      },
      view.generated_at,
    );
    // Guardrail: authenticated materialization with events must leave observations.
    // Nested Attachments may honestly be empty (event Agenda/Minutes live on Events).
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
  }

  return { ...view, dual_write: dualWrite };
}

export async function refreshMeetingOutcomes(env, fetchImpl = fetch, now = new Date()) {
  if (!env?.ALERT_STATE) return { status: "skipped", reason: "no-kv" };
  const token = env?.LEGISTAR_API_TOKEN || null;
  const view = await buildMeetingOutcomesView({ token, fetchImpl, now, env });
  // dual_write is operator telemetry only — strip before KV so public clients never see it.
  const { dual_write: dualWrite, ...publicView } = view;
  await env.ALERT_STATE.put(MEETING_OUTCOMES_KV_KEY, JSON.stringify(publicView));
  return {
    status: token ? "success" : "no-token",
    enrichment: token ? "authenticated" : "unavailable",
    ...publicView.counts,
    dual_write: dualWrite || null,
  };
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
