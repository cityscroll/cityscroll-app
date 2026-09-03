import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyRecordScope,
  normalizeEnvironmentalRegimeLabel,
  rejectFromTrainingCorpus,
  REJECT_REASONS,
  summarizeScopeClassification,
} from "../warehouse/lib/seqra_scope_classifier.mjs";

describe("SEQRA/CEQR scope classifier", () => {
  it("normalizes NYS SEQR and SEQRA labels to SEQRA while CEQR and CEQA pass through unchanged", () => {
    assert.equal(normalizeEnvironmentalRegimeLabel("SEQR"), "SEQRA");
    assert.equal(normalizeEnvironmentalRegimeLabel("SEQRA"), "SEQRA");
    assert.equal(normalizeEnvironmentalRegimeLabel("seqr"), "SEQRA");
    assert.equal(normalizeEnvironmentalRegimeLabel("CEQR"), "CEQR");
    assert.equal(normalizeEnvironmentalRegimeLabel("CEQA"), "CEQA");
    assert.equal(normalizeEnvironmentalRegimeLabel(null), null);
    assert.equal(normalizeEnvironmentalRegimeLabel("something else"), null);
  });

  it("admits a NYS record published as SEQR, normalizing to SEQRA while preserving the original label", () => {
    const result = classifyRecordScope({
      source_jurisdiction: "NY",
      environmental_regime: "SEQR",
      review_label_as_published: "SEQR",
      judicial_review_regime: "NY_ARTICLE_78",
    });
    assert.equal(result.admitted, true);
    assert.equal(result.jurisdiction_level, "NYS");
    assert.equal(result.environmental_regime, "SEQRA");
    assert.equal(result.review_label_as_published, "SEQR");
    assert.equal(result.judicial_review_regime, "NY_ARTICLE_78");
    assert.equal(result.reject_reason, null);
  });

  it("admits a NYS record published as SEQRA, normalizing to SEQRA and preserving the original label", () => {
    const result = classifyRecordScope({
      source_jurisdiction: "NYS",
      environmental_regime: "SEQRA",
      review_label_as_published: "SEQRA",
    });
    assert.equal(result.admitted, true);
    assert.equal(result.jurisdiction_level, "NYS");
    assert.equal(result.environmental_regime, "SEQRA");
    assert.equal(result.review_label_as_published, "SEQRA");
  });

  it("admits a NYC record published as CEQR and keeps it separately identifiable from statewide SEQRA", () => {
    const result = classifyRecordScope({
      source_jurisdiction: "NYC",
      environmental_regime: "CEQR",
      review_label_as_published: "CEQR",
    });
    assert.equal(result.admitted, true);
    assert.equal(result.jurisdiction_level, "NYC");
    assert.equal(result.environmental_regime, "CEQR");
  });

  it("rejects a California CEQA record via the required rejection test", () => {
    const test = rejectFromTrainingCorpus({ source_jurisdiction: "CA", environmental_regime: "CEQA" });
    assert.equal(test.rejected, true);
    assert.equal(test.reason, REJECT_REASONS.OUT_OF_SCOPE_JURISDICTION);

    const result = classifyRecordScope({
      source_jurisdiction: "CA",
      environmental_regime: "CEQA",
      review_label_as_published: "CEQA",
    });
    assert.equal(result.admitted, false);
    assert.equal(result.reject_reason, REJECT_REASONS.OUT_OF_SCOPE_JURISDICTION);
    assert.equal(result.jurisdiction_level, null);
    // Original published terminology survives normalization even when rejected.
    assert.equal(result.review_label_as_published, "CEQA");
    assert.notEqual(result.environmental_regime, "SEQRA");
  });

  it("rejects source_jurisdiction=='CA' even when environmental_regime is missing or mislabeled", () => {
    const result = classifyRecordScope({ source_jurisdiction: "CA", environmental_regime: "SEQRA" });
    assert.equal(result.admitted, false);
    assert.equal(result.reject_reason, REJECT_REASONS.OUT_OF_SCOPE_JURISDICTION);
  });

  it("rejects environmental_regime=='CEQA' even when jurisdiction is unset", () => {
    const result = classifyRecordScope({ environmental_regime: "CEQA" });
    assert.equal(result.admitted, false);
    assert.equal(result.reject_reason, REJECT_REASONS.OUT_OF_SCOPE_JURISDICTION);
  });

  it("rejects an ambiguous or unknown jurisdiction rather than defaulting it into New York", () => {
    const ambiguous = classifyRecordScope({
      source_jurisdiction: "Unknown territory",
      environmental_regime: "SEQRA",
    });
    assert.equal(ambiguous.admitted, false);
    assert.equal(ambiguous.reject_reason, REJECT_REASONS.UNRESOLVED_JURISDICTION);

    const missing = classifyRecordScope({ environmental_regime: "SEQRA" });
    assert.equal(missing.admitted, false);
    assert.equal(missing.reject_reason, REJECT_REASONS.UNRESOLVED_JURISDICTION);
  });

  it("rejects a record whose environmental regime cannot be resolved to SEQRA or CEQR", () => {
    const result = classifyRecordScope({ source_jurisdiction: "NYS", environmental_regime: "something else" });
    assert.equal(result.admitted, false);
    assert.equal(result.reject_reason, REJECT_REASONS.UNRESOLVED_REGIME);
  });

  it("rejects a mismatched jurisdiction/regime pairing (CEQR outside NYC)", () => {
    const result = classifyRecordScope({ source_jurisdiction: "NYS", environmental_regime: "CEQR" });
    assert.equal(result.admitted, false);
    assert.equal(result.reject_reason, REJECT_REASONS.UNRESOLVED_REGIME);
  });

  it("handles a mixed batch: zero California/CEQA rows ever reach the admitted population", () => {
    const batch = [
      { source_jurisdiction: "NYS", environmental_regime: "SEQR", review_label_as_published: "SEQR" },
      { source_jurisdiction: "NYS", environmental_regime: "SEQRA", review_label_as_published: "SEQRA" },
      { source_jurisdiction: "NYC", environmental_regime: "CEQR", review_label_as_published: "CEQR" },
      { source_jurisdiction: "CA", environmental_regime: "CEQA", review_label_as_published: "CEQA" },
      { source_jurisdiction: "California", environmental_regime: "CEQA", review_label_as_published: "CEQA" },
      { source_jurisdiction: "Unknown", environmental_regime: "SEQRA" },
      { source_jurisdiction: "NYS", environmental_regime: "CEQA" },
    ];
    const summary = summarizeScopeClassification(batch);
    assert.equal(summary.total_records, 7);
    assert.equal(summary.admitted_count, 3);
    assert.equal(summary.out_of_scope_record_count, 3);
    assert.equal(summary.california_or_ceqa_admitted_count, 0);
    assert.equal(summary.jurisdiction_counts.NYS, 2);
    assert.equal(summary.jurisdiction_counts.NYC, 1);
    assert.equal(summary.reject_reason_counts[REJECT_REASONS.OUT_OF_SCOPE_JURISDICTION], 3);
    assert.equal(summary.reject_reason_counts[REJECT_REASONS.UNRESOLVED_JURISDICTION], 1);
    // Every admitted record normalized correctly and none carry a CEQA regime.
    for (const record of summary.classified) {
      if (record.admitted) assert.ok(["SEQRA", "CEQR"].includes(record.environmental_regime));
    }
  });

  it("preserves original terminology on a mixed page with both SEQR and SEQRA spellings", () => {
    const rows = [
      { source_jurisdiction: "NYS", environmental_regime: "SEQR", review_label_as_published: "SEQR" },
      { source_jurisdiction: "NYS", environmental_regime: "SEQRA", review_label_as_published: "SEQRA" },
    ].map(classifyRecordScope);
    assert.deepEqual(rows.map((row) => row.review_label_as_published), ["SEQR", "SEQRA"]);
    assert.deepEqual(rows.map((row) => row.environmental_regime), ["SEQRA", "SEQRA"]);
  });
});
