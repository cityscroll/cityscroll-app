/**
 * Legislative matter appearance calendar.
 *
 * A source-backed committee/Council appearance is evidence a matter was
 * before a body on a date — it is not itself a claimed decision. This module
 * only decides whether a matter's observed appearances cluster densely
 * enough to earn a compact month view; it never renders committee,
 * proceeding, action, or vote identity, and it never forks the shared
 * CBICS-01/CBICS-02 contract. `legislative_matter_document.mjs` keeps that
 * identity in the detailed appearance list below whatever this module
 * produces.
 *
 * Each appearance becomes one bounded display-occurrence record whose
 * canonical destination is the same CityScroll meeting notice link the
 * appearance's own evidence list already points to, so a calendar cell and
 * its appearance always resolve to the same evidence (A1). Two appearances
 * that resolve to the same Council/committee event (for example two notices
 * for one meeting) share one `object_ref` and collapse to a single cell
 * through the existing CBICS-01 duplicate-occurrence handling — the
 * appearance list itself is never touched.
 */

import { boundedDisplayOccurrences } from "./calendar_display.mjs";
import { buildCompactMonthView, renderCompactMonth } from "./compact_calendar.mjs";
import { LEGISLATIVE_MATTER_SCHEMA } from "./legislative_matter_document.mjs";

export const MATTER_APPEARANCES_ANCHOR = "matter-appearances";
export const MATTER_APPEARANCES_FULL_LIST_LABEL = "View all observed appearances";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isoDateOnly(value) {
  return typeof value === "string" && ISO_DATE.test(value) ? value : null;
}

function noticeCanonicalUrl(requestId) {
  return requestId ? `https://cityscroll.org/notices/${encodeURIComponent(requestId)}/` : null;
}

// One bounded-display-query record per appearance (CBICS-01 shape). Only the
// fields this module needs to prove a real date, canonical identity, and a
// source basis are set — committee, action, and vote identity are
// deliberately left off so the calendar cannot carry a claim the retained
// appearance below does not.
function calendarRecordForAppearance(matterId, appearance) {
  const eventDate = isoDateOnly(appearance?.event?.date);
  const eventId = appearance?.event?.event_id;
  const requestId = appearance?.request_id;
  const canonicalUrl = noticeCanonicalUrl(requestId);
  if (!eventDate || !eventId || !canonicalUrl) return null;
  return {
    object_ref: `matter:${matterId}:${eventId}`,
    event_date: eventDate,
    canonical_url: canonicalUrl,
    source_system: "legistar",
    source_record_id: eventId,
    source_url: appearance.event.href || undefined,
    timezone: "America/New_York",
    title: appearance.event.name || undefined,
    // Forward-compatible only: today's Council meeting-outcome
    // materialization carries no reschedule/cancellation signal, so these
    // are undefined for every real appearance and the occurrence defaults
    // to "scheduled". A future source revision that does carry lifecycle
    // state flows through unchanged — this module does not reinterpret it.
    status: appearance.status || undefined,
    lifecycle: appearance.lifecycle || undefined,
    sequence: appearance.sequence,
  };
}

/**
 * Build the CBICS-01 bounded display-occurrence records for a matter's
 * appearances, without evaluating density. Exported mainly for tests that
 * need to inspect the record shape directly.
 */
export function matterAppearanceCalendarRecords(view) {
  if (!view || view.schema !== LEGISLATIVE_MATTER_SCHEMA || !Array.isArray(view.appearances)) return [];
  return view.appearances
    .map((appearance) => calendarRecordForAppearance(view.id, appearance))
    .filter(Boolean);
}

/**
 * Build the compact month view over a legislative matter document's
 * appearances. Pure: `options.today`, when supplied, is the only clock input
 * and is never read from a hidden `Date.now()`. When it is omitted this
 * falls back to the document's own materialization date so the function
 * still never throws for a caller that has no live clock to offer — the edge
 * request handler is expected to supply the real one.
 *
 * Returns a `render:false` non-render result (no calendar furniture) when
 * the matter has no dated appearances at all or when the density rule is not
 * met, and a `render:true` compact-month view otherwise.
 */
export function buildMatterAppearanceCalendarView(view, options = {}) {
  const records = matterAppearanceCalendarRecords(view);
  const dates = records.map((record) => record.event_date).sort();
  if (!dates.length) {
    return {
      schema: "cityscroll.compact_month_non_render.v1",
      render: false,
      reason: "unavailable-no-occurrences",
      candidate_occurrences: 0,
      distinct_dates: 0,
    };
  }
  const bounds = { from: dates[0], to: dates[dates.length - 1] };
  const today = isoDateOnly(options.today)
    || isoDateOnly(String(view?.generated_at || "").slice(0, 10))
    || bounds.to;
  const occurrences = boundedDisplayOccurrences(records, bounds, { kind: "meeting" });
  return buildCompactMonthView(occurrences, { today });
}

/**
 * Render a matter's appearance calendar, including the retained link back to
 * the detailed appearance list. Empty string when the calendar view does not
 * qualify — the caller adds no empty calendar chrome (A4).
 */
export function renderMatterAppearanceCalendar(calendarView, options = {}) {
  return renderCompactMonth(calendarView, {
    fullListHref: `#${MATTER_APPEARANCES_ANCHOR}`,
    fullListLabel: MATTER_APPEARANCES_FULL_LIST_LABEL,
    esc: options.esc,
  });
}
