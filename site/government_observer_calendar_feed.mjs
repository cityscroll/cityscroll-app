/**
 * Observer calendar subscriptions: serialize supported observe scope onto the
 * standing meetings feed, project honest date/time precision, and require
 * explicit lifecycle evidence before cancel or reschedule relations.
 */

import {
  OBSERVE_SOURCE_SYSTEMS,
  normalizeObserveScope,
} from "./government_observe.mjs";
import {
  pdcCalendarOccurrences,
  bsaCalendarOccurrences,
  oathTrialCalendarOccurrences,
} from "./observer_calendar_occurrences.mjs";
import { deduplicateCalendarOccurrences } from "./calendar_occurrence.mjs";
import {
  calendarFeedUrlForScope,
  calendarFeedUnsupportedFilterFields,
} from "./scope_v0.mjs";
import {
  calendarNativeSubscriptionUrl,
  CALENDAR_SUBSCRIPTION_LABEL,
} from "./calendar_subscription.mjs";
import { icsFeed } from "../worker/src/lib/feed.mjs";

const BODY_LABELS = Object.freeze({
  pdc_calendar: "Public Design Commission",
  bsa_calendar: "Board of Standards and Appeals",
  oath_trial_calendar: "Office of Administrative Trials and Hearings",
});

const OBSERVE_FEED_FIELDS = Object.freeze(["activity", "body", "access", "place_role"]);
const UNSUPPORTED_OBSERVE_FIELDS = Object.freeze([
  "text_query",
  "keywords",
  "q",
  "agency",
  "minAmount",
  "maxAmount",
  "process",
  "group",
  "action",
  "actions",
  "entity_refs_all",
  "connection_relation",
]);

function text(value, max = 500) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function escapeHtml(value) {
  return text(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function observerAccessMethod(row) {
  if (row?.observer_access?.watch_url || row?.observer_access?.remote_join_url || row?.remote_join_url) {
    return "remote";
  }
  if (row?.venue?.name || row?.venue?.address) return "in_person";
  return "unknown";
}

function isObserverRow(row) {
  return OBSERVE_SOURCE_SYSTEMS.includes(row?.source_system);
}

function day(value) {
  const match = text(value, 80).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

/** Map discovery scope onto the standing meetings feed watch, or refuse it. */
export function observeSubscriptionWatchFromScope(scopeInput = {}) {
  const raw = scopeInput && typeof scopeInput === "object" ? scopeInput : {};
  const scope = normalizeObserveScope(raw);
  const unsupported = [];
  if (scope.errors.length) {
    unsupported.push(...scope.errors);
  }
  for (const key of UNSUPPORTED_OBSERVE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && raw[key] != null && raw[key] !== "") {
      if (Array.isArray(raw[key]) && raw[key].length === 0) continue;
      unsupported.push(key);
    }
  }
  if (raw.filter && typeof raw.filter === "object") {
    for (const key of UNSUPPORTED_OBSERVE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(raw.filter, key) && raw.filter[key] != null && raw.filter[key] !== "") {
        if (Array.isArray(raw.filter[key]) && raw.filter[key].length === 0) continue;
        unsupported.push(key);
      }
    }
  }
  // Standing meetings feeds decline place_role rather than emit a broader URL.
  // Discovery may still inspect place roles; calendar replay only carries filters
  // the feed compiler can honor (activity, body, access, geography keys).
  if (scope.placeRole) unsupported.push("place_role");
  const uniqueUnsupported = [...new Set(unsupported)].sort();
  if (uniqueUnsupported.length) {
    return Object.freeze({
      ok: false,
      reason: "unsupported-scope",
      unsupported: Object.freeze(uniqueUnsupported),
      scope,
      watch: null,
    });
  }

  const filter = { activity: "observe" };
  if (scope.body) filter.body = scope.body;
  if (scope.access) filter.access = scope.access;
  const watch = Object.freeze({ lens: "meetings", filter: Object.freeze(filter) });
  const replayUnsupported = calendarFeedUnsupportedFilterFields(watch);
  if (replayUnsupported.length) {
    return Object.freeze({
      ok: false,
      reason: "unsupported-scope",
      unsupported: Object.freeze(replayUnsupported),
      scope,
      watch: null,
    });
  }
  return Object.freeze({ ok: true, reason: null, unsupported: Object.freeze([]), scope, watch });
}

export function observeCalendarFeedUrl(scopeInput = {}, { base } = {}) {
  const prepared = observeSubscriptionWatchFromScope(scopeInput);
  if (!prepared.ok) return null;
  return calendarFeedUrlForScope(prepared.watch, base ? { base } : undefined);
}

export function observeScopeLabel(scopeInput = {}) {
  const scope = normalizeObserveScope(scopeInput);
  const parts = ["Observe"];
  if (scope.body) parts.push(BODY_LABELS[scope.body] || scope.body);
  if (scope.access) parts.push(scope.access.replaceAll("_", " "));
  if (scope.placeRole) parts.push(scope.placeRole.replaceAll("_", " "));
  return parts.join(" · ");
}

export function observeCalendarSubscriptionDetails(scopeInput = {}, { rows = [], base } = {}) {
  const prepared = observeSubscriptionWatchFromScope(scopeInput);
  if (!prepared.ok) return null;
  const selected = filterObserveRowsForFeed(rows, prepared.scope);
  if (!selected.length && rows.length) {
    // Scope is valid but currently empty; still allow following the exact scope.
  }
  const feedUrl = observeCalendarFeedUrl(prepared.scope, base ? { base } : undefined);
  const webcalUrl = calendarNativeSubscriptionUrl(feedUrl);
  if (!feedUrl || !webcalUrl) return null;
  return {
    feedUrl,
    webcalUrl,
    lens: "meetings",
    scopeLabel: observeScopeLabel(prepared.scope),
    watch: prepared.watch,
    selectedIds: selected.map((row) => row.meeting_id),
  };
}

/** Collection filter used by discovery and by feed identity comparison. */
export function filterObserveRowsForFeed(rows = [], scopeInput = {}) {
  const scope = normalizeObserveScope(scopeInput);
  if (scope.errors.length) return [];
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => isObserverRow(row) && day(row?.event_date || row?.date))
    .filter((row) => !scope.body || row.source_system === scope.body)
    .filter((row) => !scope.access || observerAccessMethod(row) === scope.access)
    .filter((row) => {
      if (!scope.placeRole) return true;
      if (scope.placeRole === "venue") return Boolean(row?.venue?.name || row?.venue?.address);
      if (scope.placeRole === "affected_area") {
        return Boolean(row?.affected_area?.community_districts?.length || row?.affected_area?.boroughs?.length);
      }
      if (scope.placeRole === "matter") {
        return Boolean(row?.agenda_items?.length || row?.description || row?.oath_index);
      }
      return true;
    });
}

function occurrenceForObserverRow(row) {
  if (!isObserverRow(row)) return [];
  if (row.source_system === "pdc_calendar") return pdcCalendarOccurrences([row]);
  if (row.source_system === "bsa_calendar") return bsaCalendarOccurrences([row]);
  if (row.source_system === "oath_trial_calendar") return oathTrialCalendarOccurrences([row]);
  return [];
}

export function observerCalendarOccurrences(rows = [], { as_of = null } = {}) {
  const projected = (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const list = occurrenceForObserverRow(row);
    if (list.length) return list;
    return [];
  });
  void as_of;
  return deduplicateCalendarOccurrences(projected);
}

export function buildObserverCalendarFeed({ scope = {}, rows = [], title = null } = {}) {
  const prepared = observeSubscriptionWatchFromScope(scope);
  if (!prepared.ok) {
    return Object.freeze({
      ok: false,
      reason: prepared.reason,
      unsupported: prepared.unsupported,
      ics: null,
      occurrences: Object.freeze([]),
      selected: Object.freeze([]),
    });
  }
  const selected = filterObserveRowsForFeed(rows, prepared.scope);
  const occurrences = observerCalendarOccurrences(selected);
  const ics = icsFeed({
    title: title || `CityScroll — ${observeScopeLabel(prepared.scope)}`,
    occurrences,
  });
  return Object.freeze({
    ok: true,
    reason: null,
    unsupported: Object.freeze([]),
    ics,
    occurrences: Object.freeze(occurrences),
    selected: Object.freeze(selected),
    watch: prepared.watch,
  });
}

/**
 * Diff two materializations. A missing row without explicit cancellation evidence
 * is a removal, never an invented cancellation or reschedule relation.
 */
export function compareObserverCalendarRevisions({
  previousRows = [],
  nextRows = [],
  scope = {},
} = {}) {
  const previous = observerCalendarOccurrences(filterObserveRowsForFeed(previousRows, scope));
  const next = observerCalendarOccurrences(filterObserveRowsForFeed(nextRows, scope));
  const previousByUid = new Map(previous.map((item) => [item.uid, item]));
  const nextByUid = new Map(next.map((item) => [item.uid, item]));
  const retained = [];
  const rescheduled = [];
  const cancelled = [];
  const removed = [];
  const added = [];

  for (const [uid, before] of previousByUid) {
    const after = nextByUid.get(uid);
    if (!after) {
      removed.push(uid);
      continue;
    }
    retained.push(uid);
    if (after.status === "cancelled" || after.lifecycle === "cancelled") cancelled.push(uid);
    else if (
      after.lifecycle === "rescheduled"
      || (before.starts_at || before.date) !== (after.starts_at || after.date)
    ) {
      if (after.lifecycle === "rescheduled" || (after.sequence ?? -1) > (before.sequence ?? -1)) {
        rescheduled.push(uid);
      }
    }
  }
  for (const uid of nextByUid.keys()) {
    if (!previousByUid.has(uid)) added.push(uid);
  }

  return Object.freeze({
    retained_uids: Object.freeze(retained.sort()),
    rescheduled_uids: Object.freeze(rescheduled.sort()),
    cancelled_uids: Object.freeze(cancelled.sort()),
    removed_without_cancellation: Object.freeze(removed.sort()),
    added_uids: Object.freeze(added.sort()),
  });
}

export function renderObserveCalendarSubscription(surface = {}, { escape = escapeHtml } = {}) {
  const scope = surface?.scope || normalizeObserveScope();
  if (scope.errors?.length) {
    return `<p class="observe-subscription-unsupported" role="status">Calendar subscription is unavailable for this unsupported observation filter. The browse view above is unchanged.</p>`;
  }
  const details = observeCalendarSubscriptionDetails(scope, {
    rows: (surface?.observations || []).map((row) => ({
      meeting_id: row.id,
      source_system: row.source_system,
      event_date: row.date,
      venue: row.venue ? { name: row.venue } : null,
      observer_access: row.access === "remote" ? { watch_url: "https://example.invalid/watch" } : null,
    })),
  });
  // Rebuild from full rows when the surface still carries them.
  const fromRows = observeCalendarSubscriptionDetails(scope, {
    rows: Array.isArray(surface?.rows) ? surface.rows : [],
  });
  const resolved = (fromRows?.feedUrl && fromRows) || details;
  if (!resolved?.feedUrl) {
    return `<p class="observe-subscription-empty" role="status">No dated observations in this supported scope can be followed yet.</p>`;
  }
  const precisionNote = "Date-only sessions say when the day is known but the clock time is not yet published. Timed sessions keep the published local start without inventing an end.";
  return `<section class="observe-subscription" aria-labelledby="observe-subscription-heading">
  <h2 id="observe-subscription-heading">Follow this selection</h2>
  <p>Subscription covers exactly: <strong>${escape(resolved.scopeLabel)}</strong>.</p>
  <p class="observe-subscription-precision">${escape(precisionNote)}</p>
  <p><a class="calendar-subscribe-btn" data-calendar-subscription="scope" data-calendar-subscription-feed="${escape(resolved.feedUrl)}" data-calendar-subscription-webcal="${escape(resolved.webcalUrl)}" data-calendar-subscription-label="${escape(resolved.scopeLabel)}" href="${escape(resolved.webcalUrl)}" aria-label="${escape(CALENDAR_SUBSCRIPTION_LABEL)}">${escape(CALENDAR_SUBSCRIPTION_LABEL)}</a></p>
  <p class="observe-subscription-note">Inspecting an observation opens its detail. It does not subscribe your calendar.</p>
</section>`;
}

export function meetingRowMatchesObserveFilter(row, filter = {}) {
  if (!filter || typeof filter !== "object") return true;
  if (filter.activity === "observe" && !isObserverRow(row) && row?.activity !== "observe") {
    return false;
  }
  if (filter.body && row?.source_system !== filter.body) return false;
  if (filter.access && observerAccessMethod(row) !== filter.access) return false;
  return true;
}

export { OBSERVE_FEED_FIELDS, BODY_LABELS };
