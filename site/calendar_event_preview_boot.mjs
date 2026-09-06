/**
 * Browser boot for the shared calendar behaviour on rendered documents.
 *
 * The Community Board constellation, legislative matter and procurement
 * documents are rendered ahead of the reader rather than painted by a route
 * module, so they have no existing browser entry point to hang the shared
 * calendar binders on. This is that entry point, and nothing else: it mounts
 * the shared month component's one delegated behaviour on the document and
 * stops.
 *
 * It mounts through `compact_calendar.mjs` rather than reaching for one half
 * directly, so a rendered document gets exactly what a browser-painted host
 * gets: the in-place event preview and the crowded-day agenda together. A
 * document offered a clipped title but not the panel that shows it in full
 * would be a worse document than one offered neither.
 *
 * Loading this module is what reveals those affordances, so a document that
 * does not load it — or a reader whose browser never runs it — is left with
 * the canonical anchors and the native disclosure, which work on their own.
 *
 * One optional addition: a document may inline a small block of already-
 * materialized context for the matter it is about. When it does, that block
 * becomes the preview's `loadDetail` answer, so a reader inspecting an event
 * in place sees the same context the page states in full below. It is passed
 * as an option to the same shared mount rather than to the preview binder
 * directly, so a document carrying that block still gets the crowded-day
 * agenda alongside it. It is read from the document itself — there is no
 * request of any kind — and a block that is missing or unreadable leaves the
 * preview showing exactly the facts the cell was admitted with, plus its
 * working link to the full page.
 */

import { bindCompactMonthCalendar } from "./compact_calendar.mjs";

export const CALENDAR_PREVIEW_DETAIL_SELECTOR = 'script[type="application/json"][data-project-context-inspect]';

/**
 * Read the inlined summary, or throw so the binder's own recovery copy runs.
 * Throwing is the honest outcome for a block that is present but unreadable:
 * the alternative is quietly rendering the preview as though the page never
 * offered the context at all.
 */
export function calendarPreviewInlineDetailReader(doc, selector = CALENDAR_PREVIEW_DETAIL_SELECTOR) {
  const node = doc?.querySelector?.(selector);
  if (!node) return null;
  return () => {
    const parsed = JSON.parse(node.textContent || "");
    const summary = typeof parsed?.summary === "string" ? parsed.summary.trim() : "";
    if (!summary) throw new Error("inlined detail carries no summary");
    return { summary };
  };
}

if (typeof document !== "undefined") {
  const loadDetail = calendarPreviewInlineDetailReader(document);
  bindCompactMonthCalendar(document, loadDetail ? { loadDetail } : {});
}
