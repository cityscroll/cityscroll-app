import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertNoLawsuitScoreField, buildDocumentProcessingRecord, FILING_QUALITY_STATES } from "../warehouse/lib/seqra_document_processing_record.mjs";

const FETCH_ID = "seqra04-doc-fetch-0001";
const CONTENT_HASH = "sha256:abc123";
const BASE = {
  documentKey: "review_document:environmental_review:ceqr:26DCP139X:deis:2024-03-01:abc123456789",
  reviewKey: "environmental_review:ceqr:26DCP139X",
  fetchId: FETCH_ID,
  contentHash: CONTENT_HASH,
  rawObjectPath: "warehouse/raw/seqra-ceqr-access/documents/abc123.pdf",
  documentType: "deis",
  documentStage: "draft",
  classificationConfidence: "high",
  extractionQualitySummary: { overall_quality_state: "high", page_count: 1, measured_page_count: 1, unmeasured_page_count: 0, low_quality_page_count: 0 },
  processedAt: "2026-09-04T00:00:00.000Z",
};

describe("seqra_document_processing_record", () => {
  it("builds a valid record with pages resolving to the document's own fetch receipt (A2)", () => {
    const record = buildDocumentProcessingRecord({
      ...BASE,
      pages: [{ page_number: 1, fetch_id: FETCH_ID, content_hash: CONTENT_HASH, text_chars: 500 }],
    });
    assert.equal(record.schema, "cityscroll.seqra_document_processing_record.v1");
    assert.equal(record.pages[0].fetch_id, FETCH_ID);
  });

  it("throws when a page's fetch_id does not match the document's own fetch_id (A2 integrity)", () => {
    assert.throws(() => buildDocumentProcessingRecord({
      ...BASE,
      pages: [{ page_number: 1, fetch_id: "some-other-fetch", content_hash: CONTENT_HASH }],
    }));
  });

  it("throws when a page's content_hash does not match the document's own content_hash", () => {
    assert.throws(() => buildDocumentProcessingRecord({
      ...BASE,
      pages: [{ page_number: 1, fetch_id: FETCH_ID, content_hash: "sha256:different" }],
    }));
  });

  it("throws when a page is missing page_number", () => {
    assert.throws(() => buildDocumentProcessingRecord({
      ...BASE,
      pages: [{ fetch_id: FETCH_ID, content_hash: CONTENT_HASH }],
    }));
  });

  it("requires extractionQualitySummary.overall_quality_state to be a real FILING_QUALITY_STATES value", () => {
    assert.throws(() => buildDocumentProcessingRecord({
      ...BASE,
      pages: [],
      extractionQualitySummary: { overall_quality_state: "excellent" },
    }));
  });

  it("never carries a scoring/prediction field anywhere in the record (negative rule)", () => {
    const record = buildDocumentProcessingRecord({ ...BASE, pages: [] });
    assert.doesNotThrow(() => assertNoLawsuitScoreField(record));
  });

  it("assertNoLawsuitScoreField actually catches a smuggled score field", () => {
    assert.throws(() => assertNoLawsuitScoreField({ document_key: "x", nested: { lawsuit_score: 0.9 } }));
    assert.throws(() => assertNoLawsuitScoreField({ legal_risk_score: 5 }));
  });

  it("FILING_QUALITY_STATES matches the shared LDP-23 enum (reused, not re-declared)", () => {
    assert.deepEqual(FILING_QUALITY_STATES, ["not_applicable", "high", "medium", "low", "unknown"]);
  });
});
