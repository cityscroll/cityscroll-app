/**
 * Rolling minimum lead time for discovery money watches.
 *
 * `minRemainingDays` is an optional integer (0–365) meaning "at least N NYC
 * calendar days remain before the sourced response deadline." Exact follows
 * never carry it. Eligibility uses the same response-deadline transport as
 * delivery, plus an injected clock — never the host wall clock.
 */

import { daysUntilDue } from "./closing_this_week.mjs";
import {
  DEADLINE_PRECISION,
  DEADLINE_TRANSPORT_STATUS,
  NYC_PUBLISHER_TIMEZONE,
  projectDeadlinesFromNoticeRow,
} from "./procurement_deadline_projection.mjs";

export const MIN_REMAINING_DAYS_MIN = 0;
export const MIN_REMAINING_DAYS_MAX = 365;
export const MIN_REMAINING_DAYS_FIELD = "minRemainingDays";

export const MIN_REMAINING_DAYS_CODES = Object.freeze({
  INVALID: "min-remaining-days-invalid",
  OUT_OF_RANGE: "min-remaining-days-out-of-range",
  INCOMPATIBLE_EXACT_FOLLOW: "min-remaining-days-incompatible-exact-follow",
  UNSUPPORTED_LENS: "min-remaining-days-unsupported-lens",
});

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONEY_LENSES = new Set(["money", "alerts"]);

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** NYC civil calendar day for an injected clock (Date, epoch ms, or ISO string). */
export function nycCivicDayISO(clock = Date.now(), timezone = NYC_PUBLISHER_TIMEZONE) {
  const instant = clock instanceof Date ? clock : new Date(clock);
  if (!Number.isFinite(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (!year || !month || !day) return null;
    return `${year}-${month}-${day}`;
  } catch {
    return null;
  }
}

/**
 * Validate the optional rolling lead-time preference.
 * Absent / null / "" → unset (ok). Present values must be integers 0–365.
 */
export function validateMinRemainingDays(value) {
  if (value == null || value === "") {
    return { ok: true, present: false, value: null, code: null, reason: null };
  }
  if (typeof value === "boolean" || Array.isArray(value) || (typeof value === "object")) {
    return {
      ok: false,
      present: true,
      value: null,
      code: MIN_REMAINING_DAYS_CODES.INVALID,
      reason: "minRemainingDays must be an integer from 0 to 365",
    };
  }
  if (typeof value === "string" && !/^-?\d+$/.test(value.trim())) {
    return {
      ok: false,
      present: true,
      value: null,
      code: MIN_REMAINING_DAYS_CODES.INVALID,
      reason: "minRemainingDays must be an integer from 0 to 365",
    };
  }
  const number = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    return {
      ok: false,
      present: true,
      value: null,
      code: MIN_REMAINING_DAYS_CODES.INVALID,
      reason: "minRemainingDays must be an integer from 0 to 365",
    };
  }
  if (number < MIN_REMAINING_DAYS_MIN || number > MIN_REMAINING_DAYS_MAX) {
    return {
      ok: false,
      present: true,
      value: null,
      code: MIN_REMAINING_DAYS_CODES.OUT_OF_RANGE,
      reason: `minRemainingDays must be between ${MIN_REMAINING_DAYS_MIN} and ${MIN_REMAINING_DAYS_MAX}`,
    };
  }
  return { ok: true, present: true, value: number, code: null, reason: null };
}

export function minRemainingDaysSupportedLens(lens) {
  return MONEY_LENSES.has(String(lens || "").trim().toLowerCase());
}

/**
 * Admission gate for save/edit paths. Rejects invalid values and the
 * exact-follow combination with explicit codes — never by silent drop.
 */
export function admitMinRemainingDays(lens, rawFilter) {
  const filter = object(rawFilter) || {};
  const present = Object.prototype.hasOwnProperty.call(filter, MIN_REMAINING_DAYS_FIELD)
    && filter[MIN_REMAINING_DAYS_FIELD] != null
    && filter[MIN_REMAINING_DAYS_FIELD] !== "";
  if (!present) return { ok: true, present: false, value: null, code: null };

  if (!minRemainingDaysSupportedLens(lens)) {
    return {
      ok: false,
      present: true,
      value: null,
      code: MIN_REMAINING_DAYS_CODES.UNSUPPORTED_LENS,
    };
  }

  const exactId = text(filter.procurement_id);
  if (exactId) {
    return {
      ok: false,
      present: true,
      value: null,
      code: MIN_REMAINING_DAYS_CODES.INCOMPATIBLE_EXACT_FOLLOW,
    };
  }

  const validation = validateMinRemainingDays(filter[MIN_REMAINING_DAYS_FIELD]);
  if (!validation.ok) {
    return {
      ok: false,
      present: true,
      value: null,
      code: validation.code,
    };
  }
  return { ok: true, present: true, value: validation.value, code: null };
}

/** Resolved response-deadline transport for eligibility (never bid openings). */
export function resolvedResponseDeadline(row) {
  const existing = object(row?.response_deadline);
  if (
    existing
    && existing.status === DEADLINE_TRANSPORT_STATUS.RESOLVED
    && ISO_DAY.test(String(existing.date || ""))
  ) {
    return existing;
  }
  if (!row || typeof row !== "object") return null;
  const projected = projectDeadlinesFromNoticeRow(row);
  const deadline = object(projected?.response_deadline);
  if (
    deadline
    && deadline.status === DEADLINE_TRANSPORT_STATUS.RESOLVED
    && ISO_DAY.test(String(deadline.date || ""))
  ) {
    return deadline;
  }
  return null;
}

function deadlineInstantMs(deadline) {
  const date = text(deadline?.date);
  const wall = text(deadline?.wall_time) || "00:00:00";
  if (!date || deadline?.precision !== DEADLINE_PRECISION.EXACT_TIME) return null;
  const timezone = text(deadline?.timezone) || NYC_PUBLISHER_TIMEZONE;
  // Build a UTC instant for the NYC civil wall time via iterative offset match.
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wall);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || "0");
  const probe = new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`);
  if (!Number.isFinite(probe.getTime())) return null;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    // Walk the UTC guess so the zoned civil stamp matches the deadline wall time.
    for (let i = 0; i < 4; i += 1) {
      const parts = Object.fromEntries(
        formatter.formatToParts(probe).filter((part) => part.type !== "literal")
          .map((part) => [part.type, part.value]),
      );
      const asUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second),
      );
      const wanted = Date.UTC(
        Number(date.slice(0, 4)),
        Number(date.slice(5, 7)) - 1,
        Number(date.slice(8, 10)),
        hour,
        minute,
        second,
      );
      const delta = wanted - asUtc;
      if (delta === 0) return probe.getTime();
      probe.setTime(probe.getTime() + delta);
    }
    return probe.getTime();
  } catch {
    return null;
  }
}

/**
 * NYC calendar days remaining until a sourced response deadline.
 * Returns null when the deadline is missing, unconfirmed, or already closed.
 */
export function responseDeadlineRemainingDays(deadline, clock = Date.now()) {
  const resolved = object(deadline);
  if (
    !resolved
    || resolved.status !== DEADLINE_TRANSPORT_STATUS.RESOLVED
    || !ISO_DAY.test(String(resolved.date || ""))
  ) {
    return null;
  }

  const instant = clock instanceof Date ? clock : new Date(clock);
  if (!Number.isFinite(instant.getTime())) return null;

  if (resolved.precision === DEADLINE_PRECISION.EXACT_TIME && resolved.wall_time) {
    const closesAt = deadlineInstantMs(resolved);
    if (closesAt != null && instant.getTime() >= closesAt) return null;
  }

  const today = nycCivicDayISO(instant);
  if (!today) return null;
  const remaining = daysUntilDue(resolved.date, today);
  if (remaining == null || remaining < 0) return null;
  return remaining;
}

/** True when the row's sourced response deadline still meets the threshold. */
export function rowMeetsMinRemainingDays(row, minRemainingDays, clock = Date.now()) {
  const validation = validateMinRemainingDays(minRemainingDays);
  if (!validation.present) return true;
  if (!validation.ok) return false;
  const deadline = resolvedResponseDeadline(row);
  if (!deadline) return false;
  const remaining = responseDeadlineRemainingDays(deadline, clock);
  if (remaining == null) return false;
  return remaining >= validation.value;
}

/** Apply the preference after lifecycle match/dedup. Unset filters pass through. */
export function applyMinRemainingDaysPreference(rows, filter = {}, clock = Date.now()) {
  const list = Array.isArray(rows) ? rows : [];
  // Exact follows never carry this preference; ignore a stray field rather than
  // narrowing a single-record watch.
  if (text(filter?.procurement_id)) return list;
  const validation = validateMinRemainingDays(filter?.[MIN_REMAINING_DAYS_FIELD]);
  if (!validation.present) return list;
  if (!validation.ok) return [];
  return list.filter((row) => rowMeetsMinRemainingDays(row, validation.value, clock));
}

export function minRemainingDaysCalendarUnavailableMessage() {
  return "Calendar export is unavailable while this watch requires a minimum lead time; calendar parity for that filter is not ready yet.";
}

export function minRemainingDaysControlCopy() {
  return Object.freeze({
    label: "At least N calendar days remaining",
    help: "Only opportunities with a confirmed deadline",
  });
}
