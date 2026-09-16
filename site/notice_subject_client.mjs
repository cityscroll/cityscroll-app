/**
 * Client-side notice subject links. Kept outside app/routing.mjs so the route
 * module stays under the short-context working bar while still projecting
 * accepted procurement subjects onto the hydrated notice document.
 */

import {
  projectNoticeSubjectLinks,
  renderNoticeSubjectLinksHtml,
} from "./notice_subject_projection.mjs";

/** Load the reverse lookup and render subject continuation links for one notice row. */
export async function renderNoticeSubjectLinksForRow(row, { escape } = {}) {
  let subjectsLookup = null;
  try {
    subjectsLookup = (await import("./data/notice_procurement_subjects_lookup.json", {
      with: { type: "json" },
    })).default;
  } catch (_error) {
    subjectsLookup = null;
  }
  const projection = projectNoticeSubjectLinks(row || {}, { subjectsLookup });
  return renderNoticeSubjectLinksHtml(projection.subjects || [], { escape });
}
