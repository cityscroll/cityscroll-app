import { calendarFeedUrlForScope, scopeFromRouteHash } from "./scope_v0.mjs";

export const CALENDAR_SUBSCRIPTION_LABEL = "Subscribe to calendar";

const CALENDAR_LENSES = new Set(["money", "property", "rules", "meetings"]);

function hasValidDate(value) {
  const raw = String(value || "").trim();
  if (!raw || !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(raw)) return false;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp);
}

/**
 * Match the dated identity that worker/src/lib/feed.mjs can turn into a VEVENT.
 * Date-only deadlines are valid subscription occurrences; identity and date are
 * both required so a feed cannot advertise an empty or unaddressable event set.
 */
export function calendarOccurrenceForRow(lens, row = {}) {
  if (!CALENDAR_LENSES.has(lens) || !row || typeof row !== "object") return null;
  if (lens === "meetings") {
    return row.meeting_id && hasValidDate(row.event_date)
      ? { id: String(row.meeting_id), date: String(row.event_date) }
      : null;
  }
  if (lens === "money" && row.procurement_id && !row.request_id) return null;
  const id = row.request_id || row.id;
  const date = lens === "money" ? row.due_date : row.event_date || row.due_date;
  return id && hasValidDate(date) ? { id: String(id), date: String(date) } : null;
}

export function hasDefensibleDatedOccurrences(lens, rows = []) {
  return Array.isArray(rows) && rows.some((row) => calendarOccurrenceForRow(lens, row));
}

/** Build a subscription URL only when the displayed scope has a dated occurrence. */
export function calendarSubscriptionHrefForScope(scope, { lens, rows, base } = {}) {
  const targetLens = lens || scope?.facets?.domains?.[0] || scope?.lens;
  const href = calendarFeedUrlForScope(scope, base ? { base } : undefined);
  if (!href || !hasDefensibleDatedOccurrences(targetLens, rows)) return null;
  return href;
}

export function calendarSubscriptionHrefForBrowseView(view, options = {}) {
  if (!view || view.scope?.mode === "unsupported") return null;
  const scope = view.scopeObject
    || scopeFromRouteHash(`#${view.config?.tab || view.facet}?${view.scopeSearch || ""}`);
  return calendarSubscriptionHrefForScope(scope, {
    lens: view.config?.tab || view.facet,
    rows: view.calendarRows || view.rows,
    base: options.base,
  });
}

export function renderCalendarSubscriptionAffordance(view, { escape = (value) => String(value ?? "") } = {}) {
  const href = calendarSubscriptionHrefForBrowseView(view);
  if (!href) return "";
  return `<a class="calendar-subscribe-btn" data-calendar-subscription="scope" href="${escape(href)}" aria-label="${escape(CALENDAR_SUBSCRIPTION_LABEL)} for this scope">${escape(CALENDAR_SUBSCRIPTION_LABEL)}</a>`;
}
