import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildSharedMeetingReadModel,
  meetingReadModelSourceStatus,
} from "../site/shared_meeting_read_model.mjs";
import { materializeCommunityBoardMeetingRow } from "../tools/build_community_board_meeting_index.mjs";

const meetings = JSON.parse(readFileSync(new URL("../site/data/meetings_domain_observations.json", import.meta.url)));
const boardIndex = JSON.parse(readFileSync(new URL("../site/data/community_board_meeting_index.json", import.meta.url)));

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
    cityRecordRows: [{
      request_id: "20260820001",
      agency_name: "Buildings",
      short_title: "Public hearing on a proposed rule",
      start_date: "2026-08-14T00:00:00Z",
      event_date: "2026-08-20T14:00:00Z",
      type_of_notice_description: "Public Hearings",
      section_name: "Public Hearings and Meetings",
      additional_description_1: "The first substantive notice paragraph.",
      additional_description_2: "A second notice paragraph.",
      other_info_1: "Additional public information.",
      other_info_2: "Further public information.",
      street_address_1: "250 Broadway",
      street_address_2: "Room 915",
      building_name: "Municipal Building",
      city: "New York",
      state: "NY",
      zip_code: "10007",
      contact_name: "Public Hearings Unit",
      contact_phone: "212-555-0100",
      email: "hearings@example.gov",
    }],
    communityBoardIndex: { generated_at: "2026-08-14T12:00:00Z", rows: [] },
    generatedAt: "2026-08-14T12:00:00Z",
    now: "2026-08-14T12:00:00Z",
  });
  const row = model.rows[0];
  for (const field of [
    "type_of_notice_description", "section_name", "additional_description_1",
    "additional_description_2", "other_info_1", "other_info_2", "street_address_1",
    "street_address_2", "building_name", "city", "state", "zip_code", "contact_name",
    "contact_phone", "email",
  ]) assert.ok(Object.hasOwn(row, field), `read model should retain ${field}`);
  assert.equal(row.additional_description_1, "The first substantive notice paragraph.");
  assert.match(row.search_text, /Further public information/);
});
