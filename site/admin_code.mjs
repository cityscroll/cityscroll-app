import manifest from "./data/legal_code/manifest.json" with { type: "json" };
import searchIndex from "./data/legal_code/search.json" with { type: "json" };
import {
  adminCodeHref,
  adminCodeProvisionId,
  adminCodeSearchDocuments as searchDocumentsFromIndex,
  normalizeAdminCodeCitation,
  searchAdminCodeDocuments as searchDocumentsForQuery,
} from "./admin_code_search.mjs";
import { renderLegalChangeList } from "./legal_change_edges.mjs";
import { selectCodeVersionAt } from "./code_version_materialization.mjs";

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

export function renderAdminCodeProvisionDocument(row, { currentHref = null, changes = [], versions = [], as_of = null } = {}) {
  if (!row) return null;
  const scopedVersions = Array.isArray(versions)
    ? versions.filter((version) => version?.provision_id === row.id)
    : [];
  const currentVersion = selectCodeVersionAt(scopedVersions, as_of);
  const renderedRow = currentVersion
    ? {
      ...row,
      current_text: currentVersion.status === "repealed" ? "" : (currentVersion.text ?? row.current_text),
      status: currentVersion.status === "repealed" ? "repealed" : "current",
    }
    : row;
  const canonical = `https://cityscroll.org${adminCodeHref(renderedRow.citation)}`;
  const sourceUrl = renderedRow.source?.url || "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCadmin/0-0-0-1";
  const hierarchy = Array.isArray(renderedRow.hierarchy) && renderedRow.hierarchy.length
    ? `<p class="admin-code-hierarchy">${renderedRow.hierarchy.map((item) => escapeHtml(item.label)).join(" · ")}</p>`
    : "";
  const currentText = renderedRow.current_text
    ? `<div class="admin-code-text">${escapeHtml(renderedRow.current_text).replaceAll("\n\n", "</p><p>").replace(/^/, "<p>").replace(/$/, "</p>")}</div>`
    : `<p class="admin-code-empty">This provision is marked repealed in the current publisher snapshot.</p>`;
  const targetChanges = (Array.isArray(changes) ? changes : []).filter((change) => (
    change?.target?.provision_id === renderedRow.id
    || (change?.target?.corpus_id === ADMIN_CODE_CORPUS_ID
      && change?.target?.citation === renderedRow.citation)
  ));
  const proposals = targetChanges.filter((change) => change.state === "prospective");
  const enacted = targetChanges.filter((change) => change.state !== "prospective");
  const versionMarkup = Array.isArray(versions) && versions.length
    ? `<section class="history" aria-labelledby="version-history"><h3 id="version-history">Version history</h3><ul class="legal-change-list">${scopedVersions.sort((left, right) => String(left.valid_from || "").localeCompare(String(right.valid_from || ""))).map((version) => `<li data-code-version-id="${escapeHtml(version.id)}"><strong>${escapeHtml(version.valid_from || "Unknown start")}</strong>${version.valid_to ? ` – ${escapeHtml(version.valid_to)}` : version.status === "pending" ? " – not yet operative" : " – current"} · ${escapeHtml(version.status || "current")}</li>`).join("")}</ul></section>`
    : "";
  const changesMarkup = targetChanges.length
    ? `<section class="history" aria-labelledby="changes"><h3 id="changes">Changed by</h3>${renderLegalChangeList(enacted, { empty: "No modeled enacted changes yet." })}</section><section class="history" aria-labelledby="proposals"><h3 id="proposals">Current proposals</h3>${renderLegalChangeList(proposals, { empty: "No current explicit proposals." })}</section>${versionMarkup}`
    : versionMarkup || `<section class="history" aria-labelledby="history"><h3 id="history">History</h3><p>No modeled changes yet.</p></section>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Administrative Code ${escapeHtml(renderedRow.citation)} · CityScroll</title><meta name="description" content="Current NYC Administrative Code ${escapeHtml(renderedRow.citation)}."><link rel="canonical" href="${escapeHtml(canonical)}"><style>body{font-family:system-ui,sans-serif;max-width:860px;margin:0 auto;padding:2rem;line-height:1.55;color:#202124}.skip{position:absolute;left:-9999px;top:0;padding:.5rem .75rem;background:#fff;color:#202124}.skip:focus{left:1rem;z-index:1}.eyebrow{font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:#6b4f32}h1{font-size:2rem;margin:.25rem 0}.admin-code-hierarchy{color:#666}.admin-code-text{font-family:Georgia,serif;font-size:1.05rem}.admin-code-text p{margin:0 0 1rem}.meta{border-top:1px solid #ddd;margin-top:2rem;padding-top:1rem}.meta dt{font-weight:700}.meta dd{margin:0 0 .6rem}.history{border-top:1px solid #ddd;margin-top:2rem;padding-top:1rem}.legal-change-list{padding-left:1.3rem}.legal-change-list p{color:#555}.code-change-text,.code-change-diff pre{white-space:pre-wrap;background:#f6f6f3;padding:.75rem;border-left:3px solid #bbb}.code-change-after{border-left-color:#27734d}.code-change-diff pre{border-left-color:#6b4f32}main:focus{outline:3px solid #005fcc;outline-offset:4px}</style></head><body data-civic-object-kind="legal-code-provision"><a class="skip" href="#main">Skip to content</a><main id="main" tabindex="-1"><p class="eyebrow">NYC Administrative Code</p><h1>${escapeHtml(renderedRow.citation)}</h1><h2>${escapeHtml(renderedRow.heading || "Untitled provision")}</h2>${hierarchy}<section aria-labelledby="current-text"><h3 id="current-text">Current text</h3>${currentText}</section><section class="meta" aria-labelledby="source"><h3 id="source">Source</h3><dl><dt>Publisher</dt><dd>American Legal Publishing</dd><dt>Last observed</dt><dd>${escapeHtml(renderedRow.source?.observed_at || "Unknown")}</dd><dt>Content hash</dt><dd>${escapeHtml(renderedRow.source?.content_hash || "Unknown")}</dd><dt>Official source</dt><dd><a href="${escapeHtml(sourceUrl)}" rel="noopener noreferrer">View at American Legal Publishing</a></dd></dl></section><p class="node-meta">Status: ${escapeHtml(renderedRow.status || "unknown")}</p>${changesMarkup}</main></body></html>`;
}

export { manifest as ADMIN_CODE_MANIFEST, searchIndex as ADMIN_CODE_SEARCH_INDEX };
