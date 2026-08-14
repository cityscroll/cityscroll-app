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
  promoteCommunityBoardHostsMeetingEdge,
} from "../site/community_board_institution_edges.mjs";
import { normalizeEntityPivot } from "../site/edge_summary.mjs";

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
