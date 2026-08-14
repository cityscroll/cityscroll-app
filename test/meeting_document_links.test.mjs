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
  assert.match(html, /Minutes and records/);
  assert.match(html, /https:\/\/board\.example\/minutes-1\.pdf/);
  assert.match(html, /data-meeting-documents/);
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
