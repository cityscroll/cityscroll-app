import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assessPageQuality,
  detectPdfLibraryVersionViaPython,
  extractHtmlText,
  extractPdfPagesViaPython,
  measureExtractionQuality,
  summarizeDocumentExtractionQuality,
} from "../warehouse/lib/seqra_document_extraction.mjs";

const CLEAN_TEXT =
  "This Final Environmental Impact Statement describes the review of the proposed project by the " +
  "Department of City Planning. The environmental review board considered the impact of the project " +
  "on transportation, air quality, and open space in the community.";

const GARBLED_TEXT = "�□㷀 ⌫␦ xkq zzq ¤¤¤ □□□□ 8#$%&*() qqqzz wwvvxx";

describe("seqra_document_extraction: measureExtractionQuality", () => {
  it("scores clean, language-like text as high quality", () => {
    const result = measureExtractionQuality(CLEAN_TEXT);
    assert.equal(result.quality_state, "high");
    assert.ok(result.score >= 0.8);
  });

  it("scores garbled OCR-noise text as low quality with explanatory reasons", () => {
    const result = measureExtractionQuality(GARBLED_TEXT);
    assert.equal(result.quality_state, "low");
    assert.ok(result.reasons.length > 0);
  });

  it("scores empty text as low quality", () => {
    const result = measureExtractionQuality("");
    assert.equal(result.quality_state, "low");
    assert.equal(result.score, 0);
  });
});

describe("seqra_document_extraction: assessPageQuality", () => {
  it("reports measured: false (never a fabricated score) when there is no text layer and no OCR engine", () => {
    const result = assessPageQuality({ text: "", ocrRequired: true, ocrAttempted: false, ocrEngineAvailable: false });
    assert.equal(result.measured, false);
    assert.equal(result.score, null);
    assert.match(result.reasons[0], /no OCR engine is available/);
  });

  it("reports measured: true for a page with a real text layer", () => {
    const result = assessPageQuality({ text: CLEAN_TEXT, ocrRequired: false, ocrAttempted: false, ocrEngineAvailable: false });
    assert.equal(result.measured, true);
    assert.equal(result.method, "pdf_text_layer");
    assert.equal(result.ocr_used, false);
  });

  it("marks ocr_used: true only when OCR was actually attempted", () => {
    const result = assessPageQuality({ text: CLEAN_TEXT, ocrRequired: true, ocrAttempted: true, ocrEngineAvailable: true });
    assert.equal(result.ocr_used, true);
    assert.equal(result.method, "ocr");
  });
});

describe("seqra_document_extraction: summarizeDocumentExtractionQuality", () => {
  it("identifies low-quality pages by their real page_number, and requires one on every entry", () => {
    const pages = [
      { page_number: 1, ...assessPageQuality({ text: CLEAN_TEXT }) },
      { page_number: 2, ...assessPageQuality({ text: GARBLED_TEXT }) },
      { page_number: 3, ...assessPageQuality({ text: CLEAN_TEXT }) },
    ];
    const summary = summarizeDocumentExtractionQuality(pages);
    assert.deepEqual(summary.low_quality_page_numbers, [2]);
    assert.equal(summary.page_count, 3);
  });

  it("throws when a page entry lacks a valid page_number", () => {
    assert.throws(() => summarizeDocumentExtractionQuality([{ ...assessPageQuality({ text: CLEAN_TEXT }) }]));
  });

  it("reports overall_quality_state: unknown when nothing was measured", () => {
    const pages = [{ page_number: 1, ...assessPageQuality({ text: "", ocrRequired: true, ocrAttempted: false, ocrEngineAvailable: false }) }];
    const summary = summarizeDocumentExtractionQuality(pages);
    assert.equal(summary.overall_quality_state, "unknown");
    assert.equal(summary.unmeasured_page_count, 1);
  });
});

describe("seqra_document_extraction: extractHtmlText", () => {
  it("strips tags, scripts, and styles, decoding common entities", () => {
    const html = "<html><head><style>.x{}</style><script>evil()</script></head><body><p>Hello &amp; welcome</p></body></html>";
    const text = extractHtmlText(html);
    assert.equal(text, "Hello & welcome");
  });
});

describe("seqra_document_extraction: extractPdfPagesViaPython (honest skip when pypdf is unavailable)", () => {
  it("returns a typed skip/extract result rather than throwing when pypdf is not installed", () => {
    const result = extractPdfPagesViaPython(Buffer.from("%PDF-1.4 not a real pdf"));
    assert.ok(["ok", "skipped", "extract_failed"].includes(result.status));
    if (result.status === "skipped") assert.equal(result.reason, "pdf_lib_unavailable");
  });

  it("reports a matching library version and flags image-only attachment pages as ocr_required", () => {
    const version = detectPdfLibraryVersionViaPython();
    if (version === "unavailable") return;
    // Build a minimal valid 1-page PDF containing a 100x100 raster XObject and a 12-char header ("Attachment A").
    const objs = [
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 5 0 R >> >> /Contents 6 0 R >>\nendobj\n",
      "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
      "5 0 obj\n<< /Type /XObject /Subtype /Image /Width 100 /Height 100 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n0\nendstream\nendobj\n",
      "6 0 obj\n<< /Length 46 >>\nstream\nBT /F1 12 Tf 10 180 Td (Attachment A) Tj ET\nendstream\nendobj\n",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const obj of objs) {
      offsets.push(Buffer.byteLength(pdf, "latin1"));
      pdf += obj;
    }
    const xrefStart = Buffer.byteLength(pdf, "latin1");
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objs.length; i += 1) {
      pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

    const result = extractPdfPagesViaPython(Buffer.from(pdf, "latin1"));
    assert.equal(result.status, "ok");
    assert.equal(result.pdf_library, version);
    assert.equal(result.pages.length, 1);
    assert.equal(result.pages[0].text, "Attachment A");
    assert.equal(result.pages[0].ocr_required, true);
    assert.equal(result.pages[0].reason, "image_attachment_with_header_only");
  });
});
