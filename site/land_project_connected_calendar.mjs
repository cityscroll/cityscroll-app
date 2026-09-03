/**
 * Land project "Connected dates" panel.
 *
 * Mounts an eligible connected-dates month between a Land project's actions
 * and connections and its long phase spine, using exactly the accepted
 * project-occurrence population the project subscription already uses
 * (`project_calendar.mjs`, CAL-C8), routed through the bounded display
 * eligibility gate (`calendar_display.mjs`, CBICS-01) so a statutory clock, a
 * role definition, or an estimated date never becomes an ordinary calendar
 * event. Rendering itself is the shared compact month component
 * (`compact_calendar.mjs`, CBICS-02) — this module owns no calendar grid of
 * its own.
 */

import { projectCalendarRecordsForRecord } from "./project_calendar.mjs";
import { boundedDisplayOccurrences } from "./calendar_display.mjs";
import { buildCompactMonthView, renderCompactMonth } from "./compact_calendar.mjs";

export { bindCompactMonthPrintDisclosure } from "./compact_calendar.mjs";

export const PROJECT_CONNECTED_CALENDAR_HEADING = "Connected dates";

// A project's accepted connections span years, not a near-term window, so the
// bounded display query is given a wide practical range: the month itself is
// then selected by whichever real dates cluster, per the density rule — not
// by this range. Month is temporal proximity, not procedural prediction.
const DISPLAY_BOUNDS = Object.freeze({ from: "2000-01-01", to: "2099-12-31" });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function defaultEscape(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

/**
 * Pure: builds the panel markup from a normalized Land outcome record, or ""
 * when the accepted population does not meet the shared density rule (a
 * project with too few or too sparse connected dates gets no month view
 * rather than an empty grid). `today` is required and must be an explicit
 * `YYYY-MM-DD` day — this module never reads a hidden clock.
 */
export function landProjectConnectedCalendarHTML(record, { today, escape = defaultEscape } = {}) {
  if (!ISO_DATE.test(String(today))) return "";
  const records = projectCalendarRecordsForRecord(record);
  const occurrences = boundedDisplayOccurrences(records, DISPLAY_BOUNDS);
  const view = buildCompactMonthView(occurrences, { today });
  if (view.render !== true) return "";
  return `<section class="eicard project-connected-calendar" data-project-id="${escape(record?.project_id || "")}">
    <div class="chain-h">${escape(PROJECT_CONNECTED_CALENDAR_HEADING)}</div>
    ${renderCompactMonth(view)}
  </section>`;
}

export function ensureCompactCalendarStylesheet(doc = document) {
  if (doc.querySelector('link[data-land-route-style="compact-calendar"]')) return;
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = "compact_calendar.css";
  link.dataset.landRouteStyle = "compact-calendar";
  doc.head.appendChild(link);
}
