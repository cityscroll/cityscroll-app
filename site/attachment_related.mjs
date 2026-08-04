/**
 * T3 attachment-content related notices — pure render helpers.
 * Edges come from build-time materialization (precomputed_related_edges).
 * No query-time embedding.
 */

import {
  publicRelatedPayload,
  relatedForNotice,
} from "../warehouse/lib/attachment_embeddings.mjs";

export {
  publicRelatedPayload,
  relatedForNotice,
};

/** Fetch + cache the static related-notices artifact (site path). */
let relatedLookupPromise = null;
export function loadAttachmentRelatedLookup(fetchImpl = globalThis.fetch) {
  if (!relatedLookupPromise) {
    relatedLookupPromise = Promise.resolve(
      fetchImpl("data/attachment_related_notices.json", {
        cache: "force-cache",
        credentials: "omit",
      }),
    )
      .then((r) => (r && r.ok ? r.json() : null))
      .catch(() => null);
  }
  return relatedLookupPromise;
}

/** Test hook — reset cache between cases. */
export function resetAttachmentRelatedLookupCache() {
  relatedLookupPromise = null;
}

/**
 * Build HTML for related-by-attachment-content panel.
 * @param {object} artifact materialization
 * @param {string} requestId
 * @param {{ t?: Function, esc?: Function }} opts
 */
export function attachmentRelatedHTML(artifact, requestId, opts = {}) {
  const related = relatedForNotice(artifact, requestId);
  if (!related.length) return "";
  const t = typeof opts.t === "function" ? opts.t : (k) => k;
  const esc = typeof opts.esc === "function"
    ? opts.esc
    : (s) => String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const items = related.map((row) => {
    const id = esc(row.request_id);
    const title = esc(row.title || row.request_id);
    const section = row.section ? `<span class="attachment-related-meta">${esc(row.section)}</span>` : "";
    return `<li class="attachment-related-item">
      <a href="#notice/${id}">${title}</a>
      ${section}
    </li>`;
  }).join("");

  return `<div class="attachment-related" data-attachment-related="1" role="group" aria-label="${esc(t("notice_attachment_related_heading"))}">
    <div class="attachment-related-h">${esc(t("notice_attachment_related_heading"))}</div>
    <p class="attachment-related-lead note">${esc(t("notice_attachment_related_lead"))}</p>
    <ul class="attachment-related-list">${items}</ul>
  </div>`;
}
