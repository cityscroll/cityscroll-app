import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeBsaCalendarMeeting,
  normalizeCityRecordMeeting,
  normalizeCommunityBoardMeeting,
  normalizeNycLegistarEventsMeeting,
  normalizeOathTrialCalendarMeeting,
  normalizePdcCalendarMeeting,
} from "../site/meeting_object_contract.mjs";
import {
  MEETING_SCHEDULE_SCHEMA,
  projectMeetingSchedule,
  scheduleHasExactTime,
  validateMeetingSchedule,
} from "../site/meeting_temporal_evidence.mjs";
import { calendarOccurrencesForRecord } from "../site/calendar_occurrence.mjs";

const RECEIPT = {
  schema: "cityscroll.meeting_source_receipt.v1",
  status: "ok",
  observed_at: "2026-09-18T12:00:00Z",
};

const PRODUCERS = [
  ["city_record", () => normalizeCityRecordMeeting({
    request_id: "temporal-city-record",
    event_date: "2026-10-14T18:00:00",
    source_receipt: RECEIPT,
  })],
  ["community_board", () => normalizeCommunityBoardMeeting({
    source_record_id: "temporal-community-board",
    date: "2026-10-14",
    start_at: "2026-10-14T18:30:00-04:00",
    source_url: "https://example.test/community-board/temporal",
    source_receipt: RECEIPT,
  })],
  ["nyc_legistar_events", () => normalizeNycLegistarEventsMeeting({
    EventId: "temporal-legistar",
    EventDate: "2026-10-14",
    EventTime: "6:00 PM",
    EventInSiteURL: "https://example.test/legistar/temporal",
    source_receipt: RECEIPT,
  })],
  ["pdc_calendar", () => normalizePdcCalendarMeeting({
    pdc_event_id: "temporal-pdc",
    event_date: "2026-10-14T09:00:00",
    source_url: "https://example.test/pdc/temporal",
    source_receipt: RECEIPT,
  })],
  ["bsa_calendar", () => normalizeBsaCalendarMeeting({
    bsa_session_id: "temporal-bsa",
    date: "2026-10-14",
    start_time: "10:00 AM",
    source_url: "https://example.test/bsa/temporal",
    source_receipt: RECEIPT,
  })],
  ["oath_trial_calendar", () => normalizeOathTrialCalendarMeeting({
    oath_trial_session_id: "temporal-oath",
    date: "2026-10-14",
    start_time: "09:30",
    source_url: "https://example.test/oath/temporal",
    source_receipt: RECEIPT,
  })],
];

test("all six meeting producers project exact clocks through one schedule contract", () => {
  for (const [source, build] of PRODUCERS) {
    const row = build();
    assert.equal(row.source_system, source);
    assert.equal(row.schedule.schema, MEETING_SCHEDULE_SCHEMA, source);
    assert.equal(row.schedule.status, "resolved", source);
    assert.equal(row.schedule.precision, "exact_time", source);
    assert.equal(row.schedule.timezone, "America/New_York", source);
    assert.equal(row.schedule.basis, "publisher_field", source);
    assert.equal(row.schedule.observed_at, RECEIPT.observed_at, source);
    assert.ok(row.schedule.source_url, source);
    assert.equal(scheduleHasExactTime(row.schedule), true, source);
    assert.equal(validateMeetingSchedule(row.schedule).ok, true, source);
  }
});

test("date-only evidence remains date-only and never becomes midnight", () => {
  const raw = {
    source_record_id: "date-only",
    event_date: "2026-10-18",
    source_url: "https://example.test/date-only",
    source_receipt: RECEIPT,
  };
  const schedule = projectMeetingSchedule(raw);
  assert.equal(raw.event_date, "2026-10-18");
  assert.equal(schedule.status, "date_only");
  assert.equal(schedule.precision, "date_only");
  assert.equal(schedule.starts_at, null);
  assert.equal(schedule.raw_date, "2026-10-18");
  assert.equal(schedule.raw_time, null);
  assert.equal(scheduleHasExactTime(schedule), false);
  const dateOnlyStartField = projectMeetingSchedule({ start_at: "2026-10-18" });
  assert.equal(dateOnlyStartField.status, "date_only");
  assert.equal(dateOnlyStartField.starts_at, null);

  const occurrences = calendarOccurrencesForRecord({
    ...raw,
    meeting_id: "meeting:date-only",
    source_system: "community_board",
    schedule,
  }, { kind: "meetings", as_of: "2026-10-01" });
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].date, "2026-10-18");
  assert.equal(occurrences[0].starts_at, null);
});

test("conflicting official clocks remain visible as observations without a selected start", () => {
  const schedule = projectMeetingSchedule({
    event_date: "2026-10-14",
    source_url: "https://example.test/meeting",
    source_receipt: RECEIPT,
    temporal_observations: [
      { event_date: "2026-10-14", start_time: "17:00", source_url: "https://example.test/a" },
      { event_date: "2026-10-14", start_time: "18:00", source_url: "https://example.test/b" },
    ],
  });
  assert.equal(schedule.status, "conflicted");
  assert.equal(schedule.starts_at, null);
  assert.equal(scheduleHasExactTime(schedule), false);
  assert.deepEqual(schedule.observations.map((observation) => observation.starts_at), [
    null,
    "2026-10-14T17:00:00",
    "2026-10-14T18:00:00",
  ]);
  assert.deepEqual(schedule.observations.slice(1).map((observation) => observation.source_url), [
    "https://example.test/a",
    "https://example.test/b",
  ]);
});

test("invalid and missing values fail closed without manufacturing schedule facts", () => {
  const invalid = projectMeetingSchedule({
    event_date: "2026-10-14",
    start_time: "25:00",
    source_url: "https://example.test/invalid",
  });
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.starts_at, null);
  assert.equal(scheduleHasExactTime(invalid), false);

  const missing = projectMeetingSchedule({ source_url: "https://example.test/missing" });
  assert.equal(missing.status, "date_only");
  assert.equal(missing.precision, "date_only");
  assert.equal(missing.starts_at, null);
  assert.equal(missing.raw_date, null);
  assert.equal(scheduleHasExactTime(missing), false);
});
