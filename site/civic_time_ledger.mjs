import { buildDerivedFeatureRollup } from "./derived_feature_rollup.mjs";

/**
 * Civic Time Ledger — as-of filter for agency constellation pages.
 *
 * Public surface: **valid / publication time** only (publisher or event dates
 * on linked records). System-time history of the composed graph is not retained
 * and is not offered as a UI axis. See docs/adr/civic-time-event-contract.md.
 */

export const CIVIC_TIME_LEDGER_SCHEMA = "cityscroll.civic_time_ledger.v1";
export const CIVIC_TIME_LEDGER_METHOD = "civic_time_ledger_as_of_v1";
export const AS_OF_QUERY_KEY = "as_of";

/** Library axes (projection helpers). Public UI uses valid only. */
export const TIME_AXES = Object.freeze({
  valid: Object.freeze({
    id: "valid",
    label: "Valid time",
    short: "Valid",
    meaning: "When the civic fact held or was published.",
  }),
  system: Object.freeze({
    id: "system",
    label: "System time",
    short: "System",
    meaning: "When CityScroll materialised the assertion (not retained for public as-of).",
  }),
});

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const escCivicTime = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
}[char]));

/**
 * Normalise a calendar day for as-of URLs and filters.
 * @returns {string|null} YYYY-MM-DD or null when invalid / empty
 */
export function normalizeAsOfDay(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  // Accept full ISO timestamps by taking the date portion only.
  const day = raw.length >= 10 ? raw.slice(0, 10) : raw;
  const match = DAY_RE.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const dom = Number(match[3]);
  if (month < 1 || month > 12 || dom < 1 || dom > 31) return null;
  // Reject non-calendar dates (e.g. 2024-02-31) without inventing a neighbour day.
  const probe = new Date(Date.UTC(year, month - 1, dom));
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== dom
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** Extract YYYY-MM-DD from a stored date-ish string; null when absent or unparseable. */
export function dayStamp(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  // Prefer an explicit calendar prefix when present.
  const isoDay = text.match(/\d{4}-\d{2}-\d{2}/);
  if (isoDay) return normalizeAsOfDay(isoDay[0]);
  return null;
}

export function compareDay(left, right) {
  const a = normalizeAsOfDay(left) || dayStamp(left);
  const b = normalizeAsOfDay(right) || dayStamp(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function parseAsOfFromSearch(search) {
  const params = new URLSearchParams(
    typeof search === "string"
      ? (search.startsWith("?") ? search.slice(1) : search)
      : "",
  );
  return normalizeAsOfDay(params.get(AS_OF_QUERY_KEY));
}

/**
 * Build a shareable as-of URL for a document path.
 * Empty / invalid asOf strips the param so "now" is the default share.
 */
export function asOfHref(path, asOfDay, { origin = "" } = {}) {
  const basePath = String(path || "/").startsWith("/") ? String(path || "/") : `/${path || ""}`;
  const url = new URL(basePath, origin || "https://cityscroll.org");
  const day = normalizeAsOfDay(asOfDay);
  if (day) url.searchParams.set(AS_OF_QUERY_KEY, day);
  else url.searchParams.delete(AS_OF_QUERY_KEY);
  if (origin) return url.toString();
  return `${url.pathname}${url.search}`;
}

/**
 * Valid / publication clock for a constellation (or similar) list item.
 * Uses only stored publisher/event fields — never processing time.
 */
export function itemValidDay(item) {
  if (!item || typeof item !== "object") return null;
  return dayStamp(item.valid_at)
    || dayStamp(item.valid_from)
    || dayStamp(item.published_at)
    || dayStamp(item.date)
    || dayStamp(item.when)
    || null;
}

/**
 * System / observation clock when the pipeline retained one.
 * Null means "not retained" — callers must not invent materialisation vintage
 * as per-item knowledge time.
 */
export function itemSystemDay(item) {
  if (!item || typeof item !== "object") return null;
  return dayStamp(item.observed_at)
    || dayStamp(item.system_time)
    || dayStamp(item.learned_at)
    || dayStamp(item.knowledge_time)
    || null;
}

/**
 * Classify one item against an as-of day on both axes.
 * Does not invent clocks: missing axes stay null / unknown.
 */
export function classifyItemTemporal(item, asOfDay) {
  const asOf = normalizeAsOfDay(asOfDay);
  const valid_day = itemValidDay(item);
  const system_day = itemSystemDay(item);
  const valid_known = Boolean(valid_day);
  const system_known = Boolean(system_day);
  return {
    valid_day,
    system_day,
    valid_known,
    system_known,
    included_by_valid: asOf && valid_known ? compareDay(valid_day, asOf) <= 0 : null,
    included_by_system: asOf && system_known ? compareDay(system_day, asOf) <= 0 : null,
    // v1 default filter basis when system history is absent.
    filter_basis: valid_known
      ? "valid_or_publication"
      : system_known
        ? "system_observation"
        : "undated",
  };
}

function cloneCategory(category) {
  return {
    ...category,
    items: Array.isArray(category.items)
      ? category.items.map((item) => ({ ...item }))
      : [],
  };
}

/**
 * Whether a constellation has enough dated spread for a useful as-of filter.
 * Inert controls are worse than no control — require ≥2 dated items on ≥2 days.
 */
export function asOfFilterCanNarrow(view) {
  if (!view || !["agency-constellation", "parcel"].includes(view.kind)) return false;
  const days = new Set();
  let dated = 0;
  const categories = view.categories || Object.entries(view.sections || {}).map(([id, section]) => ({
    id,
    items: section.items || [],
  }));
  for (const category of categories) {
    for (const item of category.items || []) {
      const day = itemValidDay(item);
      if (!day) continue;
      dated += 1;
      days.add(day);
      if (dated >= 2 && days.size >= 2) return true;
    }
  }
  return false;
}

/**
 * Project an agency constellation view as-of a calendar day.
 *
 * Default axis is **valid** (publisher / event dates retained on items).
 * System-axis projection is library-only (no public UI) and only keeps items
 * that carry a real observation clock.
 *
 * @param {object} view - buildAgencyConstellationView result
 * @param {string} asOfDay - YYYY-MM-DD
 * @param {{ axis?: "valid"|"system" }} [opts]
 */
export function projectAgencyConstellationAsOf(view, asOfDay, opts = {}) {
  if (!view || !["agency-constellation", "parcel"].includes(view.kind)) {
    throw new TypeError("projectAgencyConstellationAsOf requires an agency-constellation or parcel view");
  }
  const asOf = normalizeAsOfDay(asOfDay);
  if (!asOf) {
    throw new TypeError("asOfDay must be YYYY-MM-DD");
  }
  const axis = opts.axis === "system" ? "system" : "valid";
  const materializationVintage = dayStamp(view.summary?.generated_at)
    || dayStamp(view.provenance?.intelligence_generated_at)
    || dayStamp(view.provenance?.certification_generated_at)
    || null;

  let itemsWithSystemClock = 0;
  let itemsWithValidClock = 0;
  let undatedCount = 0;
  const excludedAfter = [];
  const undated = [];

  const sourceCategories = view.categories || Object.entries(view.sections || {}).map(([id, section]) => ({
    id,
    label: section.label || id,
    status: section.items?.length ? "matched" : "empty",
    items: section.items || [],
  }));
  const categories = sourceCategories.map((category) => {
    const next = cloneCategory(category);
    const kept = [];
    for (const item of next.items) {
      const clocks = classifyItemTemporal(item, asOf);
      if (clocks.valid_known) itemsWithValidClock += 1;
      if (clocks.system_known) itemsWithSystemClock += 1;
      if (!clocks.valid_known && !clocks.system_known) {
        undatedCount += 1;
        undated.push({
          category_id: category.id,
          id: item.id,
          subject_ref: item.subject_ref,
          label: item.label,
          reason: "no_valid_or_system_day",
        });
      }

      const include = axis === "system"
        ? clocks.included_by_system === true
        : clocks.included_by_valid === true;

      if (include) {
        kept.push({
          ...item,
          temporal: clocks,
        });
      } else if (axis === "valid" && clocks.included_by_valid === false) {
        excludedAfter.push({
          category_id: category.id,
          id: item.id,
          subject_ref: item.subject_ref,
          label: item.label,
          valid_day: clocks.valid_day,
          reason: "valid_or_publication_after_as_of",
        });
      } else if (axis === "system" && clocks.system_known && clocks.included_by_system === false) {
        excludedAfter.push({
          category_id: category.id,
          id: item.id,
          subject_ref: item.subject_ref,
          label: item.label,
          system_day: clocks.system_day,
          reason: "system_observation_after_as_of",
        });
      } else if (axis === "system" && !clocks.system_known) {
        // Cannot project: no per-item system clock.
        undated.push({
          category_id: category.id,
          id: item.id,
          subject_ref: item.subject_ref,
          label: item.label,
          reason: "system_time_not_retained_per_item",
        });
      } else if (axis === "valid" && !clocks.valid_known) {
        // Already counted in undated; not included (no invented membership).
      }
    }

    next.items = kept;
    // Displayed count follows projected list membership for as-of honesty.
    // Full-corpus category totals remain on the "now" view.
    next.count = kept.length;
    next.status = kept.length ? "matched" : (category.status === "not_yet_ingested" ? "not_yet_ingested" : "empty");
    if (!kept.length && category.status === "matched") {
      next.gap_class = "empty_as_of";
    }
    next.derived_feature_rollup = buildDerivedFeatureRollup(kept, {
      totalCount: kept.length,
      state: next.status,
      relation: category.relation || null,
      asOf: category.as_of || null,
      referenceDay: asOf,
    });
    return next;
  });

  const matched = categories.filter((category) => category.status === "matched").length;
  const systemTimeStatus = itemsWithSystemClock > 0
    ? "per_item_observation"
    : materializationVintage
      ? "current_snapshot_only"
      : "not_retained";

  return {
    ...view,
    path: asOfHref(view.path, asOf),
    categories,
    derived_feature_rollup: buildDerivedFeatureRollup(
      categories.flatMap((category) => (category.items || []).map((item) => ({
        ...item,
        state: category.status,
        relation: category.relation || null,
        as_of: category.as_of || null,
      }))),
      {
        totalCount: categories.reduce((total, category) => total + (Number(category.count) || 0), 0),
        referenceDay: asOf,
      },
    ),
    as_of: {
      schema: CIVIC_TIME_LEDGER_SCHEMA,
      method: CIVIC_TIME_LEDGER_METHOD,
      day: asOf,
      axis,
      axis_label: TIME_AXES[axis].label,
      system_time_status: systemTimeStatus,
      materialization_vintage: materializationVintage,
      counts: {
        matched_categories: matched,
        items_with_valid_clock: itemsWithValidClock,
        items_with_system_clock: itemsWithSystemClock,
        undated: undatedCount,
        excluded_after_as_of: excludedAfter.length,
      },
      excluded_after: excludedAfter.slice(0, 40),
      undated: undated.slice(0, 40),
    },
    summary: {
      ...view.summary,
      matched_categories: matched,
      as_of: asOf,
      as_of_axis: axis,
      iteration: "civic_time_ledger_v1",
    },
  };
}


/**
 * Diff "now" vs as-of projections for the ledger panel.
 */
export function buildLedgerSummary(nowView, asOfView) {
  if (!nowView || !asOfView?.as_of) {
    throw new TypeError("buildLedgerSummary requires now and as-of views");
  }
  const asOf = asOfView.as_of;
  const nowItems = (nowView.categories || []).flatMap((category) =>
    (category.items || []).map((item) => ({
      category_id: category.id,
      id: item.id,
      label: item.label,
      date: itemValidDay(item),
    })));
  const asOfIds = new Set(
    (asOfView.categories || []).flatMap((category) =>
      (category.items || []).map((item) => `${category.id}:${item.id}`)),
  );
  const arrivedAfter = nowItems.filter((item) => !asOfIds.has(`${item.category_id}:${item.id}`));

  return {
    schema: CIVIC_TIME_LEDGER_SCHEMA,
    method: CIVIC_TIME_LEDGER_METHOD,
    subject_ref: nowView.subject_ref,
    display_name: nowView.display_name,
    path: nowView.path,
    as_of_path: asOfView.path,
    as_of: asOf.day,
    axis: asOf.axis,
    axis_label: asOf.axis_label,
    system_time_status: asOf.system_time_status,
    materialization_vintage: asOf.materialization_vintage,
    now: {
      matched_categories: nowView.summary?.matched_categories ?? 0,
      item_count: nowItems.length,
    },
    as_of_counts: {
      matched_categories: asOfView.summary?.matched_categories ?? 0,
      item_count: (asOfView.categories || []).reduce((n, c) => n + (c.items?.length || 0), 0),
      excluded_after_as_of: asOf.counts?.excluded_after_as_of ?? 0,
      undated: asOf.counts?.undated ?? 0,
    },
    arrived_after: arrivedAfter.slice(0, 40),
  };
}

/**
 * Compact as-of control: one-line purpose + date picker + result counts.
 * Deeper explanation lives behind a details affordance, not theory boxes.
 * Works without JS via GET form; runtime upgrades in place.
 */
export function renderCivicTimeLedgerPanel({
  path,
  asOfDay = null,
  summary = null,
  subjectLabel = "this agency’s linked records",
} = {}) {
  const day = normalizeAsOfDay(asOfDay);
  const action = escCivicTime(path || "/");
  const nowCount = summary?.now?.item_count;
  const asOfCount = summary?.as_of_counts?.item_count;
  const arrived = summary?.as_of_counts?.excluded_after_as_of
    ?? summary?.arrived_after?.length
    ?? null;

  const comparison = day && summary
    ? `<p class="ctl-comparison" data-ctl-comparison>
        <strong>${escCivicTime(String(asOfCount ?? 0))}</strong> of
        <strong>${escCivicTime(String(nowCount ?? 0))}</strong> dated records on or before
        <strong>${escCivicTime(day)}</strong>${arrived != null && arrived > 0
          ? ` · ${escCivicTime(String(arrived))} later` : ""}
      </p>`
    : `<p class="ctl-comparison muted node-muted" data-ctl-comparison data-ctl-idle>
        Pick a day to keep only records published or dated on or before that day.
      </p>`;

  const arrivedList = day && Array.isArray(summary?.arrived_after) && summary.arrived_after.length
    ? `<details class="ctl-arrived">
        <summary>Later records (${escCivicTime(String(summary.arrived_after.length))}${summary.arrived_after.length >= 40 ? "+" : ""})</summary>
        <ul class="node-record-list ctl-arrived-list">${summary.arrived_after.map((row) =>
          `<li class="node-record"><div class="node-record-main">${escCivicTime(row.label || row.id)}</div><span class="muted node-muted">${escCivicTime(row.category_id || "")}${row.date ? ` · ${escCivicTime(row.date)}` : ""}</span></li>`).join("")}</ul>
      </details>`
    : "";

  return `<section class="node-section node-card civic-object-section ctl-panel" data-civic-time-ledger="1" data-as-of="${escCivicTime(day || "")}" data-export-class="object_provenance" aria-labelledby="ctl-heading">
    <div class="ctl-head">
      <h2 id="ctl-heading">As of day</h2>
      <details class="ctl-how">
        <summary aria-label="How as-of works">?</summary>
        <p>Shows only linked records whose publisher or event date is on or before the day you pick. Share the URL to reopen the same day.</p>
      </details>
    </div>
    <p class="ctl-lede">Filter ${escCivicTime(subjectLabel)} by date.</p>
    <form class="ctl-form" method="get" action="${action}" data-ctl-form>
      <label class="ctl-label" for="ctl-as-of">As of</label>
      <div class="ctl-form-row">
        <input class="ctl-input" id="ctl-as-of" name="${escCivicTime(AS_OF_QUERY_KEY)}" type="date" value="${escCivicTime(day || "")}" data-ctl-as-of>
        <button class="node-action civic-object-action primary ctl-submit" type="submit">Apply</button>
        <a class="node-action civic-object-action ctl-clear" href="${action}" data-ctl-clear${day ? "" : " hidden"}>Clear</a>
      </div>
    </form>
    ${comparison}
${arrivedList}
  </section>`;
}

/**
 * Lightweight notice-level temporal strip when only publisher clocks exist.
 * Used when a notice document surfaces as-of without a full graph history.
 */
export function buildNoticeTemporalFacts(notice = {}) {
  const valid = dayStamp(notice.event_date)
    || dayStamp(notice.valid_at)
    || dayStamp(notice.hearing_date)
    || null;
  const published = dayStamp(notice.start_date)
    || dayStamp(notice.published_at)
    || dayStamp(notice.publication_date)
    || null;
  const observed = dayStamp(notice.observed_at)
    || dayStamp(notice.ingested_at)
    || null;
  return {
    schema: CIVIC_TIME_LEDGER_SCHEMA,
    subject_ref: notice.request_id ? `notice:${notice.request_id}` : (notice.subject_ref || null),
    clocks: {
      valid_at: valid,
      published_at: published,
      observed_at: observed,
      processed_at: dayStamp(notice.processed_at) || null,
    },
    system_time_status: observed ? "per_item_observation" : "not_retained",
    notes: {
      valid: valid ? "Event / hearing date from the notice fields." : null,
      publication: published ? "City Record publication date." : null,
      system: observed ? "Observation clock on this record." : null,
    },
  };
}

export function noticeVisibleAsOf(facts, asOfDay, { axis = "valid" } = {}) {
  const asOf = normalizeAsOfDay(asOfDay);
  if (!asOf || !facts?.clocks) return { known: false, included: null, basis: "no_as_of" };
  if (axis === "system") {
    const day = facts.clocks.observed_at;
    if (!day) return { known: false, included: null, basis: "system_time_not_retained" };
    return { known: true, included: compareDay(day, asOf) <= 0, basis: "system_observation", day };
  }
  // Prefer valid event day; fall back to publication (labeled).
  const valid = facts.clocks.valid_at;
  const published = facts.clocks.published_at;
  if (valid) {
    return {
      known: true,
      included: compareDay(valid, asOf) <= 0,
      basis: "valid",
      day: valid,
    };
  }
  if (published) {
    return {
      known: true,
      included: compareDay(published, asOf) <= 0,
      basis: "publication",
      day: published,
    };
  }
  return { known: false, included: null, basis: "undated" };
}

export const CIVIC_TIME_NOTICE_HISTORY_SCHEMA = "cityscroll.civic_time_notice_history.v1";

const NOTICE_EVENT_LABELS = Object.freeze({
  "procurement.notice_published": "Notice published",
  "procurement.solicitation_opened": "Solicitation opened",
  "procurement.solicitation_addenda": "Solicitation revised",
  "procurement.solicitation_due": "Responses due",
  "procurement.award_registered": "Award registered",
  "procurement.payment": "Payment recorded",
  "rules.proposal_published": "Rule proposed",
  "rules.public_hearing": "Public hearing",
  "rules.comment_close": "Comment period closed",
  "rules.adoption": "Rule adopted",
  "rules.effective": "Rule effective",
  "land.city_record_notice": "Land-use notice published",
  "land.city_record_hearing": "Land-use hearing",
  "meetings.non_council_notice": "Hearing notice published",
  "meetings.non_council_hearing": "Public hearing",
});

function noticeEventLabel(kind) {
  return NOTICE_EVENT_LABELS[String(kind || "")] || "Civic record update";
}

function noticeEventValidText(event) {
  const at = event?.valid_at ?? null;
  const from = event?.valid_from ?? null;
  const to = event?.valid_to ?? null;
  if (at != null) return String(at);
  if (from != null && to != null) return `${from} – ${to}`;
  if (from != null) return `from ${from}`;
  if (to != null) return `through ${to}`;
  return null;
}

/**
 * Project retained civic-time envelopes for one notice into the reader model.
 * The system axis prefers the ledger write clock and falls back to the contract's
 * processed_at clock; it is never filled from valid, publication, observation, or
 * the current request time.
 */
export function buildNoticeBitemporalHistory(notice = {}, events = []) {
  const subject_ref = notice.request_id
    ? `notice:${notice.request_id}`
    : (notice.subject_ref || null);
  const retained = (Array.isArray(events) ? events : [])
    .filter((event) => !subject_ref || event?.subject_ref === subject_ref)
    .map((event) => {
      const clocks = {
        valid_at: event?.valid_at ?? event?.clocks?.valid_at ?? null,
        valid_from: event?.valid_from ?? event?.clocks?.valid_from ?? null,
        valid_to: event?.valid_to ?? event?.clocks?.valid_to ?? null,
        published_at: event?.published_at ?? event?.clocks?.published_at ?? null,
        observed_at: event?.observed_at ?? event?.clocks?.observed_at ?? null,
        system_at: event?.written_at ?? event?.processed_at ?? event?.clocks?.system_at ?? null,
      };
      return {
        event_id: event?.event_id || null,
        subject_ref: event?.subject_ref || subject_ref,
        event_kind: event?.event_kind || null,
        label: noticeEventLabel(event?.event_kind),
        clocks,
        valid_text: noticeEventValidText(clocks),
        status: event?.status ?? null,
      };
    })
    .sort((left, right) => {
      const a = left.clocks.system_at || left.clocks.valid_at || left.clocks.published_at || "";
      const b = right.clocks.system_at || right.clocks.valid_at || right.clocks.published_at || "";
      return a.localeCompare(b) || String(left.event_id || "").localeCompare(String(right.event_id || ""));
    });
  return {
    schema: CIVIC_TIME_NOTICE_HISTORY_SCHEMA,
    subject_ref,
    events: retained,
    count: retained.length,
  };
}

function noticeClockText(value) {
  return value == null ? "" : String(value);
}

/** Render one notice's retained history with valid and recorded clocks side by side. */
export function renderNoticeBitemporalHistory({ notice = {}, events = [], state = "ok" } = {}) {
  const history = buildNoticeBitemporalHistory(notice, events);
  if (!history.events.length) return "";
  const entries = history.events.map((event) => `<li class="civic-time-event" data-civic-time-event="${escCivicTime(event.event_id || "")}">
    <div class="civic-time-event-title"><strong>${escCivicTime(event.label)}</strong>${event.status ? ` <span class="civic-time-status">${escCivicTime(event.status)}</span>` : ""}</div>
    <dl class="civic-time-clocks">
      <div><dt>Valid time</dt><dd data-civic-time-valid="${escCivicTime(event.valid_text || "")}">${escCivicTime(noticeClockText(event.valid_text))}</dd></div>
      <div><dt>Recorded time</dt><dd data-civic-time-system="${escCivicTime(event.clocks.system_at || "")}">${escCivicTime(noticeClockText(event.clocks.system_at))}</dd></div>
    </dl>
  </li>`).join("");
  return `<section class="civic-object-section node-card civic-time-history" data-civic-time-history="1" data-history-state="ok" aria-labelledby="civic-time-history-heading">
    <h2 id="civic-time-history-heading">Bitemporal history</h2>
    <ol class="civic-time-event-list">${entries}</ol>
  </section>`;
}
