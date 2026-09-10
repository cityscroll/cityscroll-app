/**
 * Operator-facing Council-discovery health: bounded population metrics, never
 * resident copy. Shared by the ops contract and the cycle runner.
 */

import { MEETING_COLLECTION_SUPPRESSED } from "../../../site/meeting_same_proceeding.mjs";
import {
  UPCOMING_COUNCIL_MEETINGS_MAX_AGE_MS,
  upcomingCouncilMeetingsHealth,
} from "./upcoming_council_meetings.mjs";

export const COUNCIL_DISCOVERY_HEALTH_SCHEMA = "cityscroll.council_discovery_health.v1";
export const COUNCIL_DISCOVERY_CYCLE_SCHEMA = "cityscroll.council_discovery_cycle.v1";

export const COUNCIL_DISCOVERY_CYCLE_STEPS = Object.freeze([
  Object.freeze({ id: "council-acquisition", role: "acquisition" }),
  Object.freeze({ id: "shared-meetings", role: "consumer" }),
  Object.freeze({ id: "route-slices", role: "consumer" }),
  Object.freeze({ id: "search", role: "consumer" }),
  Object.freeze({ id: "now", role: "consumer" }),
  Object.freeze({ id: "alert-replay", role: "consumer" }),
]);

export const COUNCIL_DISCOVERY_HEALTH_DEFINITIONS = Object.freeze({
  upcoming:
    "Eligible Events-feed rows whose publisher EventDate falls inside the documented upcoming horizon of the acquisition clock.",
  standalone:
    "Upcoming Events-feed meetings with no exact_date_body_tokens City Record join in this cycle.",
  exactly_joined:
    "Upcoming Events-feed meetings with a measured exact_date_body_tokens City Record join. The join is a relation, not a merge.",
  collection_suppressed:
    "Upcoming Events-feed meetings hidden from collection lists because an exact City Record join made the notice the representative. Permalinks stay resolvable.",
  truncated:
    "Eligible upcoming events whose nested EventItems this run deferred past the documented item-events cap, plus an Events page that did not complete.",
  last_successful_observation:
    "Timestamp of the last publishable upcoming Council snapshot. Failed or empty-source acquisitions leave this stamp unchanged.",
});

export const PUBLISHER_EVENT_KEY_KIND = "event_id";
export const INSITE_CALENDAR_KEY_KIND = "insite_calendar_meeting_id";

export const WORKER_COUNCIL_THEN_SHARED_MEETINGS = Object.freeze([
  "refreshMeetingOutcomes",
  "refreshHearings",
]);

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function eventIdOf(raw = {}) {
  return text(raw.EventId ?? raw.event_id ?? raw.identity?.event_id);
}

export function councilDiscoveryHealth({
  upcomingView = null,
  sharedModel = null,
  now = new Date(),
} = {}) {
  const serving = upcomingCouncilMeetingsHealth(upcomingView, new Date(now).getTime());
  const meetings = Array.isArray(upcomingView?.meetings) ? upcomingView.meetings : [];
  const sharedRows = Array.isArray(sharedModel?.rows)
    ? sharedModel.rows
    : Array.isArray(sharedModel?.hearings) ? sharedModel.hearings : [];
  const suppressedIds = new Set(
    sharedRows
      .filter((row) => row?.source_system === "nyc_legistar_events"
        && row?.collection_visibility === MEETING_COLLECTION_SUPPRESSED)
      .map((row) => eventIdOf(row)),
  );
  const deferred = Number(upcomingView?.discovery?.item_events_deferred) || 0;
  const pageTruncated = upcomingView?.discovery?.events_page_truncated === true;
  const lastSuccessful = text(upcomingView?.generated_at)
    || text(upcomingView?.source_health?.observed_at)
    || null;
  return {
    schema: COUNCIL_DISCOVERY_HEALTH_SCHEMA,
    status: serving.status,
    reason: serving.reason,
    upcoming: {
      value: meetings.length,
      definition: COUNCIL_DISCOVERY_HEALTH_DEFINITIONS.upcoming,
    },
    standalone: {
      value: meetings.filter((meeting) => !meeting?.city_record_notice?.matched_in_window).length,
      definition: COUNCIL_DISCOVERY_HEALTH_DEFINITIONS.standalone,
    },
    exactly_joined: {
      value: meetings.filter((meeting) => meeting?.city_record_notice?.method === "exact_date_body_tokens").length,
      definition: COUNCIL_DISCOVERY_HEALTH_DEFINITIONS.exactly_joined,
    },
    collection_suppressed: {
      value: meetings.filter((meeting) => suppressedIds.has(eventIdOf(meeting))).length,
      definition: COUNCIL_DISCOVERY_HEALTH_DEFINITIONS.collection_suppressed,
    },
    truncated: {
      value: deferred + (pageTruncated ? 1 : 0),
      events_page_truncated: pageTruncated,
      item_events_deferred: deferred,
      definition: COUNCIL_DISCOVERY_HEALTH_DEFINITIONS.truncated,
    },
    last_successful_observation: {
      value: lastSuccessful,
      definition: COUNCIL_DISCOVERY_HEALTH_DEFINITIONS.last_successful_observation,
      max_age_ms: UPCOMING_COUNCIL_MEETINGS_MAX_AGE_MS,
    },
  };
}
