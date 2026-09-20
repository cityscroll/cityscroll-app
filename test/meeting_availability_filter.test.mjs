import assert from "node:assert/strict";
import test from "node:test";

import {
  MEETING_AVAILABILITY_SCHEMA,
  canonicalMeetingAvailability,
  evaluateMeetingAvailability,
  evaluateMeetingAvailabilityRows,
  validateMeetingAvailability,
} from "../site/meeting_availability_filter.mjs";

const AVAILABILITY = {
  timezone: "America/New_York",
  windows: [
    { weekdays: [1, 2, 3, 4, 5], start: "17:00" },
    { weekdays: [0, 6] },
  ],
};

function row(id, schedule, extra = {}) {
  return {
    meeting_id: `meeting:test:${id}`,
    event_date: schedule?.raw_date || schedule?.starts_at || "2026-09-30T17:00:00",
    schedule,
    ...extra,
  };
}

test("canonical availability is a union of weekday/time windows with an inclusive start", () => {
  const canonical = canonicalMeetingAvailability(AVAILABILITY);
  assert.deepEqual(canonical, {
    schema: MEETING_AVAILABILITY_SCHEMA,
    timezone: "America/New_York",
    windows: [
      { weekdays: [1, 2, 3, 4, 5], start: "17:00", end: null },
      { weekdays: [0, 6], start: null, end: null },
    ],
    unknown_start: "exclude",
  });

  assert.equal(evaluateMeetingAvailability(row("weekday-boundary", {
    status: "resolved", precision: "exact_time", starts_at: "2026-09-30T17:00:00", timezone: "America/New_York",
    raw_date: "2026-09-30", raw_time: "17:00",
  }), canonical).matched, true);
  assert.equal(evaluateMeetingAvailability(row("weekday-before", {
    status: "resolved", precision: "exact_time", starts_at: "2026-09-30T16:59:00", timezone: "America/New_York",
    raw_date: "2026-09-30", raw_time: "16:59",
  }), canonical).matched, false);
  assert.equal(evaluateMeetingAvailability(row("weekend", {
    status: "resolved", precision: "exact_time", starts_at: "2026-10-04T10:00:00", timezone: "America/New_York",
    raw_date: "2026-10-04", raw_time: "10:00",
  }), canonical).matched, true);
});

test("unknown starts are excluded by default and counted without changing the base row", () => {
  const fixtures = [
    row("date-only", { status: "date_only", precision: "date_only", raw_date: "2026-10-04", timezone: "America/New_York" }),
    row("conflicted", { status: "conflicted", precision: "exact_time", raw_date: "2026-10-04", timezone: "America/New_York" }),
    row("invalid", { status: "invalid", precision: null, raw_date: "2026-10-04", raw_time: "25:00", timezone: "America/New_York" }),
    row("cancelled", { status: "resolved", precision: "exact_time", starts_at: "2026-09-30T18:00:00", raw_date: "2026-09-30", raw_time: "18:00", timezone: "America/New_York" }, { status: "cancelled" }),
  ];
  const result = evaluateMeetingAvailabilityRows(fixtures, AVAILABILITY, { asOf: "2026-09-01" });
  assert.deepEqual(result.rows, []);
  assert.deepEqual(result.counts, {
    total: 4,
    matched: 0,
    excluded: 4,
    unknown_start: 1,
    conflicted: 1,
    invalid_time: 1,
    canceled: 1,
    outside_window: 0,
  });
  assert.equal(fixtures[0].schedule.status, "date_only");
  assert.equal(evaluateMeetingAvailability(fixtures[0], { ...AVAILABILITY, unknown_start: "include" }).matched, true);
});

test("civil classification follows the requested IANA zone across both DST transitions", () => {
  const weekend = {
    timezone: "America/New_York",
    windows: [{ weekdays: [0], start: "17:00" }],
  };
  const spring = row("spring-dst", {
    status: "resolved", precision: "exact_time", starts_at: "2026-03-08T22:00:00Z", timezone: "UTC",
    raw_date: "2026-03-08", raw_time: "22:00Z",
  });
  const autumn = row("autumn-dst", {
    status: "resolved", precision: "exact_time", starts_at: "2026-11-01T22:00:00Z", timezone: "UTC",
    raw_date: "2026-11-01", raw_time: "22:00Z",
  });
  assert.equal(evaluateMeetingAvailability(spring, weekend).matched, true);
  assert.equal(evaluateMeetingAvailability(autumn, weekend).matched, true);
});

test("availability admission rejects invalid weekday, clock, zone, and empty windows", () => {
  for (const [path, value] of [
    ["weekday", { ...AVAILABILITY, windows: [{ weekdays: [7] }] }],
    ["time", { ...AVAILABILITY, windows: [{ weekdays: [1], start: "5:00" }] }],
    ["timezone", { ...AVAILABILITY, timezone: "Not/IANA" }],
    ["empty", { ...AVAILABILITY, windows: [] }],
  ]) {
    const result = validateMeetingAvailability(value);
    assert.equal(result.ok, false, path);
    assert.ok(result.errors.length, path);
  }
});
