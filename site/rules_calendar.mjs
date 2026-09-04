/**
 * Rulemaking participation month (CBICS-03).
 *
 * Turns the RD-S4 rule history timeline's own observed events — the same
 * events the traceable process history already renders, with the same
 * canonical/source destinations — into the CBICS-01 bounded display
 * occurrence contract, then hands them to the CBICS-02 shared compact month
 * component. This module decides nothing about eligibility, density, or
 * markup; it only maps one domain's already-resolved history onto the shared
 * contract. Derived lifecycle labels (e.g. "awaiting agency action") live
 * outside `history_timeline.events` and are never read here, so they can
 * never acquire a false date (A3).
 */

import { classifyDisplayRecord } from "./calendar_display.mjs";
import { deduplicateCalendarOccurrences } from "./calendar_occurrence.mjs";
import { buildCompactMonthView, renderCompactMonth } from "./compact_calendar.mjs";

const SITE_ORIGIN = "https://cityscroll.org";

const RULE_CALENDAR_HEADING = "Participation month";

// Coarse calendar-cell treatment per rule history event type. The specific
// resident-facing label (e.g. "Comment period closes") lives on the
// occurrence title, reused verbatim from the history timeline.
export const RULE_EVENT_CALENDAR_KIND = Object.freeze({
  proposal_published: "milestone",
  public_hearing: "event",
  comment_close: "deadline",
  adoption: "milestone",
  effective: "milestone",
});

function absoluteHref(href) {
  const value = typeof href === "string" ? href.trim() : "";
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `${SITE_ORIGIN}${value.startsWith("/") ? value : `/${value}`}`;
}

function calendarOccurrenceInputs(view) {
  const requestId = view?.request_id || null;
  const events = view?.history_timeline?.events;
  if (!requestId || !Array.isArray(events)) return [];
  return events
    .filter((event) => event?.date_state === "known" && event.observed_date
      && RULE_EVENT_CALENDAR_KIND[event.event_type])
    .map((event) => ({
      kind: RULE_EVENT_CALENDAR_KIND[event.event_type],
      date: event.observed_date,
      uid_suffix: event.event_type,
      title: event.label,
      canonical_url: absoluteHref(event.trace_href),
      source: {
        system: event.source_system || event.source_label || null,
        record_id: requestId,
        url: /^https?:\/\//i.test(event.source_url || "") ? event.source_url : null,
      },
      provenance: {
        basis: "publisher_record",
        source_field: "rule_history_timeline",
        rule_event_type: event.event_type,
      },
    }));
}

/**
 * Build the one synthetic CBICS-01 display record for a rule case file's
 * history-observed events, or `null` when there is nothing dated to show.
 */
export function buildRuleCalendarRecord(view) {
  const requestId = view?.request_id || null;
  if (!requestId) return null;
  const occurrences = calendarOccurrenceInputs(view);
  if (!occurrences.length) return null;
  return { object_ref: `rule:${requestId}`, calendar_occurrences: occurrences };
}

/**
 * Eligible, deduplicated calendar occurrences for a rule case file. Pure: no
 * clock, no I/O. Reuses `classifyDisplayRecord` (CBICS-01) for eligibility
 * and `deduplicateCalendarOccurrences` for stable identity across a
 * rescheduled event sharing the same event type (newest observation wins).
 */
export function buildRuleCalendarOccurrences(view) {
  const record = buildRuleCalendarRecord(view);
  if (!record) return [];
  const { eligible_occurrences } = classifyDisplayRecord(record);
  return deduplicateCalendarOccurrences(eligible_occurrences);
}

/**
 * Build the CBICS-02 compact month view model for a rule case file.
 * `options.today` is required (YYYY-MM-DD), same contract as
 * `buildCompactMonthView`.
 */
export function buildRuleCompactMonthView(view, options = {}) {
  return buildCompactMonthView(buildRuleCalendarOccurrences(view), options);
}

/**
 * Render the participation-month section for a rule case file, or `""` when
 * the bundle does not meet the commissioned density rule (A5: no placeholder
 * for a sparse rule). `options.today` is required.
 */
export function renderRuleParticipationMonth(view, options = {}) {
  const monthView = buildRuleCompactMonthView(view, options);
  if (!monthView.render) return "";
  const body = renderCompactMonth(monthView, options.esc ? { esc: options.esc } : undefined);
  if (!body) return "";
  return `<div class="chain-h rule-calendar-h">${RULE_CALENDAR_HEADING}</div>${body}`;
}
