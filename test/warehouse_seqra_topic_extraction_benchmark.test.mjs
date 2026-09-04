import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractCommentFindingsFromPage, extractResponseFindingsFromPage } from "../warehouse/lib/seqra_comment_response_extraction.mjs";
import { extractTopicFindingsFromDocument } from "../warehouse/lib/seqra_topic_finding_extraction.mjs";
import { computeExtractionBenchmarkReport } from "../warehouse/lib/seqra_topic_extraction_benchmark.mjs";
import {
  TOPIC_AGENCY_RESPONSE_FIXTURE,
  TOPIC_COMMENT_LETTER_FIXTURE,
  TOPIC_DEIS_FIXTURE,
  TOPIC_EXTRACTION_BENCHMARK_ENTRIES,
  TOPIC_EXTRACTION_REVIEW_KEY,
} from "../warehouse/fixtures/seqra-ceqr-access/sample_topic_extraction_fixtures.mjs";

const DOCUMENT_KEYS = Object.freeze({
  deis: "review_document:environmental_review:ceqr:26DCP555Q:deis:2024-02-01:abcdef123456",
  comment_letter: "review_document:environmental_review:ceqr:26DCP555Q:comment_letter:2024-05-01:aaaa1111",
  agency_response: "review_document:environmental_review:ceqr:26DCP555Q:agency_response:2024-06-01:bbbb2222",
});

function buildAllFindings() {
  const deisFindings = extractTopicFindingsFromDocument({
    pages: TOPIC_DEIS_FIXTURE.pages.map((p) => ({ page_number: p.pageNumber, text: p.text, quality_state: p.qualityState })),
    context: {
      documentKey: DOCUMENT_KEYS.deis,
      documentType: "deis",
      reviewKey: TOPIC_EXTRACTION_REVIEW_KEY,
      fetchId: "fetch-0001",
      contentHash: "sha256:abcdef123456",
      rawObjectPath: "warehouse/raw/x/abcdef123456.bin",
      manualVintageId: "nyc_ceqr_technical_manual_2020",
      observedAt: "2026-09-04T00:00:00.000Z",
    },
  });
  const commentFindings = extractCommentFindingsFromPage({
    pageNumber: 1,
    text: TOPIC_COMMENT_LETTER_FIXTURE.pages[0].text,
    context: { documentKey: DOCUMENT_KEYS.comment_letter, documentType: "comment_letter", reviewKey: TOPIC_EXTRACTION_REVIEW_KEY, fetchId: "fetch-0002", contentHash: "sha256:aaaa1111", rawObjectPath: "warehouse/raw/x/aaaa1111.bin", observedAt: "2026-09-04T00:00:01.000Z" },
  });
  const responseFindings = extractResponseFindingsFromPage({
    pageNumber: 1,
    text: TOPIC_AGENCY_RESPONSE_FIXTURE.pages[0].text,
    context: { documentKey: DOCUMENT_KEYS.agency_response, documentType: "agency_response", reviewKey: TOPIC_EXTRACTION_REVIEW_KEY, fetchId: "fetch-0003", contentHash: "sha256:bbbb2222", rawObjectPath: "warehouse/raw/x/bbbb2222.bin", observedAt: "2026-09-04T00:00:02.000Z" },
  });
  return [...deisFindings, ...commentFindings, ...responseFindings];
}

function buildBenchmarkSet() {
  return TOPIC_EXTRACTION_BENCHMARK_ENTRIES.map((entry) => ({
    document_key: DOCUMENT_KEYS[entry.documentRole],
    document_type: entry.documentRole,
    page_number: entry.pageNumber,
    reviewed: true,
    expected_findings: entry.expectedFindings,
  }));
}

describe("seqra_topic_extraction_benchmark: computeExtractionBenchmarkReport (A4)", () => {
  const findings = buildAllFindings();
  const benchmarkSet = buildBenchmarkSet();
  const report = computeExtractionBenchmarkReport({ benchmarkSet, findings });

  it("is not a trivial 100% match: the fixture set carries a deliberate false positive and false negative", () => {
    assert.equal(report.overall.false_positive, 1);
    assert.equal(report.overall.false_negative, 1);
    assert.equal(report.overall.true_positive, 7);
  });

  it("reports overall precision and recall as real fractions, not placeholders", () => {
    assert.equal(report.overall.precision, 0.875);
    assert.equal(report.overall.recall, 0.875);
  });

  it("reports per-topic precision/recall, including a topic below 1.0 on each axis", () => {
    assert.equal(report.by_topic.shadows.precision, 0.6667);
    assert.equal(report.by_topic.shadows.recall, 1);
    assert.equal(report.by_topic.transportation.precision, 1);
    assert.equal(report.by_topic.transportation.recall, 0.5);
  });

  it("reports per-document-type precision/recall", () => {
    assert.equal(report.by_document_type.deis.true_positive, 5);
    assert.equal(report.by_document_type.deis.false_positive, 1);
    assert.equal(report.by_document_type.deis.false_negative, 1);
    assert.equal(report.by_document_type.comment_letter.recall, 1);
    assert.equal(report.by_document_type.agency_response.recall, 1);
  });

  it("never scores a finding on a page the benchmark set did not review", () => {
    assert.equal(report.unscored_finding_count, 0);
  });
});
