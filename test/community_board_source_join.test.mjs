import assert from "node:assert/strict";
import { test } from "node:test";

import {
  joinCommunityBoardSourceRecord,
  joinCommunityBoardSourceRecords,
  qualifyCommunityBoardNativeCalendarObservation,
  promoteCommunityBoardHostsMeetingEdge,
} from "../site/community_board_source_join.mjs";
import { buildCommunityBoardInstitutionEdges } from "../site/community_board_source_join.mjs";
import { readFileSync } from "node:fs";

const committeeRegistry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/community_board_committees.json", import.meta.url)));

const notice = {
  request_id: "20260814001",
  body_id: "bronx-cb-01",
  event_date: "2026-08-12",
  matter_tokens: ["C260001ZSM"],
};

const source = {
  schema: "cityscroll.community_board_source_record.v1",
  source_url: "https://board.example/minutes",
  board_id: "bronx-cb-01",
  body_id: "bronx-cb-01",
  body_evidence: { board_id: "bronx-cb-01", basis: "publisher_record" },
  record_kind: "document",
  record_id: "minutes-1",
  source_record_id: "minutes-1",
  document_id: "minutes-1",
  date: "2026-08-12",
  category: "minutes",
  title: "C260001ZSM full board minutes",
  format: "pdf",
  publisher_identifier: "C260001ZSM",
  publisher_matter_ids: ["C260001ZSM"],
  observed_receipt: { status: "ok", observed_at: "2026-08-14T12:00:00Z" },
};

test("official join requires exact board, date, and publisher identifier", () => {
  const joined = joinCommunityBoardSourceRecord(notice, source, { asOf: "2026-08-14T12:00:00Z" });
  assert.equal(joined.status, "official");
  assert.equal(joined.official, true);
  assert.equal(joined.join.method, "exact_board_date_publisher_identifier");
  assert.deepEqual(joined.join.evidence, ["exact_board_identity", "exact_date", "publisher_identifier"]);
  assert.equal(joined.provenance.observed_receipt.status, "ok");
});

test("address-only and title-only matches stay unknown", () => {
  for (const candidate of [
    { ...source, publisher_identifier: null, publisher_matter_ids: [], title: "C260001ZSM full board minutes" },
    { ...source, publisher_identifier: null, publisher_matter_ids: [], address: "1 Main Street", title: "Different title" },
  ]) {
    const result = joinCommunityBoardSourceRecord(notice, candidate, { asOf: "2026-08-14T12:00:00Z" });
    assert.equal(result.status, "unknown");
    assert.equal(result.official, false);
    assert.equal(result.join.matched, false);
  }
});

test("mismatched body/date/identifier, stale, and ambiguous sources never become official", () => {
  assert.equal(joinCommunityBoardSourceRecord({ ...notice, body_id: "brooklyn-cb-01" }, source, { asOf: "2026-08-14T12:00:00Z" }).reason, "board_identity_mismatch");
  assert.equal(joinCommunityBoardSourceRecord({ ...notice, event_date: "2026-08-13" }, source, { asOf: "2026-08-14T12:00:00Z" }).reason, "date_mismatch");
  assert.equal(joinCommunityBoardSourceRecord(notice, { ...source, publisher_identifier: "OTHER", publisher_matter_ids: ["OTHER"] }, { asOf: "2026-08-14T12:00:00Z" }).reason, "publisher_identifier_mismatch");
  assert.equal(joinCommunityBoardSourceRecord(notice, { ...source, observed_receipt: { status: "ok", observed_at: "2026-01-01T00:00:00Z" } }, { asOf: "2026-08-14T12:00:00Z", maxAgeDays: 30 }).reason, "source_stale");

  const ambiguous = joinCommunityBoardSourceRecords(notice, [source, { ...source, record_id: "minutes-2", source_record_id: "minutes-2" }], { asOf: "2026-08-14T12:00:00Z" });
  assert.equal(ambiguous.status, "unknown");
  assert.equal(ambiguous.reason, "ambiguous_source_records");
});

test("committee refinement reuses the exact source join and leaves the meeting key unchanged", () => {
  const boardMeeting = {
    source_system: "community_board",
    meeting_id: "meeting:community_board:cb6-transport::2026-08-12",
    board_id: "manhattan-cb-06",
    publisher_identifier: "cb6-transport",
    event_date: "2026-08-12",
    title: "Transportation Committee Meeting",
  };
  const boardRecord = {
    ...source,
    board_id: "manhattan-cb-06",
    body_id: "manhattan-cb-06",
    body_evidence: { board_id: "manhattan-cb-06", basis: "publisher_record" },
    source_record_id: "cb6-transport",
    record_id: "cb6-transport",
    publisher_identifier: "cb6-transport",
    date: "2026-08-12",
    title: "Transportation Committee Meeting",
  };
  const edges = buildCommunityBoardInstitutionEdges([{ meeting: boardMeeting, source_record: boardRecord }], {
    asOf: "2026-08-14T12:00:00Z",
    committeeRegistry,
  });
  assert.equal(edges[1].to, boardMeeting.meeting_id);
  assert.equal(edges[1].from, "community-board-committee:manhattan-cb-06:transportation");
  assert.equal(edges[1].join.method, "exact_board_date_publisher_identifier");
});

test("committee evidence cannot bypass a failed board source join", () => {
  const boardMeeting = {
    source_system: "community_board",
    meeting_id: "meeting:community_board:cb6-transport::2026-08-12",
    board_id: "manhattan-cb-06",
    publisher_identifier: "cb6-transport",
    event_date: "2026-08-12",
    title: "Transportation Committee Meeting",
  };
  const boardRecord = {
    ...source,
    board_id: "manhattan-cb-06",
    body_id: "manhattan-cb-06",
    body_evidence: { board_id: "manhattan-cb-06", basis: "publisher_record" },
    source_record_id: "cb6-transport",
    record_id: "cb6-transport",
    publisher_identifier: "cb6-transport",
    date: "2026-08-12",
    title: "Transportation Committee Meeting",
    observed_receipt: null,
  };
  const edges = buildCommunityBoardInstitutionEdges([{ meeting: boardMeeting, source_record: boardRecord }], {
    asOf: "2026-08-14T12:00:00Z",
    committeeRegistry,
  });
  assert.equal(edges.length, 1);
  assert.equal(edges[0].relation, "hosts_meeting");
  assert.equal(edges[0].from, "community-board:manhattan-cb-06");
  assert.equal(edges[0].status, "held");
  assert.equal(edges[0].href, null);
  assert.equal(edges[0].join.method, "exact_board_date_publisher_identifier");
});

test("official calendar observation publishes a native meeting without changing the held cross-source join", () => {
  const record = {
    source_system: "community_board",
    source_role: "upcoming_meetings",
    record_kind: "event",
    board_id: "brooklyn-cb-15",
    source_record_id: "nyc-calendar:brooklyn-cb-15:2026-09-29:general-board-meeting-in-person",
    record_id: "nyc-calendar:brooklyn-cb-15:2026-09-29:general-board-meeting-in-person",
    source_url: "https://www.nyc.gov/site/brooklyncb15/calendar/calendar.page",
    date: "2026-09-29",
    event_date: "2026-09-29",
    start_at: "2026-09-29T19:00:00-04:00",
    title: "General Board Meeting (In Person)",
    publisher_identifier: null,
    publisher_identifiers: [],
    observed_receipt: { status: "ok", observed_at: "2026-09-12T12:00:00Z" },
    source_entry_evidence: {
      locator: { type: "calendar_date_title", date: "2026-09-29", title: "General Board Meeting (In Person)" },
      excerpt: "Tuesday, September 29, 2026 General Board Meeting (In Person) 7:00pm Kingsborough Community College",
    },
  };
  const descriptor = {
    registered: true,
    board_id: "brooklyn-cb-15",
    source_role: "upcoming_meetings",
    adapter: "nyc_official_calendar_v1",
    url: record.source_url,
  };
  const qualification = qualifyCommunityBoardNativeCalendarObservation(record, descriptor, {
    asOf: "2026-09-12T20:00:00Z",
  });
  assert.equal(qualification.qualified, true);
  const edge = promoteCommunityBoardHostsMeetingEdge({ meeting: record, source_record: record }, {
    sourceDescriptor: descriptor,
    asOf: "2026-09-12T20:00:00Z",
  });
  assert.equal(edge.promoted, true);
  assert.equal(edge.publication_basis, "official_calendar_observation");
  assert.equal(edge.join.reason, "publisher_identifier_missing");
  assert.equal(edge.join.matched, false);
  assert.equal(edge.source_entry_evidence.excerpt.startsWith("Tuesday"), true);
  assert.equal(edge.provenance.source_entry_evidence.excerpt.startsWith("Tuesday"), true);
});

test("native calendar qualification rejects unregistered, stale, ambiguous, and evidence-poor observations", () => {
  const base = {
    source_role: "upcoming_meetings", record_kind: "event", board_id: "brooklyn-cb-15",
    record_id: "calendar-event", source_record_id: "calendar-event",
    source_url: "https://www.nyc.gov/site/brooklyncb15/calendar/calendar.page",
    date: "2026-09-29", event_date: "2026-09-29", start_at: "2026-09-29T19:00:00-04:00", title: "General Board Meeting",
    publisher_identifier: null, publisher_identifiers: [],
    observed_receipt: { status: "ok", observed_at: "2026-09-12T12:00:00Z" },
    source_entry_evidence: { locator: "p[1]", excerpt: "September 29, 2026 General Board Meeting 7:00pm" },
  };
  const descriptor = { registered: true, board_id: "brooklyn-cb-15", source_role: "upcoming_meetings", adapter: "nyc_official_calendar_v1", url: base.source_url };
  for (const [record, options, reason] of [
    [{ ...base }, { ...descriptor, registered: false }, "source_descriptor_unregistered"],
    [{ ...base, observed_receipt: { status: "ok", observed_at: "2026-01-01T00:00:00Z" } }, descriptor, "source_stale"],
    [{ ...base, ambiguous: true }, descriptor, "ambiguous_source_observation"],
    [{ ...base, source_entry_evidence: null }, descriptor, "retained_entry_evidence_missing"],
    [{ ...base, title: "September 2026" }, descriptor, "event_identity_incomplete"],
  ]) {
    assert.equal(qualifyCommunityBoardNativeCalendarObservation(record, options, { asOf: "2026-09-12T20:00:00Z" }).reason, reason);
  }
});
