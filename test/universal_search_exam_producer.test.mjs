import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildExamSearchDocuments,
  projectExamSearchDocument,
} from "../site/exam_search_producer.mjs";

function artifact(overrides = {}) {
  return {
    schema_version: 6,
    generated_at: "2026-08-03",
    data_current_as_of: "2026-07-22",
    exams: [{
      exam_number: "7016",
      title_code: "53053",
      title: "Emergency Medical Specialist - EMT",
      application_start: "2026-07-01",
      application_end: "2026-07-21",
      eligibility: "open_competitive",
      schedule_status: "scheduled",
      interest_area: "public-safety",
      sources: ["dcas-annual-schedule", "oasys-active-exams"],
    }],
    sources: [{ id: "dcas-annual-schedule", dataset_id: "4ptz-hmtc" }],
    ...overrides,
  };
}

test("civil-service exam documents preserve title, code, schedule, route, and freshness", () => {
  const source = artifact();
  const result = projectExamSearchDocument(source.exams[0], { artifact: source });
  assert.equal(result.outcome, "indexed");
  assert.equal(result.document.object_ref, "exam:7016");
  assert.equal(result.document.object_type, "civil_service_exam");
  assert.equal(result.document.domain, "staffing");
  assert.equal(result.document.canonical_href, "/exams/7016/");
  assert.deepEqual(result.document.source_observation_refs, [
    "dcas-annual-schedule:exam:7016",
    "oasys-active-exams:exam:7016",
  ]);
  assert.ok(result.document.search_text.includes("53053"));
  assert.ok(result.document.search_text.includes("Department of Citywide Administrative Services"));
  assert.equal(result.document.provenance.lifecycle.schedule_status, "scheduled");
  assert.equal(result.document.provenance.source_freshness.data_current_as_of, "2026-07-22");
});

test("malformed exam rows fail closed and coverage distinguishes partial, empty, and not indexed", () => {
  const source = artifact();
  const malformed = projectExamSearchDocument({
    exam_number: "unknown",
    title: "Possible exam",
    sources: ["dcas-annual-schedule"],
  }, { artifact: source });
  assert.equal(malformed.outcome, "unclassified");
  assert.equal(malformed.document, null);

  const partial = buildExamSearchDocuments(artifact({
    exams: [...source.exams, { exam_number: "unknown", title: "Possible", sources: [] }],
  }));
  assert.equal(partial.coverage.state, "partial");
  assert.equal(partial.coverage.indexed_count, 1);
  assert.equal(buildExamSearchDocuments(artifact({ exams: [] })).coverage.state, "empty");
  assert.equal(buildExamSearchDocuments({ schema_version: 5, exams: [] }).coverage.state, "not_indexed");
});

test("the committed staffing artifact admits every source-backed exam", () => {
  const source = JSON.parse(readFileSync(new URL("../site/data/staffing_exams.json", import.meta.url)));
  const corpus = buildExamSearchDocuments(source);
  assert.equal(corpus.coverage.state, "matched");
  assert.equal(corpus.documents.length, source.exams.length);
});
