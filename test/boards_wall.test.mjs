import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildBoardsWallReceipt,
  extractCommunityBoardReference,
  extractCommunityBoardReferences,
  measureCommunityBoardExtraction,
  validateMayoralBoardRegistry,
} from "../entity_resolution/candidate_generation/boards_wall.mjs";

const extractionFixture = JSON.parse(readFileSync(
  new URL("./fixtures/boards/community_board_extraction.json", import.meta.url),
  "utf8",
));
const mayoralRegistry = JSON.parse(readFileSync(
  new URL("../entity_resolution/review/mayoral_board_registry.json", import.meta.url),
  "utf8",
));

test("community-board extraction accepts only an unambiguous borough + number", () => {
  assert.equal(extractCommunityBoardReference("Community Board 1, Brooklyn")?.body_id, "brooklyn-cb-01");
  assert.equal(extractCommunityBoardReference("Manhattan Community Board No. 3")?.body_id, "manhattan-cb-03");
  assert.equal(extractCommunityBoardReference("Community Board 99, Brooklyn"), null);
  assert.equal(extractCommunityBoardReference("Community District 1, Brooklyn"), null);
  assert.equal(extractCommunityBoardReference("Community Board 1, Brooklyn and Community Board 2, Queens"), null);
  assert.equal(extractCommunityBoardReferences("Community Board 1, Brooklyn and Community Board 2, Queens").length, 2);
});

test("community-board fixture clears the zero-false-positive precision bar", () => {
  const measured = measureCommunityBoardExtraction(extractionFixture);
  assert.equal(measured.positive_cases, 8);
  assert.equal(measured.negative_cases, 8);
  assert.equal(measured.true_positives, 8);
  assert.equal(measured.false_negatives, 0);
  assert.equal(measured.false_positives, 0);
  assert.equal(measured.precision, 1);
  assert.equal(measured.recall, 1);
  assert.equal(measured.fixture_proven_precision, true);
});

test("mayoral registry requires reviewed entries and keeps operative links off", () => {
  const result = validateMayoralBoardRegistry(mayoralRegistry);
  assert.equal(result.valid, true);
  assert.equal(mayoralRegistry.entries.length, 11);
  assert.ok(mayoralRegistry.entries.every((entry) => entry.operative === false));
  assert.ok(mayoralRegistry.entries.every((entry) => entry.review_status === "reviewed"));
  assert.ok(mayoralRegistry.entries.every((entry) => entry.canonical_ref.startsWith("agency:id:")));
  const pending = { ...mayoralRegistry, entries: [{ ...mayoralRegistry.entries[0], review_status: "pending", reviewer: null, reviewed_date: null }] };
  assert.equal(validateMayoralBoardRegistry(pending).valid, false);
});

test("receipt keeps three populations separate and reports honest coverage blocks", () => {
  const receipt = buildBoardsWallReceipt({
    observedOn: "2026-08-06",
    legistarBodies: [{ BodyId: 7, BodyName: "Committee on Land Use" }],
    legistarMode: "fixture",
    legistarCoverage: { modern_notices_strict: { joined: 59, total: 59, rate: 1 } },
    communityInventory: { inventoried: 59, by_borough: { Bronx: 12, Brooklyn: 18, Manhattan: 12, Queens: 14, "Staten Island": 3 } },
    communityExtraction: measureCommunityBoardExtraction(extractionFixture),
    mayoralRegistry,
  });
  assert.deepEqual(Object.keys(receipt.strata), ["council_adjacent", "community_boards", "mayoral_commissions"]);
  assert.equal(receipt.strata.council_adjacent.identity, "publisher_body_id");
  assert.equal(receipt.strata.community_boards.inventory.rate, 1);
  assert.equal(receipt.strata.community_boards.extraction.precision, 1);
  assert.equal(receipt.strata.mayoral_commissions.publisher_identifiers_observed, 0);
  assert.equal(receipt.contract.operative_links_enabled, false);
  assert.equal(receipt.detectors.fail_closed_on_new_population, true);
  assert.deepEqual(receipt.detectors.unknown_source_body_types, []);
});
