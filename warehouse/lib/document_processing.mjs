/**
 * LDP-33: the publisher-neutral document-processing interface.
 *
 * Lifted out of the first source-specific document pipeline that needed
 * these primitives (LDP-33, under the whichever-lands-first rule
 * commissioned by LDP-24, data/decisions/ldp24-shared-layer-extraction.md).
 * That pipeline owned every primitive here for its one source; this module
 * is what a second pipeline against a different publisher reuses instead of
 * writing its own fetcher, hasher, quality scorer, or supersession
 * classifier.
 *
 * Four primitive groups, matching the shape a second caller must obtain
 * without a second implementation of any of them:
 *   - a hasher (content-addressed hashing and storage location),
 *   - a fetcher (hash-preserving fetch producing a fetch receipt),
 *   - a quality scorer (extraction-quality measurement, extractor-agnostic),
 *   - a document-type/supersession classifier.
 * Plus the extraction receipt that binds a parsed page back to the exact
 * bytes it came from.
 *
 * Every identity this module deals in -- a document's storage namespace, its
 * document id, its content hash, its document-type vocabulary and
 * draft/final pairing -- is a caller-supplied input. This module never
 * derives identity from a filename or a URL, and never branches on which
 * publisher is calling; a publisher's own specifics (its source id, storage
 * namespace, parser version, receipt schema, document-type patterns,
 * supersession pairing) are parameters, not conditionals.
 *
 * No optical-recognition engine exists behind this interface: a page with no
 * usable text and no OCR engine available is reported `measured: false`,
 * never scored as though it had been read. Adding an OCR engine is a
 * separate decision and a separate card.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Hasher: content-addressed hashing and storage location
// ---------------------------------------------------------------------------

export function sha256Hex(bytesOrText) {
  const buf = typeof bytesOrText === "string" ? Buffer.from(bytesOrText, "utf8") : Buffer.from(bytesOrText);
  return createHash("sha256").update(buf).digest("hex");
}

export function contentHashOf(bytesOrText) {
  return `sha256:${sha256Hex(bytesOrText)}`;
}

/**
 * Compute the content-addressed storage location for a document's bytes:
 * warehouse/raw/<storageNamespace>/documents/<sha256-hex>.<ext>.
 * `storageNamespace` is a publisher-supplied identity (e.g. one caller's own
 * source id) -- never derived from a filename or URL -- so two publishers'
 * documents never collide in storage. Byte-identical content within one
 * namespace resolves to the same path regardless of how many times, or
 * under how many different candidate URLs, it is (re)fetched: a document
 * observed twice is stored once, never duplicated under two different names.
 */
export function documentRawObjectPath({ bytes, extension = "bin", storageNamespace } = {}) {
  if (typeof storageNamespace !== "string" || storageNamespace.trim() === "") {
    throw new Error("documentRawObjectPath: storageNamespace is required (a publisher-supplied identity, never derived from a filename)");
  }
  const hex = sha256Hex(bytes);
  return { hex, relPath: path.posix.join("warehouse/raw", storageNamespace, "documents", `${hex}.${extension}`) };
}

// ---------------------------------------------------------------------------
// Fetcher: hash-preserving fetch producing a fetch receipt
// ---------------------------------------------------------------------------

export const DOCUMENT_FETCH_RECEIPT_SCHEMA = "cityscroll.document_fetch_receipt.v1";

const REQUIRED_FETCH_RECEIPT_STRING_FIELDS = ["fetchId", "sourceId", "requestedAt", "requestUrlOrQuery", "retrievedAt", "parserVersion"];

/**
 * Build one fetch receipt, matching the field-for-field SOURCE RECEIPTS shape
 * every fetch in this codebase emits (fetch_id, source_id, requested_at,
 * request_url_or_query, http_status, retrieved_at, source_vintage,
 * content_type, byte_count, content_hash, raw_object_path, parser_version,
 * warnings). `schema` and `parserVersion` are publisher-supplied so a caller
 * with its own already-committed receipts can keep its own values; pure and
 * IO-free.
 */
export function buildDocumentFetchReceipt({
  schema = DOCUMENT_FETCH_RECEIPT_SCHEMA,
  fetchId,
  sourceId,
  requestedAt,
  requestUrlOrQuery,
  httpStatus,
  retrievedAt,
  contentType,
  bytes,
  rawObjectPath,
  parserVersion,
  warnings = [],
  latencyMs = null,
  purpose = "document_fetch",
} = {}) {
  const values = { fetchId, sourceId, requestedAt, requestUrlOrQuery, retrievedAt, parserVersion };
  for (const field of REQUIRED_FETCH_RECEIPT_STRING_FIELDS) {
    const value = values[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`buildDocumentFetchReceipt: ${field} is required and must be a non-empty string`);
    }
  }
  if (httpStatus != null && !Number.isInteger(httpStatus)) {
    throw new Error("buildDocumentFetchReceipt: httpStatus must be an integer or null");
  }
  const byteCount = bytes ? bytes.length : 0;
  const contentHash = bytes ? contentHashOf(bytes) : null;
  return Object.freeze({
    schema,
    fetch_id: fetchId,
    source_id: sourceId,
    requested_at: requestedAt,
    request_url_or_query: requestUrlOrQuery,
    http_status: httpStatus ?? null,
    retrieved_at: retrievedAt,
    source_vintage: retrievedAt,
    content_type: contentType ?? null,
    byte_count: byteCount,
    content_hash: contentHash,
    raw_object_path: rawObjectPath ?? null,
    row_or_document_count: bytes ? 1 : 0,
    pagination_complete: true,
    parser_version: parserVersion,
    warnings: Object.freeze([...warnings]),
    latency_ms: Number.isFinite(latencyMs) ? latencyMs : null,
    purpose: purpose ?? null,
  });
}

function extensionFromContentType(contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("pdf")) return "pdf";
  if (ct.includes("html")) return "html";
  if (ct.includes("plain")) return "txt";
  return "bin";
}

/**
 * Fetch one document's bytes via an injected `httpGet` (so callers/tests
 * never touch the network directly through this module), store them
 * content-addressed under
 * `<projectRoot>/warehouse/raw/<storageNamespace>/documents/`, and return the
 * bytes alongside their fetch receipt. `httpGet(url)` must resolve to
 * `{ status, headers: Map|Headers-like, bytes: Buffer }`.
 *
 * `sourceId`, `storageNamespace`, and `parserVersion` are publisher-supplied
 * -- this function never assumes or hardcodes which publisher is calling.
 */
export async function fetchAndStoreDocument({
  url,
  sourceId,
  httpGet,
  projectRoot,
  fetchId,
  storageNamespace,
  parserVersion,
  schema,
  purpose = "document_fetch",
}) {
  const requestedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  let result;
  let errorMessage = null;
  try {
    result = await httpGet(url);
  } catch (error) {
    errorMessage = `request failed: ${error.message}`;
  }
  const latencyMs = Date.now() - startedAtMs;
  const retrievedAt = new Date().toISOString();

  if (errorMessage || !result?.bytes) {
    const receipt = buildDocumentFetchReceipt({
      schema,
      fetchId,
      sourceId,
      requestedAt,
      requestUrlOrQuery: url,
      httpStatus: result?.status ?? null,
      retrievedAt,
      contentType: null,
      bytes: null,
      rawObjectPath: null,
      parserVersion,
      warnings: [errorMessage ?? "no bytes returned"],
      latencyMs,
      purpose,
    });
    return { ok: false, bytes: null, fetchReceipt: receipt };
  }

  const contentType = typeof result.headers?.get === "function" ? result.headers.get("content-type") : result.headers?.["content-type"] ?? null;
  const extension = extensionFromContentType(contentType);
  const { hex, relPath } = documentRawObjectPath({ bytes: result.bytes, extension, storageNamespace });
  const absPath = path.join(projectRoot, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, result.bytes);

  const warnings = [];
  if (result.status != null && (result.status < 200 || result.status >= 300)) warnings.push(`non-2xx http_status ${result.status}`);

  const receipt = buildDocumentFetchReceipt({
    schema,
    fetchId,
    sourceId,
    requestedAt,
    requestUrlOrQuery: url,
    httpStatus: result.status ?? null,
    retrievedAt,
    contentType,
    bytes: result.bytes,
    rawObjectPath: relPath,
    parserVersion,
    warnings,
    latencyMs,
    purpose,
  });

  return {
    ok: result.status == null || (result.status >= 200 && result.status < 300),
    bytes: result.bytes,
    contentHash: `sha256:${hex}`,
    rawObjectPath: relPath,
    fetchReceipt: receipt,
  };
}

// ---------------------------------------------------------------------------
// Quality scorer: extraction-quality measurement (extractor-agnostic)
// ---------------------------------------------------------------------------

export const EXTRACTION_QUALITY_STATES = Object.freeze(["not_applicable", "high", "medium", "low", "unknown"]);
const LOW_QUALITY_THRESHOLD = 0.55;
const MEDIUM_QUALITY_THRESHOLD = 0.8;

// A small, fixed sample of common short English words used only to sanity
// -check that extracted text looks like language rather than OCR noise --
// not a dictionary-completeness claim, just a garble detector.
const COMMON_WORDS = new Set([
  "the", "and", "of", "to", "in", "a", "is", "for", "on", "that", "this",
  "with", "as", "by", "be", "are", "or", "shall", "will", "not", "at",
  "review", "project", "city", "department", "environmental", "board",
]);

/**
 * Score extracted text for garble/quality independent of extraction method.
 * Pure function of the text alone. Returns a 0-1 score plus the discrete
 * EXTRACTION_QUALITY_STATES bucket and the reasons a reviewer would check
 * first, so a low score is always explainable, never just a number.
 */
export function measureExtractionQuality(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return { score: 0, quality_state: "low", reasons: ["extracted text is empty"] };
  }
  const alphaCount = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  const totalCount = trimmed.length;
  const alphaRatio = alphaCount / totalCount;

  const words = trimmed.toLowerCase().match(/[a-z]+/g) ?? [];
  const commonHitRatio = words.length > 0 ? words.filter((w) => COMMON_WORDS.has(w)).length / words.length : 0;

  const replacementCharCount = (trimmed.match(/[�□]/g) ?? []).length;
  const replacementRatio = replacementCharCount / totalCount;

  const avgWordLength = words.length > 0 ? words.reduce((sum, w) => sum + w.length, 0) / words.length : 0;
  const wordLengthPlausible = avgWordLength >= 2 && avgWordLength <= 12;

  const reasons = [];
  if (alphaRatio < 0.4) reasons.push(`low alphabetic-character ratio (${alphaRatio.toFixed(2)})`);
  if (words.length >= 20 && commonHitRatio < 0.02) reasons.push(`no common English words found across ${words.length} tokens`);
  if (replacementRatio > 0.01) reasons.push(`replacement/garble characters present (${(replacementRatio * 100).toFixed(1)}% of text)`);
  if (words.length > 0 && !wordLengthPlausible) reasons.push(`implausible average token length (${avgWordLength.toFixed(1)} chars)`);

  let score = 1;
  score -= Math.max(0, 0.4 - alphaRatio) * 1.25;
  score -= Math.max(0, 0.05 - commonHitRatio) * 4;
  score -= replacementRatio * 5;
  score -= wordLengthPlausible ? 0 : 0.25;
  score = Math.max(0, Math.min(1, score));

  const qualityState = score >= MEDIUM_QUALITY_THRESHOLD ? "high" : score >= LOW_QUALITY_THRESHOLD ? "medium" : "low";
  return { score: Number(score.toFixed(4)), quality_state: qualityState, reasons };
}

/**
 * Assess one extracted page, distinguishing "measured and clean/garbled"
 * from "not measured because no text and no OCR engine was available" -- the
 * two must never be conflated: a low-quality extraction must be
 * identifiable downstream, which requires knowing *why* a page has no usable
 * text, not just that it doesn't.
 */
export function assessPageQuality({ text, ocrRequired = false, ocrAttempted = false, ocrEngineAvailable = false } = {}) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    if (ocrRequired && !ocrEngineAvailable) {
      return {
        measured: false,
        ocr_used: false,
        method: null,
        quality_state: "unknown",
        score: null,
        reasons: ["page has no PDF text layer and no OCR engine is available in this environment; this interface exposes the per-page contract, a separate decision and card would supply an engine"],
      };
    }
    return { measured: true, ocr_used: ocrAttempted, method: ocrAttempted ? "ocr" : "pdf_text_layer", quality_state: "low", score: 0, reasons: ["extracted text is empty"] };
  }
  const quality = measureExtractionQuality(trimmed);
  return {
    measured: true,
    ocr_used: ocrAttempted === true,
    method: ocrAttempted ? "ocr" : "pdf_text_layer",
    ...quality,
  };
}

/**
 * Roll per-page quality assessments up to a document-level summary. `pages`
 * entries are `{ page_number, ...assessPageQuality() result }` so a
 * low-quality page is always identifiable by its real page number, never a
 * positional index that could silently drift from the stored document's
 * pages.
 */
export function summarizeDocumentExtractionQuality(pages = []) {
  for (const page of pages) {
    if (!Number.isInteger(page.page_number) || page.page_number < 1) {
      throw new Error(`summarizeDocumentExtractionQuality: every page entry requires a positive integer page_number, got ${JSON.stringify(page.page_number)}`);
    }
  }
  const measured = pages.filter((p) => p.measured);
  const lowQualityPages = measured.filter((p) => p.quality_state === "low");
  const unmeasuredPages = pages.filter((p) => !p.measured);
  return Object.freeze({
    page_count: pages.length,
    measured_page_count: measured.length,
    unmeasured_page_count: unmeasuredPages.length,
    low_quality_page_count: lowQualityPages.length,
    low_quality_page_numbers: Object.freeze(lowQualityPages.map((p) => p.page_number)),
    unmeasured_page_numbers: Object.freeze(unmeasuredPages.map((p) => p.page_number)),
    overall_quality_state: measured.length === 0
      ? "unknown"
      : lowQualityPages.length / measured.length > 0.5
        ? "low"
        : measured.some((p) => p.quality_state === "medium")
          ? "medium"
          : "high",
  });
}

// ---------------------------------------------------------------------------
// Extraction receipt: binds a parsed page to the bytes it came from
// ---------------------------------------------------------------------------

export const EXTRACTION_RECEIPT_SCHEMA = "cityscroll.document_extraction_receipt.v1";

/**
 * Build the extraction receipt for one document: validates that every
 * parsed page resolves back to `fetchId`/`contentHash` -- the exact fetch
 * receipt and bytes it was extracted from -- and rolls the pages up into a
 * quality summary. `documentId` is a publisher-supplied identity (never
 * derived from a filename); a page that does not carry its own
 * `page_number`, `fetch_id`, and `content_hash`, or whose `fetch_id`/
 * `content_hash` do not match this document's own, fails structurally
 * rather than being silently accepted.
 */
export function buildExtractionReceipt({ documentId, fetchId, contentHash, pages = [] } = {}) {
  for (const [field, value] of [["documentId", documentId], ["fetchId", fetchId], ["contentHash", contentHash]]) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`buildExtractionReceipt: ${field} is required and must be a non-empty string`);
    }
  }
  for (const page of pages) {
    if (!page.page_number || !page.fetch_id || !page.content_hash) {
      throw new Error(`buildExtractionReceipt: every page must carry page_number, fetch_id, and content_hash tracing back to ${fetchId}`);
    }
    if (page.fetch_id !== fetchId || page.content_hash !== contentHash) {
      throw new Error(`buildExtractionReceipt: page ${page.page_number} does not resolve to this document's own fetch receipt/content_hash`);
    }
  }
  return Object.freeze({
    schema: EXTRACTION_RECEIPT_SCHEMA,
    document_id: documentId,
    fetch_id: fetchId,
    content_hash: contentHash,
    pages: Object.freeze(pages.map((p) => Object.freeze({ ...p }))),
    quality_summary: summarizeDocumentExtractionQuality(pages),
  });
}

// ---------------------------------------------------------------------------
// Classifier: document-type + supersession classification
// ---------------------------------------------------------------------------

export const DOCUMENT_TYPE_CONFIDENCE_LEVELS = Object.freeze(["high", "medium", "low", "unknown"]);
export const SUPERSESSION_BASES = Object.freeze(["explicit_text_reference", "stage_type_pairing", "none"]);

function normalizedSample(title, textSample) {
  return `${title ?? ""} ${textSample ?? ""}`.slice(0, 4000);
}

/**
 * Classify a candidate document's type and stage from its title and (when
 * available) a text sample, against a publisher-supplied ordered `patterns`
 * list (`{ documentType, stage, pattern }`). Patterns are tried in the order
 * given and never reordered by this module, so a publisher whose vocabulary
 * has a general/specific overlap (e.g. "negative declaration" vs.
 * "conditioned negative declaration") controls precedence itself by listing
 * the more specific pattern first. Never guesses: an unmatched document
 * returns `document_type: null`, `confidence: "unknown"`, and no matched
 * terms, so nothing downstream can mistake silence for a positive claim.
 */
export function classifyDocumentType({ title = null, textSample = null, patterns = [] } = {}) {
  const haystack = normalizedSample(title, textSample);
  for (const { documentType, stage, pattern } of patterns) {
    const match = pattern.exec(haystack);
    if (match) {
      return {
        document_type: documentType,
        document_stage: stage,
        confidence: title && pattern.test(title) ? "high" : "medium",
        matched_terms: [match[0]],
      };
    }
  }
  return { document_type: null, document_stage: null, confidence: "unknown", matched_terms: [] };
}

function extractExplicitSupersessionReference(textSample) {
  // e.g. "This Final Environmental Impact Statement supersedes the Draft
  // Environmental Impact Statement issued on March 3, 2024."
  const match = /supersed(?:es|ing)\s+the\s+(draft[^.]{0,120}?)(?:\s+(?:issued|dated|published)\s+on\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4}))?[.,]/i.exec(String(textSample ?? ""));
  if (!match) return null;
  return { referenced_draft_description: match[1].trim(), referenced_draft_date_text: match[2] ?? null };
}

/**
 * Determine whether `candidate` (already run through classifyDocumentType,
 * carrying document_type/document_stage) supersedes one of
 * `existingDocumentsForReview` -- objects carrying at least `document_key`,
 * `document_type`, `document_stage`, `issued_date`, and
 * `superseded_by_document_key`. Deliberately conservative: never inferred
 * from filename or date proximity alone. A candidate final document is
 * linked to a draft only when either (a) its own text explicitly names the
 * draft it supersedes, or (b) it is the paired draft type of an existing,
 * not-yet-superseded draft in the same review -- and even then the basis is
 * carried on the result so a caller can distinguish the two confidence
 * levels.
 *
 * `pairedDraftTypeOf(documentType)` is a publisher-supplied lookup from a
 * final-stage document_type to the draft-stage type it pairs with (default:
 * identity, i.e. the same type string names both stages). Some vocabularies
 * encode draft/final into the type name itself (a `feis` never shares a
 * document_type string with the `deis` it supersedes); this module never
 * hardcodes any publisher's own pairing, so a type a caller's vocabulary
 * does not name as paired never gets an invented counterpart.
 */
export function classifySupersession({
  candidate,
  textSample = null,
  existingDocumentsForReview = [],
  pairedDraftTypeOf = (documentType) => documentType,
} = {}) {
  if (candidate.document_stage !== "final") {
    return { supersedes_document_key: null, basis: "none", confidence: "unknown", reason: "only a final-stage document can supersede a draft" };
  }
  const pairedDraftType = pairedDraftTypeOf(candidate.document_type) ?? candidate.document_type;

  const explicitRef = extractExplicitSupersessionReference(textSample);
  if (explicitRef) {
    const matchByType = existingDocumentsForReview.find(
      (doc) => doc.document_stage === "draft" && doc.document_type === pairedDraftType && !doc.superseded_by_document_key,
    );
    if (matchByType) {
      return {
        supersedes_document_key: matchByType.document_key,
        basis: "explicit_text_reference",
        confidence: "high",
        reason: `document text explicitly names the draft it supersedes ("${explicitRef.referenced_draft_description}")`,
      };
    }
  }

  const pairedDraft = existingDocumentsForReview
    .filter((doc) => doc.document_stage === "draft" && doc.document_type === pairedDraftType && !doc.superseded_by_document_key)
    .sort((a, b) => (a.issued_date < b.issued_date ? 1 : -1))[0]; // most recent unsuperseded draft of the paired type
  if (pairedDraft) {
    return {
      supersedes_document_key: pairedDraft.document_key,
      basis: "stage_type_pairing",
      confidence: "medium",
      reason: `most recent unsuperseded draft-stage ${pairedDraftType} in the same review`,
    };
  }

  return { supersedes_document_key: null, basis: "none", confidence: "unknown", reason: `no unsuperseded ${pairedDraftType} draft exists in this review` };
}
