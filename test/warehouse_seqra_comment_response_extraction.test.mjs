import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractCommentFindingsFromPage, extractResponseFindingsFromPage } from "../warehouse/lib/seqra_comment_response_extraction.mjs";
import { TOPIC_AGENCY_RESPONSE_FIXTURE, TOPIC_COMMENT_LETTER_FIXTURE, TOPIC_EXTRACTION_REVIEW_KEY } from "../warehouse/fixtures/seqra-ceqr-access/sample_topic_extraction_fixtures.mjs";

const COMMENT_CONTEXT = Object.freeze({
  documentKey: "review_document:environmental_review:ceqr:26DCP555Q:comment_letter:2024-05-01:aaaa1111",
  documentType: "comment_letter",
  reviewKey: TOPIC_EXTRACTION_REVIEW_KEY,
  fetchId: "fetch-0002",
  contentHash: "sha256:aaaa1111",
  rawObjectPath: "warehouse/raw/seqra-ceqr-access/documents/aaaa1111.bin",
  observedAt: "2026-09-04T00:00:01.000Z",
});

const RESPONSE_CONTEXT = Object.freeze({
  documentKey: "review_document:environmental_review:ceqr:26DCP555Q:agency_response:2024-06-01:bbbb2222",
  documentType: "agency_response",
  reviewKey: TOPIC_EXTRACTION_REVIEW_KEY,
  fetchId: "fetch-0003",
  contentHash: "sha256:bbbb2222",
  rawObjectPath: "warehouse/raw/seqra-ceqr-access/documents/bbbb2222.bin",
  observedAt: "2026-09-04T00:00:02.000Z",
});

describe("seqra_comment_response_extraction: comment_letter", () => {
  const page = TOPIC_COMMENT_LETTER_FIXTURE.pages[0];
  const findings = extractCommentFindingsFromPage({ pageNumber: page.pageNumber, text: page.text, context: COMMENT_CONTEXT });

  it("extracts one noise comment finding with page evidence", () => {
    assert.equal(findings.length, 1);
    assert.equal(findings[0].technical_topic, "noise");
    assert.equal(findings[0].finding_type, "comment");
    assert.equal(findings[0].page_number, 1);
    assert.equal(findings[0].fetch_id, "fetch-0002");
  });
});

describe("seqra_comment_response_extraction: agency_response", () => {
  const page = TOPIC_AGENCY_RESPONSE_FIXTURE.pages[0];
  const findings = extractResponseFindingsFromPage({ pageNumber: page.pageNumber, text: page.text, context: RESPONSE_CONTEXT });

  it("extracts one noise agency_response finding", () => {
    assert.equal(findings.length, 1);
    assert.equal(findings[0].technical_topic, "noise");
    assert.equal(findings[0].finding_type, "agency_response");
  });

  it("classifies the response disposition as addressed", () => {
    assert.equal(findings[0].response_disposition, "addressed");
  });
});
