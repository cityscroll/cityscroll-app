// Reciprocal public navigation between /stats (how much we contain) and
// /data-health (how current/trustworthy). Consumes the committed public
// source-health artifact only — no clock evaluation and no request-time compute.

import {
  PUBLIC_SOURCE_HEALTH_SCHEMA,
  validatePublicSourceHealthProjection,
} from "./source_health_public_projection.mjs";

// Visibility gate, not a deletion. Keep the generator, lookup, and page.
// Re-expose only after every served source on the page shows real clocks
// (no UNKNOWN / Source-unavailable wall). Flip this one constant to true;
// nav helpers, sitemap tests, and the public route all read it.
export const DATA_HEALTH_PUBLIC = false;

export const DATA_HEALTH_PATH = "/data-health/";
export const STATS_PATH = "/stats.html";

export const STATS_TO_DATA_HEALTH_HTML =
  'For source freshness and coverage, see <a href="data-health/">Data health</a>.';
export const DATA_HEALTH_TO_STATS_HTML =
  'For corpus size and date range, see <a href="/stats.html">Stats</a>.';

const USAGE_LEAK = /\b(?:subscriptions|digests|nl_search|pageviews|watches_active|usage_analytics)\b/;
const DISCLAIMER_SLOP = /all operational|all systems operational|data may be incomplete|may be incomplete/i;
const DEBUG_LEAK = /join_coverage|snapshot_sha|contract_fingerprint|auth_token|runbook|reason_codes|source_id=/;

export function navigationFromPublicSourceHealth(projection) {
  const errors = Array.isArray(projection)
    ? ["projection must be an object"]
    : validatePublicSourceHealthProjection(projection);
  if (errors.length) {
    return {
      schema: PUBLIC_SOURCE_HEALTH_SCHEMA,
      available: false,
      generated_at: null,
      source_count: null,
      data_health_href: DATA_HEALTH_PATH,
      stats_href: STATS_PATH,
    };
  }
  return {
    schema: projection.schema,
    available: true,
    generated_at: projection.generated_at,
    source_count: projection.source_count,
    data_health_href: DATA_HEALTH_PATH,
    stats_href: STATS_PATH,
  };
}

export function isDataHealthPath(pathname) {
  return /^\/data-health(?:\/index\.html)?\/?$/.test(String(pathname || ""));
}

export function renderDataHealthUnavailableDocument() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not available · CityScroll</title>
</head>
<body>
<main id="main" tabindex="-1">
  <h1>This page is not available</h1>
  <p><a href="/">CityScroll home</a></p>
</main>
</body>
</html>`;
}

export function renderStatsToDataHealthHtml() {
  if (!DATA_HEALTH_PUBLIC) return "";
  return `<p class="stats-data-health-crosslink">${STATS_TO_DATA_HEALTH_HTML}</p>`;
}

export function renderDataHealthToStatsHtml() {
  return `<p class="data-health-crosslink">${DATA_HEALTH_TO_STATS_HTML}</p>`;
}

function hasDataHealthHref(html) {
  return /href="(?:\/)?data-health\/"/.test(html);
}

function hasStatsHref(html) {
  return /href="(?:\/)?stats\.html"/.test(html);
}

export function dataHealthNavigationFindings(html, surface) {
  const text = String(html || "");
  const findings = [];
  if (DISCLAIMER_SLOP.test(text)) findings.push("disclaimer-slop");
  if (DEBUG_LEAK.test(text)) findings.push("debug-internals");
  if (surface === "stats") {
    if (DATA_HEALTH_PUBLIC) {
      if (!hasDataHealthHref(text)) findings.push("missing-data-health-link");
      if (!/source freshness and coverage/i.test(text)) findings.push("missing-stats-boundary");
    } else if (hasDataHealthHref(text)) {
      findings.push("gated-data-health-link");
    }
    if (/\/source-health/.test(text)) findings.push("request-time-source-health");
  }
  if (surface === "data-health") {
    if (!hasStatsHref(text)) findings.push("missing-stats-link");
    if (USAGE_LEAK.test(text)) findings.push("usage-stats-on-data-health");
  }
  if (surface === "nav") {
    if (DATA_HEALTH_PUBLIC) {
      if (!hasDataHealthHref(text) || !/data-i18n="footer_data_health"/.test(text)) {
        findings.push("missing-public-data-health-nav");
      }
    } else if (hasDataHealthHref(text) || /data-i18n="footer_data_health"/.test(text)) {
      findings.push("gated-data-health-link");
    }
  }
  if (surface === "sitemap") {
    const listed = /https:\/\/cityscroll\.org\/data-health\//.test(text);
    if (DATA_HEALTH_PUBLIC && !listed) findings.push("missing-data-health-sitemap");
    if (!DATA_HEALTH_PUBLIC && listed) findings.push("gated-data-health-link");
  }
  return findings;
}
