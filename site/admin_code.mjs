import manifest from "./data/legal_code/manifest.json" with { type: "json" };
import searchIndex from "./data/legal_code/search.json" with { type: "json" };
import {
  adminCodeHref,
  adminCodeProvisionId,
  adminCodeSearchDocuments as searchDocumentsFromIndex,
  normalizeAdminCodeCitation,
  searchAdminCodeDocuments as searchDocumentsForQuery,
} from "./admin_code_search.mjs";

export const ADMIN_CODE_CORPUS_ID = "nyc-administrative-code";
export const ADMIN_CODE_SEARCH_LENS = "legal_code";

export function lookupAdminCodeCitation(value, sourceManifest = manifest) {
  const citation = normalizeAdminCodeCitation(value);
  if (!citation) return null;
  const lookup = sourceManifest?.citations?.[`§ ${citation}`];
  if (!lookup?.shard || lookup.id !== `${ADMIN_CODE_CORPUS_ID}:${citation}`) return null;
  return Object.freeze({
    citation: `§ ${citation}`,
    id: lookup.id,
    shard: lookup.shard,
    row_index: lookup.row_index,
  });
}

export { adminCodeHref, adminCodeProvisionId, normalizeAdminCodeCitation };

export function adminCodeSearchDocuments(index = searchIndex) {
  return searchDocumentsFromIndex(index);
}

export function searchAdminCodeDocuments(query, options = {}) {
  return searchDocumentsForQuery(query, { ...options, index: options.index || searchIndex });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderAdminCodeProvisionDocument(row, { currentHref = null } = {}) {
  if (!row) return null;
  const canonical = `https://cityscroll.org${adminCodeHref(row.citation)}`;
  const sourceUrl = row.source?.url || "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCadmin/0-0-0-1";
  const hierarchy = Array.isArray(row.hierarchy) && row.hierarchy.length
    ? `<p class="admin-code-hierarchy">${row.hierarchy.map((item) => escapeHtml(item.label)).join(" · ")}</p>`
    : "";
  const currentText = row.current_text
    ? `<div class="admin-code-text">${escapeHtml(row.current_text).replaceAll("\n\n", "</p><p>").replace(/^/, "<p>").replace(/$/, "</p>")}</div>`
    : `<p class="admin-code-empty">This provision is marked repealed in the current publisher snapshot.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Administrative Code ${escapeHtml(row.citation)} · CityScroll</title><meta name="description" content="Current NYC Administrative Code ${escapeHtml(row.citation)}."><link rel="canonical" href="${escapeHtml(canonical)}"><style>body{font-family:system-ui,sans-serif;max-width:860px;margin:0 auto;padding:2rem;line-height:1.55;color:#202124}.eyebrow{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:#6b4f32}h1{font-size:2rem;margin:.25rem 0}.admin-code-hierarchy{color:#666}.admin-code-text{font-family:Georgia,serif;font-size:1.05rem}.admin-code-text p{margin:0 0 1rem}.meta{border-top:1px solid #ddd;margin-top:2rem;padding-top:1rem}.meta dt{font-weight:700}.meta dd{margin:0 0 .6rem}.history{border-top:1px solid #ddd;margin-top:2rem;padding-top:1rem}</style></head><body data-civic-object-kind="legal-code-provision"><main><p class="eyebrow">NYC Administrative Code</p><h1>${escapeHtml(row.citation)}</h1><h2>${escapeHtml(row.heading || "Untitled provision")}</h2>${hierarchy}<section aria-labelledby="current-text"><h3 id="current-text">Current text</h3>${currentText}</section><section class="meta" aria-labelledby="source"><h3 id="source">Source</h3><dl><dt>Publisher</dt><dd>American Legal Publishing</dd><dt>Last observed</dt><dd>${escapeHtml(row.source?.observed_at || "Unknown")}</dd><dt>Content hash</dt><dd>${escapeHtml(row.source?.content_hash || "Unknown")}</dd><dt>Official source</dt><dd><a href="${escapeHtml(sourceUrl)}" rel="noopener noreferrer">View at American Legal Publishing</a></dd></dl></section><section class="history" aria-labelledby="history"><h3 id="history">History</h3><p>No modeled changes yet.</p></section></main></body></html>`;
}

export { manifest as ADMIN_CODE_MANIFEST, searchIndex as ADMIN_CODE_SEARCH_INDEX };
