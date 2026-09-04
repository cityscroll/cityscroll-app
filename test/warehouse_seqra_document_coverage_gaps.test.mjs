import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCoverageGapStatement, summarizeMissingOlderMaterial } from "../warehouse/lib/seqra_document_coverage_gaps.mjs";

const REVIEW_KEY = "environmental_review:ceqr:26DCP139X";

const FORBIDDEN_PATTERNS = [/\bno\s+review\s+activity\b/i, /\bnothing\s+happened\b/i, /\breview\s+was\s+inactive\b/i];

function assertNeverReadsAsAbsenceOfActivity(statement) {
  for (const pattern of FORBIDDEN_PATTERNS) assert.doesNotMatch(statement, pattern);
}

describe("seqra_document_coverage_gaps: buildCoverageGapStatement", () => {
  it("flags gap_detected: true when zero documents were found, with an explicit coverage-limitation statement", () => {
    const result = buildCoverageGapStatement({ reviewKey: REVIEW_KEY, periodStart: "2018-01-01", periodEnd: "2019-01-01", documentsFoundCount: 0 });
    assert.equal(result.gap_detected, true);
    assertNeverReadsAsAbsenceOfActivity(result.statement);
    assert.match(result.statement, /limitation of the document search/);
  });

  it("never states or implies the review itself had no activity (A4)", () => {
    const result = buildCoverageGapStatement({ reviewKey: REVIEW_KEY, periodStart: "2018-01-01", periodEnd: "2019-01-01", documentsFoundCount: 0 });
    assertNeverReadsAsAbsenceOfActivity(result.statement);
  });

  it("reports gap_detected: false and a positive count when documents were found", () => {
    const result = buildCoverageGapStatement({ reviewKey: REVIEW_KEY, periodStart: "2018-01-01", periodEnd: "2019-01-01", documentsFoundCount: 3 });
    assert.equal(result.gap_detected, false);
    assert.equal(result.documents_found_count, 3);
  });

  it("throws on a negative or non-integer documentsFoundCount rather than silently coercing it", () => {
    assert.throws(() => buildCoverageGapStatement({ reviewKey: REVIEW_KEY, periodStart: "2018-01-01", periodEnd: "2019-01-01", documentsFoundCount: -1 }));
  });
});

describe("seqra_document_coverage_gaps: summarizeMissingOlderMaterial", () => {
  it("reports status: unknown (not a gap claim) when the earliest known milestone date is unavailable", () => {
    const result = summarizeMissingOlderMaterial({ reviewKey: REVIEW_KEY, earliestDocumentFoundDate: "2020-01-01", earliestKnownMilestoneDate: null });
    assert.equal(result.status, "unknown");
    assertNeverReadsAsAbsenceOfActivity(result.statement);
  });

  it("flags older_material_missing when the earliest found document postdates the earliest known milestone", () => {
    const result = summarizeMissingOlderMaterial({ reviewKey: REVIEW_KEY, earliestDocumentFoundDate: "2020-06-01", earliestKnownMilestoneDate: "2015-01-01" });
    assert.equal(result.status, "older_material_missing");
    assertNeverReadsAsAbsenceOfActivity(result.statement);
    assert.match(result.statement, /may not be available online/);
  });

  it("reports no_gap_detected when the earliest found document is on or before the earliest known milestone", () => {
    const result = summarizeMissingOlderMaterial({ reviewKey: REVIEW_KEY, earliestDocumentFoundDate: "2015-01-01", earliestKnownMilestoneDate: "2015-01-01" });
    assert.equal(result.status, "no_gap_detected");
  });

  it("reports no_documents_found distinctly from a confirmed gap in older material", () => {
    const result = summarizeMissingOlderMaterial({ reviewKey: REVIEW_KEY, earliestDocumentFoundDate: null, earliestKnownMilestoneDate: "2015-01-01" });
    assert.equal(result.status, "no_documents_found");
    assertNeverReadsAsAbsenceOfActivity(result.statement);
  });
});
