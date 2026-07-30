// Daily materialized meeting-outcome read model for NYC Council.
// City Record remains the event-discovery layer; NYC Council Legistar enriches
// outcomes once notices, agenda items, matters, votes, and documents are present.

import { normalizeHearing } from "./hearings.mjs";

export const MEETING_OUTCOMES_VIEW_VERSION = 1;
export const MEETING_OUTCOMES_KV_KEY = "meeting-outcomes:materialized:v1";

const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const LEGISTAR_API_BASE = "https://council.nyc.gov/legislation/api/";
export const MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const NOTICE_LIMIT = 500;
export const API_RECORD_LIMIT = 100;

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

function normalizeMatterIds(rawValue) {
  if (!rawValue) return [];
  return String(rawValue)
    .split(/[,;\s]+/)
    .map((value) => normalizeText(value))
    .filter(Boolean);
}

function toNumber(value) {
  if (value == null || value === "") return 0;
  const parsed = Number.parseInt(String(value), 10);
  if (Number.isFinite(parsed)) return parsed;
  return 0;
}

function clamp(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function todayISO(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function parseTitleText(text = "") {
  return normalizeText(text).toLowerCase();
}

function tokenSet(value) {
  const tokens = new Set();
  const normalized = parseTitleText(value).replace(/[^a-z0-9\s]/g, " ");
  for (const token of normalized.split(/\s+/)) {
    if (token.length > 2) tokens.add(token);
  }
  return tokens;
}

function titleOverlap(a, b) {
  const aSet = tokenSet(a);
  const bSet = tokenSet(b);
  if (!aSet.size || !bSet.size) return 0;
  let overlap = 0;
  for (const token of aSet) if (bSet.has(token)) overlap++;
  return overlap / Math.min(aSet.size, bSet.size);
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
    affected_area: base.affected_area,
    venue: base.venue,
  };
}

function normalizeCouncilLocation(raw = {}) {
  const address = normalizeText(readFirst(raw, ["EventLocation", "Location", "location", "Venue", "VenueAddress"]));
  const name = normalizeText(readFirst(raw, ["Building", "VenueName", "Room"]));
  const city = normalizeText(readFirst(raw, ["VenueCity", "City", "city"]));
  const borough = normalizeText(readFirst(raw, ["VenueBorough", "Borough", "borough"]));
  const neighborhood = normalizeText(readFirst(raw, ["VenueNeighborhood", "Neighborhood", "neighborhood"]));
  return {
    mode: normalizeText(readFirst(raw, ["VenueType"])) || "in-person",
    building: name || null,
    address: address || null,
    borough: borough || null,
    neighborhood: neighborhood || null,
  };
}

function normalizeCouncilEvent(raw = {}) {
  const startTime = readFirst(raw, ["StartDate", "StartTime", "EventTime", "Date"]);
  const endTime = readFirst(raw, ["EndDate", "EndTime"]);
  return {
    event_id: readFirst(raw, ["EventId", "eventId", "Event_ID", "id"]),
    title: normalizeText(readFirst(raw, ["EventTitle", "Title", "Name", "event_name"])),
    body_text: normalizeText(readFirst(raw, ["BodyText", "Description", "body_text"])),
    body_name: normalizeText(readFirst(raw, ["BodyName", "Body", "committee", "agency"])),
    event_url: readFirst(raw, ["EventUrl", "EventURL", "url", "link"]) || null,
    start_time: toDateIso(startTime),
    end_time: toDateIso(endTime),
    event_date: toLocaleDate(startTime),
    venue: normalizeCouncilLocation(raw),
    raw,
  };
}

function normalizeCouncilAgendaItem(raw = {}) {
  const agendaItemId = readFirst(raw, ["AgendaItemId", "AgendaItemID", "agendaItemId", "AgendaItem_Number"]);
  const matterId = readFirst(raw, ["MatterId", "MatterID", "matterId", "Matter_ID"]);
  return {
    agenda_item_id: agendaItemId,
    event_id: readFirst(raw, ["EventId", "eventId", "EventID"]),
    agenda_number: normalizeText(readFirst(raw, ["AgendaItemNumber", "ItemNumber", "number"])) || null,
    title: normalizeText(readFirst(raw, ["AgendaItemTitle", "Title", "name", "itemTitle"])),
    body_text: normalizeText(readFirst(raw, ["AgendaItemText", "Body", "Description", "text"])) || null,
    matter_id: matterId,
    matter_ids: normalizeMatterIds(matterId),
  };
}

function normalizeCouncilMatter(raw = {}) {
  const matterId = readFirst(raw, ["MatterId", "MatterID", "matterId", "Matter_ID"]);
  return {
    matter_id: matterId,
    event_id: readFirst(raw, ["EventId", "eventId", "EventID"]),
    agenda_item_id: readFirst(raw, ["AgendaItemId", "AgendaItemID", "agendaItemId"]),
    title: normalizeText(readFirst(raw, ["MatterName", "Title", "name", "MatterName"])),
    body_text: normalizeText(readFirst(raw, ["MatterText", "Text", "Description", "body"])),
    status: normalizeText(readFirst(raw, ["Status", "MatterStatus", "status"])),
    outcome: normalizeText(readFirst(raw, ["Outcome", "MatterOutcome", "Result"])),
    raw,
  };
}

function normalizeCouncilVote(raw = {}) {
  const matterId = readFirst(raw, ["MatterId", "MatterID", "matterId", "Matter_ID"]);
  return {
    vote_id: readFirst(raw, ["VoteId", "VoteID", "voteId", "VoteIDText"]),
    matter_id: matterId,
    motion: normalizeText(readFirst(raw, ["Motion", "Title", "title", "Description"])) || null,
    result: normalizeText(readFirst(raw, ["Result", "VoteResult", "Outcome", "Decision"])) || null,
    passed: /\bpassed\b|\baye\b|\by\b/i.test(String(readFirst(raw, ["Result", "VoteResult", "Outcome"])) || ""),
    counts: {
      aye: toNumber(readFirst(raw, ["Ayes", "Yes", "Yea", "AyeCount"])),
      nay: toNumber(readFirst(raw, ["Nays", "No", "Nay", "NoCount"])),
      abstain: toNumber(readFirst(raw, ["Abstain", "Excused", "Absent", "ExcusedNoVote"])),
    },
    vote_date: toLocaleDate(readFirst(raw, ["VoteDate", "Date", "CreatedDate"])),
    source_url: readFirst(raw, ["VoteUrl", "VoteURL", "vote_url", "url", "link"]) || null,
    raw,
  };
}

function normalizeCouncilDocument(raw = {}) {
  return {
    document_id: readFirst(raw, ["DocumentId", "DocumentID", "documentId", "DocId"]),
    matter_id: readFirst(raw, ["MatterId", "MatterID", "matterId", "Matter_ID"]),
    title: normalizeText(readFirst(raw, ["DocumentName", "Title", "name", "FileName"])) || null,
    file_url: readFirst(raw, ["FileUrl", "FileURL", "fileUrl", "fileURL", "url", "link"]) || null,
    category: normalizeText(readFirst(raw, ["Category", "Type", "documentType", "DocType"])) || "Document",
    uploaded_at: toLocaleDate(readFirst(raw, ["UploadDate", "CreatedDate", "Date"])),
  };
}

export function parseLegistarResponse(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.value)) return raw.value;
  if (Array.isArray(raw.d)) return raw.d;
  return [];
}

function matchNoticeToEvent(notice, event) {
  let score = 0;
  const reasonBits = [];

  const eventAgency = parseTitleText(event.body_text || event.title || "");
  const noticeAgency = parseTitleText(notice.agency || "");
  if (noticeAgency && eventAgency && eventAgency.includes(noticeAgency)) {
    score += 0.35;
    reasonBits.push("agency match")
  }

  if (notice.event_date && event.event_date) {
    const eventTime = Date.parse(notice.event_date);
    const eventFromLegistar = Date.parse(event.event_date);
    if (Number.isFinite(eventTime) && Number.isFinite(eventFromLegistar)) {
      const days = Math.abs((eventTime - eventFromLegistar) / 86_400_000);
      if (days <= 7) {
        score += 0.45;
        reasonBits.push("same-week date")
      } else if (days <= 30) {
        score += 0.25;
        reasonBits.push("same-month date")
      }
    }
  }

  const overlap = titleOverlap(notice.title, event.title);
  if (overlap > 0.15) {
    score += Math.min(1, overlap);
    reasonBits.push("title overlap")
  }

  if (score >= 1.1) {
    return { matched: true, score, confidence: "high", reason: reasonBits.join(" + "), event };
  }
  if (score >= 1.0) {
    return { matched: true, score, confidence: "medium", reason: reasonBits.join(" + "), event };
  }
  return {
    matched: false,
    score: 0,
    confidence: "none",
    reason: "No match with city-record notice title/date/agency evidence.",
    event: null,
  };
}

function assembleAgenda(agenda, mattersByAgenda, mattersByEvent, votesByMatter, documentsByMatter) {
  const rows = [];
  for (const item of agenda) {
    const explicitIds = item.matter_ids.length ? item.matter_ids : [item.matter_id].filter(Boolean);
    const matterRows = ([]);
    for (const matterId of explicitIds) {
      for (const matter of mattersByAgenda.get(matterId) || []) matterRows.push(matter);
    }
    if (!matterRows.length && item.event_id) {
      for (const matter of mattersByEvent.get(item.event_id) || []) matterRows.push(matter);
    }

    const deduped = [];
    const byId = new Set();
    for (const matter of matterRows) {
      if (!matter?.matter_id || byId.has(matter.matter_id)) continue;
      byId.add(matter.matter_id);
      deduped.push({
        ...matter,
        votes: (votesByMatter.get(matter.matter_id) || []).map((vote) => ({
          ...vote,
          kind: "vote",
        })),
        documents: (documentsByMatter.get(matter.matter_id) || []).map((document) => ({
          ...document,
          kind: "document",
        })),
        join: {
          matched: true,
          reason: null,
        },
      });
    }

    const matters = deduped.length
      ? deduped
      : [{
          matter_id: null,
          title: null,
          body_text: null,
          status: null,
          outcome: null,
          votes: [],
          documents: [],
          join: {
            matched: false,
            reason: "No matter rows linked to this agenda item yet.",
          },
        }];

    rows.push({
      ...item,
      matters,
      join: {
        matched: matterRows.length > 0,
        reason: matterRows.length > 0
          ? null
          : "No matter row linked to this agenda item yet.",
      },
    });
  }
  return rows;
}

export function buildMeetingOutcomes(noticeRows, eventRows, agendaRows, matterRows, voteRows, documentRows) {
  const notices = (noticeRows || []).map(normalizeNoticeForOutcomes).filter((notice) => notice.request_id);
  const events = (eventRows || []).map(normalizeCouncilEvent).filter((event) => event.event_id);
  const agendaItems = (agendaRows || []).map(normalizeCouncilAgendaItem).filter((item) => item.agenda_item_id || item.event_id);
  const matters = (matterRows || []).map(normalizeCouncilMatter).filter((matter) => matter.matter_id);
  const votes = (voteRows || []).map(normalizeCouncilVote).filter((vote) => vote.matter_id);
  const documents = (documentRows || []).map(normalizeCouncilDocument).filter((document) => document.matter_id);

  const agendaByEvent = groupBy(agendaItems, (item) => item.event_id);
  const mattersByAgenda = groupBy(matters, (matter) => matter.matter_id);
  const mattersByEvent = groupBy(matters, (matter) => matter.event_id);
  const votesByMatter = groupBy(votes, (vote) => vote.matter_id);
  const documentsByMatter = groupBy(documents, (document) => document.matter_id);

  const matchedRecords = [];
  const unmatchedNotices = [];

  for (const notice of notices) {
    let selected = null;
    let best = null;
    for (const event of events) {
      const candidate = matchNoticeToEvent(notice, event);
      if (candidate.matched && (!best || candidate.score > best.score)) {
        best = candidate;
      }
    }
    if (!best || !best.matched) {
      unmatchedNotices.push({
        request_id: notice.request_id,
        join: {
          matched: false,
          reason: "No Council event matched this City Record notice on title/date/agency confidence.",
          score: 0,
          confidence: "none",
        },
        notice: { ...notice },
        council_event: null,
        agenda_items: [],
      });
      continue;
    }
    selected = best.event;
    const items = agendaByEvent.get(selected.event_id) || [];
    const assembledAgenda = assembleAgenda(items, mattersByAgenda, mattersByEvent, votesByMatter, documentsByMatter);
    if (selected && !assembledAgenda.length) {
      assembledAgenda.push({
        agenda_item_id: null,
        title: null,
        body_text: null,
        agenda_number: null,
        matters: [{
          matter_id: null,
          title: null,
          body_text: null,
          status: null,
          outcome: null,
          votes: [],
          documents: [],
          join: {
            matched: false,
            reason: "Council event exists but has no Agenda items in the latest enrichment.",
          },
        }],
        join: {
          matched: false,
          reason: "No agenda items were returned by NYC Council Legistar for this event.",
        },
      });
    }

    matchedRecords.push({
      request_id: notice.request_id,
      join: {
        matched: true,
        score: best.score,
        confidence: best.confidence,
        reason: best.reason,
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
        affected_area: notice.affected_area,
        venue: notice.venue,
      },
      council_event: selected,
      agenda_items: assembledAgenda,
    });
  }

  const matchedEventIds = new Set(matchedRecords.map((record) => record.council_event?.event_id).filter(Boolean));
  const unmatchedEvents = events
    .filter((event) => !matchedEventIds.has(event.event_id))
    .map((event) => ({
      event,
      join: {
        matched: false,
        reason: "No City Record notice matched this Council event in the current look-back window.",
      },
    }));

  const allMatters = matchedRecords.flatMap((record) => record.agenda_items.flatMap((item) => item.matters));
  const totalVotes = allMatters.reduce((sum, matter) => sum + (matter.votes?.length || 0), 0);
  const totalDocuments = allMatters.reduce((sum, matter) => sum + (matter.documents?.length || 0), 0);

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
        name: "NYC Council Legistar",
        base_url: LEGISTAR_API_BASE,
      },
    },
    counts: {
      notices: notices.length,
      matched_notices: matchedRecords.length,
      unmatched_notices: unmatchedNotices.length,
      unmatched_events: unmatchedEvents.length,
      agenda_items: matchedRecords.reduce((sum, record) => sum + record.agenda_items.length, 0),
      matters: allMatters.length,
      votes: totalVotes,
      documents: totalDocuments,
      records: matchedRecords.length + unmatchedNotices.length,
      event_rows: events.length,
      raw_matter_rows: matters.length,
    },
    records: [...matchedRecords, ...unmatchedNotices],
    unmatched_events: unmatchedEvents,
    notice_join_policy: {
      required_fields: ["title", "agency", "event_date"],
      no_vague_venue_fallback: true,
    },
  };
}

async function buildNoticeRows(fetchImpl, now = new Date()) {
  const since = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    $select: NOTICE_SELECT,
    $where: `(section_name='Public Hearings and Meetings' OR (section_name='Agency Rules' AND type_of_notice_description='Public Hearings' AND event_date IS NOT NULL)) AND event_date >= '${since}T00:00:00'`,
    $order: "event_date DESC",
    $limit: String(NOTICE_LIMIT),
  });
  const response = await fetchImpl(`${SODA}?${params}`);
  if (!response.ok) throw new Error(`City Record notices ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error("City Record notices response is not an array");
  return payload;
}

async function fetchLegistarRows(fetchImpl, path, now = new Date()) {
  const url = new URL(`${LEGISTAR_API_BASE}${path}`);
  url.searchParams.set("$top", "500");
  url.searchParams.set("$orderby", "LastModified desc");
  url.searchParams.set("$filter", `LastModified ge ${todayISO(now)}T00:00:00Z`);
  const response = await fetchImpl(url.toString());
  if (!response.ok) return [];
  const payload = await response.json();
  return parseLegistarResponse(payload);
}

export async function buildMeetingOutcomesView(fetchImpl = fetch, now = new Date()) {
  const [noticeRows, eventRows, agendaRows, matterRows, voteRows, documentRows] = await Promise.all([
    buildNoticeRows(fetchImpl, now),
    fetchLegistarRows(fetchImpl, "Events", now),
    fetchLegistarRows(fetchImpl, "AgendaItems", now),
    fetchLegistarRows(fetchImpl, "Matters", now),
    fetchLegistarRows(fetchImpl, "Votes", now),
    fetchLegistarRows(fetchImpl, "Documents", now),
  ]);

  return buildMeetingOutcomes(
    noticeRows,
    eventRows,
    agendaRows,
    matterRows,
    voteRows,
    documentRows,
  );
}

export async function refreshMeetingOutcomes(env, fetchImpl = fetch, now = new Date()) {
  if (!env?.ALERT_STATE) return { status: "skipped", reason: "no-kv" };
  const view = await buildMeetingOutcomesView(fetchImpl, now);
  await env.ALERT_STATE.put(MEETING_OUTCOMES_KV_KEY, JSON.stringify(view), {
    expirationTtl: 3 * 24 * 60 * 60,
  });
  return { status: "success", ...view.counts };
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
