/**
 * Bounded display-occurrence contract and density evaluator.
 *
 * The standing calendar feed is future-oriented by construction (see
 * `calendar_occurrence.mjs`). A month calendar, though, has to look backwards:
 * an object-history view shows the hearings and votes that already happened, and
 * visual-density qualification has to weigh past and future dates together. This
 * module adds that ability without touching the feed's future-only default.
 *
 * It separates two things that are easy to conflate:
 *
 *   - *What an occurrence means* — a real date, canonical identity, a
 *     source-backed reason, a CityScroll destination, retained lifecycle. This
 *     is decided by the occurrence projection and re-checked here at the
 *     eligibility boundary so a date-like-but-ineligible record never reaches a
 *     calendar cell.
 *   - *Which window is being queried* — an explicit, required `{ from, to }`
 *     bound. Query bounds are presentation state, never civic scope: they are a
 *     required parameter of the new path and cannot alter any legacy default.
 *
 * On top of the bounded query sits a pure eligibility-and-density layer. It
 * makes the commissioned rule — at least three eligible occurrences, on at least
 * two distinct dates, inside a rolling 42-day window — executable before any
 * interface exists, so nine future surfaces cannot each invent a threshold. The
 * census exercises that rule across the commissioned surfaces from a committed
 * fixture corpus and records, per surface, the eligible / sparse / excluded /
 * unavailable outcome with reasons and the densest cluster it found.
 *
 * This module renders nothing. The month grid, six-week spillover, weekday
 * headings, and overflow disclosure are a separate shared component's job.
 */

import {
  deduplicateCalendarOccurrences,
  displayCandidateOccurrencesForRecord,
  recordHasAmbiguousDate,
} from "./calendar_occurrence.mjs";

export const CALENDAR_DISPLAY_SCHEMA = "cityscroll.calendar_display_occurrence.v1";
export const CALENDAR_DISPLAY_CENSUS_SCHEMA = "cityscroll.calendar_display_occurrence_census.v1";

// The commissioned density rule, kept as named constants so no surface hard-codes it.
export const DENSITY_MIN_OCCURRENCES = 3;
export const DENSITY_MIN_DISTINCT_DATES = 2;
// A rolling window of 42 consecutive calendar days: an anchor day plus the 41 after it.
export const DENSITY_WINDOW_DAYS = 42;

// The commissioned surfaces, in reader-visible order. Rules, Community Boards and
// Now are the first visual proofs; exams and legislative matters stay conditional.
export const CALENDAR_CENSUS_SURFACES = Object.freeze([
  "rules",
  "community_boards",
  "now",
  "land",
  "procurement",
  "property",
  "exams",
  "legislative",
]);

// The exhaustive, closed set of reasons a candidate is excluded. Every reason is
// one of the spec's normative exclusions; the census only ever reports these.
export const CALENDAR_DISPLAY_EXCLUSION_REASONS = Object.freeze([
  "missing-canonical-identity",
  "unjoined-source-record",
  "inferred-date-no-publisher-basis",
  "forecast-date",
  "predicted-date",
  "statutory-expected-date",
  "profile-derived-date",
  "low-confidence-derived-deadline",
  "missing-source-basis",
  "missing-canonical-destination",
  "duplicate-stable-occurrence",
  "publication-only-timestamp",
  "ambiguous-date",
  "undated-record",
]);

const LOW_CONFIDENCE_THRESHOLD = 0.5;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Provenance bases whose dates are not source-observed events. A basis that is
// not listed here (e.g. `publisher_record`) is treated as source-observed.
const EXCLUDED_BASIS_REASONS = Object.freeze({
  inferred: "inferred-date-no-publisher-basis",
  inference: "inferred-date-no-publisher-basis",
  forecast: "forecast-date",
  forecasted: "forecast-date",
  prediction: "predicted-date",
  predicted: "predicted-date",
  statutory_expected: "statutory-expected-date",
  statutory: "statutory-expected-date",
  expected: "statutory-expected-date",
  profile_derived: "profile-derived-date",
  profile: "profile-derived-date",
});

// Publication timestamps that are not themselves a semantic event.
const PUBLICATION_TIMESTAMP_FIELDS = Object.freeze([
  "published_at",
  "publication_date",
  "date_of_publication",
  "notice_published_at",
  "posted_at",
  "printed_at",
  "start_date",
]);

/* ---------- date and day identity ---------- */

function isDateOnly(value) {
  return typeof value === "string" && ISO_DATE.test(value);
}

function isoToEpochDay(iso) {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
}

function epochDayToIso(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function addDays(iso, count) {
  return epochDayToIso(isoToEpochDay(iso) + count);
}

function spanDaysInclusive(fromIso, toIso) {
  return isoToEpochDay(toIso) - isoToEpochDay(fromIso) + 1;
}

function monthOf(iso) {
  return typeof iso === "string" ? iso.slice(0, 7) : null;
}

// The calendar day an occurrence falls on. A date-only occurrence is its own
// day. A timestamp resolves to the calendar day in the occurrence's own
// timezone, so an evening hearing that crosses midnight in UTC still lands on
// the civic day the resident experienced.
export function occurrenceDay(occurrence = {}) {
  if (occurrence.date) return isDateOnly(occurrence.date) ? occurrence.date : null;
  const stamp = occurrence.starts_at;
  if (!stamp) return null;
  if (isDateOnly(stamp)) return stamp;
  const instant = Date.parse(stamp);
  if (Number.isNaN(instant)) return null;
  const timezone = occurrence.timezone;
  if (!timezone) return String(stamp).slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(instant));
    const at = (type) => parts.find((part) => part.type === type)?.value;
    const year = at("year");
    const month = at("month");
    const day = at("day");
    return year && month && day ? `${year}-${month}-${day}` : String(stamp).slice(0, 10);
  } catch {
    return String(stamp).slice(0, 10);
  }
}

/* ---------- bounds ---------- */

export function normalizeDisplayBounds(bounds) {
  if (!bounds || typeof bounds !== "object" || Array.isArray(bounds)) {
    throw new TypeError("bounded display query requires explicit { from, to } bounds");
  }
  const { from, to } = bounds;
  if (!isDateOnly(from) || !isDateOnly(to)) {
    throw new TypeError("display bounds must be YYYY-MM-DD `from` and `to` dates");
  }
  if (from > to) throw new TypeError("display bounds `from` must not be after `to`");
  return { from, to };
}

// Inclusive membership. ISO date strings compare lexically as dates do.
function withinBounds(day, bounds) {
  return day != null && day >= bounds.from && day <= bounds.to;
}

/* ---------- eligibility ---------- */

function objectRefFor(record = {}) {
  return record.object_ref || record.subject_ref || record.meeting_id || record.procurement_id
    || record.project_id || record.request_id || record.record_id
    || (record.exam_number ? `exam:${record.exam_number}` : null) || null;
}

function occurrenceBasis(occurrence, record) {
  const basis = occurrence?.provenance?.basis ?? record?.provenance?.basis ?? record?.date_basis;
  return String(basis ?? "").trim().toLowerCase();
}

function joinExclusion(record = {}) {
  const raw = record.join_status ?? record.cb_join_status ?? record.relationship_join_status ?? record.match_status;
  if (raw == null || raw === "") return null;
  const status = String(raw).trim().toLowerCase();
  const accepted = ["accepted", "joined", "matched", "confirmed", "resolved"];
  return accepted.includes(status) ? null : "unjoined-source-record";
}

function basisExclusion(occurrence, record = {}) {
  // Explicit record markers win, so a fixture can flag a domain record whose
  // producer would otherwise stamp a publisher basis over the real one.
  if (record.forecast === true) return "forecast-date";
  if (record.predicted === true) return "predicted-date";
  if (record.inferred === true) return "inferred-date-no-publisher-basis";
  if (record.statutory_expected === true || record.expected === true) return "statutory-expected-date";
  if (record.profile_derived === true) return "profile-derived-date";
  const basis = occurrenceBasis(occurrence, record);
  if (EXCLUDED_BASIS_REASONS[basis]) return EXCLUDED_BASIS_REASONS[basis];
  const confidence = Number(record.confidence ?? occurrence?.provenance?.confidence);
  const derived = basis === "derived" || record.derived === true;
  if (record.low_confidence === true) return "low-confidence-derived-deadline";
  if (derived && Number.isFinite(confidence) && confidence < LOW_CONFIDENCE_THRESHOLD) {
    return "low-confidence-derived-deadline";
  }
  return null;
}

/**
 * Decide whether one produced occurrence is an eligible display occurrence.
 * Returns `{ eligible, reason }`; reason is null iff eligible. The order is a
 * fixed priority so the census reports one deterministic reason per candidate.
 */
export function displayOccurrenceEligibility(occurrence, record = {}) {
  if (!occurrence || !occurrence.object_ref) return { eligible: false, reason: "missing-canonical-identity" };
  const join = joinExclusion(record);
  if (join) return { eligible: false, reason: join };
  const basis = basisExclusion(occurrence, record);
  if (basis) return { eligible: false, reason: basis };
  if (!occurrence.source) return { eligible: false, reason: "missing-source-basis" };
  if (!occurrence.canonical_url) return { eligible: false, reason: "missing-canonical-destination" };
  return { eligible: true, reason: null };
}

function zeroCandidateReason(record = {}) {
  if (recordHasAmbiguousDate(record)) return "ambiguous-date";
  if (PUBLICATION_TIMESTAMP_FIELDS.some((key) => record[key] != null && String(record[key]).trim() !== "")) {
    return "publication-only-timestamp";
  }
  return "undated-record";
}

/**
 * Classify one source record: the occurrences it produces, which are eligible,
 * and — for each candidate it emits or fails to emit — why it was excluded.
 * Deduplication is deliberately deferred to the pool step so duplicates that
 * span two records are still counted once.
 */
export function classifyDisplayRecord(record = {}, options = {}) {
  const produced = displayCandidateOccurrencesForRecord(record, options);
  if (produced.length === 0) {
    return {
      object_ref: objectRefFor(record),
      candidate_count: 0,
      eligible_occurrences: [],
      excluded: [{ reason: zeroCandidateReason(record), uid: null, day: null }],
    };
  }
  const eligible = [];
  const excluded = [];
  for (const occurrence of produced) {
    const verdict = displayOccurrenceEligibility(occurrence, record);
    if (verdict.eligible) eligible.push(occurrence);
    else excluded.push({ reason: verdict.reason, uid: occurrence.uid, day: occurrenceDay(occurrence) });
  }
  return { object_ref: objectRefFor(record), candidate_count: produced.length, eligible_occurrences: eligible, excluded };
}

/**
 * Pool eligible occurrences across records and resolve stable identity. A
 * rescheduled or cancelled record collapses onto the same UID (newest source
 * state wins, per the lifecycle contract); every dropped twin is reported as a
 * duplicate exclusion rather than surfacing a stale second cell.
 */
function poolEligible(classified) {
  const pooled = classified.flatMap((row) => row.eligible_occurrences);
  const deduped = deduplicateCalendarOccurrences(pooled);
  const keptByUid = new Map(deduped.map((occurrence) => [occurrence.uid, occurrence]));
  const counts = new Map();
  for (const occurrence of pooled) counts.set(occurrence.uid, (counts.get(occurrence.uid) || 0) + 1);
  const duplicates = [];
  for (const [uid, count] of counts) {
    const kept = keptByUid.get(uid);
    for (let index = 1; index < count; index += 1) {
      duplicates.push({ reason: "duplicate-stable-occurrence", uid, day: kept ? occurrenceDay(kept) : null });
    }
  }
  return { eligible: sortOccurrences(deduped), duplicates };
}

function sortOccurrences(occurrences) {
  return [...occurrences].sort((a, b) => {
    const dayA = occurrenceDay(a) || "";
    const dayB = occurrenceDay(b) || "";
    if (dayA !== dayB) return dayA < dayB ? -1 : 1;
    if ((a.kind || "") !== (b.kind || "")) return (a.kind || "") < (b.kind || "") ? -1 : 1;
    return (a.uid || "") < (b.uid || "") ? -1 : (a.uid || "") > (b.uid || "") ? 1 : 0;
  });
}

/* ---------- bounded display query (A1) ---------- */

/**
 * The bounded display query. `bounds` is a required `{ from, to }` window; past
 * occurrences inside it are included. This is the only calendar-facing path that
 * looks backwards, and it never touches feed defaults.
 */
export function boundedDisplayOccurrences(rows, bounds, options = {}) {
  const window = normalizeDisplayBounds(bounds);
  const classified = (Array.isArray(rows) ? rows : []).map((record) => classifyDisplayRecord(record, options));
  const { eligible } = poolEligible(classified);
  return eligible.filter((occurrence) => withinBounds(occurrenceDay(occurrence), window));
}

/* ---------- density / cluster evaluation (A3) ---------- */

function betterWindow(candidate, best) {
  if (!best) return true;
  if (candidate.occurrence_count !== best.occurrence_count) return candidate.occurrence_count > best.occurrence_count;
  if (candidate.distinct_dates !== best.distinct_dates) return candidate.distinct_dates > best.distinct_dates;
  return candidate.anchor < best.anchor;
}

function selectedMonthFor(daysInWindow) {
  const counts = new Map();
  for (const day of daysInWindow) {
    const month = monthOf(day);
    counts.set(month, (counts.get(month) || 0) + 1);
  }
  let selected = null;
  let top = -1;
  for (const month of [...counts.keys()].sort()) {
    if (counts.get(month) > top) {
      top = counts.get(month);
      selected = month;
    }
  }
  return selected;
}

/**
 * Evaluate the commissioned density rule against a bundle of eligible
 * occurrences. Pure: no clock, no I/O. Returns whether a month view qualifies,
 * an explicit reason when it does not, the densest rolling window found, the
 * month that window sits in, and whether the cluster crosses a month boundary.
 */
export function evaluateDisplayCluster(occurrences = [], options = {}) {
  const windowDays = options.window_days ?? DENSITY_WINDOW_DAYS;
  const minOccurrences = options.min_occurrences ?? DENSITY_MIN_OCCURRENCES;
  const minDistinctDates = options.min_distinct_dates ?? DENSITY_MIN_DISTINCT_DATES;
  const days = occurrences.map(occurrenceDay).filter(Boolean).sort();
  const distinctDates = [...new Set(days)];

  const base = {
    schema: CALENDAR_DISPLAY_SCHEMA,
    candidate_occurrences: occurrences.length,
    distinct_dates: distinctDates.length,
    densest_window: null,
    selected_month: null,
    crosses_month_boundary: false,
  };

  if (occurrences.length === 0) {
    return { ...base, qualifies: false, reason: "unavailable-no-occurrences" };
  }

  let best = null;
  for (const anchor of distinctDates) {
    const end = addDays(anchor, windowDays - 1);
    const inWindow = days.filter((day) => day >= anchor && day <= end);
    const candidate = {
      anchor,
      window_from: anchor,
      window_to: end,
      first: inWindow[0],
      last: inWindow[inWindow.length - 1],
      occurrence_count: inWindow.length,
      distinct_dates: new Set(inWindow).size,
    };
    if (betterWindow(candidate, best)) best = candidate;
  }

  const qualifies = Boolean(best && best.occurrence_count >= minOccurrences && best.distinct_dates >= minDistinctDates);
  let reason;
  if (qualifies) reason = "eligible";
  else if (occurrences.length < minOccurrences) reason = "sparse-too-few-occurrences";
  else if (distinctDates.length < minDistinctDates) reason = "sparse-single-date";
  else reason = "sparse-no-dense-window";

  const densestWindow = best
    ? {
      window_from: best.window_from,
      window_to: best.window_to,
      from: best.first,
      to: best.last,
      span_days: spanDaysInclusive(best.first, best.last),
      occurrence_count: best.occurrence_count,
      distinct_dates: best.distinct_dates,
    }
    : null;

  const daysInBest = best ? days.filter((day) => day >= best.window_from && day <= best.window_to) : [];
  return {
    ...base,
    densest_window: densestWindow,
    selected_month: qualifies ? selectedMonthFor(daysInBest) : null,
    crosses_month_boundary: qualifies ? monthOf(best.first) !== monthOf(best.last) : false,
    qualifies,
    reason,
  };
}

/* ---------- census (A3) ---------- */

function tallyReasons(entries) {
  const counts = {};
  for (const entry of entries) counts[entry.reason] = (counts[entry.reason] || 0) + 1;
  return Object.fromEntries(Object.keys(counts).sort().map((reason) => [reason, counts[reason]]));
}

/**
 * Build the census row for one commissioned surface from its fixture records.
 * `qualification` is the reviewed outcome: `eligible` (a month view qualifies),
 * `sparse` (eligible occurrences exist but the density rule is not met),
 * `excluded` (date-like candidates existed but none were eligible), or
 * `unavailable` (no date-like candidate at all).
 */
export function buildSurfaceCensus(surface = {}, options = {}) {
  const records = Array.isArray(surface.records) ? surface.records : [];
  const surfaceOptions = { ...options, ...(surface.options || {}) };
  const classified = records.map((record) => classifyDisplayRecord(record, surfaceOptions));
  const { eligible, duplicates } = poolEligible(classified);
  const excluded = [...classified.flatMap((row) => row.excluded), ...duplicates];
  const candidateCount = classified.reduce((sum, row) => sum + row.candidate_count, 0);
  const cluster = evaluateDisplayCluster(eligible);

  let qualification;
  if (cluster.qualifies) qualification = "eligible";
  else if (eligible.length > 0) qualification = "sparse";
  else if (candidateCount > 0) qualification = "excluded";
  else qualification = "unavailable";

  return {
    surface: surface.surface,
    fixture: surface.fixture ?? null,
    input_revision: surface.revision ?? null,
    record_count: records.length,
    candidate_occurrences: candidateCount,
    eligible_occurrences: eligible.length,
    excluded_occurrences: excluded.length,
    distinct_eligible_dates: new Set(eligible.map(occurrenceDay).filter(Boolean)).size,
    exclusion_reasons: tallyReasons(excluded),
    densest_window: cluster.densest_window,
    selected_month: cluster.selected_month,
    crosses_month_boundary: cluster.crosses_month_boundary,
    qualifies: cluster.qualifies,
    qualification,
    qualification_reason: cluster.reason,
  };
}

const CENSUS_QUALIFICATIONS = Object.freeze(["eligible", "sparse", "excluded", "unavailable"]);

/**
 * Build the full deterministic census across the commissioned surfaces. Every
 * output field is derived from the committed fixture corpus and the fixed
 * density rule — there is no clock and no live fetch — so the census is
 * reproducible byte-for-byte.
 */
export function buildDisplayOccurrenceCensus(surfaces = [], options = {}) {
  const rows = (Array.isArray(surfaces) ? surfaces : []).map((surface) => buildSurfaceCensus(surface, options));
  const statusCounts = Object.fromEntries(CENSUS_QUALIFICATIONS.map((status) => [status, 0]));
  for (const row of rows) statusCounts[row.qualification] += 1;

  return {
    schema: CALENDAR_DISPLAY_CENSUS_SCHEMA,
    version: 1,
    density_rule: {
      min_occurrences: options.min_occurrences ?? DENSITY_MIN_OCCURRENCES,
      min_distinct_dates: options.min_distinct_dates ?? DENSITY_MIN_DISTINCT_DATES,
      window_days: options.window_days ?? DENSITY_WINDOW_DAYS,
    },
    policy: {
      eligibility: "An eligible display occurrence has a valid exact date or timestamp, canonical identity, a source-observed reason, an accepted join where a relationship supplies one, a canonical CityScroll destination, and retained lifecycle and source state.",
      exclusion_reasons: [...CALENDAR_DISPLAY_EXCLUSION_REASONS],
      qualification_definitions: {
        eligible: "At least three eligible occurrences on at least two distinct dates fit inside a rolling 42-day window.",
        sparse: "Eligible occurrences exist but do not meet the density rule; the existing date presentation is retained with no empty calendar.",
        excluded: "Date-like candidates existed but none were eligible display occurrences.",
        unavailable: "No date-like candidate occurrence was available on the surface.",
      },
      feed_relationship: "The bounded display query can look backwards; the standing feed remains future-only. Query bounds and the calendar/list selector are presentation state and never enter Follow, Browse, project, watch, or subscription scope.",
    },
    provenance: {
      corpus: "Measured over the committed fixture corpus for this workstream, not a live production sample.",
      cluster: "Densest-window and selected-month values are derived from the corpus above.",
      coverage: "Production-wide prevalence is unknown and is deliberately not claimed from fixtures.",
    },
    summary: {
      surface_count: rows.length,
      status_counts: statusCounts,
      headline: `Of ${rows.length} commissioned surfaces measured against the fixture corpus: ${statusCounts.eligible} qualify for a month view, ${statusCounts.sparse} sparse, ${statusCounts.excluded} with only ineligible candidates, ${statusCounts.unavailable} with no date-like candidate.`,
    },
    surfaces: rows,
  };
}
