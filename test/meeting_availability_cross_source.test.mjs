import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCorpusShape,
  CROSS_SOURCE_PARITY_FIXTURE,
  CORPUS_ROWS,
  EXPECTED_EXCLUSION_COUNTS,
  PROJECTED_ROWS,
  crossSourceModel,
  expectedExcludedIdentities,
  fixtureIdentity,
} from "./helpers/meeting_availability_cross_source_corpus.mjs";

test("the retained corpus names every producer family and adversarial schedule state", () => {
  assertCorpusShape();
  const specs = CROSS_SOURCE_PARITY_FIXTURE.cases;
  assert.equal(new Set(specs.map((spec) => spec.id)).size, specs.length - 1, "the reschedule pair shares a delivery identity");
  assert.deepEqual(new Set(specs.filter((spec) => spec.expected === "accepted").map(fixtureIdentity)), new Set(
    CROSS_SOURCE_PARITY_FIXTURE.expected.accepted_identities,
  ));
  assert.deepEqual(Object.keys(CROSS_SOURCE_PARITY_FIXTURE.source_coverage).sort(), [
    "bsa_calendar", "city_record", "community_board", "pdc_calendar", "public_body_calendar",
  ]);
});

test("coverage states remain explicit and excluded source rows never enter the read model", () => {
  const model = crossSourceModel();
  assert.equal(model.sources.public_body_calendar.status, "partial");
  assert.deepEqual(model.sources.public_body_calendar.contract_coverage, {
    nycps_pep: "fresh",
    ccrb_board: "fresh",
    brooklyn_borough_board: "fresh",
    hplus_h_cab: "fresh",
    nycps_pep_stale: "stale",
    ccrb_board_failed: "failed",
  });
  assert.deepEqual(
    CORPUS_ROWS.filter((row) => ["stale", "failed"].includes(row.source_receipt.status)).map((row) => row.meeting_id).sort(),
    [
      "meeting:public_body_calendar:ccrb_board_failed:failed-ccrb-meeting",
      "meeting:public_body_calendar:nycps_pep_stale:stale-pep-meeting",
    ],
  );
  assert.equal(PROJECTED_ROWS.some((row) => row.meeting_id.includes("stale-pep-meeting")), false);
  assert.equal(PROJECTED_ROWS.some((row) => row.meeting_id.includes("failed-ccrb-meeting")), false);
  assert.deepEqual(Object.keys(EXPECTED_EXCLUSION_COUNTS).sort(), [
    "canceled", "conflicted", "excluded", "invalid_time", "matched", "outside_window", "total", "unknown_start",
  ]);
  assert.ok(expectedExcludedIdentities().includes("meeting:community_board:near-duplicate-cb11"));
});
