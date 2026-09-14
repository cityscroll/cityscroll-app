import assert from "node:assert/strict";
import { test } from "node:test";
import { NEGATIVE_CLASSIFICATION_FIXTURES, classifyConsultationCandidate, classifyPilotFixtures } from "../site/consultation_classification.mjs";

test("negative controls stay outside open consultations", () => {
  assert.equal(NEGATIVE_CLASSIFICATION_FIXTURES.length, 4);
  assert.deepEqual(NEGATIVE_CLASSIFICATION_FIXTURES.map((fixture) => classifyConsultationCandidate(fixture).kind), ["not_consultation", "not_consultation", "not_consultation", "meeting"]);
});

test("a readable form without affirmative acceptance is not called open", () => {
  assert.deepEqual(classifyConsultationCandidate({ title: "Library survey", readable: true }), { kind: "consultation", reason: "readable_acceptance_unconfirmed" });
  assert.deepEqual(classifyConsultationCandidate({ title: "Library survey", accepted: false }), { kind: "consultation", reason: "readable_acceptance_unconfirmed" });
});

test("classification report retains six positive records and four controls", () => {
  const report = classifyPilotFixtures();
  assert.equal(report.positive_count, 6);
  assert.equal(report.negative_controls.length, 4);
});
