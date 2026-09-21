import assert from "node:assert/strict";
import test from "node:test";

import {
  MEETINGS_BROWSE_CAPABILITY_REFERENCE,
  meetingsBrowseFromModel,
  normalizeMeetingsBrowseInput,
} from "../capabilities/meetings.mjs";

const availability = {
  timezone: "America/New_York",
  windows: [
    { weekdays: [1, 2, 3, 4, 5], start: "17:00" },
    { weekdays: [0, 6] },
  ],
};

const rows = [
  {
    object_type: "meeting", meeting_id: "meeting:city_record:oct-1700", source_system: "city_record",
    title: "Weekday evening", event_date: "2026-10-01T17:00:00-04:00", attendance_mode: "hybrid",
    schedule: { status: "resolved", precision: "exact_time", starts_at: "2026-10-01T17:00:00-04:00", timezone: "America/New_York" },
    source_receipt: { status: "ok", observed_at: "2026-09-30T12:00:00Z" },
  },
  {
    object_type: "meeting", meeting_id: "meeting:city_record:oct-1659", source_system: "city_record",
    title: "Weekday before window", event_date: "2026-10-02T16:59:00-04:00", attendance_mode: "remote",
    schedule: { status: "resolved", precision: "exact_time", starts_at: "2026-10-02T16:59:00-04:00", timezone: "America/New_York" },
    source_receipt: { status: "ok", observed_at: "2026-09-30T12:00:00Z" },
  },
  {
    object_type: "meeting", meeting_id: "meeting:community_board:oct-date-only", source_system: "community_board",
    title: "Weekend date only", event_date: "2026-10-03", attendance_mode: "remote",
    schedule: { status: "date_only", precision: "date_only", raw_date: "2026-10-03", timezone: "America/New_York" },
    source_receipt: { status: "ok", observed_at: "2026-09-30T12:00:00Z" },
  },
  {
    object_type: "meeting", meeting_id: "meeting:public_body_calendar:contract:oct-weekend", source_system: "public_body_calendar",
    source_contract_id: "contract", title: "Weekend morning", event_date: "2026-10-04T10:00:00-04:00", attendance_mode: "remote",
    schedule: { status: "resolved", precision: "exact_time", starts_at: "2026-10-04T10:00:00-04:00", timezone: "America/New_York" },
    source_receipt: { status: "ok", observed_at: "2026-09-30T12:00:00Z" },
  },
];

function model() {
  return {
    schema: "cityscroll.shared_meeting_read_model.v1",
    version: 1,
    generated_at: "2026-09-30T12:00:00Z",
    freshness: { generated_at: "2026-09-30T12:00:00Z", checked_at: "2026-09-30T12:00:00Z" },
    sources: {
      city_record: { status: "available", row_count: 2, generated_at: "2026-09-30T12:00:00Z" },
      community_board: { status: "available", row_count: 1, generated_at: "2026-09-30T12:00:00Z" },
      contract: { status: "fresh", row_count: 1, generated_at: "2026-09-30T12:00:00Z" },
    },
    rows: rows.map((row) => ({ ...row })),
  };
}

function query(extra = {}) {
  return {
    from: "2026-10-01",
    to: "2026-10-31",
    availability,
    attendanceModes: ["hybrid", "remote"],
    limit: 10,
    ...extra,
  };
}

test("the anchor query returns structured rows, applied civil-time filters, coverage, and freshness", () => {
  const result = meetingsBrowseFromModel(model(), query());
  assert.equal(result.capability_reference, MEETINGS_BROWSE_CAPABILITY_REFERENCE);
  assert.equal(result.availability, "complete");
  assert.deepEqual(result.results.map((row) => row.meeting_id), [
    "meeting:city_record:oct-1700",
    "meeting:public_body_calendar:contract:oct-weekend",
  ]);
  assert.deepEqual(result.filters.availability, {
    schema: "cityscroll.meeting_availability.v1",
    timezone: "America/New_York",
    windows: [
      { weekdays: [1, 2, 3, 4, 5], start: "17:00", end: null },
      { weekdays: [0, 6], start: null, end: null },
    ],
    unknown_start: "exclude",
  });
  assert.equal(result.coverage.exclusions.unknown_start, 1);
  assert.equal(result.coverage.exclusions.outside_window, 1);
  assert.equal(result.coverage.sources.contract.status, "fresh");
  assert.equal(result.freshness.as_of, "2026-09-30T12:00:00Z");
});

test("pages are stable and cursors are bound to the query and model vintage", () => {
  const first = meetingsBrowseFromModel(model(), query({ limit: 1 }));
  assert.equal(first.pagination.truncated, true);
  const second = meetingsBrowseFromModel(model(), query({ limit: 1, cursor: first.pagination.next_cursor }));
  assert.deepEqual(second.results.map((row) => row.meeting_id), ["meeting:public_body_calendar:contract:oct-weekend"]);
  assert.throws(() => meetingsBrowseFromModel(model(), query({ limit: 1, attendanceModes: ["remote"], cursor: first.pagination.next_cursor })), /stale/);
  assert.throws(() => meetingsBrowseFromModel({ ...model(), generated_at: "2026-10-01T00:00:00Z" }, query({ limit: 1, cursor: first.pagination.next_cursor })), /stale/);
});

test("unsupported fields, invalid zones, and attendance values fail closed", () => {
  assert.throws(() => normalizeMeetingsBrowseInput({ unknown: true }), /does not accept/);
  assert.throws(() => normalizeMeetingsBrowseInput({ availability: { ...availability, timezone: "Mars/Olympus" } }), /invalid_timezone/);
  assert.throws(() => normalizeMeetingsBrowseInput({ attendanceModes: ["livestream"] }), /unsupported/);
  assert.throws(() => normalizeMeetingsBrowseInput({ from: "2026-10-31", to: "2026-10-01" }), /later/);
});
