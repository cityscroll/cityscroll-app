/**
 * One scheduled Council-discovery cycle: acquire the Events feed, then every
 * shared meeting consumer reads that vintage. The order is the contract.
 * A failed acquisition retains last-known-good meetings and never publishes
 * zero as complete.
 */

import { buildSharedMeetingReadModel } from "../../../site/shared_meeting_read_model.mjs";
import { buildMeetingSearchDocuments } from "../../../site/meeting_search_producer.mjs";
import { buildNowSurface } from "../../../site/now_surface.mjs";
import { collapseMeetingDeliveryRows } from "../../../site/meeting_delivery_identity.mjs";
import { buildMeetingDateIndex, joinNoticeToCouncilMeeting } from "./legistar_join.mjs";
import {
  UPCOMING_COUNCIL_MEETINGS_SCHEMA,
  assertPublicUpcomingProjection,
  buildUpcomingCouncilMeetingsView,
  upcomingCouncilMeetingsIndex,
} from "./upcoming_council_meetings.mjs";
import {
  COUNCIL_DISCOVERY_CYCLE_SCHEMA,
  COUNCIL_DISCOVERY_CYCLE_STEPS,
  PUBLISHER_EVENT_KEY_KIND,
  councilDiscoveryHealth,
} from "./council_discovery_health.mjs";

export {
  COUNCIL_DISCOVERY_CYCLE_SCHEMA,
  COUNCIL_DISCOVERY_CYCLE_STEPS,
  COUNCIL_DISCOVERY_HEALTH_DEFINITIONS,
  COUNCIL_DISCOVERY_HEALTH_SCHEMA,
  PUBLISHER_EVENT_KEY_KIND,
  INSITE_CALENDAR_KEY_KIND,
  WORKER_COUNCIL_THEN_SHARED_MEETINGS,
  councilDiscoveryHealth,
} from "./council_discovery_health.mjs";

function cityRecordJoinMap(eventRows = [], cityRecordRows = []) {
  const byDate = buildMeetingDateIndex(eventRows);
  const map = new Map();
  for (const row of cityRecordRows) {
    const hit = joinNoticeToCouncilMeeting(
      { event_date: row.event_date, short_title: row.short_title || row.title, title: row.title },
      byDate,
    );
    if (!hit) continue;
    const id = String(hit.event_id);
    if (!map.has(id)) map.set(id, { request_id: row.request_id || null, method: hit.method });
  }
  return map;
}

function itemsMap(itemsByEventId = new Map()) {
  if (itemsByEventId instanceof Map) return itemsByEventId;
  return new Map(Object.entries(itemsByEventId || {}));
}

function monthOf(row) {
  const month = String(row?.event_date || row?.date || "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(month) ? month : "undated";
}

/** Versioned meeting route slices from an already-built shared read model. */
export function buildMeetingRouteSlices(sharedModel, version = "cycle") {
  const grouped = new Map();
  const idToSlice = {};
  for (const row of sharedModel?.rows || sharedModel?.hearings || []) {
    if (!row?.meeting_id) continue;
    const bucket = monthOf(row);
    if (!grouped.has(bucket)) grouped.set(bucket, []);
    grouped.get(bucket).push(row);
  }
  const entries = [];
  const slices = {};
  for (const [month, rows] of grouped) {
    const key = `meetings:v1:${version}:${encodeURIComponent(month)}`;
    if (month !== "undated") slices[month] = key;
    for (const row of rows) idToSlice[row.meeting_id] = key;
    entries.push({
      key,
      month,
      rows,
      value: { schema_version: 1, kind: "meetings", version, month, rows },
    });
  }
  return {
    version,
    entries,
    manifest: {
      schema_version: 1,
      kind: "meetings",
      version,
      slices,
      id_to_slice: idToSlice,
    },
  };
}

function keywordHits(rows, keywords = []) {
  const terms = keywords.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
  if (!terms.length) return [...rows];
  return rows.filter((row) => {
    const haystack = `${row.search_text || ""} ${row.title || ""} ${row.agenda?.search_text || ""}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function containsMeeting(rows, meetingId) {
  return (rows || []).some((row) => row?.meeting_id === meetingId || row?.object_ref === meetingId);
}

/**
 * Inject already-acquired Events rows and observe every shared consumer in one
 * cycle. Callers never fetch the publisher. A non-publishable acquisition
 * returns last-known-good meetings and unavailable/stale health.
 */
export function runCouncilDiscoveryCycle({
  eventRows = [],
  itemsByEventId = new Map(),
  cityRecordRows = [],
  now = new Date(),
  previousUpcoming = null,
  watchKeywords = ["M/WBE"],
  eventsFetch = { ok: true, complete: true, pages: 1 },
} = {}) {
  const generatedAt = new Date(now).toISOString();
  const today = generatedAt.slice(0, 10);
  const cityRecordByEventId = cityRecordJoinMap(eventRows, cityRecordRows);
  const acquired = buildUpcomingCouncilMeetingsView({
    eventRows,
    itemsByEventId: itemsMap(itemsByEventId),
    now,
    cityRecordByEventId,
    eventsFetch,
  });

  if (!acquired.publishable || !acquired.view) {
    const retained = previousUpcoming
      && previousUpcoming.schema === UPCOMING_COUNCIL_MEETINGS_SCHEMA
      ? previousUpcoming
      : null;
    const health = councilDiscoveryHealth({
      upcomingView: retained,
      sharedModel: null,
      now,
    });
    if (health.status === "healthy") health.status = retained ? "stale" : "unavailable";
    if (!health.reason) health.reason = acquired.reason || "empty-source";
    return {
      schema: COUNCIL_DISCOVERY_CYCLE_SCHEMA,
      generated_at: generatedAt,
      publishable: false,
      reason: acquired.reason || "empty-source",
      retained_last_known_good: Boolean(retained),
      published_zero_as_complete: false,
      health,
      steps: COUNCIL_DISCOVERY_CYCLE_STEPS.map((step) => ({
        id: step.id,
        role: step.role,
        observed: false,
      })),
      view: retained,
      shared: null,
    };
  }

  assertPublicUpcomingProjection(acquired.view);
  const shared = buildSharedMeetingReadModel({
    cityRecordRows,
    communityBoardIndex: { generated_at: generatedAt, rows: [] },
    nycLegistarEventsIndex: upcomingCouncilMeetingsIndex(acquired.view),
    generatedAt,
    now: generatedAt,
  });
  const slices = buildMeetingRouteSlices(shared, `cycle-${today}`);
  const sliceRows = slices.entries.flatMap((entry) => entry.rows);
  const search = buildMeetingSearchDocuments(shared);
  const nowSurface = buildNowSurface({
    meetings: { status: "available", generated_at: generatedAt, hearings: shared.rows },
  }, { today });
  const replaySource = collapseMeetingDeliveryRows(sliceRows);
  const replayed = keywordHits(replaySource, watchKeywords);
  const health = councilDiscoveryHealth({
    upcomingView: acquired.view,
    sharedModel: shared,
    now,
  });

  const meetingIds = acquired.view.meetings.map((meeting) => meeting.meeting_id);
  const observations = meetingIds.map((meetingId) => ({
    meeting_id: meetingId,
    publisher_key: {
      kind: PUBLISHER_EVENT_KEY_KIND,
      event_id: meetingId.replace(/^meeting:nyc_legistar_events:/, ""),
    },
    consumers: {
      "shared-meetings": containsMeeting(shared.rows, meetingId),
      "route-slices": containsMeeting(sliceRows, meetingId),
      search: containsMeeting(search.documents, meetingId),
      now: (nowSurface.happening_soon?.items || []).some((item) => item.id === `meetings:${meetingId}`),
      "alert-replay": containsMeeting(replayed, meetingId),
    },
  }));

  return {
    schema: COUNCIL_DISCOVERY_CYCLE_SCHEMA,
    generated_at: generatedAt,
    publishable: true,
    reason: null,
    retained_last_known_good: false,
    published_zero_as_complete: false,
    health,
    steps: COUNCIL_DISCOVERY_CYCLE_STEPS.map((step) => ({
      id: step.id,
      role: step.role,
      observed: step.role === "acquisition"
        || observations.some((row) => row.consumers[step.id] === true),
    })),
    observations,
    view: acquired.view,
    shared,
    slices,
    search,
    now: nowSurface,
    alert_replay: { keywords: watchKeywords, rows: replayed },
  };
}

