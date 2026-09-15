import assert from "node:assert/strict";
import test from "node:test";
import { buildDistrictTopicIndex, searchDistrictTopics } from "../site/district_topic_index.mjs";
import { todayISO, withPinnedClock } from "./helpers/test_clock.mjs";

const base = (family, id, observedThrough, extra = {}) => ({ source_family: family, id, route: `/records/${id}`, source_reference: `${family}:${id}`, source_url: `https://example.test/${id}`, observed_through: observedThrough, districts: ["K15"], ...extra });

test("A1: indexes every named retained topic family", async () => withPinnedClock("2026-09-01T00:00:00.000Z", () => {
  const observedThrough = todayISO();
  const index = buildDistrictTopicIndex({
    district_activity: [base("district_activity", "a1", observedThrough, { title: "Traffic safety study" })],
    community_board_request: [base("community_board_request", "r1", observedThrough, { request: "Shelter capacity near the avenue" })],
    community_board_response: [base("community_board_response", "r2", observedThrough, { response_text: "Agency response on sanitation" })],
    community_board_project: [base("community_board_project", "p1", observedThrough, { project_description: "Tree pruning project" })],
    community_board_position: [base("community_board_position", "pos1", observedThrough, { position_text: "Safety position" })],
    community_board_decision: [base("community_board_decision", "d1", observedThrough, { decision_text: "Shelter decision" })],
    community_board_meeting: [base("community_board_meeting", "m1", observedThrough, { agenda: "Sanitation meeting" })],
    document_excerpt: [base("document_excerpt", "doc1", observedThrough, { accepted_excerpt: "Tree pruning excerpt" })],
    shared_procurement_read_model: [base("shared_procurement_read_model", "proc1", observedThrough, { short_title: "Shelter contract", search_text: "Shelter contract" })],
  }, { district: "K15" });
  assert.deepEqual(index.entries.map((entry) => entry.source_family), ["district_activity", "community_board_request", "community_board_response", "community_board_project", "community_board_position", "community_board_decision", "community_board_meeting", "document_excerpt", "shared_procurement_read_model"]);
  assert.equal(searchDistrictTopics(index, "shelter")[0].object_id, "r1");
}));

test("A2: every entry retains the complete canonical evidence field set", async () => withPinnedClock("2026-09-01T00:00:00.000Z", () => {
  const observedThrough = todayISO();
  const index = buildDistrictTopicIndex({ district_activity: [base("district_activity", "a1", observedThrough, { title: "Traffic safety" })], community_board_meeting: [base("community_board_meeting", "m1", observedThrough, { agenda: "Traffic meeting" })] }, { district: "K15" });
  for (const entry of index.entries) {
    assert.ok(entry.canonical_type && entry.object_id && entry.route);
    assert.equal(entry.relationship.district, "k15");
    assert.ok(entry.source.reference && entry.source.url && entry.observed_through);
  }
}));

test("A3: identical text in one district remains two typed identities", async () => withPinnedClock("2026-09-01T00:00:00.000Z", () => {
  const observedThrough = todayISO();
  const index = buildDistrictTopicIndex({
    community_board_decision: [base("community_board_decision", "same-words-a", observedThrough, { title: "Bike lane decision", board_id: "manhattan-cb-03" }), base("community_board_decision", "same-words-b", observedThrough, { title: "Bike lane decision", board_id: "manhattan-cb-04" }), base("community_board_decision", "other-district", observedThrough, { title: "Bike lane decision", districts: ["K03"] })],
  }, { district: "K15" });
  assert.deepEqual(searchDistrictTopics(index, "bike lane").map((row) => row.object_id), ["same-words-a", "same-words-b"]);
}));

test("A4: procurement retains the source search document and canonical facts", async () => withPinnedClock("2026-09-01T00:00:00.000Z", () => {
  const procurement = base("shared_procurement_read_model", "proc-1", todayISO(), { object_type: "procurement", route: "/procurements/proc-1", short_title: "Shelter repairs", search_text: "Shelter repairs", coverage_state: "stale", contract_amount: 42, canonical_id: "procurement:proc-1", detail_route: "/procurements/proc-1", aliases: ["shelter repairs"] });
  const index = buildDistrictTopicIndex({ shared_procurement_read_model: [procurement] }, { district: "K15" });
  assert.equal(index.entries[0].procurement_document.contract_amount, 42);
  assert.equal(index.entries[0].object_id, "proc-1");
  assert.equal(index.entries[0].route, "/procurements/proc-1");
  assert.strictEqual(index.entries[0].procurement_document, procurement);
  assert.equal(index.coverage.by_source_family.shared_procurement_read_model.stale, 1);
}));

test("A5: frozen K15 and all-district queries recall three source families", async () => withPinnedClock("2026-09-01T00:00:00.000Z", () => {
  const row = (family, id, district) => base(family, id, todayISO(), { districts: [district], title: "Shelter safety", request: "Shelter safety", response_text: "Shelter safety", project_description: "Shelter safety" });
  const input = { district_activity: [row("district_activity", "a", "K15")], community_board_request: [row("community_board_request", "r", "K15")], community_board_project: [row("community_board_project", "p", "K03")] };
  assert.equal(new Set(searchDistrictTopics(buildDistrictTopicIndex(input, { district: "K15" }), "shelter safety").map((entry) => entry.source_family)).size, 2);
  assert.equal(new Set(searchDistrictTopics(buildDistrictTopicIndex(input, { district: "all" }), "shelter safety").map((entry) => entry.source_family)).size, 3);
}));

test("A6: coverage counts all five states without converting missingness to zero", async () => withPinnedClock("2026-09-01T00:00:00.000Z", () => {
  const observedThrough = todayISO();
  const procurement = base("shared_procurement_read_model", "proc-1", observedThrough, { short_title: "Shelter repairs", search_text: "Shelter repairs", coverage_state: "stale", contract_amount: 42 });
  const index = buildDistrictTopicIndex({ shared_procurement_read_model: [procurement, { ...procurement, id: "proc-2", coverage_state: "withheld" }, { ...procurement, id: "proc-3", coverage_state: "unavailable" }, { ...procurement, id: "proc-4", districts: [], coverage_state: "unlocated" }, { ...procurement, id: "proc-5", coverage_state: "indexed" }] }, { district: "K15" });
  const coverage = index.coverage.by_source_family.shared_procurement_read_model;
  assert.deepEqual(coverage, { indexed: 1, withheld: 1, stale: 1, unavailable: 1, unlocated: 1 });
}));
