/**
 * Retained community-board meeting detail identities.
 *
 * Upcoming calendar feeds move on. A successful refresh that omits a previously
 * admitted publisher identity is not evidence the meeting was canceled, and it
 * must not erase the historical detail route. Explicitly linked event URLs
 * (for example a board hearing-preparation reading) are reacquired through the
 * ordinary HTML event-detail adapter and folded into the same union.
 *
 * Collection visibility stays separate from identity: a retained past detail
 * remains resolvable while upcoming collections exclude it after its scheduled
 * day.
 */

import {
  MEETING_COLLECTION_SUPPRESSED,
  MEETING_COLLECTION_VISIBLE,
} from "./meeting_same_proceeding.mjs";

export const RETAINED_MEETING_DETAIL_SCHEMA = "cityscroll.community_board_retained_meeting_detail.v1";
export const RETENTION_BASIS_PREVIOUSLY_ADMITTED = "previously_admitted";
export const RETENTION_BASIS_KNOWN_LINKED_EVENT_URL = "known_linked_event_url";
export const MEETING_TIMING_PAST = "past";
export const MEETING_TIMING_CURRENT = "current";
export const MEETING_TIMING_UPCOMING = "upcoming";
export const MEETING_TIMING_UNKNOWN = "unknown";

function text(value, max = 2_000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max) || null;
}

function dayOf(value) {
  const match = String(value || "").slice(0, 10).match(/^(\d{4}-\d{2}-\d{2})$/);
  return match ? match[1] : null;
}

export function publisherIdentityOf(record = {}) {
  return text(record.publisher_identifier)
    || text(record.record_id)
    || text(record.source_record_id)
    || text(record.record_url)
    || null;
}

export function eventDayOf(record = {}) {
  return dayOf(record.date)
    || dayOf(record.meeting_date)
    || dayOf(record.start_at)
    || dayOf(record.event_date);
}

/**
 * Explicit meeting URLs already linked from the hearing-preparation reading.
 * These are product links, not a neighborhood allowlist: every board that
 * publishes such a reading contributes its hearing.source_url.
 */
export function knownLinkedEventUrlsFromHearingContext(hearingContext = null) {
  const boards = Array.isArray(hearingContext?.boards) ? hearingContext.boards : [];
  const out = [];
  for (const board of boards) {
    const url = text(board?.hearing?.source_url, 2_000);
    const boardId = text(board?.board_id, 80);
    if (!url || !boardId) continue;
    out.push({
      board_id: boardId,
      source_url: url,
      meeting_date: dayOf(board?.hearing?.meeting_date) || null,
      linked_from: "community_board_hearing_context",
    });
  }
  return out.sort((left, right) => (
    left.board_id.localeCompare(right.board_id)
    || left.source_url.localeCompare(right.source_url)
  ));
}

export function meetingTimingStatus(record = {}, asOfDay = null) {
  const eventDay = eventDayOf(record);
  const asOf = dayOf(asOfDay);
  if (!eventDay || !asOf) return MEETING_TIMING_UNKNOWN;
  if (eventDay < asOf) return MEETING_TIMING_PAST;
  if (eventDay > asOf) return MEETING_TIMING_UPCOMING;
  return MEETING_TIMING_CURRENT;
}

/**
 * Upcoming collections exclude retained past details. Omission from a successful
 * feed never invents a cancellation; only an explicit publisher cancellation
 * record carries that claim.
 */
export function upcomingCollectionVisibilityFor(record = {}, {
  asOfDay = null,
  presentInUpcomingFeed = false,
} = {}) {
  if (presentInUpcomingFeed) {
    return {
      collection_visibility: MEETING_COLLECTION_VISIBLE,
      timing_status: meetingTimingStatus(record, asOfDay),
      reason: null,
    };
  }
  const timing = meetingTimingStatus(record, asOfDay);
  if (timing === MEETING_TIMING_PAST) {
    return {
      collection_visibility: MEETING_COLLECTION_SUPPRESSED,
      timing_status: timing,
      reason: "retained_detail_past_upcoming_window",
    };
  }
  return {
    collection_visibility: MEETING_COLLECTION_VISIBLE,
    timing_status: timing,
    reason: record?.detail_retention?.basis || null,
  };
}

function isAdmittedEvent(record) {
  return record?.record_kind === "event"
    && Boolean(publisherIdentityOf(record))
    && Boolean(eventDayOf(record))
    && record?.observed_receipt?.status === "ok";
}

function withRetention(record, retention) {
  const asOfDay = retention.as_of_day || null;
  const visibility = upcomingCollectionVisibilityFor(record, {
    asOfDay,
    presentInUpcomingFeed: false,
  });
  return {
    ...record,
    detail_retention: {
      schema: RETAINED_MEETING_DETAIL_SCHEMA,
      basis: retention.basis,
      omitted_from_upcoming: true,
      cancellation_inferred: false,
      linked_from: retention.linked_from || null,
      as_of_day: asOfDay,
    },
    collection_visibility: visibility.collection_visibility,
    timing_status: visibility.timing_status,
  };
}

function withCurrentObservation(record, asOfDay) {
  const visibility = upcomingCollectionVisibilityFor(record, {
    asOfDay,
    presentInUpcomingFeed: true,
  });
  const next = {
    ...record,
    collection_visibility: visibility.collection_visibility,
    timing_status: visibility.timing_status,
  };
  if (next.detail_retention) delete next.detail_retention;
  return next;
}

/**
 * Union current upcoming observations with previously admitted identities and
 * known linked event-detail records. Current observations win for the same
 * publisher identity. Deduplicates by publisher identity within the board.
 */
export function unionRetainedMeetingDetailRecords({
  currentRecords = [],
  previousRecords = [],
  knownLinkedRecords = [],
  asOfDay = null,
} = {}) {
  const asOf = dayOf(asOfDay);
  const byIdentity = new Map();
  const order = [];

  const take = (record, mode) => {
    if (!isAdmittedEvent(record)) return;
    const identity = publisherIdentityOf(record);
    if (!identity) return;
    if (byIdentity.has(identity)) {
      if (mode !== "current") return;
      byIdentity.set(identity, withCurrentObservation(record, asOf));
      return;
    }
    const next = mode === "current"
      ? withCurrentObservation(record, asOf)
      : withRetention(record, {
        basis: mode === "known_linked"
          ? RETENTION_BASIS_KNOWN_LINKED_EVENT_URL
          : RETENTION_BASIS_PREVIOUSLY_ADMITTED,
        linked_from: record.detail_retention?.linked_from || record.linked_from || null,
        as_of_day: asOf,
      });
    byIdentity.set(identity, next);
    order.push(identity);
  };

  for (const record of currentRecords) take(record, "current");
  for (const record of knownLinkedRecords) take(record, "known_linked");
  for (const record of previousRecords) take(record, "previous");

  return order.map((identity) => byIdentity.get(identity));
}

export function upcomingCollectionRecords(records = [], { asOfDay = null } = {}) {
  return (Array.isArray(records) ? records : []).filter((record) => {
    const present = !record?.detail_retention?.omitted_from_upcoming;
    const visibility = upcomingCollectionVisibilityFor(record, {
      asOfDay,
      presentInUpcomingFeed: present,
    });
    return visibility.collection_visibility !== MEETING_COLLECTION_SUPPRESSED;
  });
}
