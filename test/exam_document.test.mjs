import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

import { buildExamPhaseView } from "../site/exam_phase_spine.mjs";
import { buildExamProcessSpine } from "../site/exam_process_spine.mjs";
import {
  examDocumentPath,
  examSubjectRef,
  examWatchUrl,
  renderExamDocument,
} from "../site/exam_document.mjs";
import { edgeRequestKind } from "../site/pages_edge.mjs";
import { migrateLegacyUrl } from "../site/route_migration.mjs";
import { examDocumentOutputs } from "../tools/build_exam_documents.mjs";
import { compileSub } from "../worker/src/lib/compile.mjs";
import { sanitize } from "../worker/src/lib/filter.mjs";
import { describeFilter } from "../worker/src/lib/confirm_email.mjs";
import { formatSubjectRef, parseSubjectRef } from "../worker/src/lib/subject_registry.mjs";

const require = createRequire(import.meta.url);
const Staffing = require("../site/staffing.js");
const artifact = JSON.parse(readFileSync(new URL("../site/data/staffing_exams.json", import.meta.url)));

test("exam documents have typed identity, attached context, and static-first affordances", () => {
  const exam = artifact.exams.find((row) => row.exam_number === "7016");
  const html = renderExamDocument(exam, {
    today: "2026-08-05",
    status: Staffing.statusFor(exam, "2026-08-05"),
    feeSalary: Staffing.examFeeSalaryView(exam),
    outcome: Staffing.examOutcomeView(exam),
    phaseView: buildExamPhaseView(buildExamProcessSpine(exam)),
  });
  assert.match(html, /data-exam-document="1"/);
  assert.match(html, /data-subject-ref="exam:7016"/);
  assert.match(html, /Published by DCAS/);
  assert.match(html, /data-exam-watch="7016"/);
  assert.match(html, /data-export-class="exam_prediction"/);
  assert.match(html, /data-prediction-subject="eligible-list-establishment"/);
  assert.match(html, /data-prediction-value=/);
  assert.match(html, /Expect the eligible list about/);
  assert.match(html, /How this range is calculated/);
  assert.match(html, /data-exam-copy/);
  assert.match(html, /data-exam-print/);
  assert.match(html, /data-exam-export="json"/);
  assert.match(html, /data-exam-export="xlsx"/);
  assert.match(html, /data-subject-ref="exam:7016"/);
  assert.match(html, /class="exam-facet-pivot" data-scope-edge="people:format:education_experience"/);
  assert.match(html, /class="exam-facet-pivot" data-scope-edge="people:salary:45k_60k"/);
  assert.match(html, /class="exam-facet-pivot" data-scope-edge="people:fee:fee-bearing"/);
  assert.match(html, /class="exam-facet-pivot" data-scope-edge="people:experience:yes"/);
  assert.match(html, /class="exam-facet-pivot" data-scope-edge="people:window:open"/);
  assert.doesNotMatch(html, /href="#exam\/7016/);
});

test("committed exam document pages are reproducible and contain useful no-JavaScript HTML", () => {
  const outputs = examDocumentOutputs();
  assert.equal(outputs.length, artifact.exams.length);
  for (const [path, html] of outputs) {
    assert.ok(existsSync(path), path);
    assert.equal(readFileSync(path, "utf8"), html, `${path} is stale`);
    assert.match(html, /<main id="main"/);
    assert.match(html, /<h1>/);
    assert.match(html, /data-exam-document="1"/);
    assert.match(html, /rel="canonical"/);
  }
});

test("exam URL grammar forwards legacy hashes and carries validated language", () => {
  assert.equal(examDocumentPath("7016"), "/exams/7016/");
  assert.equal(examSubjectRef("7016"), "exam:7016");
  assert.equal(migrateLegacyUrl("/#exam/7016").target, "/exams/7016/");
  assert.equal(migrateLegacyUrl("/?lang=es#exam/7016").target, "/exams/7016/?lang=es");
  assert.equal(migrateLegacyUrl("/#exam/70").migrated, false);
  assert.equal(edgeRequestKind("https://cityscroll.org/exams/7016/"), "exam");
  assert.match(examWatchUrl("7016"), /lens=people/);
  assert.match(examWatchUrl("7016"), /subject_refs_all/);
});

test("exact exam watches survive worker sanitization and compile to one exam", () => {
  const filter = sanitize("people", { view: "guide", examNumber: "7016", interestArea: "public-safety" });
  assert.deepEqual(filter, {
    keywords: [], lookupType: null, view: "guide", interestArea: "public-safety", interestLabel: null, examNumber: "7016",
    subject_refs_all: [],
  });
  assert.match(describeFilter("people", filter), /exact exam updates/);
  const compiled = compileSub({ lens: "people", filter }, "2026-08-05");
  const rows = compiled.transformRows({ exams: [
    { exam_number: "7016", application_end: "2026-09-01" },
    { exam_number: "6125", application_end: "2026-09-01" },
  ] });
  assert.deepEqual(rows.map((row) => row.exam_number), ["7016"]);
});

test("exam subject references are closed and typed", () => {
  assert.equal(formatSubjectRef("exam", "7016"), "exam:7016");
  assert.deepEqual(parseSubjectRef("exam:7016"), { kind: "exam", id: "7016", ref: "exam:7016" });
  assert.equal(parseSubjectRef("exam:70 16"), null);
});
