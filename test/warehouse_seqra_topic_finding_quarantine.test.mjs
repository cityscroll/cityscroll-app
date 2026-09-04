import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTopicFinding } from "../warehouse/lib/seqra_topic_finding.mjs";
import { LOW_CONFIDENCE_THRESHOLD, buildTrainingCorpusRows, quarantineFindings } from "../warehouse/lib/seqra_topic_finding_quarantine.mjs";

const BASE = Object.freeze({
  reviewKey: "environmental_review:ceqr:26DCP555Q",
  documentKey: "review_document:environmental_review:ceqr:26DCP555Q:deis:2024-02-01:abcdef123456",
  documentType: "deis",
  findingType: "impact",
  technicalTopic: "shadows",
  pageNumber: 1,
  evidenceExcerpt: "The proposed action would result in an impact from new shadows.",
  fetchId: "fetch-0001",
  contentHash: "sha256:abcdef123456",
  rawObjectPath: "warehouse/raw/seqra-ceqr-access/documents/abcdef123456.bin",
  extractorType: "seqra05_pattern_extractor",
  extractorVersion: "v1",
  observedAt: "2026-09-04T00:00:00.000Z",
});

describe("seqra_topic_finding_quarantine: quarantineFindings (A5)", () => {
  it("accepts a high-confidence finding and quarantines a low-confidence one, with a matching count", () => {
    const high = buildTopicFinding({ ...BASE, confidence: 0.9 });
    const low = buildTopicFinding({ ...BASE, pageNumber: 4, technicalTopic: "air_quality", evidenceExcerpt: "impact on air quality", confidence: 0.3 });
    const result = quarantineFindings([high, low]);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0].finding_key, high.finding_key);
    assert.equal(result.quarantined.length, 1);
    assert.equal(result.quarantined_count, 1);
    assert.equal(result.quarantined[0].review_status, "quarantined_low_confidence");
  });

  it("uses LOW_CONFIDENCE_THRESHOLD as the default cutoff", () => {
    const atThreshold = buildTopicFinding({ ...BASE, confidence: LOW_CONFIDENCE_THRESHOLD });
    const result = quarantineFindings([atThreshold]);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.quarantined.length, 0);
  });

  it("throws rather than quarantining a finding that lacks resolvable evidence outright", () => {
    const malformed = { ...buildTopicFinding({ ...BASE, confidence: 0.9 }), page_number: null };
    assert.throws(() => quarantineFindings([malformed]));
  });
});

describe("seqra_topic_finding_quarantine: buildTrainingCorpusRows never accepts a quarantined finding", () => {
  it("refuses a finding tagged quarantined_low_confidence", () => {
    const low = buildTopicFinding({ ...BASE, confidence: 0.2 });
    const { quarantined } = quarantineFindings([low]);
    assert.throws(() => buildTrainingCorpusRows(quarantined));
  });

  it("accepts a properly accepted finding", () => {
    const high = buildTopicFinding({ ...BASE, confidence: 0.9 });
    const { accepted } = quarantineFindings([high]);
    const rows = buildTrainingCorpusRows(accepted);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].review_status, "training_corpus");
  });
});
