import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildMinutesEvidence,
  buildTitleCodeCatalog,
  buildTitleCodeContext,
  emptyReviewedRegistry,
  generateMinutesCandidates,
  generateTitleCodeCandidates,
  measurePotentialLift,
  scoreTitleCodePair,
} from "../entity_resolution/candidate_generation/published_walls.mjs";

const fixture = JSON.parse(readFileSync(new URL("../warehouse/fixtures/non_council_outcomes.json", import.meta.url), "utf8"));

test("title-code candidates carry every feature receipt and remain non-operative", () => {
  const catalog = buildTitleCodeCatalog([
    { title_code: "100", official_title: "Assistant Architect", base_min: 50000, base_max: 90000 },
    { title_code: "200", official_title: "Police Officer", base_min: 50000, base_max: 90000 },
  ]);
  const context = buildTitleCodeContext({
    historyRecords: [{ title_code: "100", application_start: "2024-01-01", application_close: "2024-01-20" }],
  });
  const pair = scoreTitleCodePair({ exam_number: "1", exam_title: "Assistant Architect", application_start: "2024-01-05" }, catalog[0], context);
  assert.equal(pair.candidate_status, "candidate");
  assert.equal(pair.operative_link_authorized, false);
  assert.deepEqual(pair.evidence.map((row) => row.feature), ["title_text", "agency_cooccurrence", "salary_overlap", "temporal_consistency", "sibling_schedule"]);
  assert.equal(pair.evidence.find((row) => row.feature === "agency_cooccurrence").state, "unavailable");
  assert.ok(pair.evidence.some((row) => row.agreement === true));
});

test("minutes scorer records missing evidence rather than treating absence as agreement", () => {
  const evidence = buildMinutesEvidence(
    { body_id: "cb-1", meeting_date: "2026-06-25", extracted_text: null },
    { body_id: "cb-1", event_date: "2026-06-25", matter_tokens: [] },
  );
  assert.equal(evidence.features.find((row) => row.feature === "body_match").state, "agreement");
  assert.equal(evidence.features.find((row) => row.feature === "date_proximity").state, "agreement");
  assert.equal(evidence.features.find((row) => row.feature === "docket_fragment").state, "unavailable");
});

test("minutes candidate generation blocks by body/date and never authorizes an edge", () => {
  const rows = generateMinutesCandidates(
    [{ minutes_id: "doc-1", body_id: "cb-1", meeting_date: "2026-06-25", extracted_text: "C260190ZSX" }],
    [
      { request_id: "notice-1", body_id: "cb-1", event_date: "2026-06-25", matter_tokens: ["C260190ZSX"] },
      { request_id: "notice-2", body_id: "cb-2", event_date: "2026-06-25", matter_tokens: ["C260190ZSX"] },
    ],
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.candidate_status === "candidate" && row.operative_link_authorized === false));
  assert.ok(rows[0].evidence.every((item) => Object.hasOwn(item, "weight")));
});

test("potential lift counts distinct left entities only and labels itself hypothetical", () => {
  const potential = measurePotentialLift({
    baseline: 367,
    denominator: 1271,
    rows: [
      { score: 0.9, agreements: 2, left: { exam_number: "1" } },
      { score: 0.91, agreements: 3, left: { exam_number: "1" } },
      { score: 0.9, agreements: 2, left: { exam_number: "2" } },
    ],
    threshold: 0.8,
  });
  assert.equal(potential.eligible_left_entities, 2);
  assert.match(potential.note, /not confirmations/i);
});

test("review registry is empty and explicitly disables operative links", () => {
  const registry = emptyReviewedRegistry("title_code_confirmations", "2026-08-05");
  assert.deepEqual(registry.confirmations, []);
  assert.deepEqual(registry.rejections, []);
  assert.equal(registry.operative_links_enabled, false);
});

test("published fixture contains the two strict ULURP calibration positives", () => {
  assert.equal(fixture.notices.length, 10);
  assert.equal(fixture.documents.length, 7);
  assert.ok(fixture.documents.some((row) => row.extracted_text.includes("260190ZSX")));
  assert.ok(fixture.documents.some((row) => row.extracted_text.includes("C240001ZMM")));
});
