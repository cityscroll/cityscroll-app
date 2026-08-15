import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildSharedMeetingReadModel,
  meetingReadModelSourceStatus,
} from "../site/shared_meeting_read_model.mjs";

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
