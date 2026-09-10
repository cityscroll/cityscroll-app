/**
 * Exact same-proceeding join between a City Record notice and an NYC Council
 * Legistar Events meeting. The existing date-and-body join is the only path
 * that creates a relation. Collection visibility is a separate flag from
 * source identity: suppression happens only after that exact join.
 */

import {
  buildMeetingDateIndex,
  committeeMatchesTitle,
  joinNoticeToCouncilMeeting,
} from "../worker/src/lib/legistar_join.mjs";
import { meetingCanonicalHref } from "./meeting_object_contract.mjs";

export const SAME_PROCEEDING_SCHEMA = "cityscroll.meeting_same_proceeding.v1";
export const SAME_PROCEEDING_METHOD = "exact_date_body_tokens";
export const MEETING_COLLECTION_VISIBLE = "visible";
export const MEETING_COLLECTION_SUPPRESSED = "suppressed";

function text(value) {
  const valueText = String(value ?? "").trim();
  return valueText || null;
}

function eventDay(row) {
  const match = String(row?.event_date || row?.EventDate || row?.date || row?.meeting_date || "")
    .slice(0, 10)
    .match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function bodyName(row) {
  return text(row?.committee?.name)
    || text(row?.EventBodyName)
    || text(row?.governing_body?.name)
    || text(row?.body_name)
    || text(row?.body)
    || "";
}

function eventIdOf(row) {
  return text(row?.event_id)
    || text(row?.EventId)
    || text(row?.publisher_identifier)
    || text(row?.identity?.event_id)
    || "";
}

function joinMeetingsForIndex(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const body = bodyName(row);
    const day = eventDay(row);
    const eventId = eventIdOf(row) || row?.EventId;
    return {
      EventId: eventId,
      event_id: eventId,
      EventBodyName: body,
      committee: body,
      EventDate: day,
      event_date: day,
      meeting_date: day,
      meeting_id: row?.meeting_id || null,
    };
  });
}

/**
 * Classify one City Record notice against Legistar Events meetings.
 * Only `exact_date_body_tokens` is accepted. Date-only, title-only,
 * ambiguous, and failed candidates stay unmatched.
 */
export function classifySameProceedingCandidate(notice, meetings = []) {
  const indexed = joinMeetingsForIndex(meetings);
  const byDate = buildMeetingDateIndex(indexed);
  const accepted = joinNoticeToCouncilMeeting(notice, byDate);
  if (accepted?.event_id) {
    const matched = meetings.find((row) => eventIdOf(row) === String(accepted.event_id)) || accepted.meeting;
    return {
      status: "matched",
      method: SAME_PROCEEDING_METHOD,
      accepted: true,
      event_id: String(accepted.event_id),
      meeting: matched,
    };
  }

  const day = eventDay(notice);
  const title = notice?.short_title || notice?.title || "";
  const sameDay = day ? indexed.filter((row) => eventDay(row) === day) : [];
  const bodyHits = sameDay.filter((row) => committeeMatchesTitle(bodyName(row), title));
  if (bodyHits.length > 1) {
    return {
      status: "ambiguous",
      method: "multi_match_ambiguous",
      accepted: false,
      event_id: null,
      meeting: null,
      candidate_event_ids: bodyHits.map((row) => eventIdOf(row)).filter(Boolean),
    };
  }
  if (sameDay.length > 0) {
    return {
      status: "unmatched",
      method: "date_only",
      accepted: false,
      event_id: null,
      meeting: null,
    };
  }
  const otherHits = indexed.filter((row) => {
    const otherDay = eventDay(row);
    return otherDay && otherDay !== day && committeeMatchesTitle(bodyName(row), title);
  });
  if (otherHits.length > 0) {
    return {
      status: "unmatched",
      method: "title_only",
      accepted: false,
      event_id: null,
      meeting: null,
    };
  }
  return {
    status: "unmatched",
    method: null,
    accepted: false,
    event_id: null,
    meeting: null,
  };
}

function sameProceedingEvidence(cityRow, legistarRow, method) {
  const cityId = text(cityRow.meeting_id);
  const legistarId = text(legistarRow.meeting_id);
  return {
    schema: SAME_PROCEEDING_SCHEMA,
    method,
    meeting_ids: [cityId, legistarId].filter(Boolean),
    city_record_meeting_id: cityId,
    nyc_legistar_events_meeting_id: legistarId,
    date: eventDay(cityRow) || eventDay(legistarRow),
    body: bodyName(legistarRow) || null,
    permalinks: {
      city_record: meetingCanonicalHref(cityRow),
      nyc_legistar_events: meetingCanonicalHref(legistarRow),
    },
  };
}

function withCollection(row, visibility, role, evidence) {
  return {
    ...row,
    join_status: row.source_system === "nyc_legistar_events" && evidence
      ? "matched"
      : row.join_status,
    same_proceeding: evidence || row.same_proceeding || null,
    collection_visibility: visibility,
    collection_role: role,
  };
}

/**
 * Attach exact same-proceeding evidence and collection visibility.
 * Both source objects remain; only an exact unique join suppresses the
 * Legistar row from collections, preferring the City Record representative.
 */
export function applySameProceedingJoins(cityRows = [], legistarRows = []) {
  const city = Array.isArray(cityRows) ? cityRows : [];
  const legistar = Array.isArray(legistarRows) ? legistarRows : [];
  if (!city.length || !legistar.length) {
    return {
      cityRows: city.map((row) => withCollection(row, MEETING_COLLECTION_VISIBLE, "representative", null)),
      legistarRows: legistar.map((row) => withCollection(row, MEETING_COLLECTION_VISIBLE, "representative", null)),
      relations: [],
    };
  }

  const byEventId = new Map();
  for (const row of legistar) {
    const id = eventIdOf(row);
    if (id) byEventId.set(id, row);
  }

  const pairByCity = new Map();
  const citiesByEvent = new Map();
  const rejectedByCity = new Map();
  for (const notice of city) {
    const classified = classifySameProceedingCandidate(notice, legistar);
    if (classified.accepted && classified.event_id && byEventId.has(classified.event_id)) {
      pairByCity.set(notice.meeting_id, classified.event_id);
      const holders = citiesByEvent.get(classified.event_id) || [];
      holders.push(notice.meeting_id);
      citiesByEvent.set(classified.event_id, holders);
    } else {
      rejectedByCity.set(notice.meeting_id, classified);
    }
  }

  const uniquePairs = [];
  for (const [cityId, eventId] of pairByCity) {
    if ((citiesByEvent.get(eventId) || []).length === 1) {
      uniquePairs.push({ cityId, eventId });
    }
  }
  const uniqueCityIds = new Set(uniquePairs.map((pair) => pair.cityId));
  const uniqueEventIds = new Set(uniquePairs.map((pair) => pair.eventId));
  const relations = uniquePairs.map((pair) => {
    const cityRow = city.find((row) => row.meeting_id === pair.cityId);
    const legistarRow = byEventId.get(pair.eventId);
    return sameProceedingEvidence(cityRow, legistarRow, SAME_PROCEEDING_METHOD);
  });
  const evidenceByMeetingId = new Map();
  for (const relation of relations) {
    evidenceByMeetingId.set(relation.city_record_meeting_id, relation);
    evidenceByMeetingId.set(relation.nyc_legistar_events_meeting_id, relation);
  }

  return {
    cityRows: city.map((row) => {
      const evidence = evidenceByMeetingId.get(row.meeting_id) || null;
      return withCollection(row, MEETING_COLLECTION_VISIBLE, "representative", evidence);
    }),
    legistarRows: legistar.map((row) => {
      const eventId = eventIdOf(row);
      const evidence = evidenceByMeetingId.get(row.meeting_id) || null;
      if (evidence && uniqueEventIds.has(eventId)) {
        return withCollection(row, MEETING_COLLECTION_SUPPRESSED, "joined_source", evidence);
      }
      const visibility = MEETING_COLLECTION_VISIBLE;
      const role = "representative";
      const next = withCollection(row, visibility, role, null);
      if (!evidence) {
        const cityHits = [...pairByCity.entries()].filter(([, id]) => id === eventId);
        if (cityHits.length > 1) {
          next.join_status = "ambiguous";
        }
      }
      return next;
    }),
    relations,
    uniqueCityIds,
    uniqueEventIds,
    rejectedByCity,
  };
}

export function collectionVisibilityOf(row) {
  return text(row?.collection_visibility) === MEETING_COLLECTION_SUPPRESSED
    ? MEETING_COLLECTION_SUPPRESSED
    : MEETING_COLLECTION_VISIBLE;
}

export { eventIdOf, eventDay, bodyName };
