import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const readJson = (relativePath) => JSON.parse(
  readFileSync(new URL(relativePath, import.meta.url), "utf8"),
);

const receipt = readJson("../site/data/meetings_location_residual_receipt.json");
const meetings = readJson("../site/data/meetings_domain_observations.json");
const sharedMeetings = readJson("../site/data/shared_meeting_read_model.json");
const activity = readJson("../site/data/district_activity.json");
const sources = readJson("../site/data/meetings_location_residual_sources.json");

test("fixed Meetings residual is classified and remeasured without synthetic rows", () => {
  assert.equal(receipt.schema, "cityscroll.meetings_location_residual.v1");
  assert.deepEqual(receipt.baseline, {
    measured_on: "2026-08-04",
    total: 24,
    joined: 0,
    no_place_signal: 24,
  });
  assert.deepEqual(receipt.classification_counts, {
    body_place_omitted: 2,
    neighborhood_alias_missed: 1,
    venue_usable_weak_pin: 12,
    virtual_only: 0,
    external_board_page_needed: 9,
  });
  assert.equal(receipt.result.joined, 13);
  assert.equal(receipt.result.total, 24);
  assert.equal(receipt.result.honest_absent, 11);
  assert.deepEqual(receipt.result.joined_by_method, {
    neighborhood_place: 1,
    venue_line: 12,
  });
  assert.deepEqual(receipt.result.honest_absent_by_reason, {
    external_board_page_needed: 9,
    body_place_omitted: 2,
  });
  assert.equal(receipt.honesty_review.agency_headquarters_used, 0);
  assert.equal(receipt.honesty_review.synthetic_rows, 0);
  assert.equal(receipt.honesty_review.raw_notice_bodies_committed, false);
});

test("all incremental joins are evidence-labeled venue geography", () => {
  const joined = receipt.cases.filter((row) => row.status === "joined");
  assert.equal(joined.length, 13);
  assert.ok(joined.every((row) => row.role === "venue"));
  assert.ok(joined.every((row) => row.confidence >= 0.55 && row.confidence < 0.8));
  assert.ok(joined.every((row) => row.boroughs.length >= 1));
  assert.equal(joined.filter((row) => row.community_districts.includes("Q12")).length, 1);
  assert.equal(joined.some((row) => row.method === "agency_hq"), false);
});

test("partial non-Council registry remains an honest absence for generic board directories", () => {
  assert.equal(receipt.source_registry_review.bodies_inventoried, 64);
  assert.equal(receipt.source_registry_review.citywide_complete, false);
  assert.equal(receipt.source_registry_review.candidate_residual_rows, 9);
  assert.equal(receipt.source_registry_review.accepted_specific_body_matches, 0);
});

test("the fixed 11-row follow-up has terminal source-backed classifications", () => {
  assert.equal(sources.cases.length, 11);
  assert.equal(receipt.followup.baseline_total, 11);
  assert.deepEqual(receipt.followup.result, { virtual_only: 2, honest_residual: 9 });
  assert.ok(receipt.followup.cases.every((row) => row.source_locator.startsWith("https://")));
  assert.equal(receipt.followup.cases.filter((row) => row.terminal_classification === "multi_event_directory").length, 9);
  assert.equal(receipt.followup.cases.filter((row) => row.terminal_classification === "virtual_only").length, 2);
});

test("district activity retains residual accounting while adding ontology-placed board meetings", () => {
  assert.equal(meetings.row_count, 119);
  assert.equal(meetings.location_residual.fixed_rows, 24);
  assert.equal(activity.sources.meetings.corpus, "shared_meeting_read_model");
  assert.equal(activity.sources.meetings.counted, sharedMeetings.rows.length);
  assert.equal(activity.sources.meetings.located, 504);
  assert.equal(activity.sources.meetings.by_method.community_board_ontology, 411);
  assert.equal(sharedMeetings.counts.community_board, 411);
  assert.equal(activity.unlocated.meetings, 27);
  assert.equal(activity.virtual.meetings, 1);
  assert.deepEqual(activity.unlocated_reasons.meetings, {
    no_place_signal: 7,
    body_place_omitted: 9,
    multi_event_directory: 6,
    external_board_page_needed: 5,
  });
  // The virtual list is stated as a rule rather than as pinned request ids: a
  // generation retains a different window of notices, and what the accounting
  // claims is that every listed meeting is one the corpus itself calls virtual,
  // and that the list and the count are the same population.
  assert.equal(activity.district_items.virtual.meetings.length, activity.virtual.meetings);
  const virtualIds = new Set(activity.district_items.virtual.meetings);
  assert.ok(virtualIds.size === activity.district_items.virtual.meetings.length);
  for (const id of virtualIds) assert.match(id, /^\d{8,}$/);
});
