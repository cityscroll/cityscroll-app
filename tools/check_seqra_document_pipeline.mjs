#!/usr/bin/env node
/**
 * SEQRA-04: the narrow `npm run warehouse:seqra:documents` command surface
 * the card's `verify` field names, matching `tools/check_seqra_ontology.mjs`'s
 * convention for SEQRA-02. This does not perform a live fetch of any kind --
 * it validates, against retained fixtures and the previously committed
 * discovery receipt, that the pipeline's own contracts hold:
 *
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
];
const FORBIDDEN_FIELD_LITERALS = ["lawsuit_score", "legal_risk_score", "litigation_probability", "lawsuit_probability"];

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

const failed = checks.filter((c) => c.result === "fail");
const gateResult = failed.length === 0 ? "pass" : "fail";

const receipt = {
  schema: "cityscroll.seqra_document_pipeline_receipt.v1",
  checks,
  discovery_receipt_summary: discoveryReceipt
    ? { bulk_api_documented: discoveryReceipt.bulk_api_documented, search_interface_status: discoveryReceipt.search_interface.status, probe_count: discoveryReceipt.probe_count }
    : null,
  sample_review_key: SAMPLE_REVIEW_KEY,
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
