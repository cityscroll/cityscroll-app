import assert from "node:assert/strict";
import test from "node:test";

import {
  BROOKLYN_BOROUGH_BOARD_CALENDAR_PARSER,
  BROOKLYN_BOROUGH_BOARD_INSTITUTION_REF,
  BROOKLYN_BOROUGH_BOARD_SOURCE_URL,
  parseBrooklynBoroughBoardScheduleHtml,
} from "../site/brooklyn_borough_board_calendar.mjs";

const RECEIPT = {
  schema: "cityscroll.meeting_source_receipt.v1",
  source_url: BROOKLYN_BOROUGH_BOARD_SOURCE_URL,
  observed_at: "2026-09-20T12:00:00.000Z",
  status: "ok",
  fetch_status: "snapshot",
};

const POSITIVE_FIXTURE = `
  <main>
    <h2>When does the Borough Board meet?</h2>
    <p>The Board meets the first Tuesday of every month, except when that day is a holiday,
      at Brooklyn Borough Hall at 6:00 pm.</p>
    <h2>Meeting Schedule</h2>
    <h3>2026</h3>
    <ul>
      <li>October 6</li>
      <li>November 5</li>
      <li>December 1</li>
    </ul>
  </main>`;

test("A1: listed Brooklyn Borough Board dates materialize at the shared clock with Borough Hall evidence", () => {
  const result = parseBrooklynBoroughBoardScheduleHtml(POSITIVE_FIXTURE, { receipt: RECEIPT });
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows.map((row) => row.publisher_identifier), [
    "2026-10-06", "2026-11-05", "2026-12-01",
  ]);
  for (const row of result.rows) {
    assert.equal(row.event_date, row.publisher_identifier);
    assert.equal(row.schedule.starts_at, `${row.publisher_identifier}T18:00:00`);
    assert.equal(row.schedule.timezone, "America/New_York");
    assert.equal(row.venue.name, "Brooklyn Borough Hall");
    assert.equal(row.institution_refs.institution_ref, BROOKLYN_BOROUGH_BOARD_INSTITUTION_REF);
    assert.equal(row.source_receipt.parser, BROOKLYN_BOROUGH_BOARD_CALENDAR_PARSER);
  }
});

test("A2: only enumerated dates are emitted, including the Thursday exception", () => {
  const result = parseBrooklynBoroughBoardScheduleHtml(POSITIVE_FIXTURE, { receipt: RECEIPT });
  assert.deepEqual(result.rows.map((row) => row.event_date), [
    "2026-10-06", "2026-11-05", "2026-12-01",
  ]);
  assert.equal(result.rows.some((row) => row.event_date === "2026-11-03"), false);
});

test("A3: missing shared time, duplicate dates, malformed dates, and institution attachment fail closed", () => {
  const missingTime = parseBrooklynBoroughBoardScheduleHtml(`
    <h3>2026</h3><ul><li>October 6</li></ul>`, { receipt: RECEIPT });
  assert.equal(missingTime.rows.length, 0);
  assert.equal(missingTime.quarantined[0].reason, "missing_shared_time");

  const duplicate = parseBrooklynBoroughBoardScheduleHtml(`
    <p>The Board meets at Brooklyn Borough Hall at 6:00 pm.</p>
    <h3>2026</h3><ul><li>October 6</li><li>October 6</li></ul>`, { receipt: RECEIPT });
  assert.equal(duplicate.rows.length, 0);
  assert.equal(duplicate.quarantined[0].reason, "duplicate_date_key");

  const malformed = parseBrooklynBoroughBoardScheduleHtml(`
    <p>The Board meets at Brooklyn Borough Hall at 6:00 pm.</p>
    <h3>2026</h3><ul><li>November 31</li></ul>`, { receipt: RECEIPT });
  assert.equal(malformed.rows.length, 0);
  assert.equal(malformed.quarantined[0].reason, "malformed_date");

  const attached = parseBrooklynBoroughBoardScheduleHtml(POSITIVE_FIXTURE, { receipt: RECEIPT }).rows[0];
  assert.equal(attached.institution_refs.institution_ref, BROOKLYN_BOROUGH_BOARD_INSTITUTION_REF);
});
