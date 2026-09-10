/**
 * The one closing-this-week window for Contracts preview, list, labels, and
 * suggestion certification. "Closing this week" is the next seven civic days
 * after today (rolling, inclusive of the seventh day), not a Sunday-bounded
 * calendar week. Callers pass `today` when they have one; live paths use the
 * same UTC date-only civic day as `todayISO()`.
 */

export const CLOSING_THIS_WEEK_DAYS = 7;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function dateOnly(value) {
  const day = String(value ?? "").slice(0, 10);
  return DAY.test(day) ? day : "";
}

export function civicDayISO(nowMs = Date.now()) {
  const pinned = globalThis.CROL_PINNED_TODAY;
  if (typeof pinned === "string" && DAY.test(pinned)) return pinned;
  // determinism-lint: allow clock the closing-this-week civic day is a statement about now; harnesses pin CROL_PINNED_TODAY.
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function addCivicDaysISO(today, days) {
  const day = dateOnly(today);
  if (!day) return "";
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

export function closingWeekEndISO(today) {
  return addCivicDaysISO(today, CLOSING_THIS_WEEK_DAYS);
}

/** Whole civic days from today to the due date. Same clock as the week window. */
export function daysUntilDue(due, today) {
  const dueDay = dateOnly(due);
  const floor = dateOnly(today);
  if (!dueDay || !floor) return null;
  const dueMs = Date.parse(`${dueDay}T00:00:00Z`);
  const floorMs = Date.parse(`${floor}T00:00:00Z`);
  if (!Number.isFinite(dueMs) || !Number.isFinite(floorMs)) return null;
  return Math.round((dueMs - floorMs) / 86400000);
}

export function dueClosesThisWeek(due, today) {
  const dueDay = dateOnly(due);
  const floor = dateOnly(today);
  const weekEnd = closingWeekEndISO(floor);
  if (!dueDay || !floor || !weekEnd) return false;
  return dueDay > floor && dueDay <= weekEnd;
}

export function closingThisWeekQuery(today) {
  const day = dateOnly(today) || civicDayISO();
  return Object.freeze({
    mode: "open",
    closingWeek: true,
    sort: "deadline",
    today: day,
    weekEnd: closingWeekEndISO(day),
  });
}
