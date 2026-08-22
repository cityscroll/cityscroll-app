import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMMUNITY_BOARD_SOURCE_ADAPTER_CONTRACTS,
  fetchCommunityBoardSource,
  googleCalendarIdsFromHtml,
  googleCalendarPublicIcsUrl,
  parseNycOfficialCalendarSource,
  parseAirtableSource,
  parseGoogleCalendarSource,
  parseHtmlPdfSource,
  parseVideoRecordSource,
  sourceRecordStatus,
} from "../site/community_board_source_adapters.mjs";
import { meetingSourceFieldNames } from "../site/meeting_source_completeness.mjs";

const receipt = { status: "ok", observed_at: "2026-08-14T12:00:00Z" };

test("each heterogeneous source has a bounded explicit adapter contract", () => {
  assert.deepEqual(Object.keys(COMMUNITY_BOARD_SOURCE_ADAPTER_CONTRACTS).sort(), [
    "airtable_v1", "google_calendar_v1", "html_pdf_v1", "nyc_official_calendar_v1", "video_record_v1",
  ]);
  for (const contract of Object.values(COMMUNITY_BOARD_SOURCE_ADAPTER_CONTRACTS)) {
    assert.ok(contract.max_bytes > 0);
    assert.ok(contract.contract);
    assert.ok(contract.record_kinds.length);
  }
});

test("NYC official-calendar adapter preserves explicit event logistics without inferring outcomes", () => {
  const records = parseNycOfficialCalendarSource(`
    <div class="span6 about-description">
      <h2>Calendar of Meetings &ndash; August 2026</h2>
      <h3>CB 3 Public Hearing - FY 2028 Budget Priorities</h3>
      <p>Monday, September 21 at 6:30pm -- Community Board 3 Office, 59 East 4th Street<br>
        <strong>Registration Link: <a href="https://www.zoomgov.com/webinar/register/example">Register</a></strong>
      </p>
      <p>Help assess the needs of the community.</p>
      <h3>Community Board 3, Full Board Meeting</h3>
      <p>Tuesday, September 29, 2026 - 6:30pm<br>PS 20 - 166 Essex Street</p>
    </div>
  `, {
    adapter: "nyc_official_calendar_v1",
    role: "upcoming_meetings",
    publisher_kind: "nyc_official",
    format: "explicit board calendar",
    board_id: "manhattan-cb-03",
    body_name: "Manhattan Community Board 3",
    url: "https://www.nyc.gov/site/manhattancb3/calendar/calendar.page",
  }, { receipt });

  assert.deepEqual(records.map((row) => row.date), ["2026-09-21", "2026-09-29"]);
  assert.equal(records[0].start_at, "2026-09-21T18:30:00-04:00");
  assert.equal(records[0].address, "Community Board 3 Office, 59 East 4th Street");
  assert.equal(records[0].participation.remote_join_url, "https://www.zoomgov.com/webinar/register/example");
  assert.equal(records[1].start_at, "2026-09-29T18:30:00-04:00");
  assert.equal(records[1].address, "PS 20 - 166 Essex Street");
  assert.deepEqual(records[1].participation.links, []);
  assert.ok(records.every((row) => row.record_kind === "event"));
  assert.ok(records.every((row) => row.observed_receipt.parser === "nyc_official_calendar_v1"));
  assert.ok(records.every((row) => !Object.hasOwn(row, "vote") && !Object.hasOwn(row, "outcome")));
});

test("HTML/PDF adapter keeps explicit source and publisher fields", () => {
  const records = parseHtmlPdfSource(`
    <a data-record-id="minutes-2026-08-12" data-board-id="bronx-cb-01" data-date="2026-08-12"
       data-category="minutes" href="/records/board-minutes.pdf">Full board minutes</a>
  `, {
    adapter: "html_pdf_v1",
    board_id: "bronx-cb-01",
    url: "https://board.example/minutes",
    format: "html_pdf",
  }, { receipt });
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    schema: "cityscroll.community_board_source_record.v1",
    source_url: "https://board.example/minutes",
    board_id: "bronx-cb-01",
    body_id: "bronx-cb-01",
    body: "bronx-cb-01",
    body_name: null,
    body_evidence: { board_id: "bronx-cb-01", basis: "publisher_record" },
    record_kind: "document",
    record_id: "minutes-2026-08-12",
    source_record_id: "minutes-2026-08-12",
    event_id: null,
    document_id: "minutes-2026-08-12",
    video_id: null,
    date: "2026-08-12",
    meeting_date: "2026-08-12",
    start_at: null,
    category: "minutes",
    title: "Full board minutes",
    address: null,
    format: "pdf",
    publisher_identifier: null,
    publisher_identifiers: [],
    publisher_matter_ids: [],
    record_url: "https://board.example/records/board-minutes.pdf",
    observed_receipt: {
      schema: "cityscroll.community_board_source_receipt.v1",
      source_url: "https://board.example/minutes",
      observed_at: "2026-08-14T12:00:00Z",
      status: "ok",
      fetch_status: null,
      content_type: null,
      content_length: null,
      parser: "html_pdf_v1",
      reason: null,
    },
  });
});

test("HTML adapter accepts explicit Schema.org Event records without guessing dates", () => {
  const records = parseHtmlPdfSource(`
    <script type="application/ld+json">[{"@type":"Event","name":"General Board Meeting &#8211; September","url":"https://board.example/event/1","startDate":"2026-09-10T18:00:00-04:00"},{"@type":"Thing","name":"not an event"}]</script>
  `, {
    adapter: "html_pdf_v1",
    role: "upcoming_meetings",
    board_id: "bronx-cb-06",
    url: "https://board.example/calendar",
  }, { receipt });
  assert.equal(records.length, 1);
  assert.equal(records[0].record_kind, "event");
  assert.equal(records[0].record_id, "https://board.example/event/1");
  assert.equal(records[0].date, "2026-09-10");
  assert.equal(records[0].title, "General Board Meeting – September");
  assert.equal(records[0].body_evidence.basis, "explicit_source_descriptor");
});

test("event-detail materialization keeps publisher description, participation, and exact child documents", () => {
  const meetingKey = "https://board.example/event/1";
  const records = parseHtmlPdfSource(`
    <script type="application/ld+json">[{"@type":"Event","name":"LANDMARKS 2 – Chair","url":"${meetingKey}","startDate":"2026-09-10T18:00:00-04:00","endDate":"2026-09-10T21:00:00-04:00","description":"Agenda: 63-65 Charles Street. Register to join online.","location":{"@type":"Place","name":"CB 2 Conference Room","address":{"streetAddress":"3 Washington Square Village #1A","addressLocality":"New York","addressRegion":"NY","postalCode":"10012"},"telephone":"212-979-2272"}}]</script>
    <a href="/documents/agenda-2026-09-10.pdf">Agenda PDF</a>
    <a href="/images/logo.png">Board logo</a>
  `, {
    adapter: "html_pdf_v1", event_detail: true, meeting_key: meetingKey, meeting_date: "2026-09-10",
    board_id: "manhattan-cb-02", url: meetingKey,
  }, { receipt });
  const event = records.find((row) => row.record_kind === "event");
  const document = records.find((row) => row.record_kind === "document");
  assert.equal(event.description, "Agenda: 63-65 Charles Street. Register to join online.");
  assert.equal(event.venue_name, "CB 2 Conference Room");
  assert.equal(event.address, "3 Washington Square Village #1A, New York, NY, 10012");
  assert.equal(event.end_at, "2026-09-10T21:00:00-04:00");
  const reviewed = new Set(meetingSourceFieldNames("community_board"));
  assert.deepEqual(Object.keys(event).filter((field) => !reviewed.has(field) && field !== "schema"), []);
  assert.equal(document.meeting_key, meetingKey);
  assert.equal(document.record_url, "https://board.example/documents/agenda-2026-09-10.pdf");
  assert.equal(records.filter((row) => row.record_kind === "document").length, 1);
});

test("event-detail materialization extracts resident-facing logistics from the publisher page", () => {
  const meetingKey = "https://board.example/event/2";
  const records = parseHtmlPdfSource(`
    <script type="application/ld+json">[{"@type":"Event","name":"Landmarks 2","url":"${meetingKey}","startDate":"2026-09-10T18:00:00-04:00"}]</script>
    <div class="tribe-events-single-event-description tribe-events-content"><p>Registration is required. The meeting is held at 3 Washington Square Village.</p></div>
    <a href="https://events.example/register/2">Register for the meeting</a>
    <a href="https://zoom.example/join/2">Join by Zoom</a>
  `, {
    adapter: "html_pdf_v1", event_detail: true, meeting_key: meetingKey,
    board_id: "manhattan-cb-02", url: meetingKey,
  }, { receipt });
  const event = records.find((row) => row.record_kind === "event");
  assert.equal(event.description, "Registration is required. The meeting is held at 3 Washington Square Village.");
  assert.equal(event.participation.remote_join_url, "https://zoom.example/join/2");
  assert.deepEqual(event.participation.links, [
    { label: "Register to attend", url: "https://events.example/register/2" },
    { label: "Join online", url: "https://zoom.example/join/2" },
    { label: "Meeting information", url: meetingKey },
  ]);
});

test("HTML adapter treats linked document URLs as document identities, never event identities", () => {
  const documents = parseHtmlPdfSource(
    `<a data-date="2026-09-12" href="/minutes/2026-09-12.pdf">September 12, 2026 minutes</a>`,
    { adapter: "html_pdf_v1", role: "minutes", board_id: "bronx-cb-06", url: "https://board.example/minutes" },
    { receipt },
  );
  assert.equal(documents.length, 1);
  assert.equal(documents[0].record_kind, "document");
  assert.equal(documents[0].document_id, "https://board.example/minutes/2026-09-12.pdf");

  const events = parseHtmlPdfSource(
    `<a data-date="2026-09-12" href="/calendar/2026-09-12.pdf">September 12, 2026 meeting</a>`,
    { adapter: "html_pdf_v1", role: "upcoming_meetings", board_id: "bronx-cb-06", url: "https://board.example/calendar" },
    { receipt },
  );
  assert.equal(events.length, 0);
});

test("Google Calendar, Airtable, and video adapters use native record IDs", () => {
  const calendar = parseGoogleCalendarSource(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:event-1\nDTSTART;VALUE=DATE:20260820\nSUMMARY:Full board meeting\nX-BOARD-ID:bronx-cb-01\nEND:VEVENT\nEND:VCALENDAR`, {
    adapter: "google_calendar_v1", board_id: "bronx-cb-01", url: "https://calendar.example/board.ics",
  }, { receipt });
  assert.equal(calendar[0].event_id, "event-1::2026-08-20");
  assert.equal(calendar[0].publisher_identifier, "event-1::2026-08-20");
  assert.equal(calendar[0].start_at, null);
  assert.equal(calendar[0].date, "2026-08-20");
  assert.equal(calendar[0].body_evidence.basis, "publisher_record");

  const recurring = parseGoogleCalendarSource(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:series-1
DTSTART;TZID=America/New_York:20260901T183000
SUMMARY:Full Board Meeting
END:VEVENT
BEGIN:VEVENT
UID:series-1
DTSTART;TZID=America/New_York:20261103T183000
RECURRENCE-ID;TZID=America/New_York:20261103T183000
SUMMARY:Full Board Meeting
END:VEVENT
BEGIN:VEVENT
UID:series-1
DTSTART;TZID=America/New_York:20240102T183000
SUMMARY:Full Board Meeting
END:VEVENT
END:VCALENDAR`, {
    adapter: "google_calendar_v1",
    role: "upcoming_meetings",
    board_id: "manhattan-cb-07",
    url: "https://calendar.google.com/calendar/ical/example/public/basic.ics",
  }, { receipt: { status: "ok", observed_at: "2026-08-21T12:00:00Z" } });
  assert.deepEqual(recurring.map((row) => [row.date, row.record_id, row.start_at]), [
    ["2026-09-01", "series-1::2026-09-01", "2026-09-01T18:30:00-04:00"],
    ["2026-11-03", "series-1::2026-11-03", "2026-11-03T18:30:00-05:00"],
  ]);
  assert.equal(recurring.every((row) => row.record_kind === "event"), true);

  const airtable = parseAirtableSource({ records: [{ id: "rec-1", fields: {
    when: "2026-08-21", board: "manhattan-cb-11", title: "Minutes", matter: ["C260001ZSM"],
  } }] }, {
    adapter: "airtable_v1", url: "https://airtable.com/app/view", field_map: {
      date: "when", board_id: "board", title: "title", publisher_matter_ids: "matter",
    },
  }, { receipt });
  assert.equal(airtable[0].document_id, "rec-1");
  assert.deepEqual(airtable[0].publisher_matter_ids, ["C260001ZSM"]);

  const video = parseVideoRecordSource({ records: [{ id: "video-1", board_id: "queens-cb-03", date: "2026-08-22", event_id: "event-22", url: "https://video.example/1" }] }, {
    adapter: "video_record_v1", url: "https://video.example/feed.json",
  }, { receipt });
  assert.equal(video[0].video_id, "video-1");
  assert.equal(video[0].publisher_identifier, "event-22");
  assert.equal(video[0].source_url, "https://video.example/feed.json");
});

test("fetch contract is bounded and records inaccessible sources as unknown", async () => {
  const result = await fetchCommunityBoardSource({
    adapter: "html_pdf_v1", board_id: "bronx-cb-01", url: "https://board.example/minutes",
  }, {
    observedAt: "2026-08-14T12:00:00Z",
    fetchImpl: async () => ({ ok: false, status: 403, headers: { get: () => "text/html" }, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  assert.equal(result.records.length, 0);
  assert.equal(result.receipt.status, "unknown");
  assert.equal(result.receipt.reason, "http_error");
  assert.deepEqual(sourceRecordStatus({ observed_receipt: { status: "ok", observed_at: "2026-01-01T00:00:00Z" } }, {
    asOf: "2026-08-14T00:00:00Z", maxAgeDays: 30,
  }), { state: "unknown", reason: "source_stale" });
});

test("NYC calendar fetch retries the official www1 alias after an edge denial", async () => {
  const calls = [];
  const page = `<div class="about-description"><h2>Calendar of Meetings - August 2026</h2><h3>Full Board Meeting</h3><p>Tuesday, September 29, 2026 - 6:30pm<br>PS 20 - 166 Essex Street</p></div>`;
  const result = await fetchCommunityBoardSource({
    role: "upcoming_meetings",
    publisher_kind: "nyc_official",
    format: "explicit board calendar",
    board_id: "manhattan-cb-03",
    url: "https://www.nyc.gov/site/manhattancb3/calendar/calendar.page",
  }, {
    observedAt: "2026-08-16T12:00:00Z",
    fetchImpl: async (url) => {
      calls.push(url);
      const ok = calls.length === 2;
      const bytes = new TextEncoder().encode(ok ? page : "<h1>Access Denied</h1>");
      return { ok, status: ok ? 200 : 403, headers: { get: () => "text/html" }, arrayBuffer: async () => bytes.buffer };
    },
  });
  assert.deepEqual(calls, [
    "https://www.nyc.gov/site/manhattancb3/calendar/calendar.page",
    "https://www1.nyc.gov/site/manhattancb3/calendar/calendar.page",
  ]);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].date, "2026-09-29");
  assert.equal(result.receipt.source_url, "https://www.nyc.gov/site/manhattancb3/calendar/calendar.page");
});

test("Google Calendar discovery reads embed src, base64 src, cid links, and public ICS URLs", () => {
  assert.deepEqual(googleCalendarIdsFromHtml(`
    <iframe src="https://calendar.google.com/calendar/embed?src=g4b54u7hbpp1b6p63gp0n97448%40group.calendar.google.com&#038;ctz=America/New_York"></iframe>
    <iframe src="https://calendar.google.com/calendar/embed?src=YmswM0BjYi5ueWMuZ292&amp;color=%23039BE5"></iframe>
    <a href="https://calendar.google.com/calendar/r?cid=cbsix.org_coj3atji6ll3sjsn5cupptc27g@group.calendar.google.com">Subscribe</a>
    <iframe src="https://calendar.google.com/calendar/embed?src=NTFscWRoY2UzM2w5YzY3azFpNjQ1ZGVqcXNAZ3JvdXAuY2FsZW5kYXIuZ29vZ2xlLmNvbQ&src=ZzdvY25sbmkyMTlubHQ3Z29iOHRjNDcwb2NAZ3JvdXAuY2FsZW5kYXIuZ29vZ2xlLmNvbQ"></iframe>
  `).sort(), [
    "51lqdhce33l9c67k1i645dejqs@group.calendar.google.com",
    "bk03@cb.nyc.gov",
    "cbsix.org_coj3atji6ll3sjsn5cupptc27g@group.calendar.google.com",
    "g4b54u7hbpp1b6p63gp0n97448@group.calendar.google.com",
    "g7ocnlni219nlt7gob8tc470oc@group.calendar.google.com",
  ]);
  assert.equal(
    googleCalendarPublicIcsUrl("bk03@cb.nyc.gov"),
    "https://calendar.google.com/calendar/ical/bk03%40cb.nyc.gov/public/basic.ics",
  );
});

test("Google Calendar fetch follows a public embed to ICS and keeps UID plus date identity", async () => {
  const html = `<iframe src="https://calendar.google.com/calendar/embed?src=queenscb6secretary%40gmail.com&ctz=America/New_York"></iframe>`;
  const ics = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:qn6-board
DTSTART;TZID=America/New_York:20260917T183000
SUMMARY:Community Board 6 Meeting
END:VEVENT
BEGIN:VEVENT
UID:qn6-board
DTSTART;TZID=America/New_York:20261014T183000
RECURRENCE-ID;TZID=America/New_York:20261014T183000
SUMMARY:Community Board 6 Meeting
END:VEVENT
END:VCALENDAR`;
  const calls = [];
  const result = await fetchCommunityBoardSource({
    adapter: "google_calendar_v1",
    role: "upcoming_meetings",
    format: "NYC HTML + Google Calendar iframe",
    board_id: "queens-cb-06",
    url: "https://www.nyc.gov/site/queenscb6/calendar/calendar.page",
  }, {
    observedAt: "2026-08-21T12:00:00Z",
    fetchImpl: async (url) => {
      calls.push(url);
      const body = /\/calendar\/ical\//.test(url) ? ics : html;
      const bytes = new TextEncoder().encode(body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => (/\/calendar\/ical\//.test(url) ? "text/calendar" : "text/html") },
        arrayBuffer: async () => bytes.buffer,
      };
    },
  });
  assert.equal(calls[0], "https://www.nyc.gov/site/queenscb6/calendar/calendar.page");
  assert.equal(calls[1], "https://calendar.google.com/calendar/ical/queenscb6secretary%40gmail.com/public/basic.ics");
  assert.deepEqual(result.records.map((row) => row.event_id), ["qn6-board::2026-09-17", "qn6-board::2026-10-14"]);
  assert.equal(result.receipt.status, "ok");
  assert.equal(result.receipt.source_url, "https://www.nyc.gov/site/queenscb6/calendar/calendar.page");
  assert.equal(result.records[0].source_url, "https://www.nyc.gov/site/queenscb6/calendar/calendar.page");
});

test("a private Google Calendar ICS stays empty instead of inventing events", async () => {
  const html = `<iframe src="https://calendar.google.com/calendar/embed?src=private-board%40group.calendar.google.com"></iframe>`;
  const result = await fetchCommunityBoardSource({
    adapter: "google_calendar_v1",
    role: "upcoming_meetings",
    format: "NYC HTML + Google Calendar iframe",
    board_id: "brooklyn-cb-03",
    url: "https://www.nyc.gov/site/brooklyncb3/calendar/calendar.page",
  }, {
    observedAt: "2026-08-21T12:00:00Z",
    fetchImpl: async (url) => {
      if (/\/calendar\/ical\//.test(url)) {
        return { ok: false, status: 404, headers: { get: () => "text/html" }, arrayBuffer: async () => new ArrayBuffer(0) };
      }
      const bytes = new TextEncoder().encode(html);
      return { ok: true, status: 200, headers: { get: () => "text/html" }, arrayBuffer: async () => bytes.buffer };
    },
  });
  assert.equal(result.records.length, 0);
  assert.equal(result.receipt.status, "ok");
});

test("NYC official-calendar adapter accepts a dated meeting paragraph without an h3", () => {
  const records = parseNycOfficialCalendarSource(`
    <div class="span6 about-description">
      <h1>Calendar</h1>
      <p>All NYC Community Board meetings are open to the public.</p>
      <p><strong><u>REGULAR MONTHLY BOARD MEETING &ndash; JUNE 17, 2026, 7 PM</u></strong></p>
      <p>Join from PC, Mac, iPad, or Android:<br>
        <a href="https://us02web.zoom.us/j/81929515972">https://us02web.zoom.us/j/81929515972</a>
      </p>
      <p><strong>September 17, 2025</strong></p>
    </div>
  `, {
    adapter: "nyc_official_calendar_v1",
    role: "upcoming_meetings",
    publisher_kind: "nyc_official",
    format: "explicit board calendar",
    board_id: "brooklyn-cb-18",
    body_name: "Brooklyn Community Board 18",
    url: "https://www.nyc.gov/site/brooklyncb18/meetings/calendar.page",
  }, { receipt });

  assert.equal(records.length, 1);
  assert.equal(records[0].date, "2026-06-17");
  assert.equal(records[0].start_at, "2026-06-17T19:00:00-04:00");
  assert.equal(records[0].title, "REGULAR MONTHLY BOARD MEETING");
  assert.equal(records[0].record_id, "nyc-calendar:brooklyn-cb-18:2026-06-17:regular-monthly-board-meeting");
  assert.equal(records[0].participation.remote_join_url, "https://us02web.zoom.us/j/81929515972");
});

test("Queens CB1 official calendar keeps the dated full-board heading", () => {
  const records = parseNycOfficialCalendarSource(`
    <div class="span6 about-description">
      <h2>Board Meetings</h2>
      <p>The following are a listing of the dates from <strong>September 2026 through June 2027</strong>:</p>
      <h3>Full Board / Public Hearing Meetings</h3>
      <div class="row"><div class="span6">
        <p>September 22, 2026 - <strong>6:00 PM</strong><br />October 20, 2026<br />November 17, 2026</p>
      </div></div>
    </div>
  `, {
    adapter: "nyc_official_calendar_v1",
    role: "upcoming_meetings",
    publisher_kind: "nyc_official",
    format: "explicit board calendar",
    board_id: "queens-cb-01",
    url: "https://www.nyc.gov/site/queenscb1/calendar/calendar.page",
  }, { receipt });

  assert.equal(records.length, 1);
  assert.equal(records[0].date, "2026-09-22");
  assert.equal(records[0].start_at, "2026-09-22T18:00:00-04:00");
  assert.equal(records[0].title, "Full Board / Public Hearing Meetings");
});
