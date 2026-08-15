import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildSharedMeetingReadModel,
  meetingReadModelSourceStatus,
} from "../site/shared_meeting_read_model.mjs";
import { materializeCommunityBoardMeetingRow } from "../tools/build_community_board_meeting_index.mjs";
import { normalizeHearing } from "../worker/src/lib/hearings.mjs";

const meetings = JSON.parse(readFileSync(new URL("../site/data/meetings_domain_observations.json", import.meta.url)));
const boardIndex = JSON.parse(readFileSync(new URL("../site/data/community_board_meeting_index.json", import.meta.url)));
const sharedSnapshot = JSON.parse(readFileSync(new URL("../site/data/shared_meeting_read_model.json", import.meta.url)));
const cityRecordParity = JSON.parse(readFileSync(new URL("./fixtures/city_record_meeting_parity.json", import.meta.url)));

test("one read model preserves source-qualified identities and parity fields", () => {
  const model = buildSharedMeetingReadModel({
    cityRecordRows: meetings.rows.slice(0, 2),
    communityBoardIndex: boardIndex,
    generatedAt: meetings.retrieved_at,
    now: boardIndex.generated_at,
  });
  assert.equal(model.schema, "cityscroll.shared_meeting_read_model.v1");
  assert.equal(model.counts.total, model.rows.length);
  assert.equal(model.counts.city_record, 2);
  assert.equal(model.counts.community_board, boardIndex.rows.length);
  assert.equal(model.sources.community_board.status, "available");
  assert.equal(model.rows.filter((row) => row.source_system === "city_record").length, 2);
  assert.equal(model.rows.filter((row) => row.source_system === "community_board").length, boardIndex.rows.length);

  const city = model.rows.find((row) => row.source_system === "city_record");
  const board = model.rows.find((row) => row.source_system === "community_board");
  assert.equal(city.meeting_id, `meeting:city_record:${city.request_id}`);
  assert.equal(city.compatibility.legacy_notice_href, `/notices/${city.request_id}`);
  assert.ok(city.source_record.identifier);
  assert.equal(city.source_receipt.status, "ok");
  assert.match(board.meeting_id, /^meeting:community_board:/);
  assert.equal(board.institution_refs.agency_ref, null);
  assert.ok(board.institution_refs.board_ref);
  assert.ok(board.source_record.receipt);
  assert.ok(board.source_url);
});

test("missing or old board snapshots are explicit and never become an unbounded fallback", () => {
  const missing = buildSharedMeetingReadModel({
    cityRecordRows: meetings.rows.slice(0, 1),
    communityBoardIndex: null,
    generatedAt: "2026-08-14T12:00:00Z",
    now: "2026-08-14T12:00:00Z",
  });
  assert.equal(meetingReadModelSourceStatus(missing), "unavailable");
  assert.equal(missing.counts.community_board, 0);
  assert.equal(missing.rows.some((row) => row.source_system === "community_board"), false);

  const stale = buildSharedMeetingReadModel({
    cityRecordRows: [],
    communityBoardIndex: { generated_at: "2026-08-01T12:00:00Z", rows: boardIndex.rows.slice(0, 1) },
    generatedAt: "2026-08-14T12:00:00Z",
    now: "2026-08-14T12:00:00Z",
  });
  assert.equal(meetingReadModelSourceStatus(stale), "stale");
  assert.equal(stale.counts.community_board, 1);
  assert.equal(stale.freshness.sources.community_board, "stale");
});

test("materializes searchable context and minutes freshness once for every source", () => {
  const model = buildSharedMeetingReadModel({
    cityRecordRows: [{
      request_id: "20260814001",
      agency_name: "Buildings",
      short_title: "Public hearing on facade safety",
      event_date: "2026-08-20T10:00:00.000",
      source_system: "city_record",
      venue: { name: "250 Broadway", address: "250 Broadway, New York, NY", mode: "in-person" },
      participation: { links: [{ label: "Join online", url: "https://example.test/join" }], remote_join_url: "https://example.test/join" },
      description: "Facade safety hearing",
      meeting_documents: [{ role: "minutes", document_url: "https://example.test/minutes.pdf", meeting_date: "2026-08-10", meeting_key: "meeting:city_record:20260814001", source_receipt: { status: "ok", observed_at: "2026-08-14T12:00:00Z" }, attachment_status: "attached" }],
    }],
    communityBoardIndex: { generated_at: "2026-08-14T12:00:00Z", rows: [] },
    generatedAt: "2026-08-14T12:00:00Z",
    now: "2026-08-14T12:00:00Z",
  });
  const row = model.rows[0];
  assert.match(row.search_text, /Facade safety hearing/);
  assert.match(row.search_text, /250 Broadway/);
  assert.deepEqual(row.minutes_freshness, { status: "published", latest_date: "2026-08-10", checked_at: "2026-08-14T12:00:00Z" });
  assert.equal(row.participation.remote_join_url, "https://example.test/join");
});

test("community-board publisher times survive indexing and shared materialization", () => {
  const observedAt = "2026-08-14T12:00:00Z";
  const indexed = materializeCommunityBoardMeetingRow({
    record_kind: "event",
    record_id: "event-rich",
    source_record_id: "event-rich",
    publisher_identifier: "event-rich",
    record_url: "https://www.nyc.gov/site/manhattancb2/calendar/event-rich.page",
    source_url: "https://www.nyc.gov/site/manhattancb2/calendar/calendar.page",
    date: "2026-08-17",
    start_at: "2026-08-17T18:30:00-04:00",
    end_at: "2026-08-17T20:30:00-04:00",
    title: "Landmarks 2",
    description: "Agenda: 63-65 Charles Street.",
    venue_name: "CB 2 Conference Room",
    address: "3 Washington Square Village #1A, New York, NY 10012",
    mode: "hybrid",
    observed_receipt: { status: "ok", observed_at: observedAt },
  }, {
    id: "manhattan-cb-02",
    name: "Manhattan Community Board 2",
    borough: "Manhattan",
  }, observedAt);
  const model = buildSharedMeetingReadModel({
    cityRecordRows: [],
    communityBoardIndex: { generated_at: observedAt, rows: [indexed] },
    generatedAt: observedAt,
    now: observedAt,
  });
  const row = model.rows[0];
  assert.equal(row.event_date, "2026-08-17T18:30:00-04:00");
  assert.equal(row.event_end, "2026-08-17T20:30:00-04:00");
  assert.equal(row.description, "Agenda: 63-65 Charles Street.");
  assert.match(row.search_text, /63-65 Charles Street/);
});

test("retains City Record notice parity fields in the shared read model", () => {
  const model = buildSharedMeetingReadModel({
    cityRecordRows: [normalizeHearing(cityRecordParity)],
    communityBoardIndex: { generated_at: "2026-08-14T12:00:00Z", rows: [] },
    generatedAt: "2026-08-14T12:00:00Z",
    now: "2026-08-14T12:00:00Z",
  });
  const row = model.rows[0];
  for (const field of [
    "type_of_notice_description", "section_name", "additional_description_1",
    "additional_description_2", "additional_description_3", "other_info_1",
    "other_info_2", "other_info_3", "street_address_1", "street_address_2",
    "building_name", "city", "state", "zip_code", "contact_name", "contact_phone",
    "email", "source_links", "document_links",
  ]) assert.deepEqual(row[field], cityRecordParity[field], `read model should retain ${field}`);
  assert.deepEqual(row.venue, {
    mode: "hybrid",
    building: "Municipal Building",
    address: "250 Broadway, Room 915, New York, NY, 10007",
    borough: null,
    neighborhood: null,
  });
  assert.equal(row.participation.remote_join_url, "https://zoom.us/j/123456789");
  assert.equal(row.meeting_origin, "city_record_notice");
  assert.match(row.description, /Accessibility accommodations/);
  assert.match(row.search_text, /A recording will be posted/);
  assert.match(row.search_text, /250 Broadway/);
});

test("the canonical snapshot carries the hearing adapter projection for the City Record field case", () => {
  const row = sharedSnapshot.rows.find((candidate) => candidate.meeting_id === "meeting:city_record:20260729019");
  assert.ok(row, "the named City Record field case should remain in the canonical snapshot");
  assert.equal(row.meeting_origin, "city_record_notice");
  assert.equal(row.description, row.additional_description_1);
  assert.equal(row.venue.mode, "not-stated");
  assert.equal(row.meeting_access.mode, "unknown");
  assert.equal(row.source_url, "https://a856-cityrecord.nyc.gov/RequestDetail/20260729019");
  assert.deepEqual(row.source_links, [
    "https://a856-cityrecord.nyc.gov/Search/GetFile?sectionId=1&requestId=20260729019&requestStatus=Archived&documentId=44341",
  ]);
  assert.match(row.search_text, /Office of Technology & Innovation/);
});
