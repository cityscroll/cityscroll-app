/**
 * Typed weekly meeting availability and its shared civil-time evaluator.
 *
 * A window is an OR branch.  The constraints within a window (weekday and
 * optional clock bounds) are ANDed.  Exact starts are read from the canonical
 * calendar occurrence; date-only, conflicted, invalid, and cancelled records
 * never acquire a guessed clock time.
 */

import { calendarOccurrencesForRecord } from "./calendar_occurrence.mjs";

export const MEETING_AVAILABILITY_SCHEMA = "cityscroll.meeting_availability.v1";
export const MEETING_AVAILABILITY_UNKNOWN_START_POLICIES = Object.freeze(["exclude", "include"]);

const WEEKDAY_NAMES = Object.freeze([
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
]);
const WEEKDAY_ALIASES = new Map([
  ["sun", 0], ["sunday", 0],
  ["mon", 1], ["monday", 1],
  ["tue", 2], ["tues", 2], ["tuesday", 2],
  ["wed", 3], ["wednesday", 3],
  ["thu", 4], ["thur", 4], ["thurs", 4], ["thursday", 4],
  ["fri", 5], ["friday", 5],
  ["sat", 6], ["saturday", 6],
]);
const CLOCK_RE = /^(\d{2}):(\d{2})$/;
const OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;
const LOCAL_START_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function validTime(value, { allowMidnightEnd = false } = {}) {
  if (typeof value !== "string" || !CLOCK_RE.test(value)) return null;
  const [, hoursText, minutesText] = value.match(CLOCK_RE);
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (minutes > 59 || hours > (allowMidnightEnd ? 24 : 23)) return null;
  if (hours === 24 && minutes !== 0) return null;
  return value;
}

function minuteOf(value) {
  if (value == null) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function normalizeWeekdays(value) {
  const input = Array.isArray(value) ? value : value == null ? [] : [value];
  const weekdays = [];
  for (const item of input) {
    let day = null;
    if (Number.isInteger(item) && item >= 0 && item <= 6) day = item;
    if (typeof item === "string") {
      const normalized = item.trim().toLowerCase();
      if (/^[0-6]$/.test(normalized)) day = Number(normalized);
      else day = WEEKDAY_ALIASES.get(normalized) ?? null;
    }
    if (day == null) return null;
    weekdays.push(day);
  }
  return [...new Set(weekdays)].sort((left, right) => left - right);
}

function validTimezone(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const timezone = value.trim();
  try {
    // Constructing the formatter validates the IANA zone. Do not call format()
    // without an explicit instant: that would read the host wall clock during
    // admission and make shifted test runs depend on the day they execute.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return null;
  }
}

function validationError(code, path, value) {
  return { code, path, value };
}

/**
 * Validate and canonicalize a resident availability expression.
 *
 * `weekdays` uses JavaScript's stable Sunday=0 through Saturday=6 enum. Names
 * and short names are accepted at the boundary and canonicalized to numbers.
 * Missing start/end bounds mean the whole civil day or the open side of it.
 */
export function validateMeetingAvailability(value) {
  if (value == null) return { ok: true, present: false, canonical: null, errors: [] };
  const input = object(value);
  if (!input) return { ok: false, present: true, canonical: null, errors: [validationError("not_an_object", "availability", value)] };
  if (input.schema != null && input.schema !== MEETING_AVAILABILITY_SCHEMA) {
    return { ok: false, present: true, canonical: null, errors: [validationError("schema", "schema", input.schema)] };
  }

  const errors = [];
  const timezone = validTimezone(input.timezone);
  if (!timezone) errors.push(validationError("invalid_timezone", "timezone", input.timezone));
  const unknownStart = input.unknown_start == null ? "exclude" : input.unknown_start;
  if (!MEETING_AVAILABILITY_UNKNOWN_START_POLICIES.includes(unknownStart)) {
    errors.push(validationError("invalid_unknown_start_policy", "unknown_start", unknownStart));
  }
  if (!Array.isArray(input.windows) || input.windows.length === 0) {
    errors.push(validationError("empty_windows", "windows", input.windows));
  }

  const windows = [];
  for (const [index, rawWindow] of (Array.isArray(input.windows) ? input.windows : []).entries()) {
    const window = object(rawWindow);
    if (!window) {
      errors.push(validationError("invalid_window", `windows[${index}]`, rawWindow));
      continue;
    }
    const weekdays = normalizeWeekdays(window.weekdays ?? window.days ?? window.weekday);
    if (!weekdays?.length) {
      errors.push(validationError("empty_weekdays", `windows[${index}].weekdays`, window.weekdays));
      continue;
    }
    const start = window.start ?? window.start_at ?? window.from ?? null;
    const end = window.end ?? window.end_at ?? window.to ?? null;
    const normalizedStart = start == null ? null : validTime(start);
    const normalizedEnd = end == null ? null : validTime(end, { allowMidnightEnd: true });
    if (start != null && !normalizedStart) errors.push(validationError("invalid_time", `windows[${index}].start`, start));
    if (end != null && !normalizedEnd) errors.push(validationError("invalid_time", `windows[${index}].end`, end));
    if (normalizedStart && normalizedEnd && minuteOf(normalizedEnd) <= minuteOf(normalizedStart)) {
      errors.push(validationError("empty_or_reversed_window", `windows[${index}]`, rawWindow));
    }
    windows.push({ weekdays, start: normalizedStart, end: normalizedEnd });
  }

  if (errors.length) return { ok: false, present: true, canonical: null, errors };
  return {
    ok: true,
    present: true,
    canonical: {
      schema: MEETING_AVAILABILITY_SCHEMA,
      timezone,
      windows,
      unknown_start: unknownStart,
    },
    errors: [],
  };
}

export function canonicalMeetingAvailability(value) {
  const result = validateMeetingAvailability(value);
  return result.ok ? result.canonical : null;
}

export function admitMeetingAvailability(lens, filter) {
  if (String(lens || "").trim().toLowerCase() !== "meetings") {
    return { ok: true, present: false, canonical: null, errors: [] };
  }
  const input = object(filter) || {};
  const present = Object.prototype.hasOwnProperty.call(input, "availability")
    && input.availability != null;
  if (!present) return { ok: true, present: false, canonical: null, errors: [] };
  return validateMeetingAvailability(input.availability);
}

function formatter(timezone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function partsForInstant(instant, timezone) {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(instant)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  const weekday = WEEKDAY_ALIASES.get(String(parts.weekday || "").toLowerCase());
  if (weekday == null || parts.hour == null || parts.minute == null) return null;
  return { weekday, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function localWallInstant(value, timezone) {
  const match = String(value || "").match(LOCAL_START_RE);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const numeric = [year, month, day, hour, minute, second].map(Number);
  if (numeric[3] > 23 || numeric[4] > 59 || numeric[5] > 59) return null;
  const naive = Date.UTC(numeric[0], numeric[1] - 1, numeric[2], numeric[3], numeric[4], numeric[5]);
  if (!Number.isFinite(naive)) return null;
  let candidate = naive;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const local = partsForCivilDate(candidate, timezone);
      if (!local) return null;
      const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
      candidate = naive - (localAsUtc - candidate);
    }
    return new Date(candidate);
  } catch {
    return null;
  }
}

function partsForCivilDate(instant, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function occurrenceCivilParts(occurrence, timezone) {
  const startsAt = String(occurrence?.starts_at || "");
  if (!startsAt) return null;
  let instant;
  if (OFFSET_RE.test(startsAt)) {
    const parsed = Date.parse(startsAt);
    if (!Number.isFinite(parsed)) return null;
    instant = new Date(parsed);
  } else {
    instant = localWallInstant(startsAt, occurrence.timezone || timezone);
  }
  return instant ? partsForInstant(instant, timezone) : null;
}

function occurrenceForRow(row, asOf) {
  if (row?.uid && (row.starts_at || row.date)) return row;
  return calendarOccurrencesForRecord(row, { kind: "meetings", as_of: asOf || "1900-01-01" })[0] || null;
}

function rowStatus(row, occurrence) {
  if (row?.status === "cancelled" || row?.lifecycle === "cancelled") return "canceled";
  if (occurrence?.status === "cancelled" || occurrence?.lifecycle === "cancelled") return "canceled";
  if (row?.schedule?.status === "conflicted") return "conflicted";
  if (row?.schedule?.status === "invalid") return "invalid_time";
  return null;
}

function matchesWindow(parts, windows) {
  const matches = windows.some((window) => {
    if (!window.weekdays.includes(parts.weekday)) return false;
    const start = minuteOf(window.start) ?? 0;
    const end = minuteOf(window.end) ?? 24 * 60;
    return parts.minute >= start && parts.minute < end;
  });
  return matches;
}

/** Evaluate one row or canonical calendar occurrence against an expression. */
export function evaluateMeetingAvailability(row, expression, options = {}) {
  const validation = validateMeetingAvailability(expression);
  if (!validation.ok) return { matched: false, reason: "invalid_expression", errors: validation.errors };
  if (!validation.present) return { matched: true, reason: "unrestricted", occurrence: row };
  const availability = validation.canonical;
  const occurrence = occurrenceForRow(row, options.asOf);
  const status = rowStatus(row, occurrence);
  if (status) return { matched: false, reason: status, occurrence };
  if (!occurrence?.starts_at || occurrence.date) {
    if (availability.unknown_start === "include") {
      return { matched: true, reason: "unknown_start_included", occurrence };
    }
    return { matched: false, reason: "unknown_start", occurrence };
  }
  const parts = occurrenceCivilParts(occurrence, availability.timezone);
  if (!parts) return { matched: false, reason: "invalid_time", occurrence };
  return {
    matched: matchesWindow(parts, availability.windows),
    reason: matchesWindow(parts, availability.windows) ? "matched" : "outside_window",
    occurrence,
    civil_time: {
      weekday: parts.weekday,
      weekday_name: WEEKDAY_NAMES[parts.weekday],
      time: `${String(Math.floor(parts.minute / 60)).padStart(2, "0")}:${String(parts.minute % 60).padStart(2, "0")}`,
      timezone: availability.timezone,
    },
  };
}

/** Apply one expression to materialized rows and retain exclusion accounting. */
export function evaluateMeetingAvailabilityRows(rows, expression, options = {}) {
  const input = Array.isArray(rows) ? rows : [];
  const validation = validateMeetingAvailability(expression);
  if (!validation.ok) return { rows: [], counts: { total: input.length, matched: 0, excluded: input.length }, errors: validation.errors };
  if (!validation.present) return {
    rows: input,
    counts: { total: input.length, matched: input.length, excluded: 0 },
    errors: [],
  };
  const counts = { total: input.length, matched: 0, excluded: 0, unknown_start: 0, conflicted: 0, invalid_time: 0, canceled: 0, outside_window: 0 };
  const matched = [];
  for (const row of input) {
    const result = evaluateMeetingAvailability(row, validation.canonical, options);
    if (result.matched) {
      matched.push(row);
      counts.matched += 1;
    } else {
      counts.excluded += 1;
      if (Object.hasOwn(counts, result.reason)) counts[result.reason] += 1;
    }
  }
  return { rows: matched, counts, expression: validation.canonical, errors: [] };
}

export const filterMeetingRowsByAvailability = evaluateMeetingAvailabilityRows;

export const EVENINGS_WEEKENDS_AVAILABILITY = Object.freeze({
  schema: MEETING_AVAILABILITY_SCHEMA,
  timezone: "America/New_York",
  windows: Object.freeze([
    Object.freeze({ weekdays: Object.freeze([1, 2, 3, 4, 5]), start: "17:00", end: null }),
    Object.freeze({ weekdays: Object.freeze([0, 6]), start: null, end: null }),
  ]),
  unknown_start: "exclude",
});

export function syncMeetingAvailabilityControls() {
  const field = document.querySelector("[data-meetings-availability]");
  if (!field) return;
  const selected = field.querySelector('input[name="meetingsAvailability"]:checked')?.value || "any";
  const custom = field.querySelector("[data-meetings-availability-custom]");
  if (custom) custom.hidden = selected !== "custom";
}

function fieldAvailabilityInput(value) {
  return document.querySelector(`[data-meetings-availability] input[name="meetingsAvailability"][value="${value}"]`);
}

export function meetingAvailabilityFromControls(selection) {
  if (selection && typeof selection === "object") {
    const custom = fieldAvailabilityInput("custom");
    if (custom) custom.checked = true;
    const value = selection.windows?.[0] || {};
    document.querySelectorAll("[data-meetings-availability-day]").forEach((input) => {
      input.checked = Array.isArray(value.weekdays) && value.weekdays.includes(Number(input.value));
    });
    const start = document.querySelector("[data-meetings-availability-start]");
    const end = document.querySelector("[data-meetings-availability-end]");
    const timezone = document.querySelector("[data-meetings-availability-timezone]");
    const unknown = document.querySelector("[data-meetings-availability-unknown]");
    if (start) start.value = value.start || "";
    if (end) end.value = value.end || "";
    if (timezone) timezone.value = selection.timezone || "America/New_York";
    if (unknown) unknown.value = selection.unknown_start || "exclude";
  } else if (selection) {
    const input = document.querySelector(`[data-meetings-availability] input[name="meetingsAvailability"][value="${selection}"]`)
      || document.querySelector('[data-meetings-availability] input[name="meetingsAvailability"][value="any"]');
    if (input) input.checked = true;
  }
  syncMeetingAvailabilityControls();
  const selected = document.querySelector('[data-meetings-availability] input[name="meetingsAvailability"]:checked')?.value || "any";
  if (selected === "evenings_weekends") return EVENINGS_WEEKENDS_AVAILABILITY;
  if (selected !== "custom") return null;
  const weekdays = [...document.querySelectorAll("[data-meetings-availability-day]:checked")]
    .map((input) => Number(input.value)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  if (!weekdays.length) return null;
  return {
    schema: EVENINGS_WEEKENDS_AVAILABILITY.schema,
    timezone: document.querySelector("[data-meetings-availability-timezone]")?.value || "America/New_York",
    windows: [{
      weekdays: [...new Set(weekdays)].sort((a, b) => a - b),
      start: document.querySelector("[data-meetings-availability-start]")?.value || null,
      end: document.querySelector("[data-meetings-availability-end]")?.value || null,
    }],
    unknown_start: document.querySelector("[data-meetings-availability-unknown]")?.value || "exclude",
  };
}

export function meetingAvailabilitySummaryHTML(filter, counts) {
  if (!filter?.availability) return "";
  const excluded = Number(counts?.unknown_start || 0);
  const preset = JSON.stringify(filter.availability) === JSON.stringify(EVENINGS_WEEKENDS_AVAILABILITY);
  const windows = Array.isArray(filter.availability.windows) ? filter.availability.windows : [];
  const dayText = [...new Set(windows.flatMap((window) => Array.isArray(window.weekdays) ? window.weekdays : []))]
    .sort((a, b) => a - b).map((day) => String(day)).join(", ");
  const first = windows[0] || {};
  const boundary = `${first.start || "00:00"}–${first.end || "24:00"}`;
  const unknown = filter.availability.unknown_start === "include"
    ? (globalThis.t?.("meetings_availability_unknown_included") || "")
    : (globalThis.t?.("meetings_availability_unknown_excluded") || "");
  const label = preset
    ? (globalThis.t?.("meetings_availability_evenings_summary") || "")
    : (globalThis.t?.("meetings_availability_custom_summary", {
      days: dayText,
      boundary,
      timezone: filter.availability.timezone || "America/New_York",
      unknown,
    }) || "");
  const resultCopy = globalThis.t?.("meetings_availability_result") || "";
  const exclusion = excluded
    ? globalThis.t?.(excluded === 1 ? "meetings_availability_date_only_one" : "meetings_availability_date_only_other", { n: excluded }) || ""
    : "";
  return `<div class="note meetings-availability-result" role="status" data-meetings-availability-result>${escUiHtml(label)}. ${escUiHtml(resultCopy)}${exclusion ? ` (${escUiHtml(exclusion)})` : ""}.</div>`;
}

export function applyMeetingAvailability(rows, filter) {
  if (!filter?.availability) return { rows, counts: null };
  return evaluateMeetingAvailabilityRows(rows, filter.availability, { asOf: todayISO() });
}
