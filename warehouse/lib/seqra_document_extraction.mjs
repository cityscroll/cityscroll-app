/**
 * SEQRA-04: text/OCR/layout extraction and quality measurement.
 *
 * `extractPdfPagesViaPython` shells out to the sibling
 * warehouse/lib/seqra_document_page_extract.py (pypdf-when-available, honest
 * skip otherwise -- see that file's docstring for why this is a sibling of
 * warehouse/lib/attachment_text_extract.py rather than a reuse of it).
 * `extractHtmlText` handles the HTML documents CEQR Access itself serves
 * (notices, the search shell) with no dependency at all.
 *
 * `measureExtractionQuality` is deliberately extractor-agnostic: it scores
 * whatever text a page ended up with, whether that text came from a PDF text
 * layer or (once a later card wires an engine) real OCR. Card acceptance A3
 * requires OCR quality to be measured and low-quality extractions to be
 * identifiable downstream; this function is what makes that true, and
 * `assessPageQuality` is the one place that also records whether OCR was
 * actually used versus unavailable, so a caller can never conflate "no text
 * layer, OCR not attempted" with "measured and clean."
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAGE_EXTRACT_SCRIPT = path.join(ROOT, "warehouse/lib/seqra_document_page_extract.py");

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

/** Invoke the Python page extractor as a subprocess. IO wrapper; not pure. */
export function extractPdfPagesViaPython(bytes) {
  let stdout;
  try {
    stdout = execFileSync("python3", [PAGE_EXTRACT_SCRIPT], { input: bytes, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    return { status: "extract_failed", reason: `subprocess_error:${error.message}`, pages: [] };
  }
  try {
    return JSON.parse(stdout.toString("utf8"));
  } catch {
    return { status: "extract_failed", reason: "subprocess_output_not_json", pages: [] };
  }
}

/** Strip tags/scripts/styles from an HTML document into plain reading text. Pure. */
export function extractHtmlText(html) {
  const withoutScripts = String(html ?? "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ");
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, " ");
  const decoded = withoutTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return decoded.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

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
 * from "not measured because no text and no OCR engine was available" --
 * the two must never be conflated (A3: low-quality extractions must be
 * identifiable downstream, which requires knowing *why* a page has no
 * usable text, not just that it doesn't).
 */
export function assessPageQuality({ text, ocrRequired = false, ocrAttempted = false, ocrEngineAvailable = false }) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    if (ocrRequired && !ocrEngineAvailable) {
      return {
        measured: false,
        ocr_used: false,
        method: null,
        quality_state: "unknown",
        score: null,
        reasons: ["page has no PDF text layer and no OCR engine is available in this environment; SEQRA-04 wires the per-page interface, a later card supplies the engine"],
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
 * Roll per-page quality assessments up to a document-level summary.
 * `pages` entries are `{ page_number, ...assessPageQuality() result }` so a
 * low-quality page is always identifiable by its real page number, never a
 * positional index that could silently drift from the stored PDF's pages.
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
