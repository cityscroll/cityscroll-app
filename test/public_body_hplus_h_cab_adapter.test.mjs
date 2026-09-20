import assert from "node:assert/strict";
import test from "node:test";

import {
  HPLUS_H_CAB_SOURCE_URL,
  buildHplusHCabCalendarIndex,
  parseHplusHCabScheduleHtml,
  projectHplusHCabRecurrences,
} from "../site/hplus_h_cab_calendar.mjs";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import { todayISO } from "./helpers/test_clock.mjs";

const observedAt = () => `${todayISO()}T12:00:00.000Z`;
const receipt = () => ({
  schema: "cityscroll.meeting_source_receipt.v1",
  source_url: HPLUS_H_CAB_SOURCE_URL,
  observed_at: observedAt(),
  status: "ok",
  fetch_status: "snapshot",
});

const RULES = [
  ["Bellevue", "4th Wednesday", "6:00 pm"],
  ["Carter", "2nd Thursday", "5:30 pm"],
  ["Coler", "3rd Monday", "4:00 pm"],
  ["Gotham Health, Gouverneur", "1st Monday", "6:00 pm"],
  ["Harlem", "3rd Wednesday", "6:00 pm"],
  ["Metropolitan", "1st Thursday", "5:00 pm"],
  ["Gotham Health, Sydenham", "3rd Thursday", "5:30 pm"],
  ["Gotham Health, Belvis", "4th Monday", "6:00 pm"],
  ["Gotham Health, Morrisania", "3rd Tuesday", "6:00 pm"],
  ["Jacobi", "2nd Wednesday", "5:30 pm"],
  ["Lincoln", "2nd Thursday", "6:00 pm"],
  ["North Central Bronx", "1st Wednesday", "5:30 pm"],
  ["Coney Island", "1st Thursday", "6:00 pm"],
  ["Gotham Health, Cumberland", "3rd Tuesday", "6:00 pm"],
  ["Gotham Health, East New York", "2nd Tuesday", "6:00 pm"],
  ["Kings County", "3rd Thursday", "5:00 pm"],
  ["McKinney", "3rd Tuesday", "6:00 pm"],
  ["Woodhull", "4th Monday", "6:00 pm"],
  ["Elmhurst", "1st Wednesday", "6:00 pm"],
  ["Queens", "4th Wednesday", "5:00 pm"],
  ["Sea View", "4th Monday", "3:00 pm"],
];

function fixture(rows = RULES) {
  return `<main>${rows.map(([facility, recurrence, time], index) => `
    <p><a href="https://example.test/facilities/${index}">NYC Health + Hospitals/${facility}</a>
      ${recurrence} of each month, ${time}</p>`).join("\n")}</main>`;
}

function options(extra = {}) {
  return {
    observedAt: observedAt(),
    receipt: receipt(),
    horizonStart: "2026-10-01",
    horizonEnd: "2026-10-31",
    ...extra,
  };
}

test("all 21 published facility rows parse and the three anchors project in local time", () => {
  const index = parseHplusHCabScheduleHtml(fixture(), options());
  assert.equal(index.rule_count, 21);
  assert.equal(index.quarantined.length, 0);
  const byFacility = new Map(index.rows.map((row) => [row.facility_slug, row]));
  assert.equal(byFacility.get("coney-island").event_date, "2026-10-01T18:00:00");
  assert.equal(byFacility.get("bellevue").event_date, "2026-10-28T18:00:00");
  assert.equal(byFacility.get("kings-county").event_date, "2026-10-15T17:00:00");
  assert.ok(index.rows.every((row) => row.temporal_basis === "published_recurrence"));
  assert.ok(index.rows.every((row) => row.source_receipt.observed_at === observedAt()));
});

test("recurrence projections keep unsupported location and participation facts unknown", () => {
  const [meeting] = parseHplusHCabScheduleHtml(fixture([RULES[12]]), options()).rows;
  assert.equal(meeting.venue, null);
  assert.equal(meeting.participation, null);
  assert.equal(meeting.speaking_rights, "unknown");
  assert.equal(meeting.source_raw_values.derived, true);
  assert.equal(meeting.schedule.basis, "published_recurrence");
  assert.equal(meeting.source_url, HPLUS_H_CAB_SOURCE_URL);
});

test("malformed and duplicate rules are quarantined instead of being repaired or overwritten", () => {
  const malformed = `<p>Coney Island 6th Thursday of each month, 6:00 pm</p>
    <p>Queens 4th Wednesday of each month, 6 :00 pm</p>
    <p>Queens 4th Wednesday of each month, 5:00 pm</p>`;
  const index = parseHplusHCabScheduleHtml(malformed, options());
  assert.equal(index.rows.length, 0);
  assert.deepEqual(index.quarantined.map((entry) => entry.reason), [
    "malformed_ordinal", "duplicate_facility_rule",
  ]);
  assert.equal(index.quarantined[0].facility_name, "Coney Island");
});

test("the inclusive horizon never emits a date outside its bounds", () => {
  const index = parseHplusHCabScheduleHtml(fixture([RULES[12]]), {
    ...options(),
    horizonStart: "2026-10-02",
    horizonEnd: "2026-10-31",
  });
  assert.deepEqual(index.rows, []);
  assert.ok(index.projected_rows.every((row) => row.event_date.slice(0, 10) >= "2026-10-02"));
  assert.ok(index.projected_rows.every((row) => row.event_date.slice(0, 10) <= "2026-10-31"));
});

test("removed rules retire future projections while historical rows and receipts remain unchanged", () => {
  const first = parseHplusHCabScheduleHtml(fixture([RULES[12], RULES[15]]), options({
    horizonStart: "2026-09-01",
    horizonEnd: "2026-09-30",
  }));
  const historical = first.rows.find((row) => row.facility_slug === "coney-island");
  const second = parseHplusHCabScheduleHtml(fixture([RULES[12]]), options({
    previousIndex: first,
    horizonStart: "2026-10-01",
    horizonEnd: "2026-10-31",
  }));
  assert.deepEqual(second.retired_rules.map((rule) => rule.facility_slug), ["kings-county"]);
  assert.equal(second.historical_rows.length, 2);
  assert.equal(second.rows.find((row) => row.meeting_id === historical.meeting_id).source_receipt.observed_at, observedAt());
  assert.equal(second.projected_rows.some((row) => row.facility_slug === "kings-county"), false);
});

test("an explicit occurrence supersedes only the matching derived identity", () => {
  const explicit = {
    meeting_id: "meeting:public_body_calendar:explicit:coney-october",
    facility_slug: "coney-island",
    event_date: "2026-10-01T19:00:00",
    source_url: "https://example.test/explicit/coney-october",
  };
  const result = projectHplusHCabRecurrences({
    rules: [{
      facility_name: "Coney Island",
      facility_slug: "coney-island",
      ordinal: 1,
      weekday: "thursday",
      weekday_number: 4,
      time: "18:00:00",
      raw_time: "6:00 pm",
      source_text: "Coney Island 1st Thursday of each month, 6:00 pm",
    }],
    ...options({ explicitInstances: [explicit] }),
  });
  assert.deepEqual(result.rows, []);
  assert.equal(result.superseded.length, 1);
  assert.equal(result.superseded[0].facility_slug, "coney-island");
  assert.equal(result.superseded[0].date, "2026-10-01");
});

test("derived meetings enter the shared read model without losing recurrence evidence", () => {
  const index = buildHplusHCabCalendarIndex(fixture([RULES[12]]), options());
  const model = buildSharedMeetingReadModel({
    publicBodyCalendarIndex: index,
    generatedAt: observedAt(),
    now: observedAt(),
  });
  assert.equal(model.sources.public_body_calendar.status, "fresh");
  assert.equal(model.rows[0].temporal_basis, "published_recurrence");
  assert.equal(model.rows[0].meeting_id, "meeting:public_body_calendar:hplus_h_cab:coney-island:2026-10-01");
});
