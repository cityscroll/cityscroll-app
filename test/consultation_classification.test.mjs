import assert from "node:assert/strict";
import { test } from "node:test";
import { NEGATIVE_CLASSIFICATION_FIXTURES } from "./fixtures/consultation_classification.mjs";
import { classifyConsultationCandidate } from "../site/consultation_classification.mjs";

test("negative controls stay outside open consultations", () => {
  assert.equal(NEGATIVE_CLASSIFICATION_FIXTURES.length, 4);
  assert.deepEqual(NEGATIVE_CLASSIFICATION_FIXTURES.map((fixture) => classifyConsultationCandidate(fixture).kind), ["not_consultation", "not_consultation", "not_consultation", "meeting"]);
});

test("a readable form without affirmative acceptance is not called open", () => {
  assert.deepEqual(classifyConsultationCandidate({ title: "Library survey", readable: true }), { kind: "consultation", reason: "readable_acceptance_unconfirmed" });
  assert.deepEqual(classifyConsultationCandidate({ title: "Library survey", accepted: false }), { kind: "consultation", reason: "readable_acceptance_unconfirmed" });
});

test("the classification fixture retains six positive records and four controls", async () => {
  const { CONSULTATION_PILOT_SEEDS } = await import("../site/consultation_publisher_adapters.mjs");
  assert.equal(CONSULTATION_PILOT_SEEDS.length, 6);
  assert.equal(NEGATIVE_CLASSIFICATION_FIXTURES.length, 4);
});
