import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COMMUNITY_BOARD_SOURCE_ADAPTER_CONTRACTS,
  fetchCommunityBoardSource,
  parseAirtableSource,
  parseGoogleCalendarSource,
  parseHtmlPdfSource,
  parseVideoRecordSource,
  sourceRecordStatus,
} from "../site/community_board_source_adapters.mjs";

const receipt = { status: "ok", observed_at: "2026-08-14T12:00:00Z" };

test("each heterogeneous source has a bounded explicit adapter contract", () => {
  assert.deepEqual(Object.keys(COMMUNITY_BOARD_SOURCE_ADAPTER_CONTRACTS).sort(), [
    "airtable_v1", "google_calendar_v1", "html_pdf_v1", "video_record_v1",
  ]);
  for (const contract of Object.values(COMMUNITY_BOARD_SOURCE_ADAPTER_CONTRACTS)) {
    assert.ok(contract.max_bytes > 0);
    assert.ok(contract.contract);
    assert.ok(contract.record_kinds.length);
  }
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

test("Google Calendar, Airtable, and video adapters use native record IDs", () => {
  const calendar = parseGoogleCalendarSource(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:event-1\nDTSTART;VALUE=DATE:20260820\nSUMMARY:Full board meeting\nX-BOARD-ID:bronx-cb-01\nEND:VEVENT\nEND:VCALENDAR`, {
    adapter: "google_calendar_v1", board_id: "bronx-cb-01", url: "https://calendar.example/board.ics",
  }, { receipt });
  assert.equal(calendar[0].event_id, "event-1");
  assert.equal(calendar[0].date, "2026-08-20");
  assert.equal(calendar[0].body_evidence.basis, "publisher_record");

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
