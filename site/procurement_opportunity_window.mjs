/**
 * Provenance-safe opportunity window (procurement-pursuit-decision, Card 2).
 *
 * A procurement can carry two different "how long does a vendor have to
 * respond" boundaries, and they are not interchangeable:
 *
 *   - An exact PASSPort RFx `release_date -> due_date` pair is the true
 *     response window: CityScroll observed both the day the solicitation was
 *     released and the day a response is due, from the same authoritative
 *     record.
 *   - A City Record notice only carries a publication/`start_date` and a
 *     `due_date`. Publication can lag the real RFx release, so that span is a
 *     weaker "notice-to-due" fact and must never be relabeled as the
 *     response window.
 *
 * This module derives exactly one object per procurement — the same one
 * browse, detail, and alerts render — and fails closed (`Window unavailable`)
 * rather than ever showing a 0-day or negative-day span. It composes with,
 * and never replaces, `opportunity_calendar.mjs` (important dates) and
 * `solicitation_procurement_method.mjs` (rule-derived response floors); a
 * rule floor is display-paired here, never treated as a compliance verdict.
 *
 * Date math is deliberately local: the codebase's calendar-adjacent modules
 * (`calendar_occurrence.mjs`'s `validDate`, `calendar_display.mjs`'s
 * epoch-day helpers) already normalize ISO/US date strings through this same
 * UTC-midnight-anchored, round-trip-validated idiom, but keep it private to
 * their own file. Reimplementing the identical idiom here — rather than
 * reaching for `Date.parse` on a bare non-ISO string, which resolves in the
 * runner's local timezone and can shift a date across DST/month/year
 * boundaries — is not a second date parser; it is the same one, kept
 * dependency-free so this module stays usable from both `site/` and
 * `worker/` callers.
 */

export const PROCUREMENT_OPPORTUNITY_WINDOW_SCHEMA = "cityscroll.procurement_opportunity_window.v1";

export const OPPORTUNITY_WINDOW_KIND = Object.freeze({
  RESPONSE_WINDOW: "response_window",
  NOTICE_TO_DUE_WINDOW: "notice_to_due_window",
});

// The exhaustive, closed set of reasons a window is unavailable. Every
// unavailable result names one of these; nothing is ever silently null.
export const OPPORTUNITY_WINDOW_UNAVAILABLE_REASONS = Object.freeze([
  "missing_start_date",
  "missing_due_date",
  "invalid_date",
  "due_before_start",
  "no_qualifying_observation",
]);

const PASSPORT_SYSTEM = "passport_public_rfx";
const CITY_RECORD_SYSTEM = "city_record";
const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

/**
 * Normalize an ISO (`YYYY-MM-DD`, or the date prefix of a longer ISO
 * timestamp) or US (`MM/DD/YYYY`) date string to `YYYY-MM-DD`, anchored at
 * UTC midnight and round-trip validated so an out-of-range calendar date
 * (e.g. `02/30/2026`) returns null instead of silently rolling over.
 */
function isoDayOnly(value) {
  const raw = text(value);
  if (!raw) return null;
  const isoPrefix = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoPrefix) {
    const candidate = isoPrefix[1];
    if (!ISO_DATE.test(candidate)) return null;
    const ms = Date.parse(`${candidate}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === candidate ? candidate : null;
  }
  const us = raw.match(US_DATE);
  if (us) {
    const candidate = `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    const ms = Date.parse(`${candidate}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === candidate ? candidate : null;
  }
  return null;
}

function epochDay(iso) {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}

// UTC epoch-day subtraction is immune to local-timezone DST transitions (it
// never touches local time) and to month/year/leap-year boundaries (the
// Gregorian calendar arithmetic lives entirely inside the UTC Date engine).
function calendarDaysBetween(startIso, dueIso) {
  return epochDay(dueIso) - epochDay(startIso);
}

function unavailableWindow(reason) {
  return Object.freeze({
    schema: PROCUREMENT_OPPORTUNITY_WINDOW_SCHEMA,
    available: false,
    kind: null,
    start_date: null,
    due_date: null,
    days: null,
    day_unit: null,
    source_system: null,
    source_observation_ref: null,
    derivation: null,
    confidence: null,
    reason,
    label: "Window unavailable",
  });
}

/**
 * Pure derivation over already-resolved boundary candidates. Most callers
 * want `procurementOpportunityWindow()` below; this lower-level entry point
 * is for callers (and tests) that already know which observation supplied
 * which date and want to skip the object/observations lookup.
 */
export function deriveProcurementOpportunityWindow({
  passport_release_date = null,
  passport_due_date = null,
  passport_source_observation_ref = null,
  city_record_start_date = null,
  city_record_due_date = null,
  city_record_source_observation_ref = null,
} = {}) {
  // Rule 4: a PASSPort pair that was offered but is malformed fails closed
  // rather than silently falling through to the City Record boundary — that
  // fallback would risk exactly the "substitute City Record publication for
  // RFx release" behavior the rule forbids.
  if (passport_release_date != null && passport_due_date != null) {
    const release = isoDayOnly(passport_release_date);
    const due = isoDayOnly(passport_due_date);
    if (!release || !due) return unavailableWindow("invalid_date");
    const days = calendarDaysBetween(release, due);
    if (days <= 0) return unavailableWindow("due_before_start");
    return Object.freeze({
      schema: PROCUREMENT_OPPORTUNITY_WINDOW_SCHEMA,
      available: true,
      kind: OPPORTUNITY_WINDOW_KIND.RESPONSE_WINDOW,
      start_date: release,
      due_date: due,
      days,
      day_unit: "calendar_days",
      source_system: PASSPORT_SYSTEM,
      source_observation_ref: passport_source_observation_ref || null,
      derivation: "release_date_to_due_date",
      confidence: "high",
      reason: null,
      label: `Response window: ${days} calendar days`,
    });
  }

  if (city_record_start_date != null && city_record_due_date != null) {
    const start = isoDayOnly(city_record_start_date);
    const due = isoDayOnly(city_record_due_date);
    if (!start || !due) return unavailableWindow("invalid_date");
    const days = calendarDaysBetween(start, due);
    if (days <= 0) return unavailableWindow("due_before_start");
    return Object.freeze({
      schema: PROCUREMENT_OPPORTUNITY_WINDOW_SCHEMA,
      available: true,
      kind: OPPORTUNITY_WINDOW_KIND.NOTICE_TO_DUE_WINDOW,
      start_date: start,
      due_date: due,
      days,
      day_unit: "calendar_days",
      source_system: CITY_RECORD_SYSTEM,
      source_observation_ref: city_record_source_observation_ref || null,
      derivation: "city_record_publication_to_due_date",
      confidence: "medium",
      reason: null,
      label: `Notice-to-due window: ${days} calendar days`,
    });
  }

  const anyStart = passport_release_date != null || city_record_start_date != null;
  const anyDue = passport_due_date != null || city_record_due_date != null;
  if (!anyStart && !anyDue) return unavailableWindow("no_qualifying_observation");
  return unavailableWindow(anyDue ? "missing_start_date" : "missing_due_date");
}

function referencedObservations(object, observations) {
  const refs = new Set(Array.isArray(object?.source_observation_refs) ? object.source_observation_refs : []);
  if (!refs.size) return [];
  return (Array.isArray(observations) ? observations : [])
    .filter((entry) => entry && refs.has(entry.source_observation_ref));
}

function bySourceSystem(entries, system) {
  return entries
    .filter((entry) => text(entry.source_system)?.toLowerCase() === system)
    .sort((left, right) => text(right.ingested_at)?.localeCompare(text(left.ingested_at) || "") || 0);
}

/**
 * Object/observations adapter — the same calling convention used by
 * `procurementOpportunityOccurrences()` in `opportunity_calendar.mjs` and by
 * `renderProcurementDocument()`. Among the observations a procurement object
 * actually references, this picks the newest PASSPort RFx observation that
 * carries a complete `release_date`/`due_date` pair (preferring it, per
 * rule 1), else the newest City Record observation carrying a complete
 * `start_date`/`due_date` pair (rule 2), and derives through the same pure
 * rules as `deriveProcurementOpportunityWindow()`.
 */
export function procurementOpportunityWindow(object = {}, observations = []) {
  const referenced = referencedObservations(object, observations);
  if (!referenced.length) return unavailableWindow("no_qualifying_observation");

  const passportCandidates = bySourceSystem(referenced, PASSPORT_SYSTEM);
  const cityRecordCandidates = bySourceSystem(referenced, CITY_RECORD_SYSTEM);

  const passport = passportCandidates.find((entry) => {
    const snapshot = entry?.snapshot || {};
    return isoDayOnly(snapshot.release_date) && isoDayOnly(snapshot.due_date);
  }) || passportCandidates[0] || null;

  const cityRecord = cityRecordCandidates.find((entry) => {
    const snapshot = entry?.snapshot || {};
    return isoDayOnly(snapshot.start_date) && isoDayOnly(snapshot.due_date);
  }) || cityRecordCandidates[0] || null;

  return deriveProcurementOpportunityWindow({
    passport_release_date: passport?.snapshot?.release_date ?? null,
    passport_due_date: passport?.snapshot?.due_date ?? null,
    passport_source_observation_ref: passport?.source_observation_ref ?? null,
    city_record_start_date: cityRecord?.snapshot?.start_date ?? null,
    city_record_due_date: cityRecord?.snapshot?.due_date ?? null,
    city_record_source_observation_ref: cityRecord?.source_observation_ref ?? null,
  });
}

/**
 * Display copy pairing a published window with a rule-derived response
 * floor (`solicitation_procurement_method.mjs`'s `response_floor`). The
 * pairing is presented side by side and never as a verdict: no compliant,
 * noncompliant, suspicious, wired, preselected, or fake language, and no
 * floor comparison at all when the window itself is unavailable (rule 3).
 */
export function opportunityWindowDisplayLine(window, responseFloor = null) {
  if (!window?.available) return window?.label || "Window unavailable";
  const windowLabel = window.kind === OPPORTUNITY_WINDOW_KIND.RESPONSE_WINDOW
    ? `Published response window: ${window.days} calendar days`
    : `Published notice-to-due window: ${window.days} calendar days`;
  if (!responseFloor || !Number.isFinite(responseFloor.days)) return windowLabel;
  const floorUnit = responseFloor.day_unit === "business_days" ? "business days" : "calendar days";
  return `${windowLabel} · applicable rule floor: ${responseFloor.days} ${floorUnit}`;
}
