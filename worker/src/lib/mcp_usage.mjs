// MCP usage collection against the existing USAGE_ANALYTICS binding.
//
// Producer and reader for cityscroll.mcp_usage_observation.v1. Browser usage events share
// the same Analytics Engine dataset but a different taxonomy_version allowlist, so these
// rows never enter Site totals. Measurement failures never reject the MCP response.

import { hasValidDeveloperExclusion, ANALYTICS_DEV_HEADER } from "../events.mjs";
import { DEFAULT_ANALYTICS_DATASET } from "./analytics.mjs";
import {
  MCP_USAGE_COVERAGE_GAPS,
  MCP_USAGE_OBSERVATION_CLASSES,
  MCP_USAGE_OBSERVATION_SCHEMA,
  MCP_USAGE_OUTCOMES,
  MCP_USAGE_RETENTION_DAYS,
  MCP_USAGE_TAXONOMY_VERSION,
  mcpUsageDataPoint,
  mcpUsageObservation,
  registeredMcpToolNames,
} from "../../../capabilities/mcp_usage_observation.mjs";

export const MCP_USAGE_MEASURED_SINCE_DEFAULT = "2026-09-16";
export const MCP_USAGE_INGEST_VAR = "MCP_USAGE_INGEST_ENABLED";
export const MCP_USAGE_OBSERVATION_CLASS_HEADER = "X-CityScroll-MCP-Observation-Class";
export const MCP_USAGE_OBSERVATION_CLASS_QUERY = "observation_class";

const MARKED_OBSERVATION_CLASSES = Object.freeze(["canary", "probe"]);

function checkedDataset(value) {
  const dataset = String(value || DEFAULT_ANALYTICS_DATASET);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(dataset)) {
    throw new Error("Invalid Analytics Engine dataset name");
  }
  return dataset;
}

/**
 * Collection kill switch. Explicit "false" disables writes. Missing/other values leave
 * collection enabled whenever the USAGE_ANALYTICS binding is present.
 */
export function mcpUsageIngestEnabled(env) {
  return env?.[MCP_USAGE_INGEST_VAR] !== "false";
}

export function mcpUsageCollectionStatus(env) {
  if (!env?.USAGE_ANALYTICS || typeof env.USAGE_ANALYTICS.writeDataPoint !== "function") {
    return {
      status: "unconfigured",
      writable: false,
      reason: "usage_analytics_binding_missing",
      note: "Missing binding is unconfigured/unavailable, never reported as zero traffic.",
    };
  }
  if (!mcpUsageIngestEnabled(env)) {
    return {
      status: "disabled",
      writable: false,
      reason: "kill_switch",
      note: "MCP_USAGE_INGEST_ENABLED=false stopped collection.",
    };
  }
  if (env?.ANALYTICS_ENVIRONMENT && env.ANALYTICS_ENVIRONMENT !== "production") {
    return {
      status: "non_production",
      writable: true,
      reason: "analytics_environment_not_production",
      note: "Writes may proceed as developer-class observations; they do not enter production product totals.",
    };
  }
  return {
    status: "configured",
    writable: true,
    reason: null,
    note: "Observations write to USAGE_ANALYTICS under the MCP taxonomy version.",
  };
}

/**
 * Resolve observation class from trusted exclusion mechanisms only.
 * - Valid developer-exclusion HMAC → developer
 * - Non-production ANALYTICS_ENVIRONMENT → developer
 * - Explicit canary/probe marking via header or query → canary|probe
 * - Everything else → production
 *
 * A client cannot stamp developer without the shared secret. Marked canary/probe labels
 * are the same operator-marking pattern RUM uses; they are excluded from production
 * product totals and never become verified external adoption on their own.
 */
export async function resolveMcpObservationClass(req, env, nowMs = Date.now()) {
  if (env?.ANALYTICS_ENVIRONMENT && env.ANALYTICS_ENVIRONMENT !== "production") {
    return "developer";
  }
  try {
    if (await hasValidDeveloperExclusion(req, env, nowMs)) return "developer";
  } catch {
    // Exclusion failures count as production; never throw into the request path.
  }

  let declared = "";
  try {
    declared = String(req.headers.get(MCP_USAGE_OBSERVATION_CLASS_HEADER) || "").trim().toLowerCase();
  } catch {
    declared = "";
  }
  if (!MARKED_OBSERVATION_CLASSES.includes(declared)) {
    try {
      declared = String(new URL(req.url).searchParams.get(MCP_USAGE_OBSERVATION_CLASS_QUERY) || "")
        .trim()
        .toLowerCase();
    } catch {
      declared = "";
    }
  }
  if (MARKED_OBSERVATION_CLASSES.includes(declared)) return declared;
  return "production";
}

export function deploymentIdentityFromEnv(env) {
  const sha = String(env?.GIT_COMMIT_SHA || "").trim().toLowerCase();
  return /^[a-f0-9]{40}$/.test(sha) ? sha : "unknown";
}

/**
 * Emit one observation. Never throws to the caller; never changes MCP results.
 * Returns a small status object for tests and collection-failure visibility.
 */
export function emitMcpUsageObservation(env, input) {
  const collection = mcpUsageCollectionStatus(env);
  if (!collection.writable) {
    return { ok: false, status: collection.status, reason: collection.reason };
  }
  const observation = input?.schema === MCP_USAGE_OBSERVATION_SCHEMA
    ? input
    : mcpUsageObservation(input);
  const point = mcpUsageDataPoint(observation);
  try {
    env.USAGE_ANALYTICS.writeDataPoint(point);
    return { ok: true, status: collection.status, observation };
  } catch {
    return { ok: false, status: "write_failed", reason: "writeDataPoint_threw" };
  }
}

/**
 * Fire-and-forget helper for the MCP handler. Swallows rejections so a broken sink
 * cannot create a floating rejected promise on the request path.
 */
export function scheduleMcpUsageObservation(env, input, waiter) {
  let result;
  try {
    result = emitMcpUsageObservation(env, input);
  } catch {
    result = { ok: false, status: "write_failed", reason: "emit_threw" };
  }
  if (waiter && typeof waiter === "function") {
    try { waiter(result); } catch { /* ignore test-hook failures */ }
  }
  return result;
}

function dayOffset(now, daysAgo) {
  return new Date(now.getTime() - daysAgo * 86400000).toISOString().slice(0, 10);
}

function addCount(target, key, count) {
  if (!key) return;
  target[key] = (target[key] || 0) + count;
}

function fixedCounts(keys, observed = {}) {
  return Object.fromEntries(keys.map((key) => [key, observed[key] || 0]));
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

function summarizeLatency(samples) {
  const values = (samples || []).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (!values.length) {
    return { samples: 0, min_ms: null, max_ms: null, avg_ms: null, p50_ms: null, p95_ms: null };
  }
  const sum = values.reduce((acc, n) => acc + n, 0);
  return {
    samples: values.length,
    min_ms: values[0],
    max_ms: values[values.length - 1],
    avg_ms: Math.round(sum / values.length),
    p50_ms: percentile(values, 50),
    p95_ms: percentile(values, 95),
  };
}

function blankMcpUsage(measuredSince = null) {
  const tools = registeredMcpToolNames();
  return {
    schema: "cityscroll.mcp_usage_stats.v1",
    available: false,
    collection: {
      status: "unconfigured",
      reason: "not-read",
      ingest_enabled: true,
      binding: "USAGE_ANALYTICS",
      taxonomy_version: MCP_USAGE_TAXONOMY_VERSION,
      observation_schema: MCP_USAGE_OBSERVATION_SCHEMA,
    },
    measured_since: measuredSince,
    retention_days: MCP_USAGE_RETENTION_DAYS,
    observation_window_days: 30,
    last_observation_at: null,
    sample_semantics: {
      note: "Each Analytics Engine row is one MCP dispatch/request outcome, expanded by its sample interval. Calls, connections, results, and unique people are distinct units; this surface never invents a unique-user count.",
      units: {
        calls: "One tools/call observation.",
        connections: "One initialize / tools/list / ping / refusal observation; not a session.",
        results: "Bounded result_count on a tool observation when the tool returned a list.",
        unique_people: "Not measured. Stateless HTTP does not invent cross-request identity.",
      },
      coverage_gaps: [...MCP_USAGE_COVERAGE_GAPS],
    },
    production: blankClassSlice(tools),
    by_observation_class: Object.fromEntries(
      MCP_USAGE_OBSERVATION_CLASSES.map((cls) => [cls, blankClassSlice(tools)]),
    ),
  };
}

function blankClassSlice(tools) {
  return {
    requests_last7d: 0,
    requests_last30d: 0,
    tool_calls_last7d: 0,
    tool_calls_last30d: 0,
    by_day_last30d: {},
    by_tool_last30d: fixedCounts([...tools, "unknown", "none"]),
    by_outcome_last30d: fixedCounts(MCP_USAGE_OUTCOMES),
    by_method_last30d: {},
    latency: summarizeLatency([]),
  };
}

function isProductionClass(observationClass) {
  return observationClass === "production";
}

/**
 * Fold SQL rows into the private statistics MCP slice.
 * Rows are expected as:
 *   day, method, tool, outcome, observation_class, deployment_identity,
 *   count, duration_total_ms, duration_samples, result_count_total, last_timestamp
 */
export function buildMcpUsageSnapshot(rows, options = {}) {
  const now = options.now || new Date();
  const measuredSince = options.measuredSince || null;
  const collection = options.collection || blankMcpUsage().collection;
  const out = blankMcpUsage(measuredSince);
  out.collection = { ...out.collection, ...collection };
  out.available = true;

  const last7 = dayOffset(now, 6);
  const last30 = dayOffset(now, 29);
  const tools = registeredMcpToolNames();
  const latencyByClass = Object.fromEntries(MCP_USAGE_OBSERVATION_CLASSES.map((cls) => [cls, []]));
  let lastObservation = null;

  for (const row of Array.isArray(rows) ? rows : []) {
    const day = String(row?.day || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const count = Number(row?.count);
    if (!Number.isFinite(count) || count < 0) continue;
    const method = String(row?.method || "");
    const tool = String(row?.tool || "none");
    const outcome = String(row?.outcome || "internal");
    const observationClass = MCP_USAGE_OBSERVATION_CLASSES.includes(row?.observation_class)
      ? row.observation_class
      : "production";
    const in7 = day >= last7;
    const in30 = day >= last30;
    const durationTotal = Number(row?.duration_total_ms);
    const durationSamples = Number(row?.duration_samples);
    const stamp = row?.last_timestamp ? String(row.last_timestamp) : null;
    if (stamp && (!lastObservation || stamp > lastObservation)) lastObservation = stamp;

    const apply = (slice) => {
      if (in7) {
        slice.requests_last7d += count;
        if (method === "tools/call") slice.tool_calls_last7d += count;
      }
      if (in30) {
        slice.requests_last30d += count;
        if (method === "tools/call") slice.tool_calls_last30d += count;
        addCount(slice.by_day_last30d, day, count);
        addCount(slice.by_tool_last30d, tool, count);
        addCount(slice.by_outcome_last30d, outcome, count);
        addCount(slice.by_method_last30d, method, count);
      }
    };

    apply(out.by_observation_class[observationClass]);
    if (isProductionClass(observationClass)) apply(out.production);

    if (Number.isFinite(durationTotal) && Number.isFinite(durationSamples) && durationSamples > 0) {
      // Approximate retained latency with the row average so the desk can show a summary
      // without storing every individual duration.
      const avg = durationTotal / durationSamples;
      for (let i = 0; i < Math.min(durationSamples, 64); i += 1) {
        latencyByClass[observationClass].push(avg);
      }
    }
  }

  for (const cls of MCP_USAGE_OBSERVATION_CLASSES) {
    const slice = out.by_observation_class[cls];
    slice.by_tool_last30d = fixedCounts([...tools, "unknown", "none"], slice.by_tool_last30d);
    slice.by_outcome_last30d = fixedCounts(MCP_USAGE_OUTCOMES, slice.by_outcome_last30d);
    slice.latency = summarizeLatency(latencyByClass[cls]);
  }
  out.production.by_tool_last30d = fixedCounts([...tools, "unknown", "none"], out.production.by_tool_last30d);
  out.production.by_outcome_last30d = fixedCounts(MCP_USAGE_OUTCOMES, out.production.by_outcome_last30d);
  out.production.latency = summarizeLatency(latencyByClass.production);
  out.last_observation_at = lastObservation;
  out.measured_since = measuredSince || (lastObservation ? String(lastObservation).slice(0, 10) : null);
  return out;
}

export function mcpUsageAnalyticsQuery(datasetName = DEFAULT_ANALYTICS_DATASET) {
  const dataset = checkedDataset(datasetName);
  return `SELECT
  formatDateTime(timestamp, '%Y-%m-%d', 'Etc/UTC') AS day,
  blob2 AS method,
  blob3 AS tool,
  blob4 AS outcome,
  blob5 AS observation_class,
  blob7 AS deployment_identity,
  sum(_sample_interval * double1) AS count,
  sum(_sample_interval * double2) AS duration_total_ms,
  sum(_sample_interval) AS duration_samples,
  sum(_sample_interval * double3) AS result_count_total,
  max(timestamp) AS last_timestamp
FROM ${dataset}
WHERE timestamp >= NOW() - INTERVAL '${MCP_USAGE_RETENTION_DAYS}' DAY
  AND blob1 = '${MCP_USAGE_OBSERVATION_SCHEMA}'
  AND blob6 = '${MCP_USAGE_TAXONOMY_VERSION}'
GROUP BY day, method, tool, outcome, observation_class, deployment_identity
ORDER BY day ASC`;
}

export async function readMcpUsageAnalytics(env, options = {}) {
  const measuredSince = env?.MCP_USAGE_MEASURED_SINCE || env?.ANALYTICS_MEASURED_SINCE || MCP_USAGE_MEASURED_SINCE_DEFAULT;
  const collection = mcpUsageCollectionStatus(env);
  const unavailable = (reason) => {
    const blank = blankMcpUsage(measuredSince);
    blank.collection = {
      ...blank.collection,
      ...collection,
      status: collection.status === "configured" ? "unavailable" : collection.status,
      reason,
    };
    blank.unavailable_reason = reason;
    return blank;
  };

  if (collection.status === "unconfigured") return unavailable("not-configured");
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
      body: mcpUsageAnalyticsQuery(env.ANALYTICS_DATASET),
    });
    if (!response.ok) return unavailable(`sql-${response.status}`);
    const body = await response.json();
    return buildMcpUsageSnapshot(body?.data, {
      now: options.now || new Date(),
      measuredSince,
      collection: {
        ...collection,
        status: collection.status === "configured" ? "ok" : collection.status,
        reason: null,
        read_ok: true,
      },
    });
  } catch {
    return unavailable("sql-unreachable");
  }
}

export {
  ANALYTICS_DEV_HEADER,
  MCP_USAGE_OBSERVATION_SCHEMA,
  MCP_USAGE_TAXONOMY_VERSION,
  mcpUsageObservation,
};
