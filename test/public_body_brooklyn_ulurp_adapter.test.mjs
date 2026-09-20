import assert from "node:assert/strict";
import test from "node:test";

import { todayISO } from "./helpers/test_clock.mjs";

import {
  BROOKLYN_BP_ULURP_CALENDAR_PARSER,
  BROOKLYN_BP_ULURP_LAND_USE_URL,
  BROOKLYN_BP_ULURP_SOURCE_URL,
  parseBrooklynBpUlurpScheduleHtml,
} from "../site/brooklyn_bp_ulurp_calendar.mjs";

const receipt = () => ({
  schema: "cityscroll.meeting_source_receipt.v1",
  source_url: BROOKLYN_BP_ULURP_SOURCE_URL,
  observed_at: `${todayISO()}T12:00:00.000Z`,
  status: "ok",
  fetch_status: "snapshot",
});

const LAND_USE_PAGE = `
  <main>
    <p>Members of the public may participate in person at Brooklyn Borough Hall or via Webex.</p>
    <p>Members of the public may join and testify using the information provided for each hearing.</p>
    <a href="${BROOKLYN_BP_ULURP_SOURCE_URL}">Calendar</a>
  </main>`;

const EVENT_PAGE = `
  <main>
    <h2>October 2026</h2>
    <article data-event-id="bp-2026-10-14">
      <h3><a href="https://www.brooklynbp.nyc.gov/event/ulurp-public-hearing-2026-10-14/">ULURP Public Hearing Meeting</a></h3>
      <div class="tribe-events-calendar-list__event-datetime">October 14 @ 6:00 pm – 8:00 pm</div>
      <div class="tribe-events-calendar-list__event-venue">Brooklyn Borough Hall 209 Joralemon St., Brooklyn, NY, United States</div>
    </article>
    <article data-event-id="concert-2026-10-14">
      <h3><a href="https://www.brooklynbp.nyc.gov/event/concert/">Lunchtime Jazz</a></h3>
      <div>October 14 @ 12:00 pm – 1:30 pm Brooklyn Borough Hall</div>
    </article>
    <article data-event-id="workshop-2026-10-15">
      <h3>Downtown Revitalization Initiative Public Workshop</h3>
      <div>October 15 @ 6:00 pm – 8:00 pm Williamsburg Community Center</div>
    </article>
    <article data-event-id="survey-2026-10-16">
      <h3>Aftercare Survey</h3>
      <div>October 16</div>
    </article>
    <article data-event-id="anomalous-publisher-time">
      <h3>ULURP Public Hearing Meeting</h3>
      <div>Publisher time changed; please check back.</div>
    </article>
  </main>`;

test("A1: the classified October hearing materializes with exact local bounds, venue, and testimony evidence", () => {
  const result = parseBrooklynBpUlurpScheduleHtml(EVENT_PAGE, {
    receipt: receipt(),
    landUseHtml: LAND_USE_PAGE,
  });
  assert.equal(result.rows.length, 1);
  const [meeting] = result.rows;
  assert.equal(meeting.meeting_id, "meeting:public_body_calendar:brooklyn_bp_ulurp:bp-2026-10-14");
  assert.equal(meeting.event_date, "2026-10-14T18:00:00");
  assert.equal(meeting.event_end, "2026-10-14T20:00:00");
  assert.equal(meeting.schedule.starts_at, "2026-10-14T18:00:00");
  assert.equal(meeting.schedule.basis, "publisher_event");
  assert.equal(meeting.schedule.timezone, "America/New_York");
  assert.equal(meeting.venue.name, "Brooklyn Borough Hall");
  assert.match(meeting.venue.address, /209 Joralemon/);
  assert.equal(meeting.speaking_rights, "allowed");
  assert.equal(meeting.activity, "speak");
  assert.equal(meeting.participation.source_url, BROOKLYN_BP_ULURP_LAND_USE_URL);
  assert.match(meeting.source_raw_values.participation_evidence, /participate|testify/i);
  assert.equal(meeting.source_raw_values.classification, "ulurp_public_hearing");
  assert.equal(meeting.source_raw_values.publisher_permalink, "https://www.brooklynbp.nyc.gov/event/ulurp-public-hearing-2026-10-14/");
  assert.equal(meeting.source_url, "https://www.brooklynbp.nyc.gov/event/ulurp-public-hearing-2026-10-14/");
  assert.equal(meeting.source_receipt.parser, BROOKLYN_BP_ULURP_CALENDAR_PARSER);
});

test("A2: unrelated calendar categories are excluded and anomalous publisher times remain operator-visible", () => {
  const result = parseBrooklynBpUlurpScheduleHtml(EVENT_PAGE, {
    receipt: receipt(),
    landUseHtml: LAND_USE_PAGE,
  });
  assert.deepEqual(result.rejected.map((entry) => entry.title), [
    "Lunchtime Jazz",
    "Downtown Revitalization Initiative Public Workshop",
    "Aftercare Survey",
  ]);
  assert.deepEqual(result.quarantined.map((entry) => entry.reason), ["missing_or_malformed_date"]);
  assert.equal(result.quarantined[0].publisher_identifier, "anomalous-publisher-time");
  assert.equal(result.rows.some((row) => /Jazz|Workshop|Survey/.test(row.title)), false);
});

test("A3: permalink identity fallback and duplicate event identities are explicit", () => {
  const fallback = parseBrooklynBpUlurpScheduleHtml(`
    <h2>October 2026</h2>
    <article>
      <h3><a href="https://www.brooklynbp.nyc.gov/event/ulurp-fallback/">Uniform Land Use Review Procedure Public Hearing</a></h3>
      <div>October 21 @ 6:00 pm – 8:00 pm Brooklyn Borough Hall</div>
    </article>`, { receipt: receipt(), landUseHtml: LAND_USE_PAGE });
  assert.equal(fallback.rows[0].publisher_identifier, "https://www.brooklynbp.nyc.gov/event/ulurp-fallback/");
  assert.equal(fallback.rows[0].source_raw_values.publisher_identity_kind, "permalink_fallback");

  const duplicate = parseBrooklynBpUlurpScheduleHtml(`
    <h2>October 2026</h2>
    <article data-event-id="same-event"><h3>ULURP Public Hearing Meeting</h3><div>October 14 @ 6:00 pm – 8:00 pm</div></article>
    <article data-event-id="same-event"><h3>ULURP Public Hearing Meeting</h3><div>October 14 @ 6:00 pm – 8:00 pm</div></article>`, { receipt: receipt(), landUseHtml: LAND_USE_PAGE });
  assert.equal(duplicate.rows.length, 0);
  assert.equal(duplicate.quarantined[0].reason, "duplicate_event_identity");
});
