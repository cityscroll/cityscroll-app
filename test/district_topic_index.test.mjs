import assert from "node:assert/strict";
import test from "node:test";
import { buildDistrictTopicIndex, searchDistrictTopics } from "../site/district_topic_index.mjs";

const base = (family, id, extra = {}) => ({ source_family: family, id, route: `/records/${id}`, source_reference: `${family}:${id}`, source_url: `https://example.test/${id}`, observed_through: "2026-09-01", districts: ["K15"], ...extra });

test("indexes retained topic fields as typed, source-backed district entries", () => {
  const index = buildDistrictTopicIndex({
    district_activity: [base("district_activity", "a1", { title: "Traffic safety study" })],
    community_board_request: [base("community_board_request", "r1", { request: "Shelter capacity near the avenue" })],
    community_board_response: [base("community_board_response", "r2", { response_text: "Agency response on sanitation" })],
    community_board_project: [base("community_board_project", "p1", { project_description: "Tree pruning project" })],
  }, { district: "K15" });
  assert.equal(index.entries.length, 4);
  assert.deepEqual(index.entries.map((entry) => entry.source_family), ["district_activity", "community_board_request", "community_board_response", "community_board_project"]);
  assert.equal(index.entries[1].relationship.district, "k15");
  assert.equal(index.entries[1].observed_through, "2026-09-01");
  assert.equal(searchDistrictTopics(index, "shelter")[0].object_id, "r1");
});

test("requires exact district membership and preserves distinct identities", () => {
  const index = buildDistrictTopicIndex({
    community_board_decision: [base("community_board_decision", "same-words-a", { title: "Bike lane decision", board_id: "manhattan-cb-03" }), base("community_board_decision", "same-words-b", { title: "Bike lane decision", board_id: "brooklyn-cb-03", districts: ["K03"] })],
  }, { district: "K15" });
  assert.deepEqual(searchDistrictTopics(index, "bike lane").map((row) => row.object_id), ["same-words-a"]);
  assert.equal(index.entries[0].object_id, "same-words-a");
});

test("reports missingness as coverage states and leaves procurement facts intact", () => {
  const procurement = base("shared_procurement_read_model", "proc-1", { short_title: "Shelter repairs", search_text: "Shelter repairs", coverage_state: "stale", contract_amount: 42 });
  const index = buildDistrictTopicIndex({ shared_procurement_read_model: [procurement, { ...procurement, id: "proc-2", districts: [], coverage_state: "unavailable" }] }, { district: "K15" });
  assert.equal(index.entries[0].procurement_document.contract_amount, 42);
  assert.equal(index.coverage.by_source_family.shared_procurement_read_model.stale, 1);
  assert.equal(index.coverage.by_source_family.shared_procurement_read_model.unlocated, 1);
});
