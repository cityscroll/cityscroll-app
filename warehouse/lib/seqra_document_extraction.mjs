/**
 * SEQRA-04: text/OCR/layout extraction, for CEQR Access's own documents.
 *
 * `extractPdfPagesViaPython` shells out to the sibling
 * warehouse/lib/seqra_document_page_extract.py (pypdf-when-available, honest
 * skip otherwise -- see that file's docstring for why this is a sibling of
 * warehouse/lib/attachment_text_extract.py rather than a reuse of it).
 * `extractHtmlText` handles the HTML documents CEQR Access itself serves
 * (notices, the search shell) with no dependency at all. Both are specific to
 * how this pipeline gets text out of a document, so they stay here; a
 * different publisher (e.g. one whose documents arrive as already-extracted
 * text) would supply its own.
 *
 * Extraction-quality measurement (`measureExtractionQuality`,
 * `assessPageQuality`, `summarizeDocumentExtractionQuality`,
 * `EXTRACTION_QUALITY_STATES`) is publisher-neutral -- it scores whatever
 * text a page ended up with, independent of how that text was obtained -- and
 * lives in warehouse/lib/document_processing.mjs (LDP-33); re-exported here
 * so existing importers of this file are unaffected by that move.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export {
  EXTRACTION_QUALITY_STATES,
  measureExtractionQuality,
  assessPageQuality,
  summarizeDocumentExtractionQuality,
} from "./document_processing.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PAGE_EXTRACT_SCRIPT = path.join(ROOT, "warehouse/lib/seqra_document_page_extract.py");

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
