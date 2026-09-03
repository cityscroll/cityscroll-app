/**
 * SEQRA / CEQR jurisdiction and regime scope classifier.
 *
 * This is the shared gate for the whole New York SEQRA/CEQR workstream: any
 * record that is not clearly New York State or New York City, reviewed under
 * SEQRA or CEQR, is rejected from any admitted or training population. NYS
 * `SEQR`/`SEQRA` published labels normalize to `SEQRA` while the original
 * published terminology is retained verbatim. California CEQA records, and
 * any record whose jurisdiction cannot be resolved to NYS/NYC, are always
 * rejected -- never silently coerced into a New York bucket.
 */

export const SEQRA_SCOPE_CLASSIFIER_SCHEMA = "cityscroll.seqra_scope_classification.v1";

export const JURISDICTION_LEVELS = Object.freeze(["NYS", "NYC"]);
export const ENVIRONMENTAL_REGIMES = Object.freeze(["SEQRA", "CEQR"]);
export const JUDICIAL_REVIEW_REGIMES = Object.freeze([
  "NY_ARTICLE_78",
  "NY_HYBRID",
  "NONE",
  "UNKNOWN",
]);

export const REJECT_REASONS = Object.freeze({
  OUT_OF_SCOPE_JURISDICTION: "out_of_scope_jurisdiction",
  UNRESOLVED_JURISDICTION: "unresolved_or_ambiguous_jurisdiction",
  UNRESOLVED_REGIME: "unresolved_or_ambiguous_environmental_regime",
});

const CA_JURISDICTION_TOKENS = new Set(["ca", "california"]);
const NYS_JURISDICTION_TOKENS = new Set(["nys", "ny", "new york", "new york state"]);
const NYC_JURISDICTION_TOKENS = new Set(["nyc", "new york city"]);

/**
 * Normalize a published environmental-review-label string without losing the
 * original text. NYS `SEQR` and `SEQRA` both normalize to `SEQRA`. NYC `CEQR`
 * stays `CEQR`. California `CEQA` is preserved as `CEQA` -- it must never
 * normalize into a New York bucket.
 */
export function normalizeEnvironmentalRegimeLabel(rawLabel) {
  if (rawLabel == null) return null;
  const token = String(rawLabel).trim().toUpperCase();
  if (token === "SEQR" || token === "SEQRA") return "SEQRA";
  if (token === "CEQR") return "CEQR";
  if (token === "CEQA") return "CEQA";
  return null;
}

function normalizeJurisdictionToken(raw) {
  if (raw == null) return null;
  const token = String(raw).trim().toLowerCase();
  if (!token) return null;
  if (CA_JURISDICTION_TOKENS.has(token)) return "CA";
  if (NYC_JURISDICTION_TOKENS.has(token)) return "NYC";
  if (NYS_JURISDICTION_TOKENS.has(token)) return "NYS";
  return "UNRESOLVED";
}

/**
 * Required rejection test from the SEQRA/CEQR commission, implemented
 * literally: any California jurisdiction or CEQA regime is rejected from the
 * training/usable-population corpus. This function only decides the
 * California/CEQA branch; use `classifyRecordScope` for the full New York
 * admission decision (which additionally rejects ambiguous jurisdictions).
 */
export function rejectFromTrainingCorpus({ source_jurisdiction, environmental_regime } = {}) {
  const jurisdictionToken = normalizeJurisdictionToken(source_jurisdiction);
  const regimeToken = environmental_regime == null ? null : String(environmental_regime).trim().toUpperCase();
  if (jurisdictionToken === "CA" || regimeToken === "CEQA") {
    return { rejected: true, reason: REJECT_REASONS.OUT_OF_SCOPE_JURISDICTION };
  }
  return { rejected: false, reason: null };
}

/**
 * Classify one record's scope fields into the required New York SEQRA/CEQR
 * envelope. Only a record that resolves cleanly to NYS or NYC, with an
 * environmental regime of SEQRA or CEQR, is admitted. Everything else --
 * California/CEQA, an unresolved jurisdiction, an unresolved regime -- is
 * rejected with a distinct, typed reason. Original published terminology is
 * always preserved in `review_label_as_published`.
 *
 * @param {{
 *   source_jurisdiction?: string,
 *   environmental_regime?: string,
 *   review_label_as_published?: string,
 *   judicial_review_regime?: string,
 * }} record
 */
export function classifyRecordScope(record = {}) {
  const {
    source_jurisdiction = null,
    environmental_regime = null,
    review_label_as_published = null,
    judicial_review_regime = null,
  } = record;

  const publishedLabel = review_label_as_published ?? environmental_regime ?? null;
  const jurisdictionToken = normalizeJurisdictionToken(source_jurisdiction);
  const normalizedRegime = normalizeEnvironmentalRegimeLabel(environmental_regime ?? publishedLabel);

  const caReject = rejectFromTrainingCorpus({ source_jurisdiction, environmental_regime });
  if (caReject.rejected) {
    return {
      schema: SEQRA_SCOPE_CLASSIFIER_SCHEMA,
      jurisdiction_level: null,
      environmental_regime: normalizedRegime,
      review_label_as_published: publishedLabel,
      judicial_review_regime: normalizeJudicialReviewRegime(judicial_review_regime),
      admitted: false,
      reject_reason: caReject.reason,
    };
  }

  if (jurisdictionToken !== "NYS" && jurisdictionToken !== "NYC") {
    return {
      schema: SEQRA_SCOPE_CLASSIFIER_SCHEMA,
      jurisdiction_level: null,
      environmental_regime: normalizedRegime,
      review_label_as_published: publishedLabel,
      judicial_review_regime: normalizeJudicialReviewRegime(judicial_review_regime),
      admitted: false,
      reject_reason: REJECT_REASONS.UNRESOLVED_JURISDICTION,
    };
  }

  if (normalizedRegime !== "SEQRA" && normalizedRegime !== "CEQR") {
    return {
      schema: SEQRA_SCOPE_CLASSIFIER_SCHEMA,
      jurisdiction_level: jurisdictionToken,
      environmental_regime: normalizedRegime,
      review_label_as_published: publishedLabel,
      judicial_review_regime: normalizeJudicialReviewRegime(judicial_review_regime),
      admitted: false,
      reject_reason: REJECT_REASONS.UNRESOLVED_REGIME,
    };
  }

  // A CEQR-labeled record must carry NYC jurisdiction and vice versa for
  // statewide SEQRA; CEQR is NYC's implementation of SEQRA but the two
  // denominators must never merge silently.
  if (normalizedRegime === "CEQR" && jurisdictionToken !== "NYC") {
    return {
      schema: SEQRA_SCOPE_CLASSIFIER_SCHEMA,
      jurisdiction_level: jurisdictionToken,
      environmental_regime: normalizedRegime,
      review_label_as_published: publishedLabel,
      judicial_review_regime: normalizeJudicialReviewRegime(judicial_review_regime),
      admitted: false,
      reject_reason: REJECT_REASONS.UNRESOLVED_REGIME,
    };
  }

  return {
    schema: SEQRA_SCOPE_CLASSIFIER_SCHEMA,
    jurisdiction_level: jurisdictionToken,
    environmental_regime: normalizedRegime,
    review_label_as_published: publishedLabel,
    judicial_review_regime: normalizeJudicialReviewRegime(judicial_review_regime),
    admitted: true,
    reject_reason: null,
  };
}

function normalizeJudicialReviewRegime(value) {
  if (value == null) return "UNKNOWN";
  const token = String(value).trim().toUpperCase();
  return JUDICIAL_REVIEW_REGIMES.includes(token) ? token : "UNKNOWN";
}

/**
 * Summarize a batch of classified records into a jurisdiction breakdown and
 * the out-of-scope record count required by the inventory receipt. Rejected
 * records are counted by reason so a reviewer can see how many were rejected
 * specifically as out-of-scope (California/CEQA) versus merely ambiguous.
 */
export function summarizeScopeClassification(records = []) {
  const classified = records.map((record) => classifyRecordScope(record));
  const jurisdictionCounts = {};
  const rejectReasonCounts = {};
  let admittedCount = 0;
  let outOfScopeCount = 0;
  let californiaAdmittedCount = 0;

  for (const result of classified) {
    const jurisdictionKey = result.jurisdiction_level ?? "UNRESOLVED";
    jurisdictionCounts[jurisdictionKey] = (jurisdictionCounts[jurisdictionKey] ?? 0) + 1;
    if (result.admitted) {
      admittedCount += 1;
    } else {
      const reasonKey = result.reject_reason ?? "unknown_reject_reason";
      rejectReasonCounts[reasonKey] = (rejectReasonCounts[reasonKey] ?? 0) + 1;
      if (result.reject_reason === REJECT_REASONS.OUT_OF_SCOPE_JURISDICTION) {
        outOfScopeCount += 1;
      }
    }
    if (result.admitted && result.jurisdiction_level === "CA") californiaAdmittedCount += 1;
  }

  return {
    schema: SEQRA_SCOPE_CLASSIFIER_SCHEMA,
    total_records: records.length,
    admitted_count: admittedCount,
    rejected_count: records.length - admittedCount,
    out_of_scope_record_count: outOfScopeCount,
    jurisdiction_counts: jurisdictionCounts,
    reject_reason_counts: rejectReasonCounts,
    california_or_ceqa_admitted_count: californiaAdmittedCount,
    classified,
  };
}
