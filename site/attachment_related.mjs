/**
 * T3 attachment-content related notices — client pure helpers.
 *
 * Edges come from build-time materialization (precomputed_related_edges).
 * No query-time embedding. Keep this module self-contained under site/ so the
 * static origin can load it without reaching outside the public tree.
 */

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

/** Public edge list for one notice (empty when unknown). */
export function relatedForNotice(artifact, requestId, { limit = 5 } = {}) {
  const row = artifact?.by_notice?.[String(requestId)];
  if (!row?.related?.length) return [];
  return row.related.slice(0, limit);
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

  const heading = esc(t("notice_attachment_related_heading"));
  const lead = esc(t("notice_attachment_related_lead"));
  const items = related.map((row) => {
    const id = esc(row.request_id);
    const title = esc(row.title || row.request_id);
    const section = row.section
      ? `<span class="attachment-related-meta">${esc(row.section)}</span>`
      : "";
    return `<li class="attachment-related-item">
      <a href="#notice/${id}">${title}</a>
      ${section}
    </li>`;
  }).join("");

  // Prefer a real heading over role=group+aria-label so screen readers get one
  // outline entry without a redundant accessible name. List is labeled by the h3.
  return `<section class="attachment-related" data-attachment-related="1" aria-labelledby="attachment-related-h">
    <h3 class="attachment-related-h" id="attachment-related-h">${heading}</h3>
    <p class="attachment-related-lead note">${lead}</p>
    <ul class="attachment-related-list">${items}</ul>
  </section>`;
}
