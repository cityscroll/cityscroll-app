// Reciprocal public navigation between /stats (how much we contain) and
// /data-health (how current/trustworthy). Consumes the committed public
// source-health artifact only — no clock evaluation and no request-time compute.

import {
  PUBLIC_SOURCE_HEALTH_SCHEMA,
  validatePublicSourceHealthProjection,
} from "./source_health_public_projection.mjs";

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

export function renderStatsToDataHealthHtml() {
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
    if (!hasDataHealthHref(text)) findings.push("missing-data-health-link");
    if (!/source freshness and coverage/i.test(text)) findings.push("missing-stats-boundary");
    if (/\/source-health/.test(text)) findings.push("request-time-source-health");
  }
  if (surface === "data-health") {
    if (!hasStatsHref(text)) findings.push("missing-stats-link");
    if (USAGE_LEAK.test(text)) findings.push("usage-stats-on-data-health");
  }
  if (surface === "nav") {
    if (!hasDataHealthHref(text) || !/data-i18n="footer_data_health"/.test(text)) {
      findings.push("missing-public-data-health-nav");
    }
  }
  return findings;
}
