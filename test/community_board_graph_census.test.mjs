import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildCommunityBoardGraphCensus } from "../tools/build_community_board_graph_census.mjs";
import { readCommunityBoardMeetingIndex } from "../tools/lib/community_board_meeting_index_io.mjs";

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const registry = read("../site/data/non_council_outcome_sources/source_registry.json");
const inventory = read("../site/data/non_council_outcome_sources/board_source_inventory.json");
const committed = read("../site/data/non_council_outcome_sources/community_board_graph_census.json");
const meetingIndex = readCommunityBoardMeetingIndex(new URL("../site/data/community_board_meeting_index.json", import.meta.url));

test("the committed census covers all 59 boards and all Card 1 dimensions", () => {
  assert.equal(committed.schema, "cityscroll.community_board_graph_census.v1");
  assert.equal(committed.boards.length, 59);
  assert.equal(new Set(committed.boards.map((row) => row.board_id)).size, 59);
  assert.equal(committed.summary.board_dimension_slots, 59 * 11);
  assert.deepEqual(Object.keys(committed.dimension_summary), [
    "official_committee_directory",
    "committee_identity_in_calendar_or_source_data",
    "board_roster",
    "officers",
    "district_manager_staff",
    "bylaws",
    "upcoming_meetings",
    "minutes",
    "agendas",
    "recommendations_resolutions",
    "public_hearings",
  ]);
});

test("census is reproducible from the committed inventories and meeting index", () => {
  const rebuilt = buildCommunityBoardGraphCensus({ registry, inventory, meetingIndex });
  assert.deepEqual(rebuilt, committed);
});

test("census preserves explicit unknowns and does not register production CB objects", () => {
  assert.equal(committed.policy.no_production_inference_rules, true);
  assert.equal(committed.meeting_measurements.known_local_committee_registry.known_committee_count, 0);
  assert.equal(committed.meeting_measurements.records_whose_title_exactly_matches_known_local_committee, 0);
  assert.equal(committed.dimension_summary.official_committee_directory.counts["requires another official source"], 59);
  assert.equal(committed.dimension_summary.recommendations_resolutions.counts["requires another official source"], 59);
  for (const board of committed.boards) {
    assert.equal(board.dimensions.board_roster.status, "requires another official source");
    assert.equal(board.dimensions.officers.status, "requires another official source");
    assert.equal(board.dimensions.district_manager_staff.status, "requires another official source");
    assert.equal(board.dimensions.bylaws.status, "requires another official source");
  }
});

test("meeting measurements distinguish title signals from typed committee identity", () => {
  assert.deepEqual({
    record_count: committed.meeting_measurements.record_count,
    boards_with_records: committed.meeting_measurements.boards_with_records,
    records_explicitly_identifying_committee: committed.meeting_measurements.records_explicitly_identifying_committee,
    records_with_structured_committee_field: committed.meeting_measurements.records_with_structured_committee_field,
    records_whose_title_exactly_matches_known_local_committee: committed.meeting_measurements.records_whose_title_exactly_matches_known_local_committee,
    full_board_records: committed.meeting_measurements.full_board_records,
    explicit_public_hearing_records: committed.meeting_measurements.explicit_public_hearing_records,
    joint_committee_records: committed.meeting_measurements.joint_committee_records,
    records_without_typed_institution_host: committed.meeting_measurements.records_without_typed_institution_host,
    committee_records_with_unresolved_host_body: committed.meeting_measurements.committee_records_with_unresolved_host_body,
  }, {
    record_count: 395,
    boards_with_records: 24,
    records_explicitly_identifying_committee: 182,
    records_with_structured_committee_field: 10,
    records_whose_title_exactly_matches_known_local_committee: 0,
    full_board_records: 42,
    explicit_public_hearing_records: 10,
    joint_committee_records: 6,
    records_without_typed_institution_host: 395,
    committee_records_with_unresolved_host_body: 182,
  });
});

test("fixtures cover materially different source structures, including CB6", () => {
  const cb6 = read("./fixtures/community_board_graph_census/manhattan-cb-06.json");
  const bx10 = read("./fixtures/community_board_graph_census/bronx-cb-10.json");
  const qn07 = read("./fixtures/community_board_graph_census/queens-cb-07.json");
  assert.equal(cb6.board_id, "manhattan-cb-06");
  assert.equal(cb6.source_structure.upcoming_meetings.adapter, "google_calendar_v1");
  assert.equal(cb6.projection_collision.observed, true);
  assert.equal(cb6.expected_census_measurements.records_explicitly_identifying_committee, 73);
  assert.equal(bx10.source_structure.upcoming_meetings.adapter, "pdf_calendar_v1");
  assert.equal(bx10.expected_census_measurements.records_explicitly_identifying_committee, 0);
  assert.equal(qn07.source_structure.upcoming_meetings.adapter, "nyc_official_calendar_v1");
  assert.equal(qn07.expected_census_measurements.explicit_public_hearing_records, 1);
  assert.notEqual(cb6.source_structure.upcoming_meetings.adapter, bx10.source_structure.upcoming_meetings.adapter);
});
