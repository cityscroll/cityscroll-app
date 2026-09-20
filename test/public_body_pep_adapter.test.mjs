import assert from "node:assert/strict";
import test from "node:test";

import {
  NYCPS_PEP_SOURCE_URL,
  parseNycpsPepScheduleHtml,
} from "../site/nycps_pep_calendar.mjs";

const RECEIPT = {
  schema: "cityscroll.meeting_source_receipt.v1",
  source_url: NYCPS_PEP_SOURCE_URL,
  observed_at: "2026-09-20T12:00:00.000Z",
  status: "ok",
  fetch_status: "snapshot",
};

const POSITIVE = `
  <main>
    <div class="accordion">
      <a><h3>PEP Meeting — September 30, 2026</h3></a>
      <div class="panel">
        <p>This meeting will be held on Wednesday, September 30, 2026, at 6:00pm (EST) at
          <strong>Michael J. Petrides School</strong> (715 Ocean Terrace, Staten Island, New York 10301).
          All documents for this meeting can also be found on the <a href="https://example.test/pep-sharepoint">PEP SharePoint</a>
          and include the following:</p>
        <ul>
          <li><a href="https://example.test/public-notice.pdf">Public Notice &amp; Agenda</a></li>
          <li><a href="https://example.test/minutes.pdf">Minutes of Action</a></li>
          <li><a href="https://example.test/contracts.pdf">Contracts Agenda</a></li>
        </ul>
        <h3>Accessing the Meeting and Registering for Public Comment</h3>
        <p>If you would like to access this meeting remotely, please visit:
          <a href="https://learndoe.org/pep/sep30">https://learndoe.org/pep/sep30</a></p>
        <p>Speaker sign-up is available via the link found
          <a href="https://docs.google.com/forms/d/e/speaker/viewform">here</a>.
          To submit written comment, complete the
          <a href="https://docs.google.com/forms/d/e/written/viewform">Written Public Comment Form</a>.</p>
        <h3>Interpretation Services</h3><p>Interpretation is available on request.</p>
      </div>
    </div>
  </main>`;

test("A1: the headed September 30 block emits the local meeting and evidence", () => {
  const result = parseNycpsPepScheduleHtml(POSITIVE, { receipt: RECEIPT });
  assert.equal(result.rows.length, 1);
  const [meeting] = result.rows;
  assert.equal(meeting.publisher_identifier, "2026-09-30");
  assert.equal(meeting.event_date, "2026-09-30T18:00:00");
  assert.equal(meeting.schedule.starts_at, "2026-09-30T18:00:00");
  assert.equal(meeting.schedule.timezone, "America/New_York");
  assert.equal(meeting.source_raw_timezone, "EST");
  assert.equal(meeting.venue.name, "Michael J. Petrides School");
  assert.equal(meeting.venue.address, "715 Ocean Terrace, Staten Island, New York 10301");
  assert.equal(meeting.participation.remote_join_url, "https://learndoe.org/pep/sep30");
  assert.deepEqual(meeting.participation.links.map((link) => link.label), [
    "Join remotely", "Register for public comment", "Submit written public comment",
  ]);
  assert.equal(meeting.meeting_documents.length, 4);
  assert.deepEqual(meeting.meeting_documents.map((document) => document.role), ["materials", "agenda", "minutes", "materials"]);
  assert.ok(meeting.meeting_documents.every((document) => document.attachment_status === "attached"));
});
test("A2: EST is evidence, not a fixed offset during New York daylight time", () => {
  const [meeting] = parseNycpsPepScheduleHtml(POSITIVE, { receipt: RECEIPT }).rows;
  assert.equal(meeting.source_raw_timezone, "EST");
  assert.equal(meeting.schedule.timezone, "America/New_York");
  assert.equal(meeting.event_date.includes("-05:00"), false);
  assert.equal(meeting.schedule.starts_at.includes("-05:00"), false);
});

test("A3: malformed and unrelated blocks quarantine without entering the meeting union", () => {
  const fixture = `
    <div class="accordion"><h3>PEP Meeting —</h3><div class="panel">No date.</div></div>
    <div class="accordion"><h3>PEP Meeting — October 28, 2026</h3><div class="panel">At the venue, no clock.</div></div>
    <div class="accordion"><h3>PEP Meeting — November 18, 2026</h3><div class="panel">
      This meeting is at 6:00pm (EST) at School Hall (1 Main Street). All documents for this meeting include
      <a href="https://example.test/not-a-pep-record">Unrelated document</a>.
    </div></div>
    <div class="accordion"><h3>PEP Meeting — November 18, 2026</h3><div class="panel">
      This meeting is at 6:00pm (EST) at Another Hall (2 Main Street). All documents for this meeting include
      <a href="https://example.test/agenda.pdf">Public Notice &amp; Agenda</a>.
    </div></div>`;
  const result = parseNycpsPepScheduleHtml(fixture, { receipt: RECEIPT });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].publisher_identifier, "2026-11-18");
  assert.deepEqual(result.rows[0].meeting_documents, []);
  assert.deepEqual(result.quarantine.map((entry) => entry.reason), [
    "missing_date", "missing_time", "unrelated_document", "identity_collision",
  ]);
});
