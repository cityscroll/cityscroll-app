// One frozen meeting corpus for every watch-availability parity surface.
//
// The corpus is the publisher occurrence set: it deliberately holds the
// pre-collapse shapes (a superseded reschedule occurrence, a cancelled row, a
// date-only row, a conflicted row) so each delivery surface is driven through
// its real intake — browse and MCP over the shared collapsed read model,
// email compilation and the feed formats over the pre-collapse route read
// model slices. Every identity-set assertion in the watch parity and calendar
// feed families reads this module, so there is exactly one corpus, not one
// per suite.

import { collapseMeetingDeliveryRows } from "../../site/meeting_delivery_identity.mjs";
import { HEARINGS_KV_KEY } from "../../worker/src/hearings.mjs";
import { MEETING_MANIFEST_KEY } from "../../worker/src/lib/route_read_model_kv.mjs";
import { validateMeetingAvailability } from "../../site/meeting_availability_filter.mjs";

export const TODAY = "2026-09-01";

// Resident-written expression (no schema field, implicit unknown_start) so
// admission and canonicalization are exercised exactly as a saved watch would
// exercise them.
export const WATCH_AVAILABILITY = {
  timezone: "America/New_York",
  windows: [
    { weekdays: [1, 2, 3, 4, 5], start: "17:00" },
    { weekdays: [0, 6] },
  ],
};

export const CANONICAL_WATCH_AVAILABILITY = validateMeetingAvailability(WATCH_AVAILABILITY).canonical;

function timed(meetingId, startsAt, extra = {}) {
  const rawDate = startsAt.slice(0, 10);
  return {
    object_type: "meeting",
    meeting_id: meetingId,
    source_system: extra.source_system || "city_record",
    title: extra.title || meetingId,
    event_date: startsAt,
    schedule: {
      status: "resolved",
      precision: "exact_time",
      starts_at: startsAt,
      timezone: "America/New_York",
      raw_date: rawDate,
      raw_time: startsAt.slice(11, 16),
      basis: "publisher_field",
      source_url: `https://official.example/${encodeURIComponent(meetingId)}`,
    },
    ...extra,
  };
}

export const WATCH_CORPUS_ROWS = [
  timed("meeting:weekday-evening", "2026-10-05T17:00:00"),
  timed("meeting:weekday-before", "2026-10-05T16:59:00"),
  timed("meeting:weekend-timed", "2026-10-04T10:00:00", { source_system: "public_body_calendar" }),
  {
    ...timed("meeting:weekend-date-only", "2026-10-03T00:00:00"),
    event_date: "2026-10-03",
    schedule: {
      status: "date_only", precision: "date_only", raw_date: "2026-10-03",
      raw_time: null, timezone: "America/New_York", basis: "publisher_field",
    },
  },
  {
    ...timed("meeting:conflicted", "2026-10-06T18:00:00"),
    schedule: {
      status: "conflicted", precision: "exact_time", raw_date: "2026-10-06",
      raw_time: "18:00 / 18:30", timezone: "America/New_York", basis: "publisher_event",
    },
  },
  {
    ...timed("meeting:cancelled", "2026-10-07T18:00:00"),
    status: "cancelled", lifecycle: "cancelled",
  },
  timed("meeting:rescheduled", "2026-10-05T18:00:00", { title: "Old time" }),
  {
    ...timed("meeting:rescheduled", "2026-10-06T12:00:00", { title: "Current time" }),
    lifecycle: "rescheduled", sequence: 1,
    schedule: {
      status: "resolved", precision: "exact_time", starts_at: "2026-10-06T12:00:00",
      timezone: "America/New_York", raw_date: "2026-10-06", raw_time: "12:00",
      basis: "publisher_event", source_url: "https://official.example/rescheduled-current",
    },
  },
];

// The one accepted identity set every surface must reproduce: the weekday
// 17:00+ evening row and the weekend row, nothing else.
export const EXPECTED_WATCH_MEETING_IDENTITIES = ["meeting:weekday-evening", "meeting:weekend-timed"];

export const EXCLUDED_WATCH_MEETING_IDENTITIES = [
  ...new Set(WATCH_CORPUS_ROWS.map((row) => row.meeting_id)
    .filter((id) => !EXPECTED_WATCH_MEETING_IDENTITIES.includes(id))),
];

// The shared meeting read model browse and MCP consume: one row per delivery
// identity, reschedule already collapsed onto the current occurrence.
export function watchCorpusModel() {
  return {
    schema: "cityscroll.shared_meeting_read_model.v1",
    generated_at: "2026-09-30T12:00:00Z",
    freshness: { generated_at: "2026-09-30T12:00:00Z", checked_at: "2026-09-30T12:00:00Z" },
    sources: { city_record: { status: "available" }, public_body_calendar: { status: "fresh" } },
    rows: collapseMeetingDeliveryRows(WATCH_CORPUS_ROWS),
  };
}

const CORPUS_SLICE_KEY = "route-read-model:meetings:corpus:2026-10";

// Worker env whose ALERT_STATE serves the corpus through both production
// intakes: the shared read model key (browse/MCP) and the meetings route
// read-model manifest plus month slice (email compilation and feeds). A fresh
// KV per call matches a fresh isolate: no cross-test cache reuse.
export function watchCorpusEnv() {
  const values = new Map([
    [HEARINGS_KV_KEY, JSON.stringify(watchCorpusModel())],
    [MEETING_MANIFEST_KEY, JSON.stringify({
      schema_version: 1,
      kind: "meetings",
      version: "corpus-1",
      slices: { "2026-10": CORPUS_SLICE_KEY },
    })],
    [CORPUS_SLICE_KEY, JSON.stringify({ rows: WATCH_CORPUS_ROWS })],
  ]);
  const kv = {
    get: async (key) => values.get(key) ?? null,
    put: async () => {},
  };
  return {
    ALERT_STATE: kv,
    SUBS: { get: async () => "0", put: async () => {} },
  };
}
