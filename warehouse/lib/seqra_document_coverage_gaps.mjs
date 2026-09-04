/**
 * SEQRA-04: explicit missing-material statements (card acceptance A4).
 *
 * A review with zero documents found for an early period could mean two very
 * different things: the review genuinely had no documented activity in that
 * window, or CEQR Access simply does not have (or this pipeline could not
 * find) older material for it. This module only ever states the second
 * kind of claim -- a search/coverage limitation -- and is deliberately
 * worded so it can never be read as "no review activity occurred." Every
 * exported builder's `statement` text is asserted, by this module's own test
 * suite (test/warehouse_seqra_document_coverage_gaps.test.mjs), to avoid the
 * forbidden phrasing.
 */
export const COVERAGE_GAP_SCHEMA = "cityscroll.seqra_document_coverage_gap.v1";

const FORBIDDEN_PHRASES = Object.freeze([
  /\bno\s+review\s+activity\b/i,
  /\bnothing\s+happened\b/i,
  /\breview\s+was\s+inactive\b/i,
]);

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required and must be a non-empty string`);
  return value;
}

function assertNoForbiddenPhrasing(statement) {
  for (const phrase of FORBIDDEN_PHRASES) {
    if (phrase.test(statement)) {
      throw new Error(`coverage-gap statement must never read as an absence-of-activity claim (matched ${phrase}): ${JSON.stringify(statement)}`);
    }
  }
  return statement;
}

/**
 * Build the explicit statement for one review/period with zero documents
 * found by this pipeline's search. `gapDetected` is true whenever
 * `documentsFoundCount` is 0 for a period the review was known to be open
 * during (from the SEQRA-02 event-log projection); it is never inferred from
 * silence about the review's existence.
 */
export function buildCoverageGapStatement({ reviewKey, periodStart, periodEnd, documentsFoundCount, searchMethodDescription = "the CEQR Access document search this pipeline performed" } = {}) {
  requireNonEmptyString(reviewKey, "reviewKey");
  requireNonEmptyString(periodStart, "periodStart");
  requireNonEmptyString(periodEnd, "periodEnd");
  if (!Number.isInteger(documentsFoundCount) || documentsFoundCount < 0) {
    throw new Error("documentsFoundCount must be a non-negative integer");
  }
  const gapDetected = documentsFoundCount === 0;
  const statement = gapDetected
    ? `No documents were found by ${searchMethodDescription} for ${reviewKey} between ${periodStart} and ${periodEnd}. ` +
      "This reflects a limitation of the document search performed, not a confirmed absence of review activity in this period -- " +
      "the review may have had activity that this pipeline's search did not surface, or that CEQR Access does not host online for this window."
    : `${documentsFoundCount} document(s) were found by ${searchMethodDescription} for ${reviewKey} between ${periodStart} and ${periodEnd}.`;
  assertNoForbiddenPhrasing(statement);
  return Object.freeze({
    schema: COVERAGE_GAP_SCHEMA,
    review_key: reviewKey,
    period: Object.freeze({ start: periodStart, end: periodEnd }),
    documents_found_count: documentsFoundCount,
    gap_detected: gapDetected,
    statement,
  });
}

/**
 * Compare the earliest document this pipeline actually found for a review
 * against the review's earliest known milestone (from the SEQRA-02 event-log
 * projection, when available) and flag missing older material explicitly.
 * `earliestKnownMilestoneDate` is optional -- when absent, the statement says
 * so rather than guessing a review's start.
 */
export function summarizeMissingOlderMaterial({ reviewKey, earliestDocumentFoundDate = null, earliestKnownMilestoneDate = null } = {}) {
  requireNonEmptyString(reviewKey, "reviewKey");
  if (!earliestKnownMilestoneDate) {
    const statement =
      `The earliest known milestone date for ${reviewKey} is not available to this pipeline, so whether older ` +
      "material is missing cannot be assessed; this is reported as unknown, not as complete coverage.";
    assertNoForbiddenPhrasing(statement);
    return Object.freeze({ schema: COVERAGE_GAP_SCHEMA, review_key: reviewKey, status: "unknown", statement });
  }
  if (!earliestDocumentFoundDate) {
    const statement =
      `No documents were found at all for ${reviewKey}; whether this reflects missing older material or a search ` +
      "limitation across the review's entire history is unresolved, not evidence the review had no activity.";
    assertNoForbiddenPhrasing(statement);
    return Object.freeze({ schema: COVERAGE_GAP_SCHEMA, review_key: reviewKey, status: "no_documents_found", statement });
  }
  const olderMaterialMissing = earliestDocumentFoundDate > earliestKnownMilestoneDate;
  const statement = olderMaterialMissing
    ? `The earliest document found for ${reviewKey} is dated ${earliestDocumentFoundDate}, after the review's earliest known ` +
      `milestone on ${earliestKnownMilestoneDate}. Material from before ${earliestDocumentFoundDate} was not found by this ` +
      "pipeline's search and may not be available online; this is stated as a coverage gap, not as evidence the review " +
      "began later than its recorded milestone."
    : `The earliest document found for ${reviewKey} (${earliestDocumentFoundDate}) is on or before the review's earliest ` +
      `known milestone (${earliestKnownMilestoneDate}); no gap in early-period material was detected by this comparison.`;
  assertNoForbiddenPhrasing(statement);
  return Object.freeze({
    schema: COVERAGE_GAP_SCHEMA,
    review_key: reviewKey,
    status: olderMaterialMissing ? "older_material_missing" : "no_gap_detected",
    earliest_document_found_date: earliestDocumentFoundDate,
    earliest_known_milestone_date: earliestKnownMilestoneDate,
    statement,
  });
}
