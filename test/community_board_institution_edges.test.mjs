import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import { buildBrowseView, renderBrowseView } from "../site/browse_view.mjs";
import {
  joinCommunityBoardSourceRecord,
  joinCommunityBoardSourceRecords,
  buildCommunityBoardInstitutionEdges,
  promoteCommunityBoardHostsMeetingEdge,
} from "../site/community_board_institution_edges.mjs";
import { normalizeEntityPivot } from "../site/edge_summary.mjs";
import { readFileSync } from "node:fs";

const committeeRegistry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/community_board_committees.json", import.meta.url)));

const meeting = {
  request_id: "20260814001",
  meeting_id: "meeting:city_record:20260814001",
  source_system: "city_record",
  body_id: "bronx-cb-01",
  event_date: "2026-08-12",
  short_title: "Public hearing on a neighborhood matter",
  matter_tokens: ["C260001ZSM"],
};

const source = {
  board_id: "bronx-cb-01",
  body_id: "bronx-cb-01",
  source_url: "https://board.example/calendar",
  source_record_id: "event-2026-08-12-1",
  record_id: "event-2026-08-12-1",
  date: "2026-08-12",
  publisher_identifier: "C260001ZSM",
  title: "Public hearing on a neighborhood matter",
  observed_receipt: { status: "ok", observed_at: "2026-08-14T12:00:00Z" },
};

function acceptedEdge() {
  const join = joinCommunityBoardSourceRecord(meeting, source);
  return promoteCommunityBoardHostsMeetingEdge({ meeting, source_record: source, join });
}

test("exact board/date/publisher join promotes a typed edge to the canonical meeting", () => {
  const edge = acceptedEdge();
  assert.equal(edge.status, "promoted");
  assert.equal(edge.from, "community-board:bronx-cb-01");
  assert.equal(edge.to, "meeting:city_record:20260814001");
  assert.equal(edge.target_kind, "meeting");
  assert.equal(edge.href, "/meetings/meeting%3Acity_record%3A20260814001");
  assert.equal(edge.board_href, "/community-boards/bronx-cb-01/");
  assert.equal(normalizeEntityPivot(edge).status, "accepted");
});

test("held, ambiguous, missing-receipt, and wrong-board evidence never gets an href", () => {
  const cases = [
    joinCommunityBoardSourceRecord(meeting, { ...source, publisher_identifier: null }),
    joinCommunityBoardSourceRecords(meeting, [source, { ...source, source_record_id: "event-2", record_id: "event-2" }]),
    joinCommunityBoardSourceRecord(meeting, { ...source, observed_receipt: null }),
    joinCommunityBoardSourceRecord(meeting, { ...source, board_id: "brooklyn-cb-01", body_id: "brooklyn-cb-01" }),
  ];
  for (const join of cases) {
    const edge = promoteCommunityBoardHostsMeetingEdge({ meeting, source_record: source, join });
    assert.equal(edge.status, "held", join.reason);
    assert.equal(edge.href, null, join.reason);
    assert.equal(normalizeEntityPivot(edge).canonical_href, null, join.reason);
  }
});

test("accepted identity is shared by Browse and the board institution page", () => {
  const edge = acceptedEdge();
  const row = {
    ...meeting,
    title: meeting.short_title,
    meeting_origin: "city_record_notice",
    entity_refs_all: ["community-board:bronx-cb-01", meeting.meeting_id],
    institution_edge: edge,
  };
  const browse = renderBrowseView(buildBrowseView("meetings", {
    generated_at: "2026-08-14T12:00:00Z",
    rows: [row],
  }));
  assert.match(browse, /hosted by community board/);
  assert.match(browse, /\/community-boards\/bronx-cb-01\//);
  assert.match(browse, /\/meetings\/meeting%3Acity_record%3A20260814001/);

  const view = buildCommunityBoardConstellationView("bronx-cb-01", {
    sourceRegistry: { sources: [{ body_id: "bronx-cb-01", body_type: "community_board", name: "Bronx Community Board 1", borough: "Bronx" }] },
    sourceInventory: { boards: [] },
    scorecard: { rows: [] },
    geography: { nodes: [], public_edges: [] },
    institutionEdges: { "bronx-cb-01": [edge] },
  });
  const meetings = view.categories.find((category) => category.id === "meetings");
  assert.equal(meetings.status, "matched");
  assert.equal(meetings.count, 1);
  assert.equal(meetings.items[0].href, edge.href);
  assert.match(renderCommunityBoardConstellationDocument(view), /\/meetings\/meeting%3Acity_record%3A20260814001/);
});

test("a reviewed committee inserts has_committee before the unchanged meeting identity", () => {
  const sourceRecord = {
    ...source,
    board_id: "manhattan-cb-06",
    body_id: "manhattan-cb-06",
    date: "2026-08-12",
    title: "Transportation Committee Meeting",
    publisher_identifier: "cb6-event-1",
    source_record_id: "cb6-event-1",
    body_evidence: { board_id: "manhattan-cb-06", basis: "publisher_record" },
  };
  const meeting = {
    source_system: "community_board",
    meeting_id: "meeting:community_board:cb6-event-1",
    board_id: "manhattan-cb-06",
    publisher_identifier: "cb6-event-1",
    event_date: "2026-08-12",
    title: "Transportation Committee Meeting",
  };
  const edges = buildCommunityBoardInstitutionEdges([
    { meeting, source_record: sourceRecord },
  ], { committeeRegistry, asOf: "2026-08-14T12:00:00Z" });
  assert.deepEqual(edges.map((edge) => [edge.relation, edge.from, edge.to]), [
    ["has_committee", "community-board:manhattan-cb-06", "community-board-committee:manhattan-cb-06:transportation"],
    ["hosts_meeting", "community-board-committee:manhattan-cb-06:transportation", "meeting:community_board:cb6-event-1"],
  ]);
  assert.equal(edges[1].parent_board_ref, "community-board:manhattan-cb-06");
  assert.deepEqual(edges[1].institution_refs, {
    board_ref: "community-board:manhattan-cb-06",
    committee_ref: "community-board-committee:manhattan-cb-06:transportation",
  });
});

test("full-board and unresolved joint meetings retain the board host without a synthetic committee", () => {
  const base = {
    meeting: {
      source_system: "community_board",
      meeting_id: "meeting:community_board:cb6-full",
      board_id: "manhattan-cb-06",
      publisher_identifier: "cb6-full",
      event_date: "2026-08-12",
      title: "Full Board Meeting",
    },
    source_record: {
      ...source,
      board_id: "manhattan-cb-06",
      body_id: "manhattan-cb-06",
      body_evidence: { board_id: "manhattan-cb-06", basis: "publisher_record" },
      title: "Full Board Meeting",
      date: "2026-08-12",
      publisher_identifier: "cb6-full",
      source_record_id: "cb6-full",
    },
  };
  const full = buildCommunityBoardInstitutionEdges([base], { committeeRegistry, asOf: "2026-08-14T12:00:00Z" });
  assert.equal(full[0].from, "community-board:manhattan-cb-06");
  assert.equal(full.length, 1);
  const joint = buildCommunityBoardInstitutionEdges([{
    ...base,
    source_record: { ...base.source_record, title: "Transportation & Housing Committees", publisher_identifier: "cb6-joint", source_record_id: "cb6-joint" },
  }], { committeeRegistry, asOf: "2026-08-14T12:00:00Z" });
  assert.equal(joint.length, 1);
  assert.equal(joint[0].from, "community-board:manhattan-cb-06");
});
