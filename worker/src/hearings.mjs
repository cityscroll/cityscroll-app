// Daily materialized hearing read model.
// City Record stays authoritative. The materialized view joins its two hearing-bearing sections,
// extracts affected geography separately from venue, and resolves address signals through the
// same NYC GeoSearch service used by the Land lens.

import { applyGeocode, normalizeHearing } from "./lib/hearings.mjs";
import { withDistricts } from "./lib/council_district.mjs";
import { meetingCalendarICS } from "../../site/hearing_attend_pack.mjs";
import { sourceSignalsFromHtml } from "../../site/hearing_logistics.mjs";
import { buildSharedMeetingReadModel } from "../../site/shared_meeting_read_model.mjs";
import {
  UPCOMING_COUNCIL_MEETINGS_KV_KEY,
  upcomingCouncilMeetingsIndex,
} from "./lib/upcoming_council_meetings.mjs";
import { loadMeetingReadModelForId, loadMeetingRecord, loadMeetingRows } from "./lib/route_read_model_kv.mjs";
import {
  MEETING_GET_CAPABILITY_REFERENCE,
  MEETING_GET_PROVIDER_ID,
  MEETING_GET_REPRESENTATIONS,
  executeMeetingGet,
  meetingGetFromModel,
  MEETINGS_BROWSE_CAPABILITY_REFERENCE,
  MEETINGS_BROWSE_PROVIDER_ID,
  MEETINGS_BROWSE_REPRESENTATIONS,
  executeMeetingsBrowse,
  meetingsBrowseFromModel,
} from "../../capabilities/meetings.mjs";

export const HEARINGS_KV_KEY = "hearings:location:v1";
export const HEARINGS_SOURCE_EXTRACTION_VERSION = 2;
export const MEETING_GET_HTTP_ADAPTER = Object.freeze({
  id: "worker-http.meeting-get@1",
  capabilityReference: MEETING_GET_CAPABILITY_REFERENCE,
  providerId: MEETING_GET_PROVIDER_ID,
  route: "GET /hearings?id=…",
  surface: "Meeting detail",
  representations: MEETING_GET_REPRESENTATIONS,
});
export const MEETINGS_BROWSE_HTTP_ADAPTER = Object.freeze({
  id: "worker-http.meetings-browse@1",
  capabilityReference: MEETINGS_BROWSE_CAPABILITY_REFERENCE,
  providerId: MEETINGS_BROWSE_PROVIDER_ID,
  route: "GET /hearings?from=…",
  surface: "Meeting browse",
  representations: MEETINGS_BROWSE_REPRESENTATIONS,
});
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search";
const MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const CITY_RECORD_MEETING_SOURCE_FIELDS = Object.freeze([
  "request_id", "start_date", "agency_name", "type_of_notice_description", "section_name",
  "short_title", "event_date", "building_name", "street_address_1", "street_address_2",
  "city", "state", "zip_code", "additional_description_1", "additional_description_2",
  "additional_description_3", "other_info_1", "other_info_2", "other_info_3",
  "printout_1", "printout_2", "printout_3",
  "contact_name", "contact_phone", "email", "address_to_request", "category_description",
  "selection_method_description",
]);

/**
 * Exact-id meeting reads prefer the versioned route slices republished with
 * every Worker deploy. Those slices are already one meeting (or one month) of
 * precomputed shared-meeting rows, so the request path never has to rebuild
 * agenda, place-membership, or geography joins.
 *
 * The daily `hearings:location:v1` view is rebuilt by the digest cron and can
 * hold the whole shared meeting corpus (historically with duplicated row
 * arrays). Parsing that blob on every `get_meeting` exceeds the Worker memory
 * budget (Cloudflare Error 1102). Keep it as a same-day fallback only when the
 * published slice has not caught the id yet.
 */
async function publishedMeetingModel(env, input) {
  try {
    return await loadMeetingReadModelForId(env, input.meetingId.trim());
  } catch {
    return null;
  }
}

async function dailyHearingViewModel(env) {
  try {
    const raw = env?.ALERT_STATE ? await env.ALERT_STATE.get(HEARINGS_KV_KEY) : null;
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Explicit provider for the bounded meeting detail capability. */
export function workerMeetingGet(env, modelOverride = null) {
  return Object.freeze({
    capabilityReference: MEETING_GET_CAPABILITY_REFERENCE,
    providerId: MEETING_GET_PROVIDER_ID,
    async execute(input) {
      if (modelOverride) {
        const fromOverride = meetingGetFromModel(modelOverride, input);
        if (fromOverride.availability === "available") return fromOverride;
        const publishedFromOverride = await publishedMeetingModel(env, input);
        if (!publishedFromOverride) return fromOverride;
        const fromPublishedOverride = meetingGetFromModel(publishedFromOverride, input);
        return fromPublishedOverride.availability === "available" ? fromPublishedOverride : fromOverride;
      }

      const published = await publishedMeetingModel(env, input);
      if (published) {
        const fromPublished = meetingGetFromModel(published, input);
        if (fromPublished.availability === "available") return fromPublished;
      }

      return meetingGetFromModel(await dailyHearingViewModel(env), input);
    },
  });
}

/** Explicit provider for the bounded, pageable shared meeting browse capability. */
export function workerMeetingsBrowse(env, modelOverride = null) {
  return Object.freeze({
    capabilityReference: MEETINGS_BROWSE_CAPABILITY_REFERENCE,
    providerId: MEETINGS_BROWSE_PROVIDER_ID,
    async execute(input) {
      let model = modelOverride;
      if (!model) {
        try {
          const raw = env?.ALERT_STATE ? await env.ALERT_STATE.get(HEARINGS_KV_KEY) : null;
          model = raw ? JSON.parse(raw) : null;
        } catch {
          model = null;
        }
      }
      return meetingsBrowseFromModel(model, input);
    },
  });
}
const SELECT = CITY_RECORD_MEETING_SOURCE_FIELDS.join(",");

function materializedRows(payload) {
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.hearings)) return payload.hearings;
  return [];
}

function materializedMeetingForId(rows, id) {
  const candidates = Array.isArray(rows) ? rows : [];
  return candidates.find((row) => row?.meeting_id === id)
    || candidates.find((row) => row?.source_system === "city_record" && (
      row?.request_id === id || row?.source_record_id === id
    ))
    || null;
}

function todayISO(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

async function fetchRows(fetchImpl, now) {
  const params = new URLSearchParams({
    "$select": SELECT,
    "$where": `(section_name='Public Hearings and Meetings' OR (section_name='Agency Rules' AND event_date IS NOT NULL)) AND event_date >= '${todayISO(now)}T00:00:00'`,
    "$order": "event_date ASC",
    "$limit": "500",
  });
  const response = await fetchImpl(`${SODA}?${params}`);
  if (!response.ok) throw new Error(`hearing SODA ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("hearing SODA returned a non-array response");
  return rows;
}

async function enrichRuleSource(fetchImpl, row) {
  const bodyPresent = [
    row.additional_description_1, row.additional_description_2, row.additional_description_3,
    row.other_info_1, row.other_info_2, row.other_info_3,
    row.printout_1, row.printout_2, row.printout_3,
  ].some(Boolean);
  if (row.section_name !== "Agency Rules" || !row.event_date || bodyPresent) return row;
  try {
    const url = `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(row.request_id || "")}`;
    const response = await fetchImpl(url, { headers: { Accept: "text/html" } });
    if (!response.ok) return row;
    const signals = sourceSignalsFromHtml(await response.text(), url);
    return { ...row, source_body: signals.body || null, source_links: signals.sourceLinks };
  } catch {
    return row;
  }
}

async function geocodeAddress(fetchImpl, address) {
  try {
    const response = await fetchImpl(`${GEOSEARCH}?size=1&text=${encodeURIComponent(`${address} New York NY`)}`);
    if (!response.ok) return null;
    const payload = await response.json();
    const feature = payload?.features?.[0];
    const properties = feature?.properties || {};
    const pad = properties?.addendum?.pad || {};
    const coordinates = feature?.geometry?.coordinates || [];
    if (!feature) return null;
    return withDistricts({
      borough: properties.borough || null,
      neighborhood: properties.neighbourhood || null,
      latitude: Number.isFinite(coordinates[1]) ? coordinates[1] : null,
      longitude: Number.isFinite(coordinates[0]) ? coordinates[0] : null,
      bbl: /^\d{10}$/.test(pad.bbl || "") ? pad.bbl : null,
    });
  } catch {
    return null;
  }
}

async function geocodeAll(fetchImpl, addresses) {
  const queue = [...new Set(addresses.filter(Boolean))];
  const output = {};
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const address = queue[cursor++];
      const result = await geocodeAddress(fetchImpl, address);
      if (result) output[address] = result;
    }
  }
  await Promise.all(Array.from({ length: Math.min(5, queue.length) }, () => worker()));
  return output;
}

async function loadUpcomingCouncilMeetingsIndex(env, override) {
  if (override !== undefined) return upcomingCouncilMeetingsIndex(override) || override || null;
  if (!env?.ALERT_STATE) return null;
  try {
    const raw = await env.ALERT_STATE.get(UPCOMING_COUNCIL_MEETINGS_KV_KEY);
    return upcomingCouncilMeetingsIndex(raw ? JSON.parse(raw) : null);
  } catch {
    return null;
  }
}

export async function buildHearingView(fetchImpl = fetch, now = new Date(), options = {}) {
  const rows = await fetchRows(fetchImpl, now);
  const enriched = await Promise.all(rows.map((row) => enrichRuleSource(fetchImpl, row)));
  const normalized = enriched.map(normalizeHearing);
  const addresses = normalized.flatMap((record) => [
    record.venue.address,
    ...record.affected_area.addresses.map((address) => address.label),
  ]);
  const geocodes = await geocodeAll(fetchImpl, addresses);
  const hearings = normalized.map((record) => applyGeocode(record, geocodes));
  const readModel = buildSharedMeetingReadModel({
    cityRecordRows: hearings,
    communityBoardIndex: options.communityBoardIndex || null,
    nycLegistarEventsIndex: options.nycLegistarEventsIndex === undefined
      ? null
      : options.nycLegistarEventsIndex,
    generatedAt: now.toISOString(),
    now: now.toISOString(),
  });
  return {
    ...readModel,
    read_model: readModel,
    schema_version: 1,
    source_extraction_version: HEARINGS_SOURCE_EXTRACTION_VERSION,
    generated_at: readModel.generated_at || now.toISOString(),
    source: {
      name: "City Record Online",
      dataset: "dg92-zbpx",
      url: "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx",
    },
    counts: {
      total: hearings.length
        + readModel.counts.community_board
        + (readModel.counts.nyc_legistar_events || 0),
      local: hearings.filter((record) => record.affected_area.scope === "local").length,
      citywide: hearings.filter((record) => record.affected_area.scope === "citywide").length,
      unlocated: hearings.filter((record) => record.affected_area.scope === "unlocated").length,
    },
    hearings: readModel.rows,
  };
}

export async function refreshHearings(env, fetchImpl = fetch, now = new Date(), options = {}) {
  if (!env.ALERT_STATE) return { status: "skipped", reason: "no-kv" };
  let communityBoardIndex = options.communityBoardIndex || null;
  if (!communityBoardIndex && options.includeCommunityBoard === true) {
    const rows = await loadMeetingRows(env, { todayISO: todayISO(now) });
    communityBoardIndex = {
      generated_at: rows.find((row) => row?.source_system === "community_board")?.source_receipt?.observed_at || null,
      coverage: { source: "route-read-model", row_count: rows.length },
      rows: rows.filter((row) => row?.source_system === "community_board"),
    };
  }
  const nycLegistarEventsIndex = await loadUpcomingCouncilMeetingsIndex(
    env,
    options.nycLegistarEventsIndex,
  );
  const view = await buildHearingView(fetchImpl, now, {
    communityBoardIndex,
    nycLegistarEventsIndex,
  });
  await env.ALERT_STATE.put(HEARINGS_KV_KEY, JSON.stringify(view));
  return { status: "success", ...view.counts };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function response(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? "public, max-age=1800" : "no-store",
    },
  });
}

export async function handleHearings(request, env, _ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return response(JSON.stringify({ ok: false, reason: "method" }), 405);
  if (!env.ALERT_STATE) return response(JSON.stringify({ ok: false, reason: "not-configured" }), 503);

  let raw = await env.ALERT_STATE.get(HEARINGS_KV_KEY);
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  const age = parsed?.generated_at ? Date.now() - new Date(parsed.generated_at).getTime() : Infinity;
  const url = new URL(request.url);
  const params = url.searchParams;
  const requestedId = params.get("id") || null;

  const requestedMissing = requestedId && !parsed?.hearings?.some((hearing) => (
    hearing?.meeting_id === requestedId
      || hearing?.request_id === requestedId
      || hearing?.source_keys?.some((key) => key?.value === requestedId)
  ));
  if (!parsed) return response(JSON.stringify({ ok: false, reason: "snapshot-unavailable" }), 503);
  const browseKeys = [
    "from", "to", "date_from", "date_to", "availability", "attendance_modes", "attendance", "activity",
    "speaking_rights", "observer_access", "source_contract_id", "source_system", "institution", "body", "agency",
    "community_board", "geography", "place_scope", "query", "text_query", "status", "limit", "cursor",
  ];
  if (!requestedId && browseKeys.some((key) => params.has(key))) {
    const browseInput = {};
    for (const key of browseKeys) {
      if (key === "attendance_modes") {
        if (params.has(key)) browseInput.attendanceModes = params.get(key).split(",").filter(Boolean);
        continue;
      }
      if (params.has(key)) browseInput[key.replaceAll(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = params.get(key);
    }
    try {
      const capability = await executeMeetingsBrowse(workerMeetingsBrowse(env, parsed), browseInput);
      return response(JSON.stringify(capability));
    } catch (error) {
      return response(JSON.stringify({ ok: false, reason: "invalid-browse-request", error: error.message }), 400);
    }
  }
  const requestedRecord = requestedId ? materializedMeetingForId(parsed.hearings, requestedId) : null;
  // A canonical id the daily view has not caught up with can still be one this
  // deployment publishes, so resolve the capability before deciding the id names
  // nothing. Legacy City Record ids stay adapter compatibility only: they are
  // never handed to the capability, which accepts exact canonical ids alone.
  const canonicalId = requestedRecord?.meeting_id
    || (requestedId?.startsWith("meeting:") && requestedId.length <= 320 && !/[\r\n]/.test(requestedId)
      ? requestedId
      : null);
  let capability = null;
  if (canonicalId) {
    try {
      capability = await executeMeetingGet(workerMeetingGet(env, parsed), { meetingId: canonicalId });
    } catch {
      capability = null;
    }
  }
  if (requestedMissing && capability?.availability !== "available") {
    return response(JSON.stringify({ ok: false, reason: "not-materialized" }), 404);
  }
  return response(JSON.stringify({
    ...parsed,
    stale: age > MAX_AGE_MS || parsed.source_extraction_version !== HEARINGS_SOURCE_EXTRACTION_VERSION,
    ...(capability ? { capability } : {}),
  }));
}

/**
 * GET /meeting.ics?id=… — one meeting event from a materialized shared meeting
 * read model. This route never performs a source lookup or refresh on demand.
 */
export async function handleMeetingICS(request, env) {
  if (request.method !== "GET") {
    return new Response("method not allowed", { status: 405, headers: { "Content-Type": "text/plain" } });
  }
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!id || id.length > 320 || /[\r\n]/.test(id)) return new Response("invalid meeting id", { status: 400 });

  let record = null;
  try { record = await loadMeetingRecord(env, id); } catch { record = null; }
  if (!record) {
    let parsed = null;
    try {
      const raw = env?.ALERT_STATE ? await env.ALERT_STATE.get(HEARINGS_KV_KEY) : null;
      parsed = raw ? JSON.parse(raw) : null;
    } catch { parsed = null; }
    record = materializedMeetingForId(materializedRows(parsed), id);
  }
  if (!record) return new Response("meeting not found", { status: 404 });
  const ics = meetingCalendarICS({
    ...record,
    short_title: record.title,
    agency_name: record.agency,
    source_url: record.source_url,
  });
  if (!ics) return new Response("meeting has no event time", { status: 404 });
  return new Response(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="meeting-${id.replace(/[^A-Za-z0-9_-]+/g, "-")}.ics"`,
      "Cache-Control": "public, max-age=900",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
