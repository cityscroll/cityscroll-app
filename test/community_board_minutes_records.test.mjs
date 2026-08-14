import assert from "node:assert/strict";
import test from "node:test";

import {
  attachMeetingDocuments,
  latestMeetingDocumentDate,
  normalizeMeetingDocument,
} from "../site/meeting_document.mjs";

const receipt = { status: "ok", observed_at: "2026-08-14T12:00:00Z" };
const meeting = {
  meeting_id: "meeting:community_board:event-1",
  source_system: "community_board",
  publisher_identifier: "event-1",
  board_id: "bronx-cb-06",
  event_date: "2026-08-12",
  title: "Bronx Community Board 6 meeting",
};

function document(fields = {}) {
  return normalizeMeetingDocument({
    role: "minutes",
    document_id: "minutes-1",
    document_url: "https://board.example/minutes-1.pdf",
    board_id: "bronx-cb-06",
    meeting_date: "2026-08-12",
    format: "pdf",
    observed_receipt: receipt,
    ...fields,
  });
}

test("an exact canonical meeting key attaches minutes without creating a second meeting", () => {
  const result = attachMeetingDocuments([meeting], [document({ meeting_id: meeting.meeting_id })]);
  assert.equal(result.attached_documents.length, 1);
  assert.equal(result.meetings[0].meeting_documents.length, 1);
  assert.equal(result.meetings[0].meeting_documents[0].meeting_id, meeting.meeting_id);
  assert.equal(result.meetings[0].meeting_documents[0].attachment_method, "exact_meeting_key");
});

test("date and title similarity leaves an orphan minutes record unlinked", () => {
  const result = attachMeetingDocuments([meeting], [document({ title: meeting.title })]);
  assert.equal(result.attached_documents.length, 0);
  assert.equal(result.orphan_documents.length, 1);
  assert.equal(result.documents[0].attachment_status, "unlinked");
  assert.equal(result.documents[0].meeting_id, null);
});

test("an exact publisher join attaches a document, while an ambiguous join stays held", () => {
  const publisherDocument = document({ publisher_identifier: "event-1" });
  const joined = attachMeetingDocuments([meeting], [publisherDocument]);
  assert.equal(joined.attached_documents[0].attachment_method, "exact_source_join");

  const secondMeeting = { ...meeting, meeting_id: "meeting:community_board:event-2" };
  const ambiguous = attachMeetingDocuments([meeting, secondMeeting], [publisherDocument]);
  assert.equal(ambiguous.ambiguous_documents.length, 1);
  assert.equal(ambiguous.documents[0].attachment_status, "ambiguous");
  assert.equal(ambiguous.documents[0].meeting_id, null);
});

test("an unavailable keyed source remains visible as unavailable without a meeting link", () => {
  const result = attachMeetingDocuments([meeting], [document({
    meeting_id: meeting.meeting_id,
    observed_receipt: { status: "unknown", observed_at: "2026-08-14T12:00:00Z" },
  })]);
  assert.equal(result.documents[0].attachment_status, "unavailable");
  assert.equal(result.documents[0].attachment_reason, "source_unavailable");
  assert.equal(result.meetings[0].meeting_documents.length, 0);
});

test("latest minutes date is derived only from attached records", () => {
  const result = attachMeetingDocuments([meeting], [
    document({ document_id: "minutes-old", meeting_id: meeting.meeting_id, meeting_date: "2021-04-29" }),
    document({ document_id: "minutes-new", meeting_id: meeting.meeting_id, meeting_date: "2026-07-29" }),
    document({ document_id: "minutes-orphan", meeting_date: "2026-08-01" }),
  ]);
  assert.equal(latestMeetingDocumentDate(result.documents), "2026-07-29");
});
