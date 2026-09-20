import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCcrbBoardCalendarIndex,
  CCRB_BOARD_CALENDAR_PARSER,
  parseCcrbBoardScheduleHtml,
} from "../site/ccrb_board_calendar.mjs";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import { todayISO } from "./helpers/test_clock.mjs";

const SOURCE_URL = "https://www.nyc.gov/site/ccrb/about/news/board-meeting-schedule.page";
const observedAt = () => `${todayISO()}T12:00:00.000Z`;

const POSITIVE_FIXTURE = `
  <main>
    <p>Members of the public may speak during the public comment period.</p>
    <h2>October 2026</h2>
    <p><strong>CCRB Board Meeting</strong>: Tuesday, October 20, 2026, at 4:00 p.m. The meeting will be held at Tweed Conference Center and online via Webex.
      <a href="https://ccrb.webex.com/ccrb/j.php?MTID=october">Join Webex</a>
      <a href="/assets/ccrb/october-agenda.pdf">Agenda</a>
      <a href="/assets/ccrb/october-minutes.pdf">Minutes</a>
      <a href="/assets/ccrb/october-report.pdf">Monthly report</a>
    </p>
    <h2>September 2026</h2>
    <p>Community outreach meeting: Thursday, September 10, 2026, at 6:00 p.m.</p>
  </main>
`;

function boardFixture(record) {
  return `<main><h2>October 2026</h2><p>${record}</p></main>`;
}

test("the October board record materializes its local time, venue, Webex, documents, and speaking evidence", () => {
  const index = parseCcrbBoardScheduleHtml(POSITIVE_FIXTURE, {
    sourceUrl: SOURCE_URL,
    observedAt: observedAt(),
  });
  assert.equal(index.schema, "cityscroll.ccrb_board_calendar.v1");
  assert.equal(index.rows.length, 1);
  const [meeting] = index.rows;
  assert.equal(meeting.meeting_id, "meeting:public_body_calendar:ccrb_board:2026-10-20");
  assert.equal(meeting.event_date, "2026-10-20");
  assert.equal(meeting.schedule.starts_at, "2026-10-20T16:00:00");
  assert.equal(meeting.schedule.timezone, "America/New_York");
  assert.equal(meeting.schedule.basis, "publisher_event");
  assert.equal(meeting.venue.name, "Tweed Conference Center");
  assert.equal(meeting.participation.remote_join_url, "https://ccrb.webex.com/ccrb/j.php?MTID=october");
  assert.equal(meeting.speaking_rights, "allowed");
  assert.deepEqual(meeting.meeting_documents.map((document) => document.role), ["agenda", "minutes", "materials"]);
  assert.equal(meeting.source_receipt.parser, CCRB_BOARD_CALENDAR_PARSER);
  assert.equal(meeting.source_receipt.observed_at, observedAt());
});

test("the adapter feeds the unrestricted shared read model while the weekday-after-5 window excludes 4 PM", () => {
  const index = buildCcrbBoardCalendarIndex(POSITIVE_FIXTURE, { sourceUrl: SOURCE_URL, observedAt: observedAt() });
  const model = buildSharedMeetingReadModel({
    publicBodyCalendarIndex: index,
    generatedAt: observedAt(),
    now: observedAt(),
  });
  assert.equal(index.coverage[0].status, "fresh");
  assert.equal(model.sources.public_body_calendar.status, "fresh");
  assert.deepEqual(model.rows.map((row) => row.meeting_id), ["meeting:public_body_calendar:ccrb_board:2026-10-20"]);
  const weekdayAfterFive = model.rows.filter((row) => {
    const hour = Number(row.schedule.starts_at.slice(11, 13));
    const dayName = row.source_raw_values.raw_date.split(",", 1)[0];
    return ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].includes(dayName) && hour >= 17;
  });
  assert.deepEqual(weekdayAfterFive, []);
});

test("non-board content is not admitted and missing-clock records are quarantined", () => {
  const index = parseCcrbBoardScheduleHtml(`<main><h2>October 2026</h2>
    <p>Community outreach meeting: Tuesday, October 6, 2026, at 6:00 p.m.</p>
    <p>CCRB Board Meeting: Tuesday, October 20, 2026. Venue: Tweed Conference Center.</p>
  </main>`, { sourceUrl: SOURCE_URL, observedAt: observedAt() });
  assert.equal(index.rows.length, 0);
  assert.equal(index.quarantined.length, 1);
  assert.equal(index.quarantined[0].reason, "missing_clock");
});

test("duplicate date keys are quarantined instead of overwritten", () => {
  const index = parseCcrbBoardScheduleHtml(boardFixture([
    "CCRB Board Meeting: Tuesday, October 20, 2026, at 4:00 p.m. Tweed Conference Center.",
    "CCRB Board Meeting: Tuesday, October 20, 2026, at 5:00 p.m. Tweed Conference Center.",
  ].join("</p><p>")), { sourceUrl: SOURCE_URL, observedAt: observedAt() });
  assert.equal(index.rows.length, 0);
  assert.equal(index.quarantined[0].reason, "duplicate_date_key");
  assert.equal(index.quarantined[0].date, "2026-10-20");
});

test("a changed monthly heading quarantines a dated board record", () => {
  const index = parseCcrbBoardScheduleHtml(boardFixture(
    "CCRB Board Meeting: Tuesday, November 17, 2026, at 4:00 p.m. Tweed Conference Center.",
  ), { sourceUrl: SOURCE_URL, observedAt: observedAt() });
  assert.equal(index.rows.length, 0);
  assert.equal(index.quarantined[0].reason, "monthly_heading_mismatch");
  assert.equal(index.quarantined[0].heading, "October 2026");
});
