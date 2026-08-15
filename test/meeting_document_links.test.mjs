import assert from "node:assert/strict";
import test from "node:test";

import { meetingDocumentLinks, renderMeetingDocument } from "../site/meeting_document.mjs";

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
    board_id: "manhattan-cb-02",
    board_name: "Manhattan Community Board 2",
    committee: { name: "Landmarks 2" },
    venue: { name: "CB 2 Conference Room", address: "3 Washington Square Village #1A", mode: "hybrid" },
    affected_area: { boroughs: ["Manhattan"], community_districts: ["M02"], council_districts: ["02"] },
    participation: {
      links: [{ label: "Register to attend", url: "https://example.test/register" }],
      remote_join_url: "https://example.test/zoom",
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
  assert.match(html, /Landmarks 2/);
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
