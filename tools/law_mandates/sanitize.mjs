// Data-plane sanitization for statute-derived fields and review artifacts.

export const FIELD_LIMITS = Object.freeze({
  agency: 240,
  agency_raw: 240,
  duty_text: 2000,
  citation: 500,
  verbatim_quote: 2400,
  deadline_text: 800,
  recurrence: 80,
  affected_group: 240,
});

export function stripControlChars(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/\r\n?/gu, "\n");
}

export function sanitizeText(value, maxLength = 1000) {
  const clean = stripControlChars(value).trim();
  return clean.length > maxLength ? `${clean.slice(0, Math.max(0, maxLength - 1))}…` : clean;
}

export function sanitizeField(field, value) {
  return sanitizeText(value, FIELD_LIMITS[field] || 1000);
}

/** Escape before inserting untrusted extracted content into HTML. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Prompt payloads remain bounded and explicitly delimited. Source text is
 * untrusted data, not instructions, even though it came from a statute.
 */
export function delimitedPromptText(value, maxLength = 120000) {
  return sanitizeText(value, maxLength)
    .replace(/<\/source_(?:law_text|metadata)>/giu, "<\/source_removed>");
}
