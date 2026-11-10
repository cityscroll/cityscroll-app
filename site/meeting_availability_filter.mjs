/**
 * Typed weekly meeting availability — presentation controls and re-exports.
 *
 * The civil-time evaluator lives in capabilities/meeting_availability.mjs so
 * engine modules can depend on it without importing presentation code.
 */

export {
  MEETING_AVAILABILITY_SCHEMA,
  MEETING_AVAILABILITY_UNKNOWN_START_POLICIES,
  validateMeetingAvailability,
  canonicalMeetingAvailability,
  admitMeetingAvailability,
  evaluateMeetingAvailability,
  evaluateMeetingAvailabilityRows,
  filterMeetingRowsByAvailability,
  EVENINGS_WEEKENDS_AVAILABILITY,
} from "../capabilities/meeting_availability.mjs";

import {
  EVENINGS_WEEKENDS_AVAILABILITY,
  evaluateMeetingAvailabilityRows,
} from "../capabilities/meeting_availability.mjs";

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


function todayISO() {
  if (typeof globalThis.todayISO === "function") return globalThis.todayISO();
  return new Date().toISOString().slice(0, 10);
}

function escUiHtml(value) {
  if (typeof globalThis.escUiHtml === "function") return globalThis.escUiHtml(value);
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

export function applyMeetingAvailability(rows, filter) {
  if (!filter?.availability) return { rows, counts: null };
  return evaluateMeetingAvailabilityRows(rows, filter.availability, { asOf: todayISO() });
}
