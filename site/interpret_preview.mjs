// Bounded result projection for the plain-language topic entry point. The row renderer is
// injected so the preview cannot grow a second card vocabulary: callers pass the same renderer
// used by the corresponding result list.
export const INTERPRET_PREVIEW_LIMIT = 3;

function defaultEscape(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function boundedPreviewRows(rows, limit = INTERPRET_PREVIEW_LIMIT) {
  if (!Array.isArray(rows)) return [];
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : INTERPRET_PREVIEW_LIMIT;
  return rows.slice(0, boundedLimit);
}

export function renderInterpretPreview({
  query = "",
  rows = [],
  renderRow,
  heading = "Preview",
  empty = "No matches for this interpreted topic.",
  error = "This topic could not be previewed right now. Try again.",
  state = "ready",
  escape = defaultEscape,
} = {}) {
  if (state === "error") {
    return `<div class="interpret-preview interpret-preview-empty" data-preview-state="error" role="status">${escape(error)}</div>`;
  }
  const bounded = boundedPreviewRows(rows);
  if (!bounded.length) {
    return `<div class="interpret-preview interpret-preview-empty" data-preview-state="empty" role="status">${escape(empty)}</div>`;
  }
  const renderedRows = bounded
    .map((row, index) => typeof renderRow === "function" ? renderRow(row, index) : "")
    .filter(Boolean)
    .join("");
  if (!renderedRows) {
    return `<div class="interpret-preview interpret-preview-empty" data-preview-state="empty" role="status">${escape(empty)}</div>`;
  }
  const label = query ? `${heading} for “${query}”` : heading;
  return `<section class="interpret-preview" data-preview-state="results" aria-labelledby="interpret-preview-heading">
    <h3 id="interpret-preview-heading">${escape(label)}</h3>
    <p class="interpret-preview-note">Showing the first ${bounded.length} matching record${bounded.length === 1 ? "" : "s"}.</p>
    <div class="interpret-preview-results">${renderedRows}</div>
  </section>`;
}
