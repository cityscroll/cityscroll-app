import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractCommentFindingsFromPage, extractResponseFindingsFromPage } from "../warehouse/lib/seqra_comment_response_extraction.mjs";
import { extractTopicFindingsFromDocument } from "../warehouse/lib/seqra_topic_finding_extraction.mjs";
import { projectTopicAssessments } from "../warehouse/lib/seqra_topic_assessment_projection.mjs";
import {
  TOPIC_AGENCY_RESPONSE_FIXTURE,
  TOPIC_COMMENT_LETTER_FIXTURE,
  TOPIC_DEIS_FIXTURE,
  TOPIC_EXTRACTION_REVIEW_KEY,
  TOPIC_NEVER_MENTIONED,
} from "../warehouse/fixtures/seqra-ceqr-access/sample_topic_extraction_fixtures.mjs";

const DEIS_CONTEXT = Object.freeze({
  documentKey: "review_document:environmental_review:ceqr:26DCP555Q:deis:2024-02-01:abcdef123456",
  documentType: "deis",
  reviewKey: TOPIC_EXTRACTION_REVIEW_KEY,
  fetchId: "fetch-0001",
  contentHash: "sha256:abcdef123456",
  rawObjectPath: "warehouse/raw/seqra-ceqr-access/documents/abcdef123456.bin",
  manualVintageId: "nyc_ceqr_technical_manual_2020",
  observedAt: "2026-09-04T00:00:00.000Z",
});

function buildAllFindings() {
  const deisFindings = extractTopicFindingsFromDocument({
    pages: TOPIC_DEIS_FIXTURE.pages.map((p) => ({ page_number: p.pageNumber, text: p.text, quality_state: p.qualityState })),
    context: DEIS_CONTEXT,
  });
  const commentFindings = extractCommentFindingsFromPage({
    pageNumber: 1,
    text: TOPIC_COMMENT_LETTER_FIXTURE.pages[0].text,
    context: { documentKey: "d:comment", documentType: "comment_letter", reviewKey: TOPIC_EXTRACTION_REVIEW_KEY, fetchId: "fetch-0002", contentHash: "sha256:aaaa1111", rawObjectPath: "warehouse/raw/x/aaaa1111.bin", observedAt: "2026-09-04T00:00:01.000Z" },
  });
  const responseFindings = extractResponseFindingsFromPage({
    pageNumber: 1,
    text: TOPIC_AGENCY_RESPONSE_FIXTURE.pages[0].text,
    context: { documentKey: "d:response", documentType: "agency_response", reviewKey: TOPIC_EXTRACTION_REVIEW_KEY, fetchId: "fetch-0003", contentHash: "sha256:bbbb2222", rawObjectPath: "warehouse/raw/x/bbbb2222.bin", observedAt: "2026-09-04T00:00:02.000Z" },
  });
  return [...deisFindings, ...commentFindings, ...responseFindings];
}

describe("seqra_topic_assessment_projection: A2 boundary (not_located vs screened_out) and full state derivation", () => {
  const findings = buildAllFindings();
  const projection = projectTopicAssessments({
    reviewKey: TOPIC_EXTRACTION_REVIEW_KEY,
    findings,
    manualVintageId: "nyc_ceqr_technical_manual_2020",
    observedAt: "2026-09-04T01:00:00.000Z",
    availableToPublicAt: "2026-09-04T01:00:00.000Z",
    sourceRecordId: "seqra05-gate-projection-0001",
  });

  function stateFor(topic) {
    return projection.assessments.find((a) => a.technical_topic === topic).state;
  }

  it(`records ${TOPIC_NEVER_MENTIONED} as not_located, never screened_out`, () => {
    assert.equal(stateFor(TOPIC_NEVER_MENTIONED), "not_located");
  });

  it("records historic_cultural_resources as screened_out only via its explicit screening finding", () => {
    assert.equal(stateFor("historic_cultural_resources"), "screened_out");
  });

  it("never conflates not_located and screened_out across the projection", () => {
    const notLocated = projection.assessments.filter((a) => a.state === "not_located").map((a) => a.technical_topic);
    const screenedOut = projection.assessments.filter((a) => a.state === "screened_out").map((a) => a.technical_topic);
    assert.equal(notLocated.includes("historic_cultural_resources"), false);
    assert.equal(screenedOut.includes(TOPIC_NEVER_MENTIONED), false);
  });

  it("projects shadows (impact + mitigation) as mitigation_proposed", () => {
    assert.equal(stateFor("shadows"), "mitigation_proposed");
  });

  it("projects transportation (threshold only) as detailed_analysis", () => {
    assert.equal(stateFor("transportation"), "detailed_analysis");
  });

  it("projects air_quality (impact only, no mitigation) as unmitigated", () => {
    assert.equal(stateFor("air_quality"), "unmitigated");
  });

  it("projects noise (comment + agency_response) as agency_response_complete", () => {
    assert.equal(stateFor("noise"), "agency_response_complete");
  });

  it("emits exactly one assessment per topic in the full SEQRA_TECHNICAL_TOPICS vocabulary", () => {
    assert.equal(projection.assessment_count, 21);
  });

  it("every projected assessment carries the full temporal-integrity envelope", () => {
    for (const a of projection.assessments) {
      assert.ok(a.observed_at);
      assert.ok(a.available_to_public_at);
      assert.ok(a.source_id);
      assert.ok(a.source_record_id);
      assert.ok("confidence" in a);
    }
  });
});
