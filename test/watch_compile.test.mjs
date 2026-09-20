import assert from "node:assert/strict";
import test from "node:test";

import { compileSub, scopedMeetingWatchEvaluation, scopedMeetingWatchRows } from "../worker/src/lib/compile.mjs";
import { prepareWatchFilter } from "../worker/src/lib/filter.mjs";

const TODAY = "2026-09-01";
const AVAILABILITY = {
  timezone: "America/New_York",
  windows: [
    { weekdays: [1, 2, 3, 4, 5], start: "17:00" },
    { weekdays: [0, 6] },
  ],
};

function meeting(id, startsAt, schedule = {}) {
  const rawDate = String(startsAt || schedule.raw_date || "2026-09-30").slice(0, 10);
  return {
    meeting_id: `meeting:test:${id}`,
    event_date: startsAt || rawDate,
    schedule: {
      timezone: "America/New_York",
      raw_date: rawDate,
      ...schedule,
      ...(startsAt ? { starts_at: startsAt, status: "resolved", precision: "exact_time", raw_time: startsAt.slice(11, 16) } : {}),
    },
  };
}

const sourceRows = [
  meeting("weekday-boundary", "2026-09-30T17:00:00"),
  meeting("weekday-before", "2026-09-30T16:59:00"),
  meeting("weekend", "2026-10-04T10:00:00"),
  meeting("date-only", null, { status: "date_only", precision: "date_only", raw_date: "2026-10-04", raw_time: null }),
  meeting("conflicted", null, { status: "conflicted", precision: "exact_time", raw_date: "2026-10-04" }),
  meeting("invalid", null, { status: "invalid", raw_date: "2026-10-04", raw_time: "25:00" }),
  { ...meeting("cancelled", "2026-09-30T18:00:00"), status: "cancelled" },
];

test("watch materialization applies one canonical availability evaluator and exposes counts", () => {
  const prepared = prepareWatchFilter("meetings", { availability: AVAILABILITY });
  assert.equal(prepared.ok, true);
  const evaluation = scopedMeetingWatchEvaluation(prepared.filter, TODAY, sourceRows);
  assert.deepEqual(evaluation.rows.map((row) => row.meeting_id), [
    "meeting:test:weekday-boundary",
    "meeting:test:weekend",
  ]);
  assert.deepEqual(evaluation.availability, {
    total: 7,
    matched: 2,
    excluded: 5,
    unknown_start: 1,
    conflicted: 1,
    invalid_time: 1,
    canceled: 1,
    outside_window: 1,
  });
});

test("unrestricted browse retains temporal evidence rows while availability narrows the watch", () => {
  const unrestricted = scopedMeetingWatchRows({}, TODAY, sourceRows);
  assert.deepEqual(unrestricted.map((row) => row.meeting_id), sourceRows.map((row) => row.meeting_id));
  const prepared = prepareWatchFilter("meetings", { availability: AVAILABILITY });
  const compiled = compileSub({ lens: "meetings", filter: prepared.filter }, TODAY);
  assert.equal(compiled.routeReadModel.filter.availability.schema, "cityscroll.meeting_availability.v1");
  assert.deepEqual(scopedMeetingWatchRows(compiled.routeReadModel.filter, TODAY, sourceRows).map((row) => row.meeting_id), [
    "meeting:test:weekday-boundary",
    "meeting:test:weekend",
  ]);
});

test("invalid availability is refused before a watch can be compiled or saved", () => {
  const invalid = { timezone: "No/Such_Zone", windows: [{ weekdays: [1], start: "17:00" }] };
  const prepared = prepareWatchFilter("meetings", { availability: invalid });
  assert.equal(prepared.ok, false);
  assert.match(prepared.reason, /meeting-availability-invalid_timezone/);
  assert.equal(compileSub({ lens: "meetings", filter: { availability: invalid } }, TODAY), null);
});
