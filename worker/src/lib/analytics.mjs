// First-party, aggregate usage analytics.
//
// One Analytics Engine point represents one allowed event. The schema intentionally has no
// visitor, request, IP, user-agent, query-text, entity-name, or notice-id field. All dimensions
// are small enumerations from docs/analytics-event-taxonomy.md.

export const TAXONOMY_VERSION = "1.0.0";
export const DEFAULT_ANALYTICS_DATASET = "crol_usage_events_v1";
export const ANALYTICS_RETENTION_DAYS = 90;

export const ANALYTICS_LENSES = Object.freeze([
  "money", "people", "land", "property", "rules", "meetings", "alerts",
]);

export const ANALYTICS_AREAS = Object.freeze([
  "manhattan", "brooklyn", "queens", "bronx", "staten-island",
]);

const SURFACES = Object.freeze([
  "home", "stats", "about", "data", "api", "changelog", "standards",
]);

const EVENT_SPECS = Object.freeze({
  page_view: {
    surfaces: SURFACES,
  },
  lens_open: {
    lenses: ANALYTICS_LENSES,
    surfaces: ["home"],
  },
  search_run: {
    lenses: ANALYTICS_LENSES,
    details: ["filters", "natural-language", "preset"],
    areas: ANALYTICS_AREAS,
    surfaces: ["home", "api"],
  },
  deep_link_open: {
    lenses: ANALYTICS_LENSES,
    details: ["notice", "agency", "vendor", "search", "investigation"],
    surfaces: ["home", "digest"],
  },
  export: {
    lenses: ANALYTICS_LENSES,
    details: ["csv", "xlsx", "print", "ics", "json"],
    surfaces: ["home"],
  },
  alert_start: {
    lenses: ANALYTICS_LENSES,
    details: ["preview", "subscribe"],
    surfaces: ["home"],
  },
  alert_confirmed: {
    lenses: ANALYTICS_LENSES,
    surfaces: ["api", "email"],
  },
  digest_sent: {
    lenses: ANALYTICS_LENSES,
    surfaces: ["email"],
  },
  digest_link_open: {
    lenses: ANALYTICS_LENSES,
    details: ["notice"],
    surfaces: ["digest"],
  },
  feed_fetch: {
    details: ["atom", "json", "ics"],
    surfaces: ["api"],
  },
  saved_search_check: {
    surfaces: ["api"],
  },
  investigation_share: {
    details: ["create", "copy"],
    surfaces: ["home", "api"],
  },
});

const NONE = "none";

function enumValue(value, allowed, fallback = NONE) {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed?.includes(normalized) ? normalized : fallback;
}

export function normalizeUsageEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const event = String(input.event || "").trim().toLowerCase();
  const spec = EVENT_SPECS[event];
  if (!spec) return null;

  const lens = enumValue(input.lens, spec.lenses);
  const detail = enumValue(input.detail, spec.details);
  const geography = enumValue(input.geography, spec.areas);
  const surface = enumValue(input.surface, spec.surfaces);

  // Required dimensions are the ones whose spec has exactly one or more allowed values and whose
  // event would be meaningless without one. Optional geography is allowed only for search_run.
  if (spec.lenses && lens === NONE && !["deep_link_open", "export", "alert_start", "alert_confirmed", "digest_sent", "digest_link_open"].includes(event)) return null;
  if (spec.details && detail === NONE) return null;
  if (spec.surfaces && surface === NONE) return null;

  return {
    event,
    lens,
    detail,
    geography,
    surface,
    taxonomy_version: TAXONOMY_VERSION,
  };
}

export function usageDataPoint(input) {
  const event = normalizeUsageEvent(input);
  if (!event) return null;
  return {
    // SQL: blob1 event, blob2 lens, blob3 detail, blob4 geography, blob5 surface,
    // blob6 taxonomy version; double1 count. index1 keeps sampling independent per event type.
    blobs: [event.event, event.lens, event.detail, event.geography, event.surface, event.taxonomy_version],
    doubles: [1],
    indexes: [event.event],
  };
}

export function emitUsageEvent(env, input) {
  const point = usageDataPoint(input);
  if (!point || !env?.USAGE_ANALYTICS?.writeDataPoint) return false;
  try {
    // writeDataPoint() returns void; the runtime completes the write asynchronously.
    env.USAGE_ANALYTICS.writeDataPoint(point);
    return true;
  } catch {
    // Measurement must never break the user action being measured.
    return false;
  }
}

function checkedDataset(value) {
  const dataset = String(value || DEFAULT_ANALYTICS_DATASET);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(dataset)) {
    throw new Error("Invalid Analytics Engine dataset name");
  }
  return dataset;
}

export function usageAnalyticsQuery(datasetName = DEFAULT_ANALYTICS_DATASET) {
  const dataset = checkedDataset(datasetName);
  return `SELECT
  formatDateTime(timestamp, '%Y-%m-%d', 'Etc/UTC') AS day,
  blob1 AS event,
  blob2 AS lens,
  blob3 AS detail,
  blob4 AS geography,
  blob5 AS surface,
  sum(_sample_interval * double1) AS count
FROM ${dataset}
WHERE timestamp >= NOW() - INTERVAL '${ANALYTICS_RETENTION_DAYS}' DAY
  AND blob6 = '${TAXONOMY_VERSION}'
GROUP BY day, event, lens, detail, geography, surface
ORDER BY day ASC`;
}

function dayOffset(now, daysAgo) {
  return new Date(now.getTime() - daysAgo * 86400000).toISOString().slice(0, 10);
}

function addCount(target, key, count) {
  if (!key || key === NONE) return;
  target[key] = (target[key] || 0) + count;
}

function fixedCounts(keys, observed = {}) {
  return Object.fromEntries(keys.map((key) => [key, observed[key] || 0]));
}

function blankUsage(measuredSince = null) {
  return {
    available: false,
    measured_since: measuredSince,
    retention_days: ANALYTICS_RETENTION_DAYS,
    taxonomy_version: TAXONOMY_VERSION,
    page_views: { last7d: 0, last30d: 0, by_surface_last30d: fixedCounts(SURFACES) },
    lens_interest: { last7d: fixedCounts(ANALYTICS_LENSES), last30d: fixedCounts(ANALYTICS_LENSES) },
    searches: { last7d: 0, last30d: 0, by_lens_last30d: fixedCounts(ANALYTICS_LENSES) },
    deep_links: { last7d: 0, last30d: 0, by_kind_last30d: {} },
    exports: { last7d: 0, last30d: 0, by_format_last30d: {} },
    alerts: { starts_last30d: 0, confirmed_last7d: 0, confirmed_last30d: 0 },
    geography_interest: { last30d: fixedCounts(ANALYTICS_AREAS) },
    growth: { by_day: {} },
  };
}

export function buildUsageSnapshot(rows, now = new Date(), configuredSince = null) {
  const validRows = Array.isArray(rows) ? rows : [];
  const firstObservedDay = validRows.map((row) => String(row?.day || "").slice(0, 10))
    .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort()[0] || null;
  const out = blankUsage(firstObservedDay || configuredSince || null);
  out.available = true;

  const last7 = dayOffset(now, 6);
  const last30 = dayOffset(now, 29);
  const pageBySurface = {};
  const lens7 = {}, lens30 = {}, searchesByLens = {}, deepByKind = {}, exportsByFormat = {}, geography = {};

  for (const row of validRows) {
    const day = String(row?.day || "").slice(0, 10);
    const event = String(row?.event || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !EVENT_SPECS[event]) continue;
    const count = Number(row?.count);
    if (!Number.isFinite(count) || count < 0) continue;
    const in7 = day >= last7;
    const in30 = day >= last30;
    const lens = enumValue(row.lens, ANALYTICS_LENSES);
    const detail = String(row.detail || NONE);
    const area = enumValue(row.geography, ANALYTICS_AREAS);
    const surface = enumValue(row.surface, SURFACES);

    if (event === "page_view") {
      if (in7) out.page_views.last7d += count;
      if (in30) {
        out.page_views.last30d += count;
        addCount(pageBySurface, surface, count);
      }
    }
    if (["lens_open", "search_run", "deep_link_open", "export", "alert_start"].includes(event)) {
      if (in7) addCount(lens7, lens, count);
      if (in30) addCount(lens30, lens, count);
    }
    if (event === "search_run") {
      if (in7) out.searches.last7d += count;
      if (in30) {
        out.searches.last30d += count;
        addCount(searchesByLens, lens, count);
      }
    }
    if (["deep_link_open", "digest_link_open"].includes(event)) {
      if (in7) out.deep_links.last7d += count;
      if (in30) {
        out.deep_links.last30d += count;
        addCount(deepByKind, event === "digest_link_open" ? "digest-notice" : detail, count);
      }
    }
    if (event === "export") {
      if (in7) out.exports.last7d += count;
      if (in30) {
        out.exports.last30d += count;
        addCount(exportsByFormat, detail, count);
      }
    }
    if (event === "alert_start" && in30) out.alerts.starts_last30d += count;
    if (event === "alert_confirmed") {
      if (in7) out.alerts.confirmed_last7d += count;
      if (in30) out.alerts.confirmed_last30d += count;
    }
    if (in30) addCount(geography, area, count);

    if (!out.growth.by_day[day]) out.growth.by_day[day] = { page_views: 0, interactions: 0 };
    if (event === "page_view") out.growth.by_day[day].page_views += count;
    else out.growth.by_day[day].interactions += count;
  }

  out.page_views.by_surface_last30d = fixedCounts(SURFACES, pageBySurface);
  out.lens_interest.last7d = fixedCounts(ANALYTICS_LENSES, lens7);
  out.lens_interest.last30d = fixedCounts(ANALYTICS_LENSES, lens30);
  out.searches.by_lens_last30d = fixedCounts(ANALYTICS_LENSES, searchesByLens);
  out.deep_links.by_kind_last30d = deepByKind;
  out.exports.by_format_last30d = exportsByFormat;
  out.geography_interest.last30d = fixedCounts(ANALYTICS_AREAS, geography);
  return out;
}

export async function readUsageAnalytics(env, options = {}) {
  const measuredSince = env?.ANALYTICS_MEASURED_SINCE || null;
  const unavailable = (reason) => ({ ...blankUsage(measuredSince), unavailable_reason: reason });
  if (!env?.ANALYTICS_ACCOUNT_ID || !env?.ANALYTICS_READ_TOKEN) return unavailable("not-configured");

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  try {
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.ANALYTICS_ACCOUNT_ID}/analytics_engine/sql`;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.ANALYTICS_READ_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: usageAnalyticsQuery(env.ANALYTICS_DATASET),
    });
    if (!response.ok) return unavailable(`sql-${response.status}`);
    const body = await response.json();
    return buildUsageSnapshot(body?.data, options.now || new Date(), measuredSince);
  } catch {
    return unavailable("sql-unreachable");
  }
}

export function completeLensCounts(observed = {}) {
  return fixedCounts(ANALYTICS_LENSES, observed);
}
