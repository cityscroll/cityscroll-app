import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildTopicFinding, buildTopicFindingKey, findingHasResolvableEvidence } from "../warehouse/lib/seqra_topic_finding.mjs";

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
  confidence: 0.9,
  observedAt: "2026-09-04T00:00:00.000Z",
});

describe("seqra_topic_finding: buildTopicFinding (A1: no finding without evidence)", () => {
  it("builds a finding carrying page/span evidence resolving to stored bytes", () => {
    const finding = buildTopicFinding(BASE);
    assert.equal(finding.page_number, 1);
    assert.equal(finding.fetch_id, "fetch-0001");
    assert.equal(finding.raw_object_path, BASE.rawObjectPath);
    assert.ok(finding.finding_key.startsWith("technical_topic_finding:"));
  });

  it("is deterministic: the same identity tuple always yields the same finding_key", () => {
    const a = buildTopicFindingKey({ documentKey: BASE.documentKey, findingType: "impact", technicalTopic: "shadows", pageNumber: 1, evidenceExcerpt: "x" });
    const b = buildTopicFindingKey({ documentKey: BASE.documentKey, findingType: "impact", technicalTopic: "shadows", pageNumber: 1, evidenceExcerpt: "x" });
    assert.equal(a, b);
  });

  it("throws when page_number is missing", () => {
    const { pageNumber, ...rest } = BASE;
    assert.throws(() => buildTopicFinding(rest));
  });

  it("throws when evidenceExcerpt is missing", () => {
    const { evidenceExcerpt, ...rest } = BASE;
    assert.throws(() => buildTopicFinding(rest));
  });

  it("throws when fetchId/contentHash/rawObjectPath is missing", () => {
    const { fetchId, ...rest } = BASE;
    assert.throws(() => buildTopicFinding(rest));
  });

  it("rejects an unrecognized finding_type", () => {
    assert.throws(() => buildTopicFinding({ ...BASE, findingType: "not_a_real_type" }));
  });

  it("rejects an unrecognized technical_topic", () => {
    assert.throws(() => buildTopicFinding({ ...BASE, technicalTopic: "not_a_real_topic" }));
  });

  it("requires normalizedValue/unit/manualVintageId/factType for a threshold_comparison finding", () => {
    assert.throws(() => buildTopicFinding({ ...BASE, findingType: "threshold_comparison" }));
    const finding = buildTopicFinding({
      ...BASE,
      findingType: "threshold_comparison",
      manualVintageId: "nyc_ceqr_technical_manual_2020",
      factType: "open_space_shadow_duration",
      normalizedValue: 0.22,
      unit: "fraction_of_daylight_hours",
    });
    assert.equal(finding.normalized_value, 0.22);
    assert.equal(finding.fact_type, "open_space_shadow_duration");
  });
});

describe("seqra_topic_finding: findingHasResolvableEvidence", () => {
  it("is true for a well-formed finding", () => {
    assert.equal(findingHasResolvableEvidence(buildTopicFinding(BASE)), true);
  });

  it("is false when page_number is not a positive integer", () => {
    assert.equal(findingHasResolvableEvidence({ ...buildTopicFinding(BASE), page_number: 0 }), false);
  });

  it("is false for null/undefined", () => {
    assert.equal(findingHasResolvableEvidence(null), false);
    assert.equal(findingHasResolvableEvidence(undefined), false);
  });
});
