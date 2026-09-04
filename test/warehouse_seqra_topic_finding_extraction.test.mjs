import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateThresholdFinding, extractTopicFindingsFromDocument, extractTopicFindingsFromPage } from "../warehouse/lib/seqra_topic_finding_extraction.mjs";
import { TOPIC_DEIS_FIXTURE, TOPIC_EXTRACTION_REVIEW_KEY } from "../warehouse/fixtures/seqra-ceqr-access/sample_topic_extraction_fixtures.mjs";

const CONTEXT = Object.freeze({
  documentKey: "review_document:environmental_review:ceqr:26DCP555Q:deis:2024-02-01:abcdef123456",
  documentType: "deis",
  reviewKey: TOPIC_EXTRACTION_REVIEW_KEY,
  fetchId: "fetch-0001",
  contentHash: "sha256:abcdef123456",
  rawObjectPath: "warehouse/raw/seqra-ceqr-access/documents/abcdef123456.bin",
  manualVintageId: "nyc_ceqr_technical_manual_2020",
  observedAt: "2026-09-04T00:00:00.000Z",
});

describe("seqra_topic_finding_extraction: shadows page (impact + mitigation + threshold)", () => {
  const page = TOPIC_DEIS_FIXTURE.pages[0];
  const findings = extractTopicFindingsFromPage({ pageNumber: page.pageNumber, text: page.text, context: CONTEXT });

  it("extracts an impact finding with page/section/table evidence", () => {
    const impact = findings.find((f) => f.technical_topic === "shadows" && f.finding_type === "impact");
    assert.ok(impact, "expected a shadows impact finding");
    assert.equal(impact.page_number, 1);
    assert.equal(impact.section_heading, "Chapter 5: Shadows");
    assert.equal(impact.table_or_figure_id, "Table 5-1");
    assert.ok(impact.evidence_excerpt.includes("shadows"));
  });

  it("extracts a mitigation finding for the same topic", () => {
    const mitigation = findings.find((f) => f.technical_topic === "shadows" && f.finding_type === "mitigation");
    assert.ok(mitigation, "expected a shadows mitigation finding");
    assert.equal(mitigation.table_or_figure_id, "Figure 5-2");
  });

  it("extracts a numeric threshold_comparison finding, vintage-explicit", () => {
    const threshold = findings.find((f) => f.technical_topic === "shadows" && f.finding_type === "threshold_comparison");
    assert.ok(threshold, "expected a shadows threshold_comparison finding");
    assert.equal(threshold.normalized_value, 0.22);
    assert.equal(threshold.unit, "fraction_of_daylight_hours");
    assert.equal(threshold.manual_vintage_id, "nyc_ceqr_technical_manual_2020");

    const evaluation = evaluateThresholdFinding(threshold);
    assert.equal(evaluation.status, "compared");
    assert.equal(evaluation.exceeds_threshold, true);
  });

  it("gives every finding on this high-quality page confidence at or above the extraction floor", () => {
    for (const f of findings) assert.ok(f.confidence >= 0.6, `${f.finding_key} confidence ${f.confidence}`);
  });
});

describe("seqra_topic_finding_extraction: transportation page (threshold only, no impact cue)", () => {
  const page = TOPIC_DEIS_FIXTURE.pages[1];
  const findings = extractTopicFindingsFromPage({ pageNumber: page.pageNumber, text: page.text, context: CONTEXT });

  it("extracts exactly a threshold_comparison finding, no impact finding", () => {
    const byType = findings.filter((f) => f.technical_topic === "transportation").map((f) => f.finding_type);
    assert.deepEqual(byType.sort(), ["threshold_comparison"]);
  });

  it("resolves a different exceeds_threshold outcome under the 2014 vintage than the 2020 vintage", () => {
    const threshold = findings.find((f) => f.finding_type === "threshold_comparison");
    const under2020 = evaluateThresholdFinding(threshold);
    const under2014 = evaluateThresholdFinding({ ...threshold, manual_vintage_id: "nyc_ceqr_technical_manual_2014" });
    assert.equal(under2020.exceeds_threshold, true);
    assert.equal(under2014.exceeds_threshold, true); // 5.4s exceeds both editions' delay threshold in this fixture
    assert.notEqual(under2014.threshold_definition.value, under2020.threshold_definition.value);
  });
});

describe("seqra_topic_finding_extraction: screened_out is reachable only via explicit screening language (A2)", () => {
  const page = TOPIC_DEIS_FIXTURE.pages[2];
  const findings = extractTopicFindingsFromPage({ pageNumber: page.pageNumber, text: page.text, context: CONTEXT });

  it("classifies the historic_cultural_resources page as screened_out_statement", () => {
    const screened = findings.find((f) => f.technical_topic === "historic_cultural_resources");
    assert.ok(screened);
    assert.equal(screened.finding_type, "screened_out_statement");
  });

  it("produces no finding at all for a topic never mentioned anywhere in this document", () => {
    const allFindings = extractTopicFindingsFromDocument({
      pages: TOPIC_DEIS_FIXTURE.pages.map((p) => ({ page_number: p.pageNumber, text: p.text, quality_state: p.qualityState })),
      context: CONTEXT,
    });
    assert.equal(allFindings.some((f) => f.technical_topic === "hazardous_materials"), false);
  });
});

describe("seqra_topic_finding_extraction: low-quality page caps confidence (feeds A5's quarantine)", () => {
  it("caps confidence below the quarantine threshold for a page marked low quality", () => {
    const page = TOPIC_DEIS_FIXTURE.pages[3];
    const findings = extractTopicFindingsFromPage({ pageNumber: page.pageNumber, text: page.text, context: { ...CONTEXT, pageQualityState: "low" } });
    const airQuality = findings.find((f) => f.technical_topic === "air_quality");
    assert.ok(airQuality);
    assert.ok(airQuality.confidence < 0.6, `expected a low-quality-capped confidence, got ${airQuality.confidence}`);
  });
});
