import test from "node:test";
import assert from "node:assert/strict";
import {
  composeCommunityBoardActivity,
  paginateCommunityBoardActivity,
} from "../site/community_board_activity.mjs";

const source = (observedThrough = "2026-09-14") => ({
  source_url: "https://example.test/board-records",
  observed_through: observedThrough,
});

const meeting = (id, date = "2026-09-01") => ({
  relation: "hosts_meeting", meeting_id: id, meeting_date: date,
  canonical_href: `/meetings/${encodeURIComponent(id)}`,
  source_url: "https://example.test/calendar", source: source(),
});

function fixture(overrides = {}) {
  return {
    board_id: "brooklyn-cb-15",
    source: source(),
    institution_edges: [meeting("meeting:board:one"), meeting("meeting:board:one")],
    board_decisions: { decisions: [{ candidate_id: "decision-1", board_id: "brooklyn-cb-15", title: "Bike lane", position: "supports", document: { meeting_date: "2026-08-20", document_url: "https://example.test/minutes", observed_on: "2026-09-14" } }] },
    land_positions: { positions: [{ project_id: "ulurp-1", position: "supports", recorded_on: "2026-08-10", source_url: "https://example.test/land" }] },
    budget_requests: { groups: [{ requests: [{ tracking_code: "123456789C", request_date: "2026-07-01", source_url: "https://example.test/budget", observed_through: "2026-09-14" }] }] },
    source_records: [{ role: "minutes", source_url: "https://example.test/minutes", observed_on: "2026-09-14", published_date: "2026-08-20" }],
    ...overrides,
  };
}

test("A1/A2: composes typed accepted records with identity, dates, routes and provenance", () => {
  const view = composeCommunityBoardActivity(fixture());
  assert.deepEqual(view.entries.map((row) => row.action_type), ["meeting", "decision", "document_publication", "land_position", "budget_request"]);
  for (const entry of view.entries) {
    assert.ok(entry.board_id && entry.effective_date && entry.canonical_href && entry.source_url && entry.observed_through);
  }
});

test("A3/A4/A6: co-location, requests and people do not become board action", () => {
  const view = composeCommunityBoardActivity(fixture({
    district_projects: [{ project_id: "ulurp-1", title: "Bike lane", address: "Bike lane" }],
    board_decisions: { decisions: [{ candidate_id: "held", board_id: "brooklyn-cb-15", title: "Bike lane", document: null }] },
    person_actions: [{ title: "Board chair supports Bike lane", date: "2026-08-20" }],
  }));
  assert.equal(view.entries.some((row) => row.action_type === "district_project"), false);
  assert.equal(view.entries.some((row) => row.action_type === "person_action"), false);
  assert.equal(view.entries.some((row) => row.action_type === "decision"), false);
  assert.equal(view.entries.some((row) => row.action_type === "budget_request"), true);
});

test("A5: dense, sparse and no-action inputs are deterministic, deduplicated and bounded", () => {
  const dense = composeCommunityBoardActivity(fixture({ activity_limit: 3 }));
  assert.equal(dense.entries.length, 3);
  assert.equal(dense.total_count, 5);
  assert.deepEqual(dense.entries, composeCommunityBoardActivity(fixture({ activity_limit: 3 })).entries);
  assert.deepEqual(paginateCommunityBoardActivity(dense, 2, 1).entries.map((row) => row.action_type), ["decision"]);
  const empty = composeCommunityBoardActivity(fixture({ institution_edges: [], board_decisions: null, land_positions: null, budget_requests: null, source_records: [] }));
  assert.deepEqual(empty.entries, []);
  assert.equal(empty.coverage.state, "no_action_recorded");
});
