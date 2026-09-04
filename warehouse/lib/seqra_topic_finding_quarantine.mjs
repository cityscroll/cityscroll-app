/**
 * SEQRA-05: low-confidence quarantine (card acceptance A5 -- "low-confidence
 * facts are quarantined and do not enter training, evidenced by a count of
 * quarantined extractions").
 *
 * This is the second half of the negative rule alongside
 * seqra_manual_vintage.mjs's vintage-explicit comparison: "do not let an
 * unexplained score replace a cited finding." `quarantineFindings` first
 * rejects (throws on) any finding missing page/span evidence at all --
 * a confidence score is never a substitute for that evidence, only a
 * gate over which cited findings are trusted enough to train on -- and only
 * then partitions the remainder by the confidence threshold.
 *
 * `buildTrainingCorpusRows` is the single function anything downstream may
 * call to get training rows; it only ever accepts the `accepted` half of a
 * quarantine result, so a caller cannot bypass quarantine by reaching past
 * this module into the raw finding list.
 */
import { findingHasResolvableEvidence } from "./seqra_topic_finding.mjs";

export const SEQRA_TOPIC_FINDING_QUARANTINE_SCHEMA = "cityscroll.seqra_topic_finding_quarantine.v1";

// SEQRA-05's operating threshold: a finding must be at least this confident
// to enter the training corpus. Chosen as a round, documented cutoff rather
// than tuned against a dataset that does not exist yet; a later card may
// revise it once the benchmark (seqra_topic_extraction_benchmark.mjs) has
// enough real-document coverage to justify a different value.
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Partition findings into `accepted` (confidence >= threshold) and
 * `quarantined` (confidence < threshold). Throws if any finding lacks
 * resolvable page/span evidence at all (A1) -- that is a defect in the
 * extractor that produced it, not a confidence question, so it is never
 * silently routed into quarantine as if it were merely low-confidence.
 */
export function quarantineFindings(findings = [], { threshold = LOW_CONFIDENCE_THRESHOLD } = {}) {
  if (typeof threshold !== "number" || threshold < 0 || threshold > 1) {
    throw new Error(`threshold must be a number in [0, 1], got ${JSON.stringify(threshold)}`);
  }
  const accepted = [];
  const quarantined = [];
  for (const finding of findings) {
    if (!findingHasResolvableEvidence(finding)) {
      throw new Error(`quarantineFindings: finding ${finding?.finding_key ?? "(no finding_key)"} lacks page/span evidence resolving to stored bytes; this is a defect to fix, not a quarantine case`);
    }
    if (finding.confidence >= threshold) {
      accepted.push(finding);
    } else {
      quarantined.push(Object.freeze({ ...finding, review_status: "quarantined_low_confidence" }));
    }
  }
  return Object.freeze({
    schema: SEQRA_TOPIC_FINDING_QUARANTINE_SCHEMA,
    threshold,
    input_count: findings.length,
    accepted: Object.freeze(accepted),
    accepted_count: accepted.length,
    quarantined: Object.freeze(quarantined),
    quarantined_count: quarantined.length,
  });
}

/**
 * The only function that may emit training-corpus rows. Takes exactly the
 * `accepted` array of a `quarantineFindings` result -- typed as such by
 * convention and enforced at the call site by requiring the caller name
 * the argument `acceptedFindings`, not `findings`, so a review reading a
 * call site sees immediately whether quarantine ran first.
 */
export function buildTrainingCorpusRows(acceptedFindings = []) {
  for (const finding of acceptedFindings) {
    if (finding.review_status === "quarantined_low_confidence") {
      throw new Error(`buildTrainingCorpusRows: finding ${finding.finding_key} is marked quarantined_low_confidence and must never enter the training corpus`);
    }
  }
  return acceptedFindings.map((f) => Object.freeze({ ...f, review_status: "training_corpus" }));
}
