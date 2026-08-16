import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { meetingDocumentLinks, renderMeetingDocument } from "../site/meeting_document.mjs";
import { meetingCalendarICS } from "../site/hearing_attend_pack.mjs";
import { normalizeHearing } from "../worker/src/lib/hearings.mjs";

const cityRecordParity = JSON.parse(readFileSync(new URL("./fixtures/city_record_meeting_parity.json", import.meta.url)));

test("meeting documents render as official record links on the canonical meeting page", () => {
  const record = {
    meeting_id: "meeting:community_board:event-1",
    source_system: "community_board",
    title: "Community Board 6 meeting",
    event_date: "2026-08-12",
    meeting_documents: [{
      object_type: "meeting_document",
      role: "minutes",
      document_url: "https://board.example/minutes-1.pdf",
      meeting_date: "2026-08-12",
      attachment_status: "attached",
      source_status: "available",
    }],
  };
  assert.deepEqual(meetingDocumentLinks(record), [{
    role: "minutes",
    label: "Minutes",
    href: "https://board.example/minutes-1.pdf",
    date: "2026-08-12",
    source_status: "available",
  }]);
  const html = renderMeetingDocument(record);
  assert.match(html, /data-meeting-minutes/);
  assert.match(html, /https:\/\/board\.example\/minutes-1\.pdf/);
  assert.doesNotMatch(html, /data-meeting-documents/);
  assert.doesNotMatch(html, /meeting_document|attachment_status|source_status/);
});

test("unavailable documents do not become official meeting links", () => {
  const html = renderMeetingDocument({
    meeting_id: "meeting:community_board:event-1",
    title: "Community Board 6 meeting",
    meeting_documents: [{
      role: "minutes",
      document_url: "https://board.example/minutes-1.pdf",
      attachment_status: "unavailable",
      source_status: "unavailable",
    }],
  });
  assert.doesNotMatch(html, /data-meeting-documents/);
});

test("meeting detail renders the materialized civic object projection", () => {
  const html = renderMeetingDocument({
    meeting_id: "meeting:community_board:event-rich",
    source_system: "community_board",
    source_record_id: "event-rich",
    title: "LANDMARKS 2",
    event_date: "2026-08-17T18:30:00-04:00",
    event_end: "2026-08-17T20:30:00-04:00",
    board_id: "manhattan-cb-02",
    board_name: "Manhattan Community Board 2",
    committee: { name: "Landmarks 2" },
    description: "Agenda: 63-65 Charles Street and two preservation applications.",
    venue: { name: "CB 2 Conference Room", address: "3 Washington Square Village #1A", mode: "hybrid" },
    affected_area: { boroughs: ["Manhattan"], community_districts: ["M02"], council_districts: ["02"] },
    participation: {
      links: [{ label: "Register to attend", url: "https://example.test/register" }],
      remote_join_url: "https://zoom.us/j/123456789",
      emails: ["board@example.test"], phones: ["212-555-0100"],
    },
    meeting_documents: [
      { role: "agenda", document_url: "https://example.test/agenda.pdf", meeting_date: "2026-08-17", attachment_status: "attached", source_status: "available" },
      { role: "minutes", document_url: "https://example.test/minutes.pdf", meeting_date: "2026-08-10", attachment_status: "attached", source_status: "available" },
    ],
    minutes_freshness: { status: "published", latest_date: "2026-08-10" },
  });
  assert.match(html, /Manhattan Community Board 2/);
  assert.match(html, /\/community-boards\/manhattan-cb-02\//);
  assert.match(html, /data-pivot-schema="cityscroll\.edge_summary\.v1"/);
  assert.match(html, /data-pivot-target-kind="community-board"/);
  assert.match(html, /data-pivot-relation-label="hosted by community board"/);
  assert.match(html, /Landmarks 2/);
  assert.match(html, /63-65 Charles Street and two preservation applications/);
  assert.match(html, /2026-08-17T20:30:00-04:00/);
  assert.match(html, /\/near-you\//);
  assert.match(html, /Agenda/);
  assert.match(html, /agenda\.pdf/);
  assert.match(html, /Minutes published through/);
  assert.match(html, /2026-08-10/);
  assert.match(html, /Register to attend/);
  assert.match(html, /Join online/);
  assert.doesNotMatch(html, /search_text|minutes_freshness|meeting_documents/);
});

test("meeting affordances are progressive and shared across source systems", () => {
  const html = renderMeetingDocument({
    meeting_id: "meeting:city_record:20260814001",
    source_system: "city_record",
    title: "A city meeting",
    event_date: "2026-08-14T10:00:00-04:00",
    agency: "An agency",
  });
  assert.match(html, /class="node-hero civic-object-hero meeting-hero"/);
  assert.match(html, /class="node-actions civic-object-actions meeting-actions"/);
  assert.match(html, /An agency/);
  assert.doesNotMatch(html, /meeting-location|meeting-participation|meeting-documents|meeting-minutes/);
  assert.doesNotMatch(html, /Not published|Status unknown|Agenda and materials/);
});

test("meeting calendar action requires a valid materialized event time", () => {
  const base = {
    meeting_id: "meeting:city_record:20260814001",
    source_system: "city_record",
    title: "A city meeting",
  };
  for (const event_date of [undefined, null, "not-a-date", "2026-99-99T18:30:00", "2026-02-30T18:30:00-05:00", "2026-08-14"]) {
    const html = renderMeetingDocument({ ...base, event_date });
    assert.doesNotMatch(html, /Add to calendar/);
    assert.doesNotMatch(html, /href="\/meeting\.ics\?/);
  }
});

test("timed meeting calendar action uses the canonical meeting id", () => {
  const html = renderMeetingDocument({
    meeting_id: "meeting:community_board:https://example.test/events/land-use/",
    source_system: "community_board",
    title: "Land use committee",
    event_date: "2026-08-14T18:30:00-04:00",
  });
  assert.match(html, />Add to calendar<\/a>/);
  assert.match(html, /href="\/meeting\.ics\?id=meeting%3Acommunity_board%3Ahttps%3A%2F%2Fexample\.test%2Fevents%2Fland-use%2F"/);
});

test("meeting agency identity uses a typed pivot and unresolved committee names do not mint routes", () => {
  const html = renderMeetingDocument({
    meeting_id: "meeting:city_record:20260814002",
    source_system: "city_record",
    title: "A transportation hearing",
    event_date: "2026-08-14T10:00:00-04:00",
    agency: "Department of Transportation",
    institution_refs: { agency_ref: "agency:id:transportation" },
    committee: { name: "A committee without a published route" },
  });
  assert.match(html, /href="\/agencies\/transportation\/"/);
  assert.match(html, /data-pivot-target-kind="agency"/);
  assert.match(html, /data-pivot-relation-label="organized by agency"/);
  assert.doesNotMatch(html, /committee-without-a-published-route/);
});

test("meeting participation keeps real join methods once and labels their platforms", () => {
  const html = renderMeetingDocument({
    meeting_id: "meeting:community_board:event-participation",
    source_system: "community_board",
    title: "A hybrid board meeting",
    event_date: "2026-08-20",
    participation: {
      links: [
        { label: "Join online", url: "https://www.zoomgov.com/j/123456789" },
        { label: "Register to attend", url: "https://www.zoomgov.com/webinar/register/WN_test" },
        { label: "Join online", url: "https://workspace.google.com/products/calendar/" },
        { label: "Register to attend", url: "https://outlook.office.com/owa/?path=/calendar/action/compose&rrv=addevent" },
        { label: "Join online", url: "https://teams.microsoft.com/l/meetup-join/test" },
        { label: "Join online", url: "https://example.webex.com/meet/test" },
        { label: "Join online", url: "https://meet.google.com/abc-defg-hij" },
        { label: "Join online", url: "https://example.gov/register/meeting" },
      ],
      remote_join_url: "https://www.zoomgov.com/j/123456789",
    },
  });
  assert.equal((html.match(/Join online \(Zoom\)/g) || []).length, 1);
  assert.equal((html.match(/Join online \(Microsoft Teams\)/g) || []).length, 1);
  assert.equal((html.match(/Join online \(Webex\)/g) || []).length, 1);
  assert.equal((html.match(/Join online \(Google Meet\)/g) || []).length, 1);
  assert.equal((html.match(/Register to attend/g) || []).length, 2);
  assert.doesNotMatch(html, /workspace\.google\.com\/products/);
  assert.doesNotMatch(html, /outlook\.office\.com\/owa/);
  assert.match(html, /https:\/\/example\.gov\/register\/meeting/);
});

test("meeting participation canonicalizes equivalent join URLs before deduplication", () => {
  const html = renderMeetingDocument({
    meeting_id: "meeting:legistar:1234",
    source_system: "legistar",
    title: "City Council committee meeting",
    event_date: "2026-08-20",
    participation: {
      links: [
        { label: "Join online", url: "https://EXAMPLE.webex.com:443/meet/council/" },
        { label: "Join online", url: "https://example.webex.com/meet/council" },
      ],
      remote_join_url: "https://example.webex.com/meet/council/",
    },
  });

  assert.equal((html.match(/Join online \(Webex\)/g) || []).length, 1);
  assert.equal((html.match(/https:\/\/example\.webex\.com\/meet\/council/g) || []).length, 1);
  assert.doesNotMatch(html, /EXAMPLE\.webex\.com|:443|meet\/council\//);
});

test("meeting participation excludes platform management and calendar-product links", () => {
  const html = renderMeetingDocument({
    meeting_id: "meeting:city_record:20260820002",
    source_system: "city_record",
    title: "Public hearing",
    event_date: "2026-08-20",
    participation: {
      links: [
        { label: "Join online", url: "https://zoom.us/meeting/schedule" },
        { label: "Join online", url: "https://example.webex.com/webappng/sites/example/dashboard" },
        { label: "Join online", url: "https://calendar.google.com/calendar/render?action=TEMPLATE" },
        { label: "Add to calendar", url: "https://outlook.office.com/calendar/action/compose" },
        { label: "Join online", url: "https://zoom.us.evil.example/j/123456789" },
        { label: "Join online", url: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_example" },
      ],
    },
  });

  assert.equal((html.match(/Join online \(Microsoft Teams\)/g) || []).length, 1);
  assert.doesNotMatch(html, /zoom\.us\/meeting\/schedule|webappng|calendar\.google|outlook\.office|evil\.example/);
});

test("meeting participation stays generic for an unknown platform and empty for unknown data", () => {
  const communityBoard = renderMeetingDocument({
    meeting_id: "meeting:community_board:event-unknown-platform",
    source_system: "community_board",
    title: "Community board meeting",
    event_date: "2026-08-20",
    participation: {
      links: [{ label: "Join online", url: "https://meetings.nyc.gov/teams/join/community-board-1" }],
      remote_join_url: null,
    },
  });
  assert.match(communityBoard, />Join online<\/a>/);
  assert.doesNotMatch(communityBoard, /Join online \(/);
  assert.match(communityBoard, /href="https:\/\/meetings\.nyc\.gov\/teams\/join\/community-board-1"/);

  const unknown = renderMeetingDocument({
    meeting_id: "meeting:legistar:unknown-participation",
    source_system: "legistar",
    title: "Meeting with no published participation method",
    event_date: "2026-08-20",
    participation: {
      links: [
        { label: "Join online", url: "javascript:alert(1)" },
        { label: "Join online", url: "https://www.nyc.gov/" },
      ],
      remote_join_url: null,
    },
  });
  assert.doesNotMatch(unknown, /meeting-participation|Join online|Participation information/);
});

test("city record meeting renders materialized notice fields without fetching", () => {
  const html = renderMeetingDocument(normalizeHearing(cityRecordParity));
  assert.match(html, /Public Hearings/);
  assert.match(html, /Public Hearings and Meetings/);
  assert.match(html, /Accessibility accommodations are available on request/);
  assert.match(html, /A recording will be posted after the hearing/);
  assert.match(html, /250 Broadway/);
  assert.match(html, /Municipal Building/);
  assert.match(html, /Public Hearings Unit/);
  assert.match(html, /212-555-0100/);
  assert.match(html, /mailto:hearings@buildings\.nyc\.gov/);
  assert.match(html, /href="https:\/\/a856-cityrecord\.nyc\.gov\/RequestDetail\/20260820001"/);
  assert.match(html, /href="https:\/\/a856-cityrecord\.nyc\.gov\/Search\/GetFile\?sectionId=1&amp;requestId=20260820001&amp;requestStatus=Current&amp;documentId=44501"/);
  assert.match(html, /href="\/notices\/20260820001"/);
});

test("meeting detail keeps machine tokens and source HTML out of reader text", () => {
  const communityBoard = renderMeetingDocument({
    meeting_id: "meeting:community_board:https://example.test/cb10/health",
    source_system: "community_board",
    title: "Health and Human Services Committee",
    type_of_notice_description: "upcoming_meetings",
    section_name: "Community Board Meetings",
  });
  assert.match(communityBoard, /<dd>Upcoming meeting<\/dd>/);
  assert.doesNotMatch(communityBoard, /upcoming_meetings/);

  const cityRecord = renderMeetingDocument({
    meeting_id: "meeting:city_record:20260810053",
    source_system: "city_record",
    title: "Design Commission Meeting Agenda",
    additional_description_1: "<p>Design Commission Meeting Agenda&nbsp;</p><p>Public testimony is welcome.</p>",
  });
  assert.match(cityRecord, /Design Commission Meeting Agenda Public testimony is welcome\./);
  assert.doesNotMatch(cityRecord, /&lt;\/?p&gt;/);
});

test("malformed event dates do not offer a broken calendar download", () => {
  const html = renderMeetingDocument({
    meeting_id: "meeting:community_board:event-bad-date",
    source_system: "community_board",
    title: "Board meeting",
    event_date: "date to be announced",
  });
  assert.doesNotMatch(html, /meeting\.ics|Add to calendar/);
});

test("calendar output uses a materialized publisher end time", () => {
  const ics = meetingCalendarICS({
    meeting_id: "meeting:community_board:event-timed",
    title: "Landmarks committee",
    event_date: "2026-08-17T18:30:00-04:00",
    event_end: "2026-08-17T20:30:00-04:00",
  }, { now: "2026-08-14T12:00:00Z" });
  assert.match(ics, /DTSTART;TZID=America\/New_York:20260817T183000/);
  assert.match(ics, /DTEND;TZID=America\/New_York:20260817T203000/);
});
