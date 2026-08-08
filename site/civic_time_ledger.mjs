/**
 * Civic Time Ledger — first-iteration as-of / "what did we know when" helpers.
 *
 * Snodgrass-style bitemporality: keep **valid time** (when a fact held in the
 * world) separate from **system / transaction time** (when CityScroll learned
 * or materialised it). See docs/adr/civic-time-event-contract.md.
 *
 * v1 honesty: daily materialisations retain publisher / event dates on linked
 * records (valid or publication axis) plus a single current materialisation
 * vintage. Historical system-time snapshots of the composed graph are **not**
 * retained yet — never invent them. Filter as-of on the available axis and
 * label the missing one explicitly.
 */

export const CIVIC_TIME_LEDGER_SCHEMA = "cityscroll.civic_time_ledger.v1";
export const CIVIC_TIME_LEDGER_METHOD = "civic_time_ledger_as_of_v1";
export const AS_OF_QUERY_KEY = "as_of";

/** Bounded vocabulary for the two Snodgrass axes. */
export const TIME_AXES = Object.freeze({
  valid: Object.freeze({
    id: "valid",
    label: "Valid time",
    short: "Valid",
    meaning: "When the civic fact held or occurred in the world (or when the city published it, when that is the only stored clock).",
  }),
  system: Object.freeze({
    id: "system",
    label: "System time",
    short: "System",
    meaning: "When CityScroll first observed or materialised the assertion (transaction / knowledge time).",
  }),
});

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const clean = (value, max = 240) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const esc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
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
 * Project an agency constellation view as-of a calendar day.
 *
 * Default axis is **valid** (publisher / event dates retained on items).
 * System-axis projection only keeps items that carry a real observation clock;
 * when none do, the projection is empty and `system_time_status` explains why.
 *
 * @param {object} view - buildAgencyConstellationView result
 * @param {string} asOfDay - YYYY-MM-DD
 * @param {{ axis?: "valid"|"system" }} [opts]
 */
export function projectAgencyConstellationAsOf(view, asOfDay, opts = {}) {
  if (!view || view.kind !== "agency-constellation") {
    throw new TypeError("projectAgencyConstellationAsOf requires an agency-constellation view");
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

  const categories = (view.categories || []).map((category) => {
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
      next.note = axis === "system"
        ? "No linked record in this category carries a retained system-time observation on or before the as-of day."
        : "No linked record in this category has a publisher or event date on or before the as-of day.";
      next.gap_class = "empty_as_of";
    }
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
    as_of: {
      schema: CIVIC_TIME_LEDGER_SCHEMA,
      method: CIVIC_TIME_LEDGER_METHOD,
      day: asOf,
      axis,
      axis_label: TIME_AXES[axis].label,
      system_time_status: systemTimeStatus,
      system_time_note: systemTimeStatus === "per_item_observation"
        ? "Some linked records carry observed_at (or equivalent) clocks; system-time as-of uses those only."
        : systemTimeStatus === "current_snapshot_only"
          ? `Historical system-time snapshots of this composed graph are not retained yet. The current materialisation vintage is ${materializationVintage}; it is not used as a per-record "learned on" date.`
          : "System / knowledge time is not retained for these linked records in this materialisation.",
      valid_time_note: itemsWithValidClock
        ? "Valid/publication filtering uses each record's stored publisher or event date. That is not the same as when CityScroll learned the fact."
        : "No publisher or event dates are available on the linked sample; valid-time as-of cannot filter membership.",
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
    system_time_note: asOf.system_time_note,
    valid_time_note: asOf.valid_time_note,
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
 * Static-first panel: as-of control, Snodgrass axis legend, honesty notes.
 * Works without JS via GET form; runtime module upgrades in place.
 */
export function renderCivicTimeLedgerPanel({
  path,
  asOfDay = null,
  summary = null,
  materializationVintage = null,
  systemTimeStatus = "current_snapshot_only",
} = {}) {
  const day = normalizeAsOfDay(asOfDay);
  const action = esc(path || "/");
  const vintage = materializationVintage || summary?.materialization_vintage || null;
  const status = systemTimeStatus || summary?.system_time_status || "current_snapshot_only";
  const nowCount = summary?.now?.item_count;
  const asOfCount = summary?.as_of_counts?.item_count;
  const arrived = summary?.as_of_counts?.excluded_after_as_of
    ?? summary?.arrived_after?.length
    ?? null;

  const statusLine = status === "per_item_observation"
    ? "System time is available on some linked records (observed clocks)."
    : status === "current_snapshot_only"
      ? `System-time history of this composed graph is not retained yet. Current materialisation vintage${vintage ? `: ${esc(vintage)}` : " is unknown"}. That vintage is not treated as a per-record "learned on" date.`
      : "System / knowledge time is not retained for these linked records.";

  const comparison = day && summary
    ? `<p class="ctl-comparison" data-ctl-comparison>
        <strong>As of ${esc(day)}</strong> (valid / publication axis):
        ${esc(String(asOfCount ?? 0))} listed record${asOfCount === 1 ? "" : "s"} across
        ${esc(String(summary.as_of_counts?.matched_categories ?? 0))} categor${(summary.as_of_counts?.matched_categories ?? 0) === 1 ? "y" : "ies"}
        · <strong>Now</strong>: ${esc(String(nowCount ?? 0))} listed
        ${arrived != null ? ` · ${esc(String(arrived))} entered the sample after that day` : ""}
      </p>`
    : `<p class="ctl-comparison muted node-muted" data-ctl-comparison>
        Choose a day to project this agency's linked sample as it stood in the world by that date (publisher / event clocks). The system-time axis stays labeled until historical knowledge snapshots exist.
      </p>`;

  const arrivedList = day && Array.isArray(summary?.arrived_after) && summary.arrived_after.length
    ? `<details class="ctl-arrived">
        <summary>Later records (${esc(String(summary.arrived_after.length))}${summary.arrived_after.length >= 40 ? "+" : ""})</summary>
        <p class="muted node-muted">Listed in today's sample with a publisher or event date after ${esc(day)}.</p>
        <ul class="node-record-list ctl-arrived-list">${summary.arrived_after.map((row) =>
          `<li class="node-record"><div class="node-record-main">${esc(row.label || row.id)}</div><span class="muted node-muted">${esc(row.category_id || "")}${row.date ? ` · valid/publication ${esc(row.date)}` : " · date unknown"}</span></li>`).join("")}</ul>
      </details>`
    : "";

  return `<section class="node-section node-card civic-object-section ctl-panel" data-civic-time-ledger="1" data-as-of="${esc(day || "")}" data-system-time-status="${esc(status)}" data-export-class="object_provenance" aria-labelledby="ctl-heading">
    <h2 id="ctl-heading">As-of view · Civic Time Ledger</h2>
    <p class="ctl-lede">First iteration of bitemporal read-back: <strong>valid time</strong> (when the fact held or was published) versus <strong>system time</strong> (when CityScroll knew it). Share the URL to reopen the same day.</p>
    <form class="ctl-form" method="get" action="${action}" data-ctl-form>
      <label class="ctl-label" for="ctl-as-of">As of day</label>
      <div class="ctl-form-row">
        <input class="ctl-input" id="ctl-as-of" name="${esc(AS_OF_QUERY_KEY)}" type="date" value="${esc(day || "")}" data-ctl-as-of>
        <button class="node-action civic-object-action primary ctl-submit" type="submit">Show as-of</button>
        <a class="node-action civic-object-action ctl-clear" href="${action}" data-ctl-clear${day ? "" : " hidden"}>Clear (now)</a>
      </div>
    </form>
    <dl class="ctl-axes">
      <div>
        <dt>${esc(TIME_AXES.valid.label)}</dt>
        <dd>${esc(TIME_AXES.valid.meaning)} <span class="ctl-axis-state" data-ctl-valid-state>Available on linked records that carry a publisher or event date — this as-of filter uses that axis.</span></dd>
      </div>
      <div>
        <dt>${esc(TIME_AXES.system.label)}</dt>
        <dd>${esc(TIME_AXES.system.meaning)} <span class="ctl-axis-state" data-ctl-system-state>${statusLine}</span></dd>
      </div>
    </dl>
    ${comparison}
    ${arrivedList}
    <p class="muted node-muted ctl-honesty">Missing clocks stay unlabeled rather than filled. Valid-time membership is not claimed as system-time knowledge.</p>
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
      valid: valid
        ? "Event / hearing date from the notice fields."
        : "No separate valid-time event date is stored on this notice.",
      publication: published
        ? "City Record publication (start_date) is a publication clock, not system time."
        : "Publication date is not available on this notice.",
      system: observed
        ? "Observation clock retained on this record."
        : "CityScroll system-time history is not retained for this notice in the public materialisation.",
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
