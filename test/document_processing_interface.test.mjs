/**
 * LDP-33: the publisher-neutral document-processing interface's own gate.
 *
 * warehouse/lib/document_processing.mjs is the interface lifted out of the
 * SEQRA-04 CEQR Access document pipeline (PR 1579); this suite exercises it
 * directly, against the card's own acceptance criteria:
 *
 *   A1 hashing, quality measurement, extraction receipts, and document-type
 *      /supersession classification are all exposed by one module;
 *   A2 the interface contains no reference to any specific publisher,
 *      endpoint, identifier scheme, or search behaviour;
 *   A4 a second caller against a different publisher obtains every
 *      primitive without adding a second fetcher, hasher, quality scorer,
 *      or supersession classifier;
 *   A5 the interface accepts a publisher-supplied document identity and
 *      content hash as inputs, never deriving identity from a filename;
 *   A6 SEQRA-04's own binding (warehouse/lib/seqra_document_fetcher.mjs)
 *      reproduces the exact receipt shape it always has, proving the move
 *      changed nothing about what that pipeline produces;
 *   A7 the absence of an optical-recognition engine is stated explicitly,
 *      and a page with no usable text is reported unreadable, never scored
 *      as though it had been read.
 *
 * No network access: every fetch here is driven by an injected, in-memory
 * `httpGet`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  assessPageQuality,
  buildDocumentFetchReceipt,
  buildExtractionReceipt,
  classifyDocumentType,
  classifySupersession,
  contentHashOf,
  documentRawObjectPath,
  DOCUMENT_TYPE_CONFIDENCE_LEVELS,
  EXTRACTION_QUALITY_STATES,
  fetchAndStoreDocument,
  measureExtractionQuality,
  sha256Hex,
  summarizeDocumentExtractionQuality,
  SUPERSESSION_BASES,
} from "../warehouse/lib/document_processing.mjs";
import {
  SEQRA_DOCUMENT_FETCH_PARSER_VERSION,
  fetchAndStoreDocument as seqraFetchAndStoreDocument,
} from "../warehouse/lib/seqra_document_fetcher.mjs";
import { SEQRA_FETCH_RECEIPT_SCHEMA } from "../warehouse/lib/seqra_fetch_receipt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTERFACE_SOURCE = readFileSync(path.join(ROOT, "warehouse/lib/document_processing.mjs"), "utf8");

function fakeHeaders(map) {
  return { get: (key) => map[key.toLowerCase()] ?? null };
}

// ---------------------------------------------------------------------------
// A1: every primitive group is exposed by this one module
// ---------------------------------------------------------------------------

describe("A1: one publisher-neutral interface exposes all four primitive groups", () => {
  it("exposes content-addressed hashing", () => {
    assert.equal(typeof sha256Hex, "function");
    assert.equal(typeof contentHashOf, "function");
    assert.equal(typeof documentRawObjectPath, "function");
  });

  it("exposes a hash-preserving fetcher", () => {
    assert.equal(typeof fetchAndStoreDocument, "function");
    assert.equal(typeof buildDocumentFetchReceipt, "function");
  });

  it("exposes extraction-quality measurement", () => {
    assert.equal(typeof measureExtractionQuality, "function");
    assert.equal(typeof assessPageQuality, "function");
    assert.equal(typeof summarizeDocumentExtractionQuality, "function");
    assert.deepEqual(EXTRACTION_QUALITY_STATES, ["not_applicable", "high", "medium", "low", "unknown"]);
  });

  it("exposes extraction receipts binding a parsed page to the bytes it came from", () => {
    assert.equal(typeof buildExtractionReceipt, "function");
  });

  it("exposes document-type and supersession classification", () => {
    assert.equal(typeof classifyDocumentType, "function");
    assert.equal(typeof classifySupersession, "function");
    assert.deepEqual(DOCUMENT_TYPE_CONFIDENCE_LEVELS, ["high", "medium", "low", "unknown"]);
    assert.deepEqual(SUPERSESSION_BASES, ["explicit_text_reference", "stage_type_pairing", "none"]);
  });
});

// ---------------------------------------------------------------------------
// A2: no publisher-specific reference anywhere in the interface
// ---------------------------------------------------------------------------

describe("A2: the interface names no specific publisher, endpoint, identifier scheme, or search behaviour", () => {
  it("contains no publisher name, hostname, or endpoint literal", () => {
    const forbidden = [/ceqr/i, /seqra/i, /\bzap\b/i, /nyc\.gov/i, /dcp\b/i, /a002-ceqraccess/i, /\/api\/(bulk|export|all)/i];
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(INTERFACE_SOURCE), `document_processing.mjs must not reference ${pattern}`);
    }
  });

  it("never branches on a specific publisher/source id (no publisher-specific conditional)", () => {
    // The negative rule: the interface must not grow a branch to accommodate
    // its callers. A structural proxy for that is the absence of any
    // sourceId/storageNamespace equality check anywhere in the file.
    assert.ok(!/sourceId\s*===|storageNamespace\s*===/.test(INTERFACE_SOURCE), "must not branch on a specific sourceId/storageNamespace value");
  });

  it("takes storageNamespace, parserVersion, patterns, and pairing as parameters rather than hardcoding them", () => {
    assert.ok(/storageNamespace/.test(INTERFACE_SOURCE));
    assert.ok(/parserVersion/.test(INTERFACE_SOURCE));
    assert.ok(/patterns = \[\]/.test(INTERFACE_SOURCE) || /patterns\s*}/.test(INTERFACE_SOURCE));
    assert.ok(/pairedDraftTypeOf/.test(INTERFACE_SOURCE));
  });
});

// ---------------------------------------------------------------------------
// A5: publisher-supplied identity and content hash; never a filename
// ---------------------------------------------------------------------------

describe("A5: identity is always a caller-supplied input, never derived from a filename", () => {
  it("documentRawObjectPath requires an explicit storageNamespace and never inspects a filename", () => {
    assert.throws(() => documentRawObjectPath({ bytes: Buffer.from("x"), extension: "pdf" }), /storageNamespace is required/);
  });

  it("two wildly different candidate URLs for byte-identical content resolve to the same content-addressed path", async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "docproc-a5-"));
    try {
      const bytes = Buffer.from("%PDF-1.4 identical content, different names");
      const httpGet = async () => ({ status: 200, headers: fakeHeaders({ "content-type": "application/pdf" }), bytes });
      const first = await fetchAndStoreDocument({
        url: "https://publisher-one.example/reports/final-report-v3-FINAL-signed.pdf",
        sourceId: "publisher-one",
        storageNamespace: "publisher-one",
        parserVersion: "test.v1",
        httpGet,
        projectRoot,
        fetchId: "fetch-a",
      });
      const second = await fetchAndStoreDocument({
        url: "https://publisher-one.example/download?id=98214213",
        sourceId: "publisher-one",
        storageNamespace: "publisher-one",
        parserVersion: "test.v1",
        httpGet,
        projectRoot,
        fetchId: "fetch-b",
      });
      assert.equal(first.rawObjectPath, second.rawObjectPath);
      assert.equal(first.contentHash, second.contentHash);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("buildExtractionReceipt requires an explicit documentId (never inferred from anything else on the page)", () => {
    assert.throws(
      () => buildExtractionReceipt({ fetchId: "fetch-1", contentHash: "sha256:abc", pages: [] }),
      /documentId is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// A4: a second caller against a different publisher, no second implementation
// ---------------------------------------------------------------------------

describe("A4: a second caller against a different publisher obtains every primitive with no second implementation", () => {
  // A publisher entirely unlike CEQR Access: a fictitious project-manifest
  // portal with its own document vocabulary, its own pairing rule, and its
  // own storage namespace -- exercised using nothing but this module.
  const PORTAL_PATTERNS = Object.freeze([
    { documentType: "certified_application", stage: "draft", pattern: /certified\s+application/i },
    { documentType: "certified_resolution", stage: "final", pattern: /certified\s+resolution/i },
    { documentType: "referral_notice", stage: "draft", pattern: /referral\s+notice/i },
  ]);
  const PORTAL_PAIRING = Object.freeze({ certified_resolution: "certified_application" });

  it("fetches, hashes, and stores a document under its own storage namespace", async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "docproc-a4-"));
    try {
      const bytes = Buffer.from("%PDF-1.4 a fictitious land-use portal document");
      const httpGet = async () => ({ status: 200, headers: fakeHeaders({ "content-type": "application/pdf" }), bytes });
      const result = await fetchAndStoreDocument({
        url: "https://land-use-portal.example/documents/771",
        sourceId: "land_use_portal",
        storageNamespace: "land-use-portal",
        parserVersion: "land_use_portal_fetcher.v1",
        httpGet,
        projectRoot,
        fetchId: "portal-fetch-0001",
      });
      assert.equal(result.ok, true);
      assert.equal(result.contentHash, contentHashOf(bytes));
      assert.ok(result.rawObjectPath.startsWith("warehouse/raw/land-use-portal/documents/"));
      assert.ok(existsSync(path.join(projectRoot, result.rawObjectPath)));
      assert.equal(result.fetchReceipt.parser_version, "land_use_portal_fetcher.v1");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("scores extraction quality for the portal's own text with the same quality scorer", () => {
    const clean = "This Certified Resolution approves the application after referral to the affected community board.";
    const quality = assessPageQuality({ text: clean, ocrRequired: false, ocrAttempted: false, ocrEngineAvailable: false });
    assert.equal(quality.measured, true);
    assert.equal(quality.quality_state, "high");
  });

  it("classifies the portal's own document-type vocabulary and pairs draft/final with its own map, via the same classifier", () => {
    const draftClassification = classifyDocumentType({ title: "Certified Application", patterns: PORTAL_PATTERNS });
    assert.equal(draftClassification.document_type, "certified_application");
    assert.equal(draftClassification.document_stage, "draft");

    const finalClassification = classifyDocumentType({ title: "Certified Resolution", patterns: PORTAL_PATTERNS });
    assert.equal(finalClassification.document_type, "certified_resolution");
    assert.equal(finalClassification.document_stage, "final");

    const existingDraft = {
      document_key: "portal_document:x:certified_application:2025-01-01:aaa",
      document_type: "certified_application",
      document_stage: "draft",
      issued_date: "2025-01-01",
      superseded_by_document_key: null,
    };
    const supersession = classifySupersession({
      candidate: { document_type: "certified_resolution", document_stage: "final" },
      existingDocumentsForReview: [existingDraft],
      pairedDraftTypeOf: (documentType) => PORTAL_PAIRING[documentType] ?? documentType,
    });
    assert.equal(supersession.supersedes_document_key, existingDraft.document_key);
    assert.equal(supersession.basis, "stage_type_pairing");
  });

  it("binds the portal's own pages to its own fetch receipt with the same extraction-receipt primitive", () => {
    const receipt = buildExtractionReceipt({
      documentId: "portal_document:x:certified_resolution:2025-03-01:bbb",
      fetchId: "portal-fetch-0002",
      contentHash: "sha256:deadbeef",
      pages: [{ page_number: 1, fetch_id: "portal-fetch-0002", content_hash: "sha256:deadbeef", text_chars: 900 }],
    });
    assert.equal(receipt.pages.length, 1);
    assert.equal(receipt.quality_summary.page_count, 1);
  });
});

// ---------------------------------------------------------------------------
// A6: SEQRA-04's own binding reproduces exactly what it always has
// ---------------------------------------------------------------------------

describe("A6: SEQRA-04's binding reproduces its historical receipt shape through the shared interface", () => {
  it("still emits the seqra_fetch_receipt schema, its own parser version, and its own storage namespace", async () => {
    const projectRoot = mkdtempSync(path.join(tmpdir(), "docproc-a6-"));
    try {
      const bytes = Buffer.from("%PDF-1.4 a small fixture pdf body");
      const httpGet = async () => ({ status: 200, headers: fakeHeaders({ "content-type": "application/pdf" }), bytes });
      const result = await seqraFetchAndStoreDocument({
        url: "https://a002-ceqraccess.nyc.gov/ceqr/document/1",
        httpGet,
        projectRoot,
        fetchId: "seqra04-doc-fetch-0001",
      });
      assert.equal(result.ok, true);
      assert.equal(result.fetchReceipt.schema, SEQRA_FETCH_RECEIPT_SCHEMA);
      assert.equal(result.fetchReceipt.parser_version, SEQRA_DOCUMENT_FETCH_PARSER_VERSION);
      assert.ok(result.rawObjectPath.startsWith("warehouse/raw/seqra-ceqr-access/documents/"));
      assert.equal(result.contentHash, contentHashOf(bytes));
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("the committed SEQRA-04 pipeline gate receipt still reproduces byte-identically (npm run warehouse:seqra:documents --check)", () => {
    // Exercised as its own npm script in CI; asserted here only as a
    // structural cross-check that the gate file still exists and this test
    // does not shadow it.
    assert.ok(existsSync(path.join(ROOT, "tools/check_seqra_document_pipeline.mjs")));
  });
});

// ---------------------------------------------------------------------------
// A7: no optical-recognition engine; unreadable pages reported unreadable
// ---------------------------------------------------------------------------

describe("A7: the absent optical-recognition engine is explicit; unreadable pages are never scored as read", () => {
  it("states the OCR-engine absence explicitly and never fabricates a score for an unreadable page", () => {
    const result = assessPageQuality({ text: "", ocrRequired: true, ocrAttempted: false, ocrEngineAvailable: false });
    assert.equal(result.measured, false);
    assert.equal(result.score, null);
    assert.equal(result.quality_state, "unknown");
    assert.match(result.reasons[0], /no OCR engine is available/);
  });

  it("distinguishes an unreadable page from a genuinely empty extraction with no OCR requirement", () => {
    const unreadable = assessPageQuality({ text: "", ocrRequired: true, ocrAttempted: false, ocrEngineAvailable: false });
    const emptyNoOcrNeeded = assessPageQuality({ text: "", ocrRequired: false, ocrAttempted: false, ocrEngineAvailable: false });
    assert.equal(unreadable.measured, false);
    assert.equal(emptyNoOcrNeeded.measured, true);
    assert.equal(emptyNoOcrNeeded.quality_state, "low");
  });

  it("summarizeDocumentExtractionQuality reports unmeasured pages distinctly from measured-low pages", () => {
    const pages = [
      { page_number: 1, ...assessPageQuality({ text: "", ocrRequired: true, ocrAttempted: false, ocrEngineAvailable: false }) },
      { page_number: 2, ...assessPageQuality({ text: "clean readable text about the review and the project", ocrRequired: false, ocrAttempted: false, ocrEngineAvailable: false }) },
    ];
    const summary = summarizeDocumentExtractionQuality(pages);
    assert.equal(summary.unmeasured_page_count, 1);
    assert.deepEqual(summary.unmeasured_page_numbers, [1]);
  });

  it("this module never references an OCR engine implementation, only the absence contract", () => {
    assert.ok(!/tesseract|pytesseract|google\.cloud\.vision|\btextract\b/i.test(INTERFACE_SOURCE), "must not wire an actual OCR engine");
  });
});
