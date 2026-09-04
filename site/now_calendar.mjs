/**
 * Now → Calendar projection.
 *
 * Now already compiles one eligible, scoped, horizon-bounded population: the
 * dated act-by deadlines and the happening-soon events (`buildNowSurface` in
 * `now_surface.mjs`). This module does not re-derive eligibility, widen the
 * horizon, or add a record the Cards lanes do not already show — it only maps
 * that same population onto the shared `cityscroll.calendar_display_occurrence.v1`
 * shape so `buildCompactMonthView` (`compact_calendar.mjs`) can paint it as a
 * month grid. Undated open opportunities are never touched here, so they can
 * never receive an invented cell (A3).
 *
 * A act-by item always becomes a `deadline` occurrence and a happening-soon
 * item always becomes an `event` occurrence (A2): the lane a resident already
 * reads is the same signal that keeps the calendar cell visually distinct,
 * with no second per-domain kind vocabulary to keep in sync.
 *
 * Now recomputes fresh from the current source snapshot on every call, so a
 * single build only ever contains today's truth for a given civic record.
 * The remaining risk is a record whose own raw event list still carries a
 * superseded entry alongside its current one (an append-only source history).
 * `resolveNowCalendarOccurrences` collapses those onto one date-stable
 * identity per record: the entry with the latest date wins, and the record's
 * cancellation flag decides whether the survivor reads as retained,
 * rescheduled, or cancelled (A7) — never a stale duplicate on the old date.
 */

import { buildCompactMonthView } from "./compact_calendar.mjs";

export const NOW_CALENDAR_SCHEMA = "cityscroll.now_calendar_view.v1";

const TRAILING_DATE = /:\d{4}-\d{2}-\d{2}$/;

/**
 * The identity a calendar cell is retained under. Now's own Cards `item.id`
 * is already stable for most domains, but property, land, and rules-event
 * ids carry a trailing `:YYYY-MM-DD` so two Cards for the same object never
 * collide. Stripping that segment gives the calendar the same object+kind
 * identity across a reschedule, so one record never paints two cells.
 */
export function stableNowCalendarUid(item) {
  return String(item?.id || "").replace(TRAILING_DATE, "");
}

// Every Now item route is either an internal path (including land's
// hash-fragment `/#land/<id>` form) or, rarely, already absolute.
function absoluteCanonicalUrl(route) {
  const value = String(route || "");
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `https://cityscroll.org${value}`;
  return null;
}

function occurrenceSource(item) {
  const url = absoluteCanonicalUrl(item.route);
  return { system: item.source?.system || item.domain, url };
}

function occurrenceProvenance(item) {
  return {
    basis: item.time?.basis || null,
    source_field: item.time?.source_field || null,
    verified: item.time?.verified !== false,
  };
}

// Later date wins a same-identity collision: the source's current truth, not
// the entry it superseded. Ties keep the first-seen entry deterministically.
function laterDay(a, b) {
  return String(a?.time?.day || "") >= String(b?.time?.day || "") ? a : b;
}

/**
 * Group Now items by their date-stable calendar identity and resolve each
 * group to one retained item plus the lifecycle it should carry. A group of
 * one is simply retained as scheduled (or cancelled, if the record itself
 * says so). A group of more than one is a reschedule: the latest-dated entry
 * wins and is flagged rescheduled, unless that latest entry is itself the
 * cancellation — then the retained entry is flagged cancelled instead.
 */
export function resolveNowCalendarOccurrences(items) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.time?.value || !item?.id) continue;
    const uid = stableNowCalendarUid(item);
    const existing = groups.get(uid);
    groups.set(uid, existing ? [...existing, item] : [item]);
  }
  const resolved = [];
  for (const [uid, group] of groups) {
    const survivor = group.reduce((best, candidate) => laterDay(best, candidate));
    const rescheduled = group.length > 1 && !survivor.cancelled;
    const lifecycle = survivor.cancelled ? "cancelled" : rescheduled ? "rescheduled" : "scheduled";
    resolved.push({ uid, item: survivor, lifecycle });
  }
  return resolved;
}

function toCalendarOccurrence(uid, item, lifecycle, kind) {
  const canonicalUrl = absoluteCanonicalUrl(item.route);
  if (!canonicalUrl) return null;
  const isDateOnly = item.time?.precision !== "instant";
  return {
    uid,
    kind,
    lifecycle,
    status: lifecycle === "cancelled" ? "cancelled" : "scheduled",
    title: item.title,
    ...(isDateOnly ? { date: item.time.day } : { starts_at: item.time.value }),
    ends_at: null,
    timezone: isDateOnly ? null : "America/New_York",
    canonical_url: canonicalUrl,
    source: occurrenceSource(item),
    provenance: occurrenceProvenance(item),
  };
}

/**
 * Project one built Now surface onto the shared calendar occurrence contract.
 * Only the two dated lanes participate; `act_by.open_without_date` is never
 * read (A3). Pure: no clock, no I/O.
 */
export function nowCalendarOccurrences(surface) {
  const deadlines = resolveNowCalendarOccurrences(surface?.act_by?.dated)
    .map(({ uid, item, lifecycle }) => toCalendarOccurrence(uid, item, lifecycle, "deadline"));
  const events = resolveNowCalendarOccurrences(surface?.happening_soon?.items)
    .map(({ uid, item, lifecycle }) => toCalendarOccurrence(uid, item, lifecycle, "event"));
  return [...deadlines, ...events].filter(Boolean);
}

/**
 * Build the compact month view for a Now surface. Returns the same
 * `render: true` / `render: false` shape `buildCompactMonthView` returns —
 * `render: false` means the eligible population does not meet the
 * commissioned density rule, and the caller keeps Cards on screen (never an
 * empty calendar).
 */
export function buildNowCalendarView(surface, options = {}) {
  return buildCompactMonthView(nowCalendarOccurrences(surface), options);
}
