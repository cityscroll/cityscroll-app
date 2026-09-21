import assert from "node:assert/strict";
import { test } from "node:test";

import { meetingsBrowseFromModel } from "../capabilities/meetings.mjs";
import { collapseMeetingDeliveryRows } from "../site/meeting_delivery_identity.mjs";
import { compileSub, scopedMeetingWatchRows } from "../worker/src/lib/compile.mjs";
import { prepareWatchFilter } from "../worker/src/lib/filter.mjs";

const TODAY = "2026-09-01";
const AVAILABILITY = {
  timezone: "America/New_York",
  windows: [
    { weekdays: [1, 2, 3, 4, 5], start: "17:00" },
    { weekdays: [0, 6] },
  ],
};

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

const RAW_ROWS = [
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

const CANONICAL_ROWS = collapseMeetingDeliveryRows(RAW_ROWS);

function model() {
  return {
    schema: "cityscroll.shared_meeting_read_model.v1",
    generated_at: "2026-09-30T12:00:00Z",
    freshness: { generated_at: "2026-09-30T12:00:00Z", checked_at: "2026-09-30T12:00:00Z" },
    sources: { city_record: { status: "available" }, public_body_calendar: { status: "fresh" } },
    rows: CANONICAL_ROWS,
  };
}

test("browse, MCP capability, preview materialization, and email compilation share one identity set", () => {
  const prepared = prepareWatchFilter("meetings", { availability: AVAILABILITY });
  assert.equal(prepared.ok, true);
  const watch = { lens: "meetings", filter: prepared.filter };
  const expected = ["meeting:weekday-evening", "meeting:weekend-timed"];

  const browse = meetingsBrowseFromModel(model(), {
    from: "2026-10-01", to: "2026-10-31", availability: AVAILABILITY,
    attendanceModes: [], limit: 25,
  });
  const browseRows = browse.results;
  const preview = scopedMeetingWatchRows(watch.filter, TODAY, RAW_ROWS);
  const email = scopedMeetingWatchRows(watch.filter, TODAY, RAW_ROWS);
  const compiled = compileSub(watch, TODAY);

  assert.deepEqual(browseRows.map((row) => row.meeting_id).sort(), expected.slice().sort());
  assert.deepEqual(preview.map((row) => row.meeting_id).sort(), expected.slice().sort());
  assert.deepEqual(email.map((row) => row.meeting_id).sort(), expected.slice().sort());
  assert.equal(compiled.routeReadModel.filter.availability.schema, "cityscroll.meeting_availability.v1");
});

test("cancellation, date-only, conflict, and reschedule updates cannot widen delivery", () => {
  const prepared = prepareWatchFilter("meetings", { availability: AVAILABILITY });
  const rows = scopedMeetingWatchRows(prepared.filter, TODAY, RAW_ROWS);
  assert.deepEqual(rows.map((row) => row.meeting_id), [
    "meeting:weekday-evening", "meeting:weekend-timed",
  ]);
  assert.equal(rows.some((row) => row.meeting_id === "meeting:rescheduled"), false);
  assert.equal(rows.some((row) => row.status === "cancelled"), false);
  assert.equal(rows.some((row) => row.schedule?.status === "date_only"), false);
  assert.equal(rows.some((row) => row.schedule?.status === "conflicted"), false);
});
