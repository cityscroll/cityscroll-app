import assert from "node:assert/strict";
import test from "node:test";
import { buildDistrictTopicIndex } from "../site/district_topic_index.mjs";
import { buildLocalIssueResults, renderLocalIssueResults, LOCAL_ISSUE_RESULT_GROUPS } from "../site/local_issue_results.mjs";

const row = (source_family, id, districts = ["K15"], extra = {}) => ({
  source_family, id, districts, route: `/records/${id}`, source_reference: `${source_family}:${id}`,
  source_url: `https://example.test/${id}`, observed_through: "2026-09-01", title: "Shelter safety plans",
  ...extra,
});

function fixture() {
  return buildDistrictTopicIndex({
    community_board_meeting: [row("community_board_meeting", "meeting-1", ["K15"], { agenda: "Shelter safety public hearing" })],
    community_board_decision: [row("community_board_decision", "decision-3206", ["K15"], { decision_text: "Shelter safety decision", action_type: "decision" })],
    community_board_project: [row("community_board_project", "project-1", ["K15"], { project_description: "Shelter repair project" })],
    shared_procurement_read_model: [row("shared_procurement_read_model", "contract-3218", ["K15"], { short_title: "Shelter contract", search_text: "Shelter contract" })],
    community_board_request: [row("community_board_request", "request-1", ["K15"], { request: "Shelter priority" })],
    community_board_response: [row("community_board_response", "response-1", ["K15"], { response_text: "Shelter response" })],
    community_board_position: [row("community_board_position", "position-1", ["K15"], { position_text: "Shelter priority" })],
    document_excerpt: [row("document_excerpt", "doc-1", ["K15"], { accepted_excerpt: "Shelter supporting document" })],
  }, { district: "K15" });
}

test("A1/A2: groups all resident questions and carries separate match, locality, and source evidence", () => {
  const view = buildLocalIssueResults(fixture(), { query: "shelter", board: { label: "Brooklyn Community Board 15" } });
  assert.deepEqual(view.groups.map((group) => group.label), LOCAL_ISSUE_RESULT_GROUPS.map((group) => group.label));
  assert.deepEqual(view.groups.map((group) => group.total), [1, 1, 2, 3, 1]);
  const result = view.groups[0].results[0];
  assert.match(result.match.passage, /shelter/i);
  assert.equal(result.locality.district, "K15");
  assert.equal(result.relationship.board, "Brooklyn Community Board 15");
  assert.equal(result.evidence.source_reference, "community_board_meeting:meeting-1");
});

test("A3/A6: same words remain distinct typed identities and exact district membership filters results", () => {
  const index = buildDistrictTopicIndex({
    community_board_decision: [row("community_board_decision", "3206", ["K15"]), row("community_board_decision", "3218", ["K15"]), row("community_board_decision", "wrong-district", ["K03"])],
  }, { district: "K15" });
  const view = buildLocalIssueResults(index, { query: "shelter" });
  assert.deepEqual(view.groups.find((group) => group.id === "formal_board_actions").results.map((entry) => entry.object_id), ["3206", "3218"]);
  assert.ok(!JSON.stringify(view).includes("wrong-district"));
});

test("A4/A5: canonical issue drill-down is link-only, participation survives, and pagination is bounded", () => {
  const view = buildLocalIssueResults(fixture(), {
    query: "shelter", page_size: 1, page: 1, return_href: "/near-you/?cd=15&q=shelter",
    tracked_issue: { exists: true, label: "Open canonical issue pack", href: "/following/packs/emmons-shelter/" },
    participation_links: [{ label: "Attend the hearing", href: "/meetings/meeting-1" }],
  });
  const projects = view.groups.find((group) => group.id === "projects_procurements");
  assert.equal(projects.pagination.page_size, 1);
  assert.equal(projects.results.length, 1);
  assert.equal(projects.pagination.has_next, true);
  assert.equal(view.canonical_issue.href, "/following/packs/emmons-shelter/");
  assert.deepEqual(view.groups[0].results[0].participation, [{ label: "Attend the hearing", href: "/meetings/meeting-1" }]);
  const html = renderLocalIssueResults(view);
  assert.match(html, /Open canonical issue pack/);
  assert.match(html, /Return to results/);
  assert.doesNotMatch(html, /timeline|watch|alias/i);
});
