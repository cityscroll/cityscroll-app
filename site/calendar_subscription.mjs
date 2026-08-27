import { calendarFeedUrlForScope, scopeFromRouteHash } from "./scope_v0.mjs";

export const CALENDAR_SUBSCRIPTION_LABEL = "Subscribe to calendar";

const CALENDAR_LENSES = new Set(["money", "property", "rules", "meetings"]);
const CALENDAR_LENS_LABELS = Object.freeze({
  money: "Contracts",
  property: "Property",
  rules: "Rules",
  meetings: "Meetings",
});

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

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

/** Convert the standing HTTPS feed into the native calendar subscription scheme. */
export function calendarNativeSubscriptionUrl(feedUrl) {
  const value = String(feedUrl || "").trim();
  if (/^webcal:\/\//i.test(value)) return value.replace(/^webcal:/i, "webcal:");
  if (/^https?:\/\//i.test(value)) return value.replace(/^[a-z]+:/i, "webcal:");
  return null;
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

/** Give the handoff a compact, human-readable name without changing scope semantics. */
export function calendarScopeLabel(scope, lens) {
  const source = scope || {};
  const place = source.place || {};
  const facets = source.facets || {};
  const topic = source.topic || {};
  const targetLens = lens || firstValue(facets.domains) || source.lens || "calendar";
  const parts = [CALENDAR_LENS_LABELS[targetLens] || targetLens || "Calendar"];
  const agency = firstValue(facets.agencies);
  const keyword = topic.query || firstValue(topic.keywords);
  if (agency) parts.push(String(agency));
  if (keyword && String(keyword) !== String(agency || "")) parts.push(`“${String(keyword)}”`);
  if (place.neighborhood) parts.push(String(place.neighborhood));
  if (firstValue(place.boroughs)) parts.push(String(firstValue(place.boroughs)));
  if (firstValue(place.community_districts)) parts.push(`Community District ${String(firstValue(place.community_districts)).replace(/^\D+/i, "")}`);
  if (firstValue(place.council_districts)) parts.push(`Council District ${String(firstValue(place.council_districts)).replace(/^\D+/i, "")}`);
  if (place.location_scope && !parts.includes(String(place.location_scope))) parts.push(String(place.location_scope));
  if (source.time_window?.preset && source.time_window.preset !== "week") parts.push(String(source.time_window.preset).replaceAll("_", " "));
  return parts.join(" · ");
}

export function calendarSubscriptionDetailsForScope(scope, { lens, rows, base } = {}) {
  const feedUrl = calendarSubscriptionHrefForScope(scope, { lens, rows, base });
  const webcalUrl = calendarNativeSubscriptionUrl(feedUrl);
  if (!feedUrl || !webcalUrl) return null;
  return {
    feedUrl,
    webcalUrl,
    lens: lens || scope?.facets?.domains?.[0] || scope?.lens || "calendar",
    scopeLabel: calendarScopeLabel(scope, lens),
  };
}

export function calendarSubscriptionHrefForBrowseView(view, options = {}) {
  if (!view || view.scope?.mode === "unsupported") return null;
  const scope = view.scopeObject
    || scopeFromRouteHash(`#${view.config?.tab || view.facet}?${view.scopeSearch || ""}`);
  return calendarSubscriptionDetailsForScope(scope, {
    lens: view.config?.tab || view.facet,
    rows: view.calendarRows || view.rows,
    base: options.base,
  })?.feedUrl || null;
}

export function renderCalendarSubscriptionAffordance(view, { escape = (value) => String(value ?? "") } = {}) {
  if (!view || view.scope?.mode === "unsupported") return "";
  const scope = view.scopeObject
    || scopeFromRouteHash(`#${view.config?.tab || view.facet}?${view.scopeSearch || ""}`);
  const details = calendarSubscriptionDetailsForScope(scope, {
    lens: view.config?.tab || view.facet,
    rows: view.calendarRows || view.rows,
  });
  if (!details) return "";
  return `<a class="calendar-subscribe-btn" data-calendar-subscription="scope" data-calendar-subscription-feed="${escape(details.feedUrl)}" data-calendar-subscription-webcal="${escape(details.webcalUrl)}" data-calendar-subscription-label="${escape(details.scopeLabel)}" href="${escape(details.webcalUrl)}" aria-label="${escape(CALENDAR_SUBSCRIPTION_LABEL)} for this scope">${escape(CALENDAR_SUBSCRIPTION_LABEL)}</a>`;
}

/** Render the browser-side handoff; no external subscription state is represented here. */
export function renderCalendarSubscriptionHandoff({ feedUrl, webcalUrl, scopeLabel } = {}, { escape = escapeHtml } = {}) {
  if (!feedUrl || !webcalUrl || !scopeLabel) return "";
  return `<dialog class="calendar-subscription-dialog" data-calendar-subscription-dialog data-calendar-subscription-handoff aria-labelledby="calendar-subscription-heading">
    <div class="calendar-subscription-dialog-inner">
      <button class="calendar-subscription-close" type="button" data-calendar-subscription-close aria-label="Close calendar subscription details">×</button>
      <p class="calendar-subscription-kicker">Calendar subscription</p>
      <h2 id="calendar-subscription-heading">Subscribe to ${escape(scopeLabel)}</h2>
      <p class="calendar-subscription-intro">Keep new and rescheduled events from this scope in your calendar automatically.</p>
      <div class="calendar-subscription-actions">
        <a class="calendar-subscription-open" data-calendar-subscription-open href="${escape(webcalUrl)}">Open calendar subscription</a>
        <button class="calendar-subscription-copy" type="button" data-calendar-subscription-copy data-copy-url="${escape(feedUrl)}">Copy subscription URL</button>
      </div>
      <p class="calendar-subscription-note">No account is required to get this feed. CityScroll cannot tell whether another calendar kept the subscription.</p>
      <details class="calendar-subscription-guidance" open>
        <summary>How to subscribe</summary>
        <ul>
          <li><strong>Apple Calendar / native calendar:</strong> choose <em>Open calendar subscription</em> above. Your calendar will subscribe to the feed.</li>
          <li><strong>Google Calendar:</strong> choose <em>Copy subscription URL</em>, then use <em>Other calendars → From URL</em> and paste the HTTPS URL. Google Calendar checks it for updates.</li>
          <li><strong>Outlook:</strong> choose <em>Copy subscription URL</em>, then use <em>Add calendar → Subscribe from web</em> and paste the HTTPS URL.</li>
          <li><strong>Other calendars:</strong> look for <em>Subscribe from URL</em>, <em>Internet calendar</em>, or a <code>webcal:</code> link. Importing a downloaded file is a one-time copy, not a subscription.</li>
        </ul>
      </details>
      <p class="calendar-subscription-status" data-calendar-subscription-status role="status" aria-live="polite"></p>
    </div>
  </dialog>`;
}
