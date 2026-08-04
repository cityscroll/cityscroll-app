// First-party, aggregate usage analytics.
//
// One Analytics Engine point represents one allowed event. The schema intentionally has no
// visitor, request, IP, user-agent, query-text, entity-name, or notice-id field. All dimensions
// are small enumerations from docs/analytics-event-taxonomy.md.
//
// traffic_class (blob7): production | developer. Public /stats SQL keeps production only so
// operator probes and valid developer-exclusion tokens do not inflate Site totals. See
// worker/src/lib/ops_contract.mjs and docs/analytics-event-taxonomy.md.

import { normalizeUsageTrafficClass } from "./ops_contract.mjs";

export const TAXONOMY_VERSION = "1.2.0";
export const COMPATIBLE_TAXONOMY_VERSIONS = Object.freeze(["1.0.0", "1.1.0", TAXONOMY_VERSION]);
export const DEFAULT_ANALYTICS_DATASET = "crol_usage_events_v1";
export const ANALYTICS_RETENTION_DAYS = 90;
export { normalizeUsageTrafficClass };

export const ANALYTICS_LENSES = Object.freeze([
  "money", "people", "land", "property", "rules", "meetings", "alerts",
]);

export const ANALYTICS_AREAS = Object.freeze([
  "manhattan", "brooklyn", "queens", "bronx", "staten-island",
]);

export const ANALYTICS_SCENARIOS = Object.freeze([
  "city-work", "neighborhood", "hearings", "city-career",
  "subsidies-land-use", "legal-compliance",
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
  scenario_open: {
    lenses: ANALYTICS_LENSES,
    details: ANALYTICS_SCENARIOS,
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
  action_opened: {
    details: ["direct", "official-handoff"],
    surfaces: ["home"],
  },
  outcome_prompted: {
    details: ["official-handoff", "passed-action"],
    surfaces: ["home"],
  },
  outcome_dismissed: {
    details: ["official-handoff", "passed-action"],
    surfaces: ["home"],
  },
  outcome_recorded: {
    details: ["submitted", "attended", "bid", "won", "not-useful"],
    surfaces: ["home"],
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

  const traffic_class = normalizeUsageTrafficClass(input.traffic_class);

  return {
    event,
    lens,
    detail,
    geography,
    surface,
    traffic_class,
    taxonomy_version: TAXONOMY_VERSION,
  };
}

export function usageDataPoint(input) {
  const event = normalizeUsageEvent(input);
  if (!event) return null;
  return {
    // SQL: blob1 event, blob2 lens, blob3 detail, blob4 geography, blob5 surface,
    // blob6 taxonomy version, blob7 traffic_class; double1 count.
    // index1 keeps sampling independent per event type.
    blobs: [
      event.event,
      event.lens,
      event.detail,
      event.geography,
      event.surface,
      event.taxonomy_version,
      event.traffic_class,
    ],
    doubles: [1],
    indexes: [event.event],
  };
}

/**
 * Whether this event should write to the production Analytics Engine dataset and
 * dual-write durable production counters. Missing traffic_class defaults to production
 * (pre-traffic_class callers and ordinary site events). Only explicit developer is excluded.
 */
export function isProductionUsageTraffic(eventOrClass) {
  if (eventOrClass == null) return true;
  if (typeof eventOrClass === "string") {
    return normalizeUsageTrafficClass(eventOrClass) === "production";
  }
  if (typeof eventOrClass === "object") {
    return normalizeUsageTrafficClass(eventOrClass.traffic_class) === "production";
  }
  return true;
}

export function emitUsageEvent(env, input) {
  const point = usageDataPoint(input);
  // Production is an explicit runtime binding. Missing or non-production bindings fail closed,
  // so wrangler dev, preview deployments, and unit-test mocks cannot pollute public counts.
  // Developer traffic_class is also excluded so probes never inflate public metrics.
  if (
    env?.ANALYTICS_ENVIRONMENT !== "production"
    || !point
    || !isProductionUsageTraffic(input?.traffic_class)
    || !env?.USAGE_ANALYTICS?.writeDataPoint
  ) return false;
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
  const versions = COMPATIBLE_TAXONOMY_VERSIONS.map((version) => `'${version}'`).join(", ");
  // blob7 traffic_class: include rows with missing/empty blob7 (pre-traffic_class era) and
  // explicit production. Exclude developer so desk and /stats share one production cut.
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
  AND blob6 IN (${versions})
  AND (blob7 IS NULL OR blob7 = '' OR blob7 = 'production')
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
    scenario_interest: { last7d: fixedCounts(ANALYTICS_SCENARIOS), last30d: fixedCounts(ANALYTICS_SCENARIOS) },
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
  const lens7 = {}, lens30 = {}, scenario7 = {}, scenario30 = {}, searchesByLens = {}, deepByKind = {}, exportsByFormat = {}, geography = {};

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
    if (event === "scenario_open") {
      if (in7) addCount(scenario7, detail, count);
      if (in30) addCount(scenario30, detail, count);
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
  out.scenario_interest.last7d = fixedCounts(ANALYTICS_SCENARIOS, scenario7);
  out.scenario_interest.last30d = fixedCounts(ANALYTICS_SCENARIOS, scenario30);
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

/**
 * Reconcile usage totals with the durable Worker stores (ALERT_STATE / NL_METER).
 *
 * Field case (domain migration 2026-07-29/30): Analytics Engine SQL was not-configured and
 * the AE dataset itself held zero rows, so the "Site totals" panel looked reset. Outcome
 * counters (searches, digest-link clicks, shares, feeds, batch checks) continued to live
 * in the pre-flip KV namespaces. Prefer the max of AE vs durable so history never restarts
 * at zero when the continuous store still has counts.
 *
 * @param {object} usage — result of readUsageAnalytics / blankUsage
 * @param {object} durable — pre-loaded window totals from the same KV IDs as /stats
 */
export function reconcileUsageWithDurableStores(usage, durable = {}, options = {}) {
  const measuredSince = options.measuredSince || usage?.measured_since || null;
  const out = usage && typeof usage === "object"
    ? JSON.parse(JSON.stringify(usage))
    : blankUsage(measuredSince);

  const page7 = Number(durable.pageViewsLast7d) || 0;
  const page30 = Number(durable.pageViewsLast30d) || 0;
  const pageBySurface = durable.pageViewsBySurfaceLast30d || {};
  const searches7 = Number(durable.searchesLast7d) || 0;
  const searches30 = Number(durable.searchesLast30d) || 0;
  const searchesByLens = durable.searchesByLensLast30d || {};
  const deep7 = Number(durable.deepLinksLast7d) || 0;
  const deep30 = Number(durable.deepLinksLast30d) || 0;
  const shares7 = Number(durable.sharesLast7d) || 0;
  const shares30 = Number(durable.sharesLast30d) || 0;
  const alertsConfirmed7 = Number(durable.alertsConfirmedLast7d) || 0;
  const alertsConfirmed30 = Number(durable.alertsConfirmedLast30d) || 0;
  const growthDays = durable.growthByDay || {};

  const takeMax = (a, b) => Math.max(Number(a) || 0, Number(b) || 0);

  out.page_views = out.page_views || { last7d: 0, last30d: 0, by_surface_last30d: fixedCounts(SURFACES) };
  out.page_views.last7d = takeMax(out.page_views.last7d, page7);
  out.page_views.last30d = takeMax(out.page_views.last30d, page30);
  out.page_views.by_surface_last30d = fixedCounts(SURFACES, {
    ...out.page_views.by_surface_last30d,
    ...Object.fromEntries(
      SURFACES.map((s) => [s, takeMax(out.page_views.by_surface_last30d?.[s], pageBySurface[s])]),
    ),
  });

  out.searches = out.searches || { last7d: 0, last30d: 0, by_lens_last30d: fixedCounts(ANALYTICS_LENSES) };
  out.searches.last7d = takeMax(out.searches.last7d, searches7);
  out.searches.last30d = takeMax(out.searches.last30d, searches30);
  out.searches.by_lens_last30d = fixedCounts(ANALYTICS_LENSES, {
    ...out.searches.by_lens_last30d,
    ...Object.fromEntries(
      ANALYTICS_LENSES.map((lens) => [
        lens,
        takeMax(out.searches.by_lens_last30d?.[lens], searchesByLens[lens]),
      ]),
    ),
  });

  // Digest-link clicks and investigation shares are the continuous pre-flip proxies for
  // deep-link interest when AE never retained events.
  out.deep_links = out.deep_links || { last7d: 0, last30d: 0, by_kind_last30d: {} };
  const deep7Merged = takeMax(out.deep_links.last7d, deep7 + shares7);
  const deep30Merged = takeMax(out.deep_links.last30d, deep30 + shares30);
  out.deep_links.last7d = deep7Merged;
  out.deep_links.last30d = deep30Merged;
  if (deep30 || shares30) {
    out.deep_links.by_kind_last30d = {
      ...out.deep_links.by_kind_last30d,
      "digest-notice": takeMax(out.deep_links.by_kind_last30d?.["digest-notice"], deep30),
      investigation: takeMax(out.deep_links.by_kind_last30d?.investigation, shares30),
    };
  }

  out.alerts = out.alerts || { starts_last30d: 0, confirmed_last7d: 0, confirmed_last30d: 0 };
  out.alerts.confirmed_last7d = takeMax(out.alerts.confirmed_last7d, alertsConfirmed7);
  out.alerts.confirmed_last30d = takeMax(out.alerts.confirmed_last30d, alertsConfirmed30);

  out.lens_interest = out.lens_interest || {
    last7d: fixedCounts(ANALYTICS_LENSES),
    last30d: fixedCounts(ANALYTICS_LENSES),
  };
  // Searches-by-lens are the continuous pre-flip signal for section interest.
  out.lens_interest.last7d = fixedCounts(ANALYTICS_LENSES, {
    ...out.lens_interest.last7d,
    ...Object.fromEntries(
      ANALYTICS_LENSES.map((lens) => [
        lens,
        takeMax(out.lens_interest.last7d?.[lens], durable.searchesByLensLast7d?.[lens]),
      ]),
    ),
  });
  out.lens_interest.last30d = fixedCounts(ANALYTICS_LENSES, {
    ...out.lens_interest.last30d,
    ...Object.fromEntries(
      ANALYTICS_LENSES.map((lens) => [
        lens,
        takeMax(out.lens_interest.last30d?.[lens], searchesByLens[lens]),
      ]),
    ),
  });

  out.growth = out.growth || { by_day: {} };
  out.growth.by_day = { ...out.growth.by_day };
  for (const [day, counts] of Object.entries(growthDays)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const prev = out.growth.by_day[day] || { page_views: 0, interactions: 0 };
    out.growth.by_day[day] = {
      page_views: takeMax(prev.page_views, counts.page_views),
      interactions: takeMax(prev.interactions, counts.interactions),
    };
  }

  const hasDurable = Boolean(
    page7 || page30 || searches7 || searches30 || deep7 || deep30 || shares7 || shares30
    || alertsConfirmed7 || alertsConfirmed30
    || Object.keys(growthDays).length
    || Object.values(searchesByLens).some((n) => n > 0),
  );
  if (hasDurable) {
    out.available = true;
    delete out.unavailable_reason;
    if (!out.measured_since) out.measured_since = measuredSince;
  }
  return out;
}

export function completeLensCounts(observed = {}) {
  return fixedCounts(ANALYTICS_LENSES, observed);
}
