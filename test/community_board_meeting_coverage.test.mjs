import assert from "node:assert/strict";
import { test } from "node:test";

import { communityBoardScopeHref } from "../site/community_board_scope_links.mjs";
import { followingUrlFromWatch } from "../site/following_view.mjs";
import {
  communityBoardSourceAdapterId,
  parseGoogleCalendarSource,
  parseHtmlPdfSource,
  parseNycOfficialCalendarSource,
} from "../site/community_board_source_adapters.mjs";
import { meetingCanonicalHref } from "../site/meeting_object_contract.mjs";
import {
  buildCommunityBoardMeetingIndex,
  classifyCommunityBoardSourceRole,
  COMMUNITY_BOARD_SOURCE_STATES,
  materializeCommunityBoardMeetingRow,
} from "../tools/build_community_board_meeting_index.mjs";

function responseFor(url, { duplicate = false } = {}) {
  const id = duplicate ? "same-publisher-id" : `${url}#publisher-event`;
  if (/\.ics(?:$|[?#])/i.test(url) || /\/calendar\/ical\//i.test(url)) {
    const ics = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:${id}\nDTSTART:20260910T220000Z\nSUMMARY:Board meeting\nEND:VEVENT\nEND:VCALENDAR`;
    const bytes = new TextEncoder().encode(ics);
    return { ok: true, status: 200, headers: { get: () => "text/calendar" }, arrayBuffer: async () => bytes.buffer };
  }
  const duplicateDocuments = duplicate
    ? `<a data-record-id="${id}" data-date="2026-09-11" href="${url}#minutes-1.pdf">Minutes one</a><a data-record-id="${id}" data-date="2026-09-12" href="${url}#minutes-2.pdf">Minutes two</a>`
    : `<a data-record-id="${duplicate ? id : `${url}#document`}" data-date="2026-09-11" href="${url}#minutes.pdf">Minutes</a>`;
  const html = `<iframe src="https://calendar.google.com/calendar/embed?src=board%40group.calendar.google.com"></iframe><script type="application/ld+json">${JSON.stringify([{
    "@type": "Event",
    identifier: id,
    name: "Board meeting",
    url: `${url}#event`,
    startDate: "2026-09-10T18:00:00-04:00",
  }])}</script>${duplicateDocuments}`;
  const bytes = new TextEncoder().encode(html);
  return { ok: true, status: 200, headers: { get: () => "text/html" }, arrayBuffer: async () => bytes.buffer };
}

test("the coverage builder accounts for both roles across all 59 boards", async () => {
  const index = await buildCommunityBoardMeetingIndex({
    observedAt: "2026-08-14T12:00:00Z",
    fetchImpl: async (url) => responseFor(url),
  });

  assert.equal(index.coverage.boards_in_inventory, 59);
  assert.equal(index.coverage.source_roles_total, 118);
  assert.equal(index.receipts.length, 118);
  assert.equal(new Set(index.receipts.map((row) => row.board_id)).size, 59);
  assert.deepEqual(
    index.receipts.reduce((counts, row) => {
      counts[row.state] = (counts[row.state] || 0) + 1;
      return counts;
    }, {}),
    { indexed: 66, "checked-empty": 32, unavailable: 4, "not-yet-checked": 16 },
  );
  assert.equal(index.coverage.records_indexed, index.rows.length);
  assert.ok(index.rows.every((row) => row.source_role === "upcoming_meetings"));
  assert.ok(Object.values(index.source_records_by_board).flat().some((row) => row.source_role === "minutes"));
  assert.ok(Object.values(index.source_records_by_board).flat().every((row) => (
    row.board_id && row.body_id && row.source_record_id && row.date
      && row.source_url?.startsWith("https://")
      && row.observed_receipt?.status === "ok"
  )));
});

test("source states remain explicit for unsupported, stale, and absent roles", () => {
  assert.deepEqual(COMMUNITY_BOARD_SOURCE_STATES, [
    "indexed", "checked-empty", "unsupported-format", "unavailable", "stale", "not-yet-checked",
  ]);
  assert.equal(classifyCommunityBoardSourceRole({ url: "https://example.test/source", format: "spreadsheet" }, { receipt: { status: "ok" } }, [], "2026-08-14T00:00:00Z"), "unsupported-format");
  assert.equal(classifyCommunityBoardSourceRole({ url: "https://example.test/source", format: "html", verification: { status: "stale" } }, { receipt: { status: "ok" } }, [], "2026-08-14T00:00:00Z"), "stale");
  assert.equal(classifyCommunityBoardSourceRole({ url: null, format: null }, { receipt: { status: "unknown" } }, [], "2026-08-14T00:00:00Z"), "not-yet-checked");
});

test("duplicate publisher identifiers within a board fail the build", async () => {
  await assert.rejects(
    buildCommunityBoardMeetingIndex({
      observedAt: "2026-08-14T12:00:00Z",
      fetchImpl: async (url) => responseFor(url, { duplicate: true }),
    }),
    /duplicate publisher identifier within board/,
  );
});

test("previously missing CB7 meetings index from explicit sources and are followable", () => {
  const brooklyn = parseHtmlPdfSource(`<script type="application/ld+json">${JSON.stringify([{
    "@type": "Event",
    name: "CB7 Monthly Board Meeting – September 16",
    url: "https://cbbrooklyn.cityofnewyork.us/cb7/event/cb7-monthly-board-meeting-september-16/",
    startDate: "2026-09-16T18:30:00-04:00",
  }])}</script>`, {
    adapter: "html_pdf_v1",
    role: "upcoming_meetings",
    board_id: "brooklyn-cb-07",
    body_name: "Brooklyn Community Board 7",
    url: "https://cbbrooklyn.cityofnewyork.us/cb7/events/list/",
  }, { receipt: { status: "ok", observed_at: "2026-08-21T12:00:00Z" } });
  const manhattan = parseGoogleCalendarSource(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:63opnsm7n7f5d8rpk76mftnpfa@google.com
DTSTART;TZID=America/New_York:20260901T183000
SUMMARY:Full Board Meeting
LOCATION:10 Lincoln Center Plaza
END:VEVENT
END:VCALENDAR`, {
    adapter: "google_calendar_v1",
    role: "upcoming_meetings",
    board_id: "manhattan-cb-07",
    body_name: "Manhattan Community Board 7",
    url: "https://calendar.google.com/calendar/ical/example/public/basic.ics",
  }, { receipt: { status: "ok", observed_at: "2026-08-21T12:00:00Z" } });
  const queens = parseNycOfficialCalendarSource(`
    <div class="span6 about-description">
      Meetings The Community Board meets on the 2nd Monday of each month.
      The next scheduled Regular &amp; Public Hearing meeting will be September 14, 2026
      St. Luke-Msgr. Tosi Pastoral Center 16-34 Clintonville Street Whitestone, NY 11357
      There are no scheduled Committee meetings at this time.
    </div>
  `, {
    adapter: "nyc_official_calendar_v1",
    role: "upcoming_meetings",
    publisher_kind: "nyc_official",
    format: "explicit board calendar",
    board_id: "queens-cb-07",
    body_name: "Queens Community Board 7",
    url: "https://www.nyc.gov/site/queenscb7/meetings/meetings.page",
  }, { receipt: { status: "ok", observed_at: "2026-08-21T12:00:00Z" } });

  assert.equal(brooklyn.length, 1);
  assert.equal(manhattan.length, 1);
  assert.equal(queens.length, 0, "Queens CB7 prose without a publisher event identity stays unindexed");

  const observedAt = "2026-08-21T12:00:00Z";
  const brooklynRow = materializeCommunityBoardMeetingRow(brooklyn[0], {
    id: "brooklyn-cb-07",
    name: "Brooklyn Community Board 7",
    borough: "Brooklyn",
  }, observedAt);
  const manhattanRow = materializeCommunityBoardMeetingRow(manhattan[0], {
    id: "manhattan-cb-07",
    name: "Manhattan Community Board 7",
    borough: "Manhattan",
  }, observedAt);

  for (const row of [brooklynRow, manhattanRow]) {
    const href = meetingCanonicalHref(row);
    const scopeHref = communityBoardScopeHref("meetings", row.board_id);
    const followHref = followingUrlFromWatch({
      lens: "meetings",
      filter: { geographies: [`community-board:${row.board_id}`], borough: row.affected_area.boroughs[0] },
    });
    assert.match(href, /^\/meetings\/meeting%3Acommunity_board%3A/);
    assert.match(scopeHref, new RegExp(row.board_id));
    assert.match(followHref, /\/following\?/);
    assert.match(followHref, /lens=meetings/);
    assert.equal(row.source_provenance.observed_receipt.status, "ok");
    assert.ok(row.entity_refs_all.includes(`community-board:${row.board_id}`));
  }
});

function assertFollowableBoardMeeting(record, board) {
  const row = materializeCommunityBoardMeetingRow(record, board, "2026-08-21T12:00:00Z");
  const href = meetingCanonicalHref(row);
  const scopeHref = communityBoardScopeHref("meetings", row.board_id);
  const followHref = followingUrlFromWatch({
    lens: "meetings",
    filter: { geographies: [`community-board:${row.board_id}`], borough: row.affected_area.boroughs[0] },
  });
  assert.match(href, /^\/meetings\/meeting%3Acommunity_board%3A/);
  assert.match(scopeHref, new RegExp(row.board_id));
  assert.match(followHref, /\/following\?/);
  assert.match(followHref, /lens=meetings/);
  assert.equal(row.source_provenance.observed_receipt.status, "ok");
  assert.ok(row.entity_refs_all.includes(`community-board:${row.board_id}`));
  assert.ok(row.source_record_id);
  assert.match(row.source_url, /^https:\/\//);
  return row;
}

test("adapter-gap boards index followable upcoming meetings from explicit sources", () => {
  assert.equal(communityBoardSourceAdapterId({
    role: "upcoming_meetings",
    format: "board-owned HTML/event calendar",
    url: "https://cb14brooklyn.com/meetings/",
  }), "html_pdf_v1");
  assert.equal(communityBoardSourceAdapterId({
    role: "upcoming_meetings",
    publisher_kind: "nyc_official",
    format: "explicit board calendar",
    url: "https://www.nyc.gov/site/queenscb1/calendar/calendar.page",
  }), "nyc_official_calendar_v1");
  assert.equal(communityBoardSourceAdapterId({
    role: "upcoming_meetings",
    publisher_kind: "nyc_official",
    format: "explicit board calendar",
    url: "https://www.nyc.gov/site/brooklyncb18/meetings/calendar.page",
  }), "nyc_official_calendar_v1");
  assert.notEqual(communityBoardSourceAdapterId({
    role: "upcoming_meetings",
    format: "board-owned HTML + Google Calendar/iCalendar",
    url: "https://cb14brooklyn.com/meetings/",
  }), "html_pdf_v1");

  const brooklyn14 = parseHtmlPdfSource(`<script type="application/ld+json">${JSON.stringify([{
    "@type": "Event",
    name: "September 2026 Board Meeting",
    url: "https://cb14brooklyn.com/meeting/september-2026-board-meeting/",
    startDate: "2026-09-14T18:45:00-04:00",
  }])}</script>`, {
    adapter: "html_pdf_v1",
    role: "upcoming_meetings",
    board_id: "brooklyn-cb-14",
    body_name: "Brooklyn Community Board 14",
    url: "https://cb14brooklyn.com/meetings/",
    format: "board-owned HTML/event calendar",
  }, { receipt: { status: "ok", observed_at: "2026-08-21T12:00:00Z" } });
  const bronx08 = parseHtmlPdfSource(`<script type="application/ld+json">${JSON.stringify([{
    "@type": "Event",
    name: "Full Board",
    url: "https://cbbronx.cityofnewyork.us/cb8/event/full-board/2026-09-08/",
    startDate: "2026-09-08T19:00:00+00:00",
  }])}</script>`, {
    adapter: "html_pdf_v1",
    role: "upcoming_meetings",
    board_id: "bronx-cb-08",
    body_name: "Bronx Community Board 8",
    url: "https://cbbronx.cityofnewyork.us/cb8/events/list/",
    format: "board-owned WordPress HTML/event calendar",
  }, { receipt: { status: "ok", observed_at: "2026-08-21T12:00:00Z" } });
  const brooklyn10 = parseHtmlPdfSource(`<script type="application/ld+json">${JSON.stringify([{
    "@type": "Event",
    name: "Monthly Board Meeting",
    url: "https://cbbrooklyn.cityofnewyork.us/cb10/event/monthly-board-meeting-11/",
    startDate: "2026-09-17T19:00:00-04:00",
  }])}</script>`, {
    adapter: "html_pdf_v1",
    role: "upcoming_meetings",
    board_id: "brooklyn-cb-10",
    body_name: "Brooklyn Community Board 10",
    url: "https://cbbrooklyn.cityofnewyork.us/cb10/events/list/",
    format: "board-owned WordPress HTML/event calendar",
  }, { receipt: { status: "ok", observed_at: "2026-08-21T12:00:00Z" } });
  const queens01 = parseNycOfficialCalendarSource(`
    <div class="span6 about-description">
      <h3>Full Board / Public Hearing Meetings</h3>
      <p>September 22, 2026 - 6:00 PM<br />October 20, 2026</p>
    </div>
  `, {
    adapter: "nyc_official_calendar_v1",
    role: "upcoming_meetings",
    publisher_kind: "nyc_official",
    format: "explicit board calendar",
    board_id: "queens-cb-01",
    body_name: "Queens Community Board 1",
    url: "https://www.nyc.gov/site/queenscb1/calendar/calendar.page",
  }, { receipt: { status: "ok", observed_at: "2026-08-21T12:00:00Z" } });
  const brooklyn18 = parseNycOfficialCalendarSource(`
    <div class="span6 about-description">
      <p><strong><u>REGULAR MONTHLY BOARD MEETING – JUNE 17, 2026, 7 PM</u></strong></p>
    </div>
  `, {
    adapter: "nyc_official_calendar_v1",
    role: "upcoming_meetings",
    publisher_kind: "nyc_official",
    format: "explicit board calendar",
    board_id: "brooklyn-cb-18",
    body_name: "Brooklyn Community Board 18",
    url: "https://www.nyc.gov/site/brooklyncb18/meetings/calendar.page",
  }, { receipt: { status: "ok", observed_at: "2026-08-21T12:00:00Z" } });

  assert.equal(brooklyn14.length, 1);
  assert.equal(bronx08.length, 1);
  assert.equal(brooklyn10.length, 1);
  assert.equal(queens01.length, 1);
  assert.equal(brooklyn18.length, 1);

  assertFollowableBoardMeeting(brooklyn14[0], { id: "brooklyn-cb-14", name: "Brooklyn Community Board 14", borough: "Brooklyn" });
  assertFollowableBoardMeeting(bronx08[0], { id: "bronx-cb-08", name: "Bronx Community Board 8", borough: "Bronx" });
  assertFollowableBoardMeeting(brooklyn10[0], { id: "brooklyn-cb-10", name: "Brooklyn Community Board 10", borough: "Brooklyn" });
  assertFollowableBoardMeeting(queens01[0], { id: "queens-cb-01", name: "Queens Community Board 1", borough: "Queens" });
  assertFollowableBoardMeeting(brooklyn18[0], { id: "brooklyn-cb-18", name: "Brooklyn Community Board 18", borough: "Brooklyn" });
});

test("public Google Calendar embeds index followable upcoming meetings", () => {
  assert.equal(communityBoardSourceAdapterId({
    role: "upcoming_meetings",
    adapter: "google_calendar_v1",
    format: "board-owned HTML + Google Calendar/iCalendar",
    url: "https://cbsix.org/meetings-calendar/",
  }), "google_calendar_v1");
  assert.equal(communityBoardSourceAdapterId({
    role: "upcoming_meetings",
    publisher_kind: "nyc_official",
    format: "NYC HTML + Google Calendar iframe",
    url: "https://www.nyc.gov/site/queenscb2/calendar/calendar.page",
  }), "google_calendar_v1");
  assert.equal(communityBoardSourceAdapterId({
    role: "upcoming_meetings",
    publisher_kind: "nyc_official",
    format: "NYC HTML + Google Calendar iframe",
    url: "https://www.nyc.gov/site/queenscb6/calendar/calendar.page",
  }), "google_calendar_v1");

  const manhattan06 = parseGoogleCalendarSource(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:mn6-full-board
DTSTART;TZID=America/New_York:20261118T190000
SUMMARY:Full Board Meeting
LOCATION:211 East 43rd Street
END:VEVENT
END:VCALENDAR`, {
    adapter: "google_calendar_v1",
    role: "upcoming_meetings",
    board_id: "manhattan-cb-06",
    body_name: "Manhattan Community Board 6",
    url: "https://cbsix.org/meetings-calendar/",
    format: "board-owned HTML + Google Calendar/iCalendar",
  }, { receipt: { status: "ok", observed_at: "2026-08-21T12:00:00Z" } });
  const queens02 = parseGoogleCalendarSource(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:qn2-budget
DTSTART;TZID=America/New_York:20260917T183000
SUMMARY:Capital & Expense Budget Committee Meeting
END:VEVENT
END:VCALENDAR`, {
    adapter: "google_calendar_v1",
    role: "upcoming_meetings",
    board_id: "queens-cb-02",
    body_name: "Queens Community Board 2",
    url: "https://www.nyc.gov/site/queenscb2/calendar/calendar.page",
    format: "NYC HTML + Google Calendar iframe",
  }, { receipt: { status: "ok", observed_at: "2026-08-21T12:00:00Z" } });
  const queens06 = parseGoogleCalendarSource(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:qn6-board
DTSTART;TZID=America/New_York:20260917T183000
SUMMARY:Community Board 6 Meeting
END:VEVENT
END:VCALENDAR`, {
    adapter: "google_calendar_v1",
    role: "upcoming_meetings",
    board_id: "queens-cb-06",
    body_name: "Queens Community Board 6",
    url: "https://www.nyc.gov/site/queenscb6/calendar/calendar.page",
    format: "NYC HTML + Google Calendar iframe",
  }, { receipt: { status: "ok", observed_at: "2026-08-21T12:00:00Z" } });

  assert.equal(manhattan06.length, 1);
  assert.equal(queens02.length, 1);
  assert.equal(queens06.length, 1);
  assert.equal(manhattan06[0].event_id, "mn6-full-board::2026-11-18");
  assert.equal(queens02[0].event_id, "qn2-budget::2026-09-17");
  assert.equal(queens06[0].event_id, "qn6-board::2026-09-17");

  assertFollowableBoardMeeting(manhattan06[0], { id: "manhattan-cb-06", name: "Manhattan Community Board 6", borough: "Manhattan" });
  assertFollowableBoardMeeting(queens02[0], { id: "queens-cb-02", name: "Queens Community Board 2", borough: "Queens" });
  assertFollowableBoardMeeting(queens06[0], { id: "queens-cb-06", name: "Queens Community Board 6", borough: "Queens" });
});
