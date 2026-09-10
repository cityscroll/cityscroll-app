import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  resolveKeywordQuery,
  searchKeywordDocuments,
} from "../site/keyword_matcher.mjs";
import {
  buildMeetingSearchDocuments,
  materializeMeetingSearchDocument,
} from "../site/meeting_search_producer.mjs";
import { meetingCanonicalHref } from "../site/meeting_object_contract.mjs";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import {
  buildUpcomingCouncilMeetingsView,
  upcomingCouncilMeetingsIndex,
} from "../worker/src/lib/upcoming_council_meetings.mjs";

const NOW = "2026-08-14T12:00:00Z";

function cityMeeting(overrides = {}) {
  return {
    request_id: "20260814001",
    title: "Public hearing on a local matter",
    event_date: "2026-08-20T10:00:00.000",
    description: "Published City Record hearing details.",
    source_system: "city_record",
    ...overrides,
  };
}

function boardMeeting(overrides = {}) {
  return {
    board_id: "brooklyn-cb-06",
    source_record_id: "event-abc-123",
    title: "Public hearing on a local matter",
    event_date: "2026-08-20T10:00:00.000",
    description: "Published community-board meeting details.",
    source_url: "https://example.test/meetings/event-abc-123",
    source_receipt: { status: "ok", observed_at: NOW },
    source_system: "community_board",
    ...overrides,
  };
}

function readModel({ cityRecordRows = [], boardRows = [], boardGeneratedAt = NOW } = {}) {
  return buildSharedMeetingReadModel({
    cityRecordRows,
    communityBoardIndex: boardRows === null ? null : {
      generated_at: boardGeneratedAt,
      coverage: { boards_in_inventory: 59, records_indexed: boardRows.length },
      rows: boardRows,
    },
    generatedAt: NOW,
    now: NOW,
  });
}

test("both meeting sources produce the same canonical SearchDocument shape", () => {
  const projected = buildMeetingSearchDocuments(readModel({
    cityRecordRows: [cityMeeting()],
    boardRows: [boardMeeting()],
  }));

  assert.equal(projected.documents.length, 2);
  const city = projected.documents.find((row) => row.provenance.source_system === "city_record");
  const board = projected.documents.find((row) => row.provenance.source_system === "community_board");
  assert.deepEqual(Object.keys(city), Object.keys(board));

  assert.deepEqual(city.source_observation_refs, ["city_record:20260814001"]);
  assert.deepEqual(board.source_observation_refs, ["community_board:event-abc-123"]);
  assert.deepEqual(city.provenance.source_keys, [{
    source_system: "city_record",
    key_type: "request_id",
    value: "20260814001",
  }]);
  assert.deepEqual(board.provenance.source_keys, [{
    source_system: "community_board",
    key_type: "publisher_event_id",
    value: "event-abc-123",
  }]);
  assert.equal(city.provenance.source_receipt.status, "ok");
  assert.equal(board.provenance.source_receipt.status, "ok");
  assert.equal(city.canonical_href, "/meetings/meeting%3Acity_record%3A20260814001");
  assert.equal(board.canonical_href, "/meetings/meeting%3Acommunity_board%3Aevent-abc-123");
});

test("title and date similarity never merge distinct source-qualified meetings", () => {
  const model = readModel({
    cityRecordRows: [cityMeeting()],
    boardRows: [boardMeeting()],
  });
  const projected = buildMeetingSearchDocuments(model);
  assert.deepEqual(new Set(projected.documents.map((row) => row.object_ref)), new Set([
    "meeting:city_record:20260814001",
    "meeting:community_board:event-abc-123",
  ]));

  const duplicate = model.rows[0];
  const exactOnly = buildMeetingSearchDocuments({
    ...model,
    rows: [duplicate, duplicate, model.rows[1]],
  });
  assert.equal(exactOnly.documents.filter((row) => row.object_ref === duplicate.meeting_id).length, 1);
  assert.equal(exactOnly.counts.exact_duplicates, 1);
});

test("missing and stale board input changes coverage without changing City Record results", () => {
  const missing = buildMeetingSearchDocuments(readModel({
    cityRecordRows: [cityMeeting()],
    boardRows: null,
  }));
  const stale = buildMeetingSearchDocuments(readModel({
    cityRecordRows: [cityMeeting()],
    boardRows: [boardMeeting()],
    boardGeneratedAt: "2026-08-01T12:00:00Z",
  }));

  assert.equal(missing.coverage.community_board.status, "unavailable");
  assert.equal(stale.coverage.community_board.status, "stale");
  assert.equal(stale.coverage.community_board.source_coverage.boards_in_inventory, 59);
  assert.equal(missing.coverage.city_record.indexed_count, 1);
  assert.equal(stale.coverage.city_record.indexed_count, 1);
  assert.equal(missing.documents.filter((row) => row.provenance.source_system === "city_record").length, 1);
  assert.equal(stale.documents.filter((row) => row.provenance.source_system === "city_record").length, 1);
});

test("process roles come only from registered meeting profiles", () => {
  const rulemakingModel = readModel({
    cityRecordRows: [cityMeeting({ meeting_family: "agency_rulemaking_hearing" })],
    boardRows: [boardMeeting()],
  });
  const documents = rulemakingModel.rows.map(materializeMeetingSearchDocument);
  const city = documents.find((row) => row.provenance.source_system === "city_record");
  const board = documents.find((row) => row.provenance.source_system === "community_board");

  assert.equal(board.process_role, null);
  assert.equal(board.provenance.process_profile.expectation_mode, "descriptive");
  assert.equal(city.process_role, "rulemaking_hearing");
  assert.equal(city.provenance.process_profile.expectation_mode, "normative");
});

test("rows without an exact canonical meeting identity are not indexed", () => {
  assert.equal(materializeMeetingSearchDocument({
    source_system: "community_board",
    title: "Title and date are not identity",
    event_date: "2026-08-20",
  }), null);
});

const PINNED_NOW = "2026-09-09T12:00:00.000Z";
const upcomingFixture = JSON.parse(
  readFileSync(new URL("./fixtures/legistar/upcoming_contracts_22691.json", import.meta.url), "utf8"),
);
const UPCOMING_EVENT_ID = String(upcomingFixture.event.EventId);
const UPCOMING_MEETING_ID = `meeting:nyc_legistar_events:${UPCOMING_EVENT_ID}`;

function councilNativeReadModel() {
  const { view } = buildUpcomingCouncilMeetingsView({
    eventRows: [upcomingFixture.event],
    itemsByEventId: new Map([[UPCOMING_EVENT_ID, { rows: upcomingFixture.event_items, fetchError: null }]]),
    now: new Date(PINNED_NOW),
  });
  view.meetings[0].insite_calendar = upcomingFixture.insite_calendar;
  return buildSharedMeetingReadModel({
    cityRecordRows: [],
    communityBoardIndex: { generated_at: PINNED_NOW, rows: [] },
    nycLegistarEventsIndex: upcomingCouncilMeetingsIndex(view),
    generatedAt: PINNED_NOW,
    now: PINNED_NOW,
  });
}

test("Council calendar hearings project the same SearchDocument shape as other meeting sources", () => {
  const projected = buildMeetingSearchDocuments(councilNativeReadModel());
  assert.equal(projected.documents.length, 1);
  const document = projected.documents[0];
  assert.equal(document.object_ref, UPCOMING_MEETING_ID);
  assert.equal(document.canonical_href, meetingCanonicalHref(UPCOMING_MEETING_ID));
  assert.equal(document.provenance.source_system, "nyc_legistar_events");
  assert.deepEqual(document.source_observation_refs, [`nyc_legistar_events:${UPCOMING_EVENT_ID}`]);
  assert.equal(projected.counts.nyc_legistar_events, 1);
  assert.equal(projected.coverage.nyc_legistar_events.status, "available");
});

test("publisher-supplied Council calendar text is searchable without a City Record notice", () => {
  const documents = buildMeetingSearchDocuments(councilNativeReadModel()).documents;
  for (const query of ["M/WBE utilization", "disparity study", "Committee on Contracts"]) {
    const hits = searchKeywordDocuments(documents, resolveKeywordQuery(query), { limit: 5 });
    assert.equal(hits.length, 1, query);
    assert.equal(hits[0].object_ref, UPCOMING_MEETING_ID, query);
    assert.ok(hits[0].match_evidence?.snippet?.text, query);
  }
});
