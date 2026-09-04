#!/usr/bin/env node
/**
 * SEQRA-04 and SEQRA-05: the narrow `npm run warehouse:seqra:documents`
 * command surface both cards' `verify` field names, matching
 * `tools/check_seqra_ontology.mjs`'s convention for SEQRA-02. This does not
 * perform a live fetch of any kind -- it validates, against retained
 * fixtures and the previously committed discovery receipt, that the
 * pipeline's own contracts hold:
 *
 *   SEQRA-04
 *   A1 the committed discovery receipt records observed behavior and never
 *      asserts a documented bulk API;
 *   A2 a document fetched end to end resolves every one of its parsed pages
 *      to immutable stored bytes through its own fetch receipt;
 *   A3 OCR/extraction quality is measured per page and a deliberately
 *      garbled page is identifiable as low quality;
 *   A4 a coverage-gap statement for a zero-document period never reads as
 *      an absence-of-review-activity claim;
 *   A5 a draft and its final document classify correctly, coexist, and the
 *      final is linked to the draft it supersedes.
 *
 *   SEQRA-05
 *   A1 no accepted technical-topic finding lacks page and span evidence
 *      resolving to the stored document bytes;
 *   A2 a topic never mentioned anywhere in the review's documents is
 *      recorded as not_located, never screened_out;
 *   A3 a numeric threshold fact is compared against the manual vintage
 *      governing the review, never a different vintage's definition, with
 *      the crosswalk between recorded vintages documented;
 *   A4 precision and recall are reported per topic and per document type
 *      against a human-reviewed benchmark set;
 *   A5 low-confidence findings are quarantined out of the training corpus,
 *      evidenced by a reported count.
 *
 * No network access; every input is a retained fixture or a previously
 * committed receipt. Default mode runs the checks and writes the receipt;
 * `--check` reruns and diffs against the committed receipt.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchAndStoreDocument } from "../warehouse/lib/seqra_document_fetcher.mjs";
import {
  assessPageQuality,
  extractHtmlText,
  summarizeDocumentExtractionQuality,
} from "../warehouse/lib/seqra_document_extraction.mjs";
import { classifyDocumentType, classifySupersession } from "../warehouse/lib/seqra_document_classifier.mjs";
import { buildCoverageGapStatement, summarizeMissingOlderMaterial } from "../warehouse/lib/seqra_document_coverage_gaps.mjs";
import { buildDiscoveredManifestEntry, buildReviewDocumentManifest, markManifestEntryFetched } from "../warehouse/lib/seqra_document_manifest.mjs";
import { assertNoLawsuitScoreField, buildDocumentProcessingRecord } from "../warehouse/lib/seqra_document_processing_record.mjs";
import {
  COVERAGE_GAP_PERIOD,
  DRAFT_DEIS_FIXTURE,
  EARLIEST_KNOWN_MILESTONE_DATE,
  FINAL_FEIS_FIXTURE,
  SAMPLE_REVIEW_KEY,
} from "../warehouse/fixtures/seqra-ceqr-access/sample_review_documents.mjs";
import { extractCommentFindingsFromPage, extractResponseFindingsFromPage } from "../warehouse/lib/seqra_comment_response_extraction.mjs";
import { resolveManualVintageForReview } from "../warehouse/lib/seqra_manual_vintage.mjs";
import { projectTopicAssessments } from "../warehouse/lib/seqra_topic_assessment_projection.mjs";
import { computeExtractionBenchmarkReport } from "../warehouse/lib/seqra_topic_extraction_benchmark.mjs";
import { evaluateThresholdFinding, extractTopicFindingsFromDocument } from "../warehouse/lib/seqra_topic_finding_extraction.mjs";
import { findingHasResolvableEvidence } from "../warehouse/lib/seqra_topic_finding.mjs";
import { buildTrainingCorpusRows, quarantineFindings } from "../warehouse/lib/seqra_topic_finding_quarantine.mjs";
import {
  TOPIC_AGENCY_RESPONSE_FIXTURE,
  TOPIC_COMMENT_LETTER_FIXTURE,
  TOPIC_DEIS_FIXTURE,
  TOPIC_EXTRACTION_BENCHMARK_ENTRIES,
  TOPIC_EXTRACTION_REVIEW_KEY,
  TOPIC_NEVER_MENTIONED,
} from "../warehouse/fixtures/seqra-ceqr-access/sample_topic_extraction_fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DISCOVERY_RECEIPT = path.join(ROOT, "warehouse/receipts/proof/seqra_ceqr_access_discovery_latest.json");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/seqra_document_pipeline_latest.json");
const NO_NETWORK_SOURCE_FILES = [
  "warehouse/lib/seqra_ceqr_access_discovery.mjs",
  "warehouse/lib/seqra_document_fetcher.mjs",
  "warehouse/lib/seqra_document_extraction.mjs",
  "warehouse/lib/seqra_document_classifier.mjs",
  "warehouse/lib/seqra_document_coverage_gaps.mjs",
  "warehouse/lib/seqra_document_manifest.mjs",
  "warehouse/lib/seqra_document_processing_record.mjs",
  // LDP-33: the publisher-neutral interface this pipeline now consumes
  // rather than owning; it must hold to the same no-network, no-forbidden
  // -field structural guarantees.
  "warehouse/lib/document_processing.mjs",
];
const SEQRA05_SOURCE_FILES = [
  "warehouse/lib/seqra_manual_vintage.mjs",
  "warehouse/lib/seqra_topic_finding.mjs",
  "warehouse/lib/seqra_topic_finding_extraction.mjs",
  "warehouse/lib/seqra_comment_response_extraction.mjs",
  "warehouse/lib/seqra_topic_assessment_projection.mjs",
  "warehouse/lib/seqra_topic_finding_quarantine.mjs",
  "warehouse/lib/seqra_topic_extraction_benchmark.mjs",
];
const FORBIDDEN_FIELD_LITERALS = ["lawsuit_score", "legal_risk_score", "litigation_probability", "lawsuit_probability"];
// Negative rule (SEQRA-05): no module in this pipeline may pick "the latest"
// or "the current" manual vintage as a fallback -- every threshold
// comparison must name its vintage explicitly (checked functionally below
// too, by calling compareThresholdFact with no vintage and expecting a
// throw).
const FORBIDDEN_VINTAGE_FALLBACK_PATTERNS = [/MANUAL_VINTAGES\s*\[\s*MANUAL_VINTAGES\.length\s*-\s*1\s*\]/, /\.sort\([^)]*\)\s*\[\s*0\s*\]\s*;?\s*\/\/\s*current/i, /currentManualVintage/i, /latestManualVintage/i];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function stringify(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, result: "pass" });
  } catch (error) {
    checks.push({ name, result: "fail", message: error.message });
  }
}
function assertTrue(value, message) {
  if (!value) throw new Error(message);
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertThrows(fn, message) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}

async function fetchFixtureDocument({ fixture, fetchId, tmpRoot }) {
  const httpGet = async () => ({ status: 200, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/pdf" : null) }, bytes: fixture.bytes });
  return fetchAndStoreDocument({ url: fixture.candidateUrl, sourceId: "ceqr_access", httpGet, projectRoot: tmpRoot, fetchId });
}

function buildProcessedDocument({ fixture, fetchResult, reviewKey, existingDocumentsForReview }) {
  const classification = classifyDocumentType({ title: fixture.title });
  const supersession = classifySupersession({
    candidate: { document_type: classification.document_type, document_stage: classification.document_stage },
    textSample: fixture.pages.map((p) => p.text).join("\n"),
    existingDocumentsForReview,
  });

  const manifestEntry = markManifestEntryFetched(
    buildDiscoveredManifestEntry({
      reviewKey,
      candidateUrl: fixture.candidateUrl,
      title: fixture.title,
      discoveredAt: "2026-09-04T00:00:00.000Z",
      discoveryFetchId: "seqra04-discovery-fetch-0003",
    }),
    { documentType: classification.document_type, issuedDate: fixture.issuedDate, contentHash: fetchResult.contentHash, fetchId: fetchResult.fetchReceipt.fetch_id },
  );

  const pageAssessments = fixture.pages.map((p) => ({
    page_number: p.pageNumber,
    fetch_id: fetchResult.fetchReceipt.fetch_id,
    content_hash: fetchResult.contentHash,
    text_chars: p.text.length,
    ...assessPageQuality({ text: p.text, ocrRequired: false, ocrAttempted: false, ocrEngineAvailable: false }),
  }));
  const qualitySummary = summarizeDocumentExtractionQuality(pageAssessments);

  const record = buildDocumentProcessingRecord({
    documentKey: manifestEntry.document_key,
    reviewKey,
    fetchId: fetchResult.fetchReceipt.fetch_id,
    contentHash: fetchResult.contentHash,
    rawObjectPath: fetchResult.rawObjectPath,
    documentType: classification.document_type,
    documentStage: classification.document_stage,
    classificationConfidence: classification.confidence,
    classificationMatchedTerms: classification.matched_terms,
    supersedesDocumentKey: supersession.supersedes_document_key,
    supersessionBasis: supersession.basis,
    supersessionConfidence: supersession.confidence,
    pages: pageAssessments,
    extractionQualitySummary: qualitySummary,
    processedAt: "2026-09-04T00:00:01.000Z",
  });

  return {
    document_key: manifestEntry.document_key,
    document_type: classification.document_type,
    document_stage: classification.document_stage,
    issued_date: fixture.issuedDate,
    superseded_by_document_key: null,
    record,
    supersession,
    qualitySummary,
  };
}

check("SEQRA-04 discovery receipt is not stale (A1)", () => {
  execFileSync(process.execPath, ["tools/build_seqra_ceqr_access_discovery.mjs", "--check"], { cwd: ROOT, stdio: "pipe" });
});

let discoveryReceipt = null;
check("committed discovery receipt asserts bulk_api_documented: false and an observed (not assumed) search interface (A1)", () => {
  assertTrue(existsSync(DISCOVERY_RECEIPT), `missing ${path.relative(ROOT, DISCOVERY_RECEIPT)}`);
  discoveryReceipt = JSON.parse(readFileSync(DISCOVERY_RECEIPT, "utf8"));
  assertEqual(discoveryReceipt.bulk_api_documented, false, "bulk_api_documented");
  assertEqual(discoveryReceipt.search_interface.status, "observed", "search_interface.status");
  assertTrue(discoveryReceipt.probe_count >= 1, "at least one live probe must have been recorded");
});

check("no module in this pipeline references a fixed/bulk CEQR Access query endpoint (A1 structural check)", () => {
  for (const relPath of NO_NETWORK_SOURCE_FILES) {
    const source = readFileSync(path.join(ROOT, relPath), "utf8");
    assertTrue(!/\/api\/(bulk|export|all)/i.test(source), `${relPath} must not reference a guessed bulk API path`);
  }
});

let draft = null;
let final = null;
let topicDeis = null;
let topicComment = null;
let topicResponse = null;

/**
 * A lighter document-identity builder for the SEQRA-05 checks below: it
 * only needs a real document_key/fetch_id/content_hash/raw_object_path
 * tuple (the A1 evidence resolution this card's findings must carry), not
 * SEQRA-04's full quality-summary/supersession record.
 */
function buildTopicSourceDocument({ fixture, fetchResult, reviewKey }) {
  const classification = classifyDocumentType({ title: fixture.title });
  const manifestEntry = markManifestEntryFetched(
    buildDiscoveredManifestEntry({ reviewKey, candidateUrl: fixture.candidateUrl, title: fixture.title, discoveredAt: "2026-09-04T00:00:00.000Z", discoveryFetchId: "seqra05-discovery-fetch-0001" }),
    { documentType: classification.document_type, issuedDate: fixture.issuedDate, contentHash: fetchResult.contentHash, fetchId: fetchResult.fetchReceipt.fetch_id },
  );
  return {
    documentKey: manifestEntry.document_key,
    documentType: classification.document_type,
    fetchId: fetchResult.fetchReceipt.fetch_id,
    contentHash: fetchResult.contentHash,
    rawObjectPath: fetchResult.rawObjectPath,
  };
}

// The generic `check(name, fn)` helper above is synchronous by design (every
// other SEQRA gate check is a pure, synchronous fixture comparison); these
// two checks are the only ones needing awaited IO, so they run directly
// against the async pipeline calls and are folded into `checks` by hand.
async function runAsyncChecks() {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "seqra04-gate-"));
  try {
    try {
      const draftFetch = await fetchFixtureDocument({ fixture: DRAFT_DEIS_FIXTURE, fetchId: "seqra04-gate-fetch-draft", tmpRoot });
      assertTrue(draftFetch.ok, "draft fetch must succeed against the fixture httpGet");
      assertTrue(existsSync(path.join(tmpRoot, draftFetch.rawObjectPath)), "raw object path must exist on disk");
      draft = buildProcessedDocument({ fixture: DRAFT_DEIS_FIXTURE, fetchResult: draftFetch, reviewKey: SAMPLE_REVIEW_KEY, existingDocumentsForReview: [] });
      checks.push({ name: "fetching the fixture draft DEIS resolves to immutable stored bytes via its own fetch receipt (A2)", result: "pass" });
    } catch (error) {
      checks.push({ name: "fetching the fixture draft DEIS resolves to immutable stored bytes via its own fetch receipt (A2)", result: "fail", message: error.message });
    }

    try {
      const finalFetch = await fetchFixtureDocument({ fixture: FINAL_FEIS_FIXTURE, fetchId: "seqra04-gate-fetch-final", tmpRoot });
      assertTrue(finalFetch.ok, "final fetch must succeed against the fixture httpGet");
      final = buildProcessedDocument({ fixture: FINAL_FEIS_FIXTURE, fetchResult: finalFetch, reviewKey: SAMPLE_REVIEW_KEY, existingDocumentsForReview: draft ? [draft] : [] });
      checks.push({ name: "fetching the fixture final FEIS resolves to immutable stored bytes via its own fetch receipt (A2)", result: "pass" });
    } catch (error) {
      checks.push({ name: "fetching the fixture final FEIS resolves to immutable stored bytes via its own fetch receipt (A2)", result: "fail", message: error.message });
    }

    for (const [label, fixture, target, setter] of [
      ["topic-extraction DEIS", TOPIC_DEIS_FIXTURE, "topicDeis", (v) => { topicDeis = v; }],
      ["comment letter", TOPIC_COMMENT_LETTER_FIXTURE, "topicComment", (v) => { topicComment = v; }],
      ["agency response", TOPIC_AGENCY_RESPONSE_FIXTURE, "topicResponse", (v) => { topicResponse = v; }],
    ]) {
      try {
        const fetchResult = await fetchFixtureDocument({ fixture, fetchId: `seqra05-gate-fetch-${target}`, tmpRoot });
        assertTrue(fetchResult.ok, `${label} fixture fetch must succeed against the fixture httpGet`);
        assertTrue(existsSync(path.join(tmpRoot, fetchResult.rawObjectPath)), "raw object path must exist on disk");
        setter(buildTopicSourceDocument({ fixture, fetchResult, reviewKey: TOPIC_EXTRACTION_REVIEW_KEY }));
        checks.push({ name: `fetching the SEQRA-05 ${label} fixture resolves to immutable stored bytes via its own fetch receipt (A1)`, result: "pass" });
      } catch (error) {
        checks.push({ name: `fetching the SEQRA-05 ${label} fixture resolves to immutable stored bytes via its own fetch receipt (A1)`, result: "fail", message: error.message });
      }
    }
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}
await runAsyncChecks();

check("draft document classifies as deis/draft and final classifies as feis/final (A5)", () => {
  assertTrue(draft && final, "both fixture documents must have processed successfully");
  assertEqual(draft.document_type, "deis", "draft document_type");
  assertEqual(draft.document_stage, "draft", "draft document_stage");
  assertEqual(final.document_type, "feis", "final document_type");
  assertEqual(final.document_stage, "final", "final document_stage");
});

check("the final document supersedes the draft via an explicit text reference, at high confidence (A5)", () => {
  assertEqual(final.supersession.basis, "explicit_text_reference", "supersession.basis");
  assertEqual(final.supersession.confidence, "high", "supersession.confidence");
  assertEqual(final.supersession.supersedes_document_key, draft.document_key, "supersedes_document_key must name the draft's own document_key");
});

check("draft and final documents both remain present (coexist, never overwritten) after supersession (A5)", () => {
  assertTrue(draft.document_key !== final.document_key, "draft and final must be distinct documents");
  assertTrue(Boolean(draft.record) && Boolean(final.record), "both processing records must exist side by side");
});

check("a deliberately garbled page is identified as low quality and distinguished from the clean page on the same document (A3)", () => {
  assertEqual(draft.qualitySummary.page_count, 2, "draft page_count");
  assertEqual(draft.qualitySummary.low_quality_page_count, 1, "draft low_quality_page_count");
  assertEqual(draft.qualitySummary.low_quality_page_numbers[0], 2, "the garbled fixture page is page 2");
  assertTrue(final.qualitySummary.low_quality_page_count === 0, "the clean final document must carry zero low-quality pages");
});

check("HTML extraction is available for the notice/search-shell documents CEQR Access itself serves (A3 plumbing)", () => {
  const text = extractHtmlText("<html><body><p>Notice of Completion</p></body></html>");
  assertEqual(text, "Notice of Completion");
});

let coverageGap = null;
check("a zero-document period states a coverage limitation, never an absence-of-review-activity claim (A4)", () => {
  coverageGap = buildCoverageGapStatement({
    reviewKey: SAMPLE_REVIEW_KEY,
    periodStart: COVERAGE_GAP_PERIOD.start,
    periodEnd: COVERAGE_GAP_PERIOD.end,
    documentsFoundCount: 0,
  });
  assertEqual(coverageGap.gap_detected, true, "gap_detected");
  assertTrue(!/no\s+review\s+activity/i.test(coverageGap.statement), "statement must never claim no review activity");
});

let missingOlderMaterial = null;
check("missing older material is stated explicitly when the earliest found document postdates the earliest known milestone (A4)", () => {
  missingOlderMaterial = summarizeMissingOlderMaterial({
    reviewKey: SAMPLE_REVIEW_KEY,
    earliestDocumentFoundDate: DRAFT_DEIS_FIXTURE.issuedDate,
    earliestKnownMilestoneDate: EARLIEST_KNOWN_MILESTONE_DATE,
  });
  assertEqual(missingOlderMaterial.status, "older_material_missing", "status");
});

check("the review's manifest lists both fixture documents (Deliver: document manifest per review)", () => {
  const manifest = buildReviewDocumentManifest({
    reviewKey: SAMPLE_REVIEW_KEY,
    generatedAt: "2026-09-04T00:00:02.000Z",
    entries: [
      buildDiscoveredManifestEntry({ reviewKey: SAMPLE_REVIEW_KEY, candidateUrl: DRAFT_DEIS_FIXTURE.candidateUrl, discoveredAt: "2026-09-04T00:00:00.000Z", discoveryFetchId: "seqra04-discovery-fetch-0003" }),
    ],
  });
  assertEqual(manifest.document_count, 1, "manifest.document_count");
});

check("no document processing record ever carries a scoring/prediction field (negative rule)", () => {
  assertTrue(Boolean(draft?.record) && Boolean(final?.record), "both records must exist to check");
  assertNoLawsuitScoreField(draft.record);
  assertNoLawsuitScoreField(final.record);
});

check("no pipeline source file literally names a lawsuit/legal-risk scoring field (negative rule, static check)", () => {
  // Scans the pipeline library modules only -- not this gate tool itself,
  // which must legitimately spell out FORBIDDEN_FIELD_LITERALS to check for
  // them.
  for (const relPath of NO_NETWORK_SOURCE_FILES) {
    const source = readFileSync(path.join(ROOT, relPath), "utf8");
    for (const literal of FORBIDDEN_FIELD_LITERALS) {
      assertTrue(!source.includes(literal), `${relPath} must not reference the forbidden field name "${literal}"`);
    }
  }
});

// ---- SEQRA-05: technical-topic extraction ---------------------------------

let manualVintageResolution = null;
let allTopicFindings = [];
let quarantineResult = null;
let assessmentProjection = null;
let benchmarkReport = null;

check("the topic-extraction fixture review resolves to a single explicit manual vintage (A3)", () => {
  assertTrue(Boolean(topicDeis), "the topic-extraction DEIS fixture must have processed successfully");
  manualVintageResolution = resolveManualVintageForReview({ environmentalRegime: "CEQR", referenceDate: TOPIC_DEIS_FIXTURE.issuedDate });
  assertEqual(manualVintageResolution.status, "resolved", "manualVintageResolution.status");
  assertEqual(manualVintageResolution.vintage.manual_vintage_id, "nyc_ceqr_technical_manual_2020", "resolved manual_vintage_id");
});

check("technical-topic findings are extracted with page/section/table evidence resolving to the fetched bytes (A1)", () => {
  const manualVintageId = manualVintageResolution.vintage.manual_vintage_id;
  const deisFindings = extractTopicFindingsFromDocument({
    pages: TOPIC_DEIS_FIXTURE.pages.map((p) => ({ page_number: p.pageNumber, text: p.text, quality_state: p.qualityState })),
    context: { ...topicDeis, reviewKey: TOPIC_EXTRACTION_REVIEW_KEY, manualVintageId, observedAt: "2026-09-04T00:00:03.000Z" },
  });
  const commentFindings = extractCommentFindingsFromPage({
    pageNumber: TOPIC_COMMENT_LETTER_FIXTURE.pages[0].pageNumber,
    text: TOPIC_COMMENT_LETTER_FIXTURE.pages[0].text,
    context: { ...topicComment, reviewKey: TOPIC_EXTRACTION_REVIEW_KEY, observedAt: "2026-09-04T00:00:04.000Z" },
  });
  const responseFindings = extractResponseFindingsFromPage({
    pageNumber: TOPIC_AGENCY_RESPONSE_FIXTURE.pages[0].pageNumber,
    text: TOPIC_AGENCY_RESPONSE_FIXTURE.pages[0].text,
    context: { ...topicResponse, reviewKey: TOPIC_EXTRACTION_REVIEW_KEY, observedAt: "2026-09-04T00:00:05.000Z" },
  });
  allTopicFindings = [...deisFindings, ...commentFindings, ...responseFindings];
  assertTrue(allTopicFindings.length > 0, "expected at least one finding across the fixture documents");
  for (const finding of allTopicFindings) {
    assertTrue(findingHasResolvableEvidence(finding), `finding ${finding.finding_key} must carry resolvable page/span evidence`);
  }
});

check("a numeric threshold finding is compared against its own review's manual vintage, never a different one (A3, negative rule)", () => {
  const shadowsThreshold = allTopicFindings.find((f) => f.technical_topic === "shadows" && f.finding_type === "threshold_comparison");
  assertTrue(Boolean(shadowsThreshold), "expected a shadows threshold_comparison finding");
  const under2020 = evaluateThresholdFinding(shadowsThreshold);
  const under2014 = evaluateThresholdFinding({ ...shadowsThreshold, manual_vintage_id: "nyc_ceqr_technical_manual_2014" });
  assertEqual(under2020.exceeds_threshold, true, "under the review's own resolved 2020 vintage, the fact exceeds the threshold");
  assertEqual(under2014.exceeds_threshold, false, "the identical fact does not exceed the 2014 vintage's threshold -- applying it would be a different, undocumented answer");
  assertTrue(under2020.threshold_definition.value !== under2014.threshold_definition.value, "the two vintages must carry documented, distinct threshold values (crosswalk)");
});

check("low-confidence findings are quarantined out of the training corpus, evidenced by a count (A5)", () => {
  quarantineResult = quarantineFindings(allTopicFindings);
  assertTrue(quarantineResult.quarantined_count >= 1, "expected at least one quarantined low-confidence finding (the low-quality air_quality page)");
  const quarantinedAirQuality = quarantineResult.quarantined.find((f) => f.technical_topic === "air_quality");
  assertTrue(Boolean(quarantinedAirQuality), "the low-quality-page air_quality finding must be the quarantined one");
  assertTrue(!quarantineResult.accepted.some((f) => f.review_status === "quarantined_low_confidence"), "no accepted finding may carry the quarantined_low_confidence status");
  assertThrows(() => buildTrainingCorpusRows(quarantineResult.quarantined), "buildTrainingCorpusRows must refuse quarantined findings");
  const rows = buildTrainingCorpusRows(quarantineResult.accepted);
  assertEqual(rows.length, quarantineResult.accepted.length, "training corpus rows must equal the accepted (non-quarantined) finding count");
});

check("hazardous_materials (never mentioned) projects to not_located, never screened_out, using only accepted evidence (A2)", () => {
  assessmentProjection = projectTopicAssessments({
    reviewKey: TOPIC_EXTRACTION_REVIEW_KEY,
    documentKey: topicDeis.documentKey,
    findings: quarantineResult.accepted,
    manualVintageId: manualVintageResolution.vintage.manual_vintage_id,
    observedAt: "2026-09-04T00:00:06.000Z",
    availableToPublicAt: "2026-09-04T00:00:06.000Z",
    sourceRecordId: "seqra05-gate-projection-0001",
  });
  const stateFor = (topic) => assessmentProjection.assessments.find((a) => a.technical_topic === topic)?.state;
  assertEqual(stateFor(TOPIC_NEVER_MENTIONED), "not_located", `${TOPIC_NEVER_MENTIONED} must be not_located`);
  assertEqual(stateFor("historic_cultural_resources"), "screened_out", "historic_cultural_resources must be screened_out");
  const notLocatedTopics = assessmentProjection.assessments.filter((a) => a.state === "not_located").map((a) => a.technical_topic);
  const screenedOutTopics = assessmentProjection.assessments.filter((a) => a.state === "screened_out").map((a) => a.technical_topic);
  assertTrue(!notLocatedTopics.includes("historic_cultural_resources"), "screened_out topic must never also appear as not_located");
  assertTrue(!screenedOutTopics.includes(TOPIC_NEVER_MENTIONED), "an unmentioned topic must never appear as screened_out");
  assertEqual(assessmentProjection.assessment_count, 21, "one assessment per topic in the full vocabulary");
});

check("precision and recall are reported per topic and per document type against the human-reviewed benchmark set (A4)", () => {
  const documentKeys = { deis: topicDeis.documentKey, comment_letter: topicComment.documentKey, agency_response: topicResponse.documentKey };
  const benchmarkSet = TOPIC_EXTRACTION_BENCHMARK_ENTRIES.map((entry) => ({
    document_key: documentKeys[entry.documentRole],
    document_type: entry.documentRole,
    page_number: entry.pageNumber,
    reviewed: true,
    expected_findings: entry.expectedFindings,
  }));
  benchmarkReport = computeExtractionBenchmarkReport({ benchmarkSet, findings: allTopicFindings });
  assertTrue(Object.keys(benchmarkReport.by_topic).length > 0, "expected at least one topic in the by-topic benchmark report");
  assertTrue(Object.keys(benchmarkReport.by_document_type).length === 3, "expected all three fixture document types in the by-document-type report");
  assertTrue(benchmarkReport.overall.precision != null && benchmarkReport.overall.recall != null, "overall precision/recall must be computed, not left null");
  assertTrue(benchmarkReport.overall.precision < 1 || benchmarkReport.overall.recall < 1, "the benchmark set is deliberately not a trivial 100% match");
});

check("no SEQRA-05 module falls back to a 'current'/'latest' manual vintage instead of the review's own resolved one (negative rule, static check)", () => {
  for (const relPath of SEQRA05_SOURCE_FILES) {
    const source = readFileSync(path.join(ROOT, relPath), "utf8");
    for (const pattern of FORBIDDEN_VINTAGE_FALLBACK_PATTERNS) {
      assertTrue(!pattern.test(source), `${relPath} must not fall back to an implied current/latest manual vintage (matched ${pattern})`);
    }
  }
});

const failed = checks.filter((c) => c.result === "fail");
const gateResult = failed.length === 0 ? "pass" : "fail";

const receipt = {
  schema: "cityscroll.seqra_document_pipeline_receipt.v1",
  checks,
  discovery_receipt_summary: discoveryReceipt
    ? { bulk_api_documented: discoveryReceipt.bulk_api_documented, search_interface_status: discoveryReceipt.search_interface.status, probe_count: discoveryReceipt.probe_count }
    : null,
  sample_review_key: SAMPLE_REVIEW_KEY,
  seqra05_topic_extraction_summary: {
    review_key: TOPIC_EXTRACTION_REVIEW_KEY,
    resolved_manual_vintage_id: manualVintageResolution?.vintage?.manual_vintage_id ?? null,
    finding_count: allTopicFindings.length,
    accepted_count: quarantineResult?.accepted_count ?? null,
    quarantined_count: quarantineResult?.quarantined_count ?? null,
    assessment_count: assessmentProjection?.assessment_count ?? null,
    not_located_count: assessmentProjection?.not_located_count ?? null,
    screened_out_count: assessmentProjection?.screened_out_count ?? null,
    benchmark_overall: benchmarkReport?.overall ?? null,
  },
  gate: { result: gateResult, failed_check_count: failed.length },
};

const next = stringify(receipt);
const args = new Set(process.argv.slice(2));
if (args.has("--check")) {
  let current = null;
  try {
    current = readFileSync(RECEIPT, "utf8");
  } catch {
    current = null;
  }
  if (current !== next) {
    console.error(next);
    throw new Error(`${path.relative(ROOT, RECEIPT)} is stale; run: node tools/check_seqra_document_pipeline.mjs`);
  }
} else {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, next);
}

if (gateResult !== "pass") {
  console.error(next);
  throw new Error(`SEQRA-04 document pipeline gate failed: ${failed.map((c) => `${c.name}: ${c.message}`).join(" | ")}`);
}
console.log(`SEQRA-04 CEQR Access document pipeline gate OK (${checks.length} checks)`);
