/**
 * T1 attachment inline text — pure helpers (no I/O).
 *
 * High-value office classes (docx / pdf / doc) get clean extracted text stored
 * beside T0 metadata. No images, no OCR.
 * T2 tables: docs/adr/attachment-tables-storage.md (JSON at current scale).
 * T3 embeddings: warehouse/lib/attachment_embeddings.mjs (related edges only).
 */

export const ATTACHMENT_TEXT_SCHEMA = "cityscroll.attachment_text.v1";
export const MAX_EXTRACT_BYTES = 5_000_000;
export const MAX_TEXT_CHARS = 50_000;
export const MAX_PREVIEW_CHARS = 360;
export const MAX_PREVIEW_LINES = 4;
export const MAX_DOCS_PER_RUN = 25;
export const TEXT_PROVENANCE = "attachment-text";

const DOCX_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/docx",
]);
const PDF_TYPES = new Set(["application/pdf", "application/x-pdf"]);
const DOC_TYPES = new Set(["application/msword", "application/doc"]);

function lower(value) {
  return String(value || "").trim().toLowerCase();
}

function extensionOf(attachment = {}) {
  const name = lower(attachment.filename || attachment.title || "");
  const fromName = name.match(/\.([a-z0-9]{2,5})(?:\s|$)/i);
  if (fromName) return fromName[1].toLowerCase();
  try {
    const path = new URL(String(attachment.url || "")).pathname;
    const ext = path.split(".").pop();
    if (ext && ext.length <= 5) return ext.toLowerCase();
  } catch { /* ignore */ }
  return "";
}

/**
 * Classify whether an attachment is a T1 text-extract candidate.
 * Returns { eligible, class: 'docx'|'pdf'|'doc'|null, reason }.
 */
export function classifyAttachmentForText(attachment = {}) {
  const bytes = Number.isFinite(attachment.bytes) ? Number(attachment.bytes) : null;
  if (bytes != null && bytes > MAX_EXTRACT_BYTES) {
    return { eligible: false, class: null, reason: "too_large" };
  }
  const type = lower(attachment.content_type);
  const ext = extensionOf(attachment);
  if (DOCX_TYPES.has(type) || ext === "docx") {
    return { eligible: true, class: "docx", reason: null };
  }
  if (PDF_TYPES.has(type) || ext === "pdf") {
    return { eligible: true, class: "pdf", reason: null };
  }
  if (DOC_TYPES.has(type) || ext === "doc") {
    // Legacy .doc is listed as a high-value class, but binary OLE extraction is
    // out of scope for T1 (no antiword dependency). Honest skip.
    return { eligible: false, class: "doc", reason: "legacy_doc_unsupported" };
  }
  // Title/URL often omit extension; still try when the portal only left a title
  // that looks like an agenda / hearing / scope packet (unknown type).
  const title = lower(attachment.title);
  if (/\b(agenda|hearing notice|scope of (work|services)|volume report|bid (package|mailing)|notice of project)\b/.test(title)) {
    return { eligible: true, class: "unknown_high_value", reason: null };
  }
  return { eligible: false, class: null, reason: "not_text_class" };
}

/** Collapse whitespace; cap length; no HTML. */
export function cleanExtractedText(value, maxChars = MAX_TEXT_CHARS) {
  const text = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[^\S\n]+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}…`;
}

/** Few-line / short preview for collapsed progressive disclosure. */
export function previewFromText(text, {
  maxLines = MAX_PREVIEW_LINES,
  maxChars = MAX_PREVIEW_CHARS,
} = {}) {
  const clean = cleanExtractedText(text, MAX_TEXT_CHARS);
  if (!clean) return "";
  const lines = clean.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  let preview = lines.slice(0, maxLines).join(" · ");
  if (lines.length > maxLines) preview += "…";
  if (preview.length > maxChars) {
    preview = `${preview.slice(0, maxChars - 1).trimEnd()}…`;
  }
  return preview;
}

/**
 * Attach T1 text fields onto a T0 metadata row (or stamp a skip).
 * Never invents content — empty extract is an honest skip.
 */
export function stampAttachmentText(attachment, extract = {}) {
  const base = attachment && typeof attachment === "object" ? { ...attachment } : {};
  const classification = classifyAttachmentForText(base);
  const status = extract.status || (classification.eligible ? "pending" : "skipped");
  const reason = extract.reason || classification.reason || null;
  const method = extract.method || null;
  const raw = extract.text != null ? extract.text : extract.extracted_text;
  const text = status === "ok" ? cleanExtractedText(raw) : "";
  const preview = text ? previewFromText(text) : (extract.preview || extract.text_preview || null);

  return {
    ...base,
    text_status: text ? "ok" : status,
    text_reason: text ? null : reason,
    text_method: text ? (method || classification.class || null) : method,
    text_chars: text ? text.length : null,
    text_preview: text ? preview : null,
    extracted_text: text || null,
    text_extracted_at: extract.extracted_at || (text ? new Date().toISOString() : null),
  };
}

/** Build the attachment-text slice that feeds the D1 notices haystack. */
export function attachmentTextForHaystack(attachments = []) {
  const parts = [];
  for (const item of Array.isArray(attachments) ? attachments : []) {
    const text = cleanExtractedText(item?.extracted_text || "");
    if (!text) continue;
    parts.push(text.toLowerCase());
  }
  if (!parts.length) return "";
  // Marker keeps provenance recoverable when re-materializing haystack.
  return `[${TEXT_PROVENANCE}] ${parts.join(" ¦ ")}`;
}

/**
 * Merge base notice haystack with attachment text, replacing any prior
 * attachment-text slice so re-runs stay idempotent.
 */
export function mergeHaystackWithAttachmentText(baseHaystack, attachments = []) {
  const base = String(baseHaystack || "")
    .replace(new RegExp(`\\s*\\[?${TEXT_PROVENANCE}\\]?[\\s\\S]*$`, "i"), "")
    .replace(/\s*¦\s*$/, "")
    .trim();
  const attach = attachmentTextForHaystack(attachments);
  if (!attach) return base;
  if (!base) return attach;
  return `${base} ¦ ${attach}`;
}

/**
 * When a keyword hit lives only in attachment text, label provenance so UI
 * can say "Found in attachment" instead of an opaque unknown match.
 */
export function matchAttachmentTextEvidence(attachmentText, terms = []) {
  const text = cleanExtractedText(attachmentText || "");
  if (!text) return null;
  const hay = text.toLowerCase();
  let best = null;
  for (const term of terms || []) {
    const needle = String(term || "").trim();
    if (!needle) continue;
    const idx = hay.indexOf(needle.toLowerCase());
    if (idx !== -1 && (best === null || idx < best.index)) {
      best = { term: needle, index: idx };
    }
  }
  if (!best) return null;
  const RADIUS = 70;
  const start = Math.max(0, best.index - RADIUS);
  const end = Math.min(text.length, best.index + best.term.length + RADIUS);
  return {
    field: "attachment-text",
    provenance: TEXT_PROVENANCE,
    term: best.term,
    before: (start > 0 ? "…" : "") + text.slice(start, best.index),
    hit: text.slice(best.index, best.index + best.term.length),
    after: text.slice(best.index + best.term.length, end) + (end < text.length ? "…" : ""),
  };
}

export function joinAttachmentTexts(attachments = []) {
  return (Array.isArray(attachments) ? attachments : [])
    .map((item) => cleanExtractedText(item?.extracted_text || ""))
    .filter(Boolean)
    .join("\n\n");
}

export function publicAttachmentTextFields(attachment = {}) {
  if (!attachment || typeof attachment !== "object") return {};
  const text = cleanExtractedText(attachment.extracted_text || "");
  if (!text && attachment.text_status !== "ok") {
    return {
      text_status: attachment.text_status || null,
      text_reason: attachment.text_reason || null,
      text_method: attachment.text_method || null,
      text_chars: null,
      text_preview: null,
      // Full text omitted when empty; clients never need skip-only blobs.
    };
  }
  if (!text) return {};
  return {
    text_status: "ok",
    text_reason: null,
    text_method: attachment.text_method || null,
    text_chars: text.length,
    text_preview: previewFromText(text),
    extracted_text: text,
  };
}
