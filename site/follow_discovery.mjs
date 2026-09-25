/**
 * Contextual discovery for existing follow, calendar, saved-search, and feed
 * actions. This is a small projection over providers that already own behavior:
 * Following watches, calendar subscription eligibility, standing Atom/JSON feeds,
 * single-event ICS downloads, and browser-local saved searches.
 *
 * Opening, inspecting, or copying never creates a subscription.
 */

import {
  calendarFeedUnsupportedFilterFields,
  calendarFeedUrlForScope,
  standingFeedUrlsFromWatch,
  subscriptionParamsFromWatch,
  watchFromScope,
} from "./scope_v0.mjs";
import {
  calendarNativeSubscriptionUrl,
  calendarSubscriptionDetailsForScope,
  hasDefensibleDatedOccurrences,
  CALENDAR_SUBSCRIPTION_LABEL,
} from "./calendar_subscription.mjs";
import { renderGuideHelpLink } from "./guide_contextual_links.mjs";
import { minRemainingDaysCalendarUnavailableMessage } from "./money_watch_min_remaining_days.mjs";

const FOLLOWING_BASE = "https://cityscroll.org/following";

/** Build a Following create URL for an ordinary scoped watch without pulling the Following document renderer. */
function followingHrefFromWatch(watch, { base = FOLLOWING_BASE } = {}) {
  if (!watch?.lens) return "/following/";
  const params = subscriptionParamsFromWatch(watch);
  return `${String(base).replace(/\/$/, "")}?${params}`;
}

/** Surface → placement disposition used to close absent or inconsistent access. */
export const FOLLOW_DISCOVERY_SURFACE_MATRIX = Object.freeze([
  Object.freeze({ surface: "search", disposition: "positive_control", render_owner: "site/index.html + site/app/search-share.mjs" }),
  Object.freeze({ surface: "browse", disposition: "repair", render_owner: "site/browse_view.mjs" }),
  Object.freeze({ surface: "now", disposition: "repair", render_owner: "site/now_view.mjs + site/primary_document_view.mjs" }),
  Object.freeze({ surface: "near_you", disposition: "repair", render_owner: "site/near_you_view.mjs" }),
  Object.freeze({ surface: "following", disposition: "positive_control", render_owner: "site/following_view.mjs" }),
  Object.freeze({ surface: "board", disposition: "positive_control", render_owner: "site/community_board_participation.mjs" }),
  Object.freeze({ surface: "district", disposition: "repair", render_owner: "site/near_you_view.mjs" }),
  Object.freeze({ surface: "institution", disposition: "positive_control", render_owner: "site/institution_follow_scope.mjs" }),
  Object.freeze({ surface: "project", disposition: "positive_control", render_owner: "site/project_calendar.mjs" }),
  Object.freeze({ surface: "matter", disposition: "positive_control", render_owner: "site/council_matter_watch.mjs" }),
]);

export const FOLLOW_DISCOVERY_ACTION_KINDS = Object.freeze({
  email_follow: "email_follow",
  calendar_subscription: "calendar_subscription",
  single_event_download: "single_event_download",
  saved_search: "saved_search",
  feed_reader: "feed_reader",
});

const LABEL = Object.freeze({
  email_follow: "Get email updates",
  calendar_subscription: CALENDAR_SUBSCRIPTION_LABEL,
  single_event_download: "Download this event",
  saved_search: "Save search on this device",
  feed_reader_summary: "Feed reader links",
  feed_atom: "Atom feed",
  feed_json: "JSON feed",
  group_label: "Keep following this selection",
  unsupported_feed: "This exact filter combination cannot be turned into a standing feed without dropping constraints, so no broader feed is offered.",
  unsupported_calendar: "This selection has no dated events a calendar can hold, or its filters cannot be replayed exactly.",
  handoff_failed: "That handoff did not finish. Your original selection is unchanged.",
  handoff_recovery_copy: "Copy feed address",
  handoff_recovery_open: "Open feed address",
});

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function firstDomain(scope, lens) {
  const fromLens = String(lens || "").trim();
  if (fromLens) return fromLens === "exams" ? "people" : fromLens;
  const domains = scope?.facets?.domains;
  if (Array.isArray(domains) && domains[0]) return String(domains[0]);
  return null;
}

function surfaceEntry(surface) {
  return FOLLOW_DISCOVERY_SURFACE_MATRIX.find((row) => row.surface === surface) || null;
}

/**
 * Project which existing follow/calendar/feed actions apply to one scoped surface.
 * Unavailable actions are omitted rather than rendered as empty panels.
 */
export function projectFollowDiscovery({
  surface,
  scope = null,
  lens = null,
  rows = [],
  followHref = null,
  followLabel = null,
  eventDownloadHref = null,
  includeSavedSearch = false,
  savedSearchLabel = LABEL.saved_search,
  omitKinds = [],
  apiBase = "https://api.cityscroll.org",
} = {}) {
  const entry = surfaceEntry(surface);
  const omitted = new Set(omitKinds || []);
  const targetLens = firstDomain(scope, lens);
  const watch = scope && targetLens
    ? watchFromScope(scope, { lens: targetLens })
    : (targetLens ? { lens: targetLens, filter: {} } : null);

  const actions = [];
  const notes = [];

  const resolvedFollowHref = followHref
    || (watch ? followingHrefFromWatch(watch) : null);
  if (resolvedFollowHref && !omitted.has(FOLLOW_DISCOVERY_ACTION_KINDS.email_follow)) {
    actions.push(Object.freeze({
      kind: FOLLOW_DISCOVERY_ACTION_KINDS.email_follow,
      label: followLabel || LABEL.email_follow,
      href: resolvedFollowHref,
      semantics: "email_updates",
      creates_subscription: false,
    }));
  }

  const dated = hasDefensibleDatedOccurrences(targetLens, rows);
  const calendarDetails = dated && scope
    ? calendarSubscriptionDetailsForScope(scope, { lens: targetLens, rows })
    : null;
  if (calendarDetails && !omitted.has(FOLLOW_DISCOVERY_ACTION_KINDS.calendar_subscription)) {
    actions.push(Object.freeze({
      kind: FOLLOW_DISCOVERY_ACTION_KINDS.calendar_subscription,
      label: LABEL.calendar_subscription,
      href: calendarDetails.webcalUrl,
      feedUrl: calendarDetails.feedUrl,
      webcalUrl: calendarDetails.webcalUrl,
      scopeLabel: calendarDetails.scopeLabel,
      semantics: "updating_calendar_subscription",
      creates_subscription: false,
    }));
  } else if (scope && targetLens && !omitted.has(FOLLOW_DISCOVERY_ACTION_KINDS.calendar_subscription)) {
    const unsupported = [
      ...calendarFeedUnsupportedFilterFields(watch || { lens: targetLens, filter: {} }),
    ];
    if (!dated || unsupported.length || !calendarFeedUrlForScope(scope)) {
      const leadTimeBlocked = unsupported.includes("minRemainingDays");
      notes.push(Object.freeze({
        kind: "calendar_unavailable",
        message: leadTimeBlocked
          ? minRemainingDaysCalendarUnavailableMessage()
          : LABEL.unsupported_calendar,
        unsupported_fields: Object.freeze(unsupported),
      }));
    }
  }

  if (eventDownloadHref && !omitted.has(FOLLOW_DISCOVERY_ACTION_KINDS.single_event_download)) {
    actions.push(Object.freeze({
      kind: FOLLOW_DISCOVERY_ACTION_KINDS.single_event_download,
      label: LABEL.single_event_download,
      href: eventDownloadHref,
      semantics: "single_event_download",
      creates_subscription: false,
    }));
  }

  if (includeSavedSearch && !omitted.has(FOLLOW_DISCOVERY_ACTION_KINDS.saved_search)) {
    actions.push(Object.freeze({
      kind: FOLLOW_DISCOVERY_ACTION_KINDS.saved_search,
      label: savedSearchLabel,
      href: null,
      semantics: "local_saved_search",
      creates_subscription: false,
      local_only: true,
    }));
  }

  let feeds = null;
  let feedUnsupported = null;
  if (watch && !omitted.has(FOLLOW_DISCOVERY_ACTION_KINDS.feed_reader)) {
    const urls = standingFeedUrlsFromWatch(watch, { apiBase });
    const unsupported = calendarFeedUnsupportedFilterFields(watch);
    // Atom/JSON replay the exact watch wire. ICS may be null when calendar
    // replay would silently broaden; never substitute a broader calendar.
    if (urls?.atom && urls?.json) {
      feeds = Object.freeze({
        atom: urls.atom,
        json: urls.json,
        ics: urls.ics || null,
      });
      actions.push(Object.freeze({
        kind: FOLLOW_DISCOVERY_ACTION_KINDS.feed_reader,
        label: LABEL.feed_reader_summary,
        feeds,
        semantics: "feed_reader",
        creates_subscription: false,
        optional: true,
      }));
    } else {
      feedUnsupported = Object.freeze({
        message: LABEL.unsupported_feed,
        unsupported_fields: Object.freeze(unsupported),
      });
      notes.push(Object.freeze({
        kind: "feed_unavailable",
        message: LABEL.unsupported_feed,
        unsupported_fields: Object.freeze(unsupported),
      }));
    }
  }

  return Object.freeze({
    surface: entry?.surface || surface || null,
    disposition: entry?.disposition || "omit",
    render_owner: entry?.render_owner || null,
    lens: targetLens,
    watch: watch ? Object.freeze({ lens: watch.lens, filter: Object.freeze({ ...watch.filter }) }) : null,
    actions: Object.freeze(actions),
    notes: Object.freeze(notes),
    feeds,
    feedUnsupported,
    creates_subscription_on_open: false,
  });
}

function renderPrimaryAction(action, { escape = esc } = {}) {
  if (action.kind === FOLLOW_DISCOVERY_ACTION_KINDS.email_follow && action.href) {
    return `<a class="follow-discovery-follow" data-follow-discovery-action="email_follow" href="${escape(action.href)}">${escape(action.label)}</a>`;
  }
  if (action.kind === FOLLOW_DISCOVERY_ACTION_KINDS.calendar_subscription && action.href) {
    return `<a class="calendar-subscribe-btn follow-discovery-calendar" data-follow-discovery-action="calendar_subscription" data-calendar-subscription="scope" data-calendar-subscription-feed="${escape(action.feedUrl)}" data-calendar-subscription-webcal="${escape(action.webcalUrl)}" data-calendar-subscription-label="${escape(action.scopeLabel || "")}" href="${escape(action.webcalUrl)}" aria-label="${escape(action.label)}">${escape(action.label)}</a>`;
  }
  if (action.kind === FOLLOW_DISCOVERY_ACTION_KINDS.single_event_download && action.href) {
    return `<a class="follow-discovery-event" data-follow-discovery-action="single_event_download" href="${escape(action.href)}">${escape(action.label)}</a>`;
  }
  if (action.kind === FOLLOW_DISCOVERY_ACTION_KINDS.saved_search) {
    return `<button type="button" class="follow-discovery-saved-search" data-follow-discovery-action="saved_search" data-search-save>${escape(action.label)}</button>`;
  }
  return "";
}

function renderFeedDisclosure(action, notes, { escape = esc } = {}) {
  const feedNote = notes.find((note) => note.kind === "feed_unavailable");
  if (action?.feeds) {
    const ics = action.feeds.ics
      ? `<li><a href="${escape(action.feeds.ics)}">Calendar feed (ICS)</a> — updating subscription address</li>`
      : "";
    return `<details class="follow-discovery-feeds" data-follow-discovery-feeds>
      <summary>${escape(LABEL.feed_reader_summary)}</summary>
      <p>Optional developer-level feed addresses for the same exact filters. These do not enroll email or create a calendar subscription by themselves.</p>
      <ul>
        <li><a href="${escape(action.feeds.atom)}">${escape(LABEL.feed_atom)}</a></li>
        <li><a href="${escape(action.feeds.json)}">${escape(LABEL.feed_json)}</a></li>
        ${ics}
      </ul>
    </details>`;
  }
  if (feedNote) {
    return `<details class="follow-discovery-feeds is-unsupported" data-follow-discovery-feeds data-follow-discovery-unsupported="feed">
      <summary>${escape(LABEL.feed_reader_summary)}</summary>
      <p role="status">${escape(feedNote.message)}</p>
    </details>`;
  }
  return "";
}

/**
 * Render one contextual control group. Returns "" when nothing applicable exists
 * so callers never mount an empty panel.
 */
function recoveryHrefFromProjection(projection) {
  const calendar = (projection?.actions || []).find(
    (action) => action.kind === FOLLOW_DISCOVERY_ACTION_KINDS.calendar_subscription,
  );
  if (calendar?.feedUrl) return calendar.feedUrl;
  const feeds = (projection?.actions || []).find(
    (action) => action.kind === FOLLOW_DISCOVERY_ACTION_KINDS.feed_reader,
  );
  return feeds?.feeds?.atom || feeds?.feeds?.json || null;
}

function renderHandoffFailure(projection, { escape = esc, recoveryHref = null } = {}) {
  const recovery = recoveryHref || recoveryHrefFromProjection(projection);
  const recoveryHtml = recovery
    ? `<p class="follow-discovery-recovery">
      <button type="button" data-follow-discovery-recovery="copy" data-copy-href="${escape(recovery)}">${escape(LABEL.handoff_recovery_copy)}</button>
      <a data-follow-discovery-recovery="navigate" href="${escape(recovery)}">${escape(LABEL.handoff_recovery_open)}</a>
    </p>`
    : `<p class="follow-discovery-recovery" data-follow-discovery-recovery="context">Try again from this page. Nothing was enrolled.</p>`;
  return `<p role="status" data-follow-discovery-failed="1">${escape(LABEL.handoff_failed)}</p>${recoveryHtml}`;
}

export function renderFollowDiscoveryGroup(projection, {
  escape = esc,
  includeGuide = true,
  regionId = "follow-discovery",
  handoffStatus = null,
  recoveryHref = null,
} = {}) {
  if (!projection || !Array.isArray(projection.actions) || projection.actions.length === 0) {
    // Still allow an unsupported-feed note alone only when a primary action exists.
    return "";
  }

  const primary = projection.actions.filter((action) => action.kind !== FOLLOW_DISCOVERY_ACTION_KINDS.feed_reader);
  const feedAction = projection.actions.find((action) => action.kind === FOLLOW_DISCOVERY_ACTION_KINDS.feed_reader);
  if (!primary.length && !feedAction) return "";

  const primaryHtml = primary.map((action) => renderPrimaryAction(action, { escape })).filter(Boolean).join("");
  const feedsHtml = renderFeedDisclosure(feedAction, projection.notes, { escape });
  const guideHtml = includeGuide
    ? [
      primary.some((action) => action.kind === FOLLOW_DISCOVERY_ACTION_KINDS.email_follow)
        ? renderGuideHelpLink("following", { extraClass: "follow-discovery-guide-help" })
        : "",
      primary.some((action) => action.kind === FOLLOW_DISCOVERY_ACTION_KINDS.calendar_subscription)
        ? renderGuideHelpLink("calendar", { extraClass: "follow-discovery-guide-help" })
        : "",
    ].filter(Boolean).join("")
    : "";

  const semantics = `<ul class="follow-discovery-semantics" data-follow-discovery-semantics>
    ${primary.some((a) => a.kind === FOLLOW_DISCOVERY_ACTION_KINDS.email_follow) ? `<li data-semantics="email_updates"><strong>Get email updates</strong> opens Following so you can preview and confirm a watch. Nothing is enrolled until you create the watch.</li>` : ""}
    ${primary.some((a) => a.kind === FOLLOW_DISCOVERY_ACTION_KINDS.calendar_subscription) ? `<li data-semantics="updating_calendar_subscription"><strong>Subscribe to calendar</strong> hands an updating feed to your calendar app. Copying the URL does not enroll anyone.</li>` : ""}
    ${primary.some((a) => a.kind === FOLLOW_DISCOVERY_ACTION_KINDS.single_event_download) ? `<li data-semantics="single_event_download"><strong>Download this event</strong> saves one dated occurrence as a file. It is not a standing subscription.</li>` : ""}
    ${primary.some((a) => a.kind === FOLLOW_DISCOVERY_ACTION_KINDS.saved_search) ? `<li data-semantics="local_saved_search"><strong>Save search on this device</strong> keeps filters in this browser only.</li>` : ""}
  </ul>`;
  const failedHtml = handoffStatus === "failed"
    ? renderHandoffFailure(projection, { escape, recoveryHref })
    : "";

  const failureBlock = failedHtml ? `\n    ${failedHtml}` : "";
  return `<section class="follow-discovery" data-follow-discovery="1" data-follow-discovery-surface="${escape(projection.surface || "")}" data-follow-discovery-region="${escape(regionId)}" aria-label="${escape(LABEL.group_label)}">
    <p class="follow-discovery-kicker">${escape(LABEL.group_label)}</p>
    <div class="follow-discovery-actions">${primaryHtml}</div>
    ${semantics}
    ${guideHtml}
    ${feedsHtml}${failureBlock}
  </section>`;
}

/**
 * Observe open / inspect / copy against a discovery projection.
 * These discovery actions never write an enrollment; the returned count is the proof.
 */
export function observeFollowDiscoveryInspection(projection, {
  enrollmentLog = null,
  action = "open",
  regionId = "follow-discovery",
} = {}) {
  const log = Array.isArray(enrollmentLog) ? enrollmentLog : [];
  const before = log.length;
  const html = renderFollowDiscoveryGroup(projection, { regionId });
  const copied = [];
  if (html && (action === "open" || action === "inspect" || action === "copy")) {
    for (const match of html.matchAll(/\b(?:href|data-calendar-subscription-feed|data-calendar-subscription-webcal)="([^"]+)"/g)) {
      const value = String(match[1] || "").replaceAll("&amp;", "&").trim();
      if (/^(?:webcal|https):/i.test(value)) copied.push(value);
    }
  }
  // Opening, inspecting, or copying never pushes an enrollment record.
  const after = log.length;
  return Object.freeze({
    before,
    after,
    created: after - before,
    action,
    opened: Boolean(html),
    copied_urls: Object.freeze(copied),
    enrolls_via_form: /action="[^"]*\/(?:subscribe|prefs)"/.test(html),
  });
}

/** True when markup already contains the discovery region (duplicate prevention). */
export function followDiscoveryAlreadyPresent(html, regionId = "follow-discovery") {
  const source = String(html || "");
  if (!source) return false;
  if (regionId && regionId !== "follow-discovery") {
    return source.includes(`data-follow-discovery-region="${regionId}"`);
  }
  return /data-follow-discovery="1"/.test(source);
}

/**
 * Browse-specific helper: project + render beside an existing calendar control,
 * or omit when the view cannot support any follow action.
 */
export function renderFollowDiscoveryForBrowseView(view, options = {}) {
  if (!view || view.scope?.mode === "unsupported") return "";
  if (followDiscoveryAlreadyPresent(options.existingHtml || "", options.regionId)) return "";
  const viewLens = view.config?.tab || view.facet;
  const lens = viewLens === "exams" ? "people" : viewLens;
  const scope = view.scopeObject || null;
  if (!scope || !lens || ["people-list", "staffing"].includes(view.facet)) {
    // Institution directories and staffing lists keep their own follow owners.
    return "";
  }
  const omitKinds = [
    ...(options.omitKinds || []),
    ...(options.calendarAlreadyRendered ? [FOLLOW_DISCOVERY_ACTION_KINDS.calendar_subscription] : []),
  ];
  const projection = projectFollowDiscovery({
    surface: "browse",
    scope,
    lens,
    rows: view.calendarRows || view.rows || [],
    includeSavedSearch: false,
    omitKinds,
  });
  return renderFollowDiscoveryGroup(projection, {
    includeGuide: options.includeGuide !== false,
    regionId: options.regionId || "browse-follow-discovery",
  });
}

function nearYouCalendarRows(view) {
  if (Array.isArray(view?.calendarRows) && view.calendarRows.length) return view.calendarRows;
  if (Array.isArray(view?.rows) && view.rows.length) return view.rows;
  const lens = view?.lens;
  return (view?.results?.records || []).map((record) => ({
    meeting_id: lens === "meetings" ? record.id : null,
    request_id: record.id,
    event_date: record.date || record.event_date || null,
    due_date: record.date || record.due_date || null,
    exam_number: lens === "people" && /^\d{4}$/.test(String(record.id || "")) ? record.id : null,
    application_end: record.date || null,
  }));
}

export function renderFollowDiscoveryForNearYou(view, options = {}) {
  if (!view?.scope || view.isOverview) return "";
  if (followDiscoveryAlreadyPresent(options.existingHtml || "", options.regionId)) return "";
  // Near You already exposes "Watch these filters" as a positive control.
  // Keep feed-reader addresses off this resident surface: the static Near You
  // contract forbids absolute API hrefs in the document, and RSS/JSON remain
  // optional developer-level choices on search/Browse instead.
  //
  // Map presentation may carry a viewport box that the standing calendar feed
  // cannot replay. Drop only that presentation field so borough/district
  // filters still round-trip exactly; never invent a broader place scope.
  const scope = view.scope?.place?.viewport
    ? {
      ...view.scope,
      place: {
        ...view.scope.place,
        viewport: null,
      },
    }
    : view.scope;
  const surface = options.surface || view.surface || "near_you";
  const projection = projectFollowDiscovery({
    surface,
    scope,
    lens: view.lens,
    rows: nearYouCalendarRows(view),
    followHref: view.watchHref || null,
    followLabel: "Watch these filters",
    omitKinds: [
      FOLLOW_DISCOVERY_ACTION_KINDS.email_follow,
      FOLLOW_DISCOVERY_ACTION_KINDS.feed_reader,
      ...(options.omitKinds || []),
    ],
  });
  return renderFollowDiscoveryGroup(projection, {
    includeGuide: true,
    regionId: options.regionId || (surface === "district" ? "district-follow-discovery" : "near-you-follow-discovery"),
  });
}

export function renderFollowDiscoveryForNow(surface, options = {}) {
  if (!surface) return "";
  if (followDiscoveryAlreadyPresent(options.existingHtml || "", options.regionId)) return "";
  const scope = options.scope || surface.scope || null;
  const lens = firstDomain(scope, options.lens || "meetings");
  const datedRows = [
    ...(surface.happening_soon?.items || []),
    ...(surface.act_by?.dated || []),
  ].map((item) => ({
    meeting_id: item.meeting_id || item.id || item.request_id,
    event_date: item.event_date || item.date || item.act_by || item.when,
    request_id: item.request_id || item.id,
    due_date: item.due_date || item.act_by,
    exam_number: item.exam_number,
    application_end: item.application_end,
  }));
  const fallbackScope = scope || {
    language: "en",
    facets: { domains: [lens], agencies: [], actions: [], values: {} },
    place: {
      boroughs: [],
      community_districts: [],
      council_districts: [],
      neighborhood: null,
      location_scope: null,
      viewport: null,
    },
    topic: { query: null, keywords: [] },
    time_window: {},
  };
  const projection = projectFollowDiscovery({
    surface: "now",
    scope: fallbackScope,
    lens,
    rows: datedRows,
    followHref: options.followHref || "/following/",
    followLabel: "Get email updates",
    omitKinds: options.omitKinds || [],
  });
  return renderFollowDiscoveryGroup(projection, {
    includeGuide: true,
    regionId: options.regionId || "now-follow-discovery",
  });
}

/** Compact feed-reader disclosure for surfaces that already expose follow + calendar. */
export function renderFeedReaderDisclosureForScope(scope, {
  lens = null,
  apiBase = "https://api.cityscroll.org",
  escape = esc,
} = {}) {
  const projection = projectFollowDiscovery({ surface: "search", scope, lens, rows: [], apiBase });
  const feedAction = projection.actions.find((action) => action.kind === FOLLOW_DISCOVERY_ACTION_KINDS.feed_reader);
  return renderFeedDisclosure(feedAction, projection.notes, { escape });
}

export {
  LABEL as FOLLOW_DISCOVERY_LABELS,
  calendarNativeSubscriptionUrl,
  hasDefensibleDatedOccurrences,
  renderFeedDisclosure,
};
