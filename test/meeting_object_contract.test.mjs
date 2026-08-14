import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MEETING_OBJECT_SCHEMA,
  meetingCanonicalHref,
  meetingIdForSource,
  meetingRouteLinks,
  normalizeCityRecordMeeting,
  normalizeCommunityBoardMeeting,
  resolveMeetingRoute,
} from "../site/meeting_object_contract.mjs";

test("meeting is a registered source-qualified semantic object", () => {
  const registry = JSON.parse(readFileSync(new URL("../ontology/registry.v0.json", import.meta.url), "utf8"));
  const meeting = registry.object_types.find((entry) => entry.id === "meeting");
  assert.equal(meeting?.status, "registered");
  assert.equal(meeting?.identity_contract?.schema, MEETING_OBJECT_SCHEMA);
  assert.equal(meeting?.identity_contract?.source_qualified, true);
  assert.equal(meeting?.identity_contract?.title_date_identity_forbidden, true);
  assert.deepEqual(meeting?.identity_contract?.source_keys, [
    "city_record:request_id",
    "community_board:publisher_event_id",
  ]);
});

test("both producers preserve their exact source key in one shared object shape", () => {
  const cityRecord = normalizeCityRecordMeeting({
    request_id: "20260814001",
    short_title: "Public hearing on a local matter",
    event_date: "2026-08-20T10:00:00.000",
    venue: { mode: "in-person", address: "22 Reade Street" },
    participation: { links: [], emails: [], phones: [] },
    meeting_origin: "city_record_notice",
  });
  const board = normalizeCommunityBoardMeeting({
    board_id: "brooklyn-cb-06",
    source_record_id: "event-abc-123",
    title: "Brooklyn Community Board 6 meeting",
    event_date: "2026-08-20",
    source_url: "https://example.test/meetings/event-abc-123",
    source_receipt: { status: "ok", observed_at: "2026-08-14T12:00:00Z" },
    meeting_origin: "community_board_source_observed",
  });

  for (const record of [cityRecord, board]) {
    assert.equal(record.object_type, "meeting");
    assert.equal(record.schema, MEETING_OBJECT_SCHEMA);
    assert.ok(record.meeting_id.startsWith("meeting:"));
    assert.ok(record.source_keys.length === 1);
    assert.ok(record.publisher_identifier);
    assert.ok("title" in record && "event_date" in record);
    assert.ok("venue" in record && "participation" in record);
    assert.ok("source_url" in record && "source_system" in record);
    assert.ok("meeting_origin" in record && "source_receipt" in record);
    assert.ok("join_status" in record && "institution_refs" in record);
  }

  assert.equal(cityRecord.meeting_id, meetingIdForSource("city_record", "20260814001"));
  assert.equal(cityRecord.source_keys[0].value, "20260814001");
  assert.equal(board.meeting_id, meetingIdForSource("community_board", "event-abc-123"));
  assert.equal(board.source_keys[0].value, "event-abc-123");
  assert.equal(board.institution_refs.agency_ref, null);
  assert.equal(board.institution_refs.board_ref, "community-board:brooklyn-cb-06");
  assert.equal(board.join_status, "unknown");
});

test("identity never falls back to title/date and missing institutions stay honest", () => {
  assert.throws(() => meetingIdForSource("community_board", ""), /publisher_event_id is required/);
  const missingKey = normalizeCommunityBoardMeeting({ title: "Same title", event_date: "2026-08-20" });
  assert.equal(missingKey.meeting_id, null);
  assert.deepEqual(missingKey.source_keys, []);
  const first = normalizeCommunityBoardMeeting({ source_record_id: "event-1", title: "Same title", event_date: "2026-08-20" });
  const second = normalizeCommunityBoardMeeting({ source_record_id: "event-2", title: "Same title", event_date: "2026-08-20" });
  assert.notEqual(first.meeting_id, second.meeting_id);
  assert.deepEqual(first.institution_refs, { agency_ref: null, board_ref: null });
});

test("canonical route retains notice aliases and publisher provenance", () => {
  const cityRecord = normalizeCityRecordMeeting({ request_id: "20260814001", title: "Public hearing" });
  const board = normalizeCommunityBoardMeeting({
    source_record_id: "event-abc-123",
    title: "Board meeting",
    source_url: "https://example.test/meetings/event-abc-123",
  });
  assert.equal(meetingCanonicalHref(cityRecord), "/meetings/meeting%3Acity_record%3A20260814001");
  assert.deepEqual(meetingRouteLinks(cityRecord), {
    canonical_href: "/meetings/meeting%3Acity_record%3A20260814001",
    legacy_notice_href: "/notices/20260814001",
    legacy_fragment_href: "#notice/20260814001",
    publisher_href: "https://a856-cityrecord.nyc.gov/RequestDetail/20260814001",
  });
  assert.equal(resolveMeetingRoute("/notices/20260814001", [cityRecord]).meeting_id, cityRecord.meeting_id);
  assert.equal(resolveMeetingRoute("/#notice/20260814001", [cityRecord]).canonical_href, meetingCanonicalHref(cityRecord));
  assert.equal(resolveMeetingRoute(board.source_url, [board]).meeting_id, board.meeting_id);
  assert.equal(resolveMeetingRoute("/notices/20260814001", [board]), null);
});
