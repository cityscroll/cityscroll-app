// Private, versioned RUM read model for Desk. Analytics Engine credentials and SQL stay
// behind this module's caller; the response is assembled only from bounded query output and
// deterministic registry projections.

import performanceInventory from "./data/performance-operator-labels.v1.json" with { type: "json" };
import performanceAllowlist from "./data/performance-validation-allowlist.v1.json" with { type: "json" };
import {
  PerformanceQueryError,
  normalizePerformanceQuery,
  readPerformanceAnalytics,
} from "./lib/performance_query.mjs";

export const ADMIN_PERFORMANCE_SCHEMA = "cityscroll.admin.performance.v1";
export const ADMIN_PERFORMANCE_STATES = Object.freeze([
  "available",
  "partial",
  "insufficient_sample",
  "no_data",
  "uninstrumented",
  "unclassified",
  "unavailable",
]);

const PARAMETER_TO_FILTER = Object.freeze({
  surface: "surface_id",
  component: "component_id",
  metric: "metric_id",
  device: "device_class",
  nav: "navigation_type",
  delivery: "delivery_class",
  release: "release_id",
});
const REQUEST_PARAMETERS = new Set([
  "key",
  "window",
  "compare",
  ...Object.keys(PARAMETER_TO_FILTER),
]);

function lifecycleCounts(entries) {
  const counts = {};
  for (const entry of entries) counts[entry.lifecycle_state] = (counts[entry.lifecycle_state] || 0) + 1;
  return counts;
}

function selectedEntry(entries, idKey, id) {
  if (!id) return null;
  return entries.find((entry) => entry[idKey] === id) || null;
}

function unclassifiedCount(dataHealth) {
  const rejected = dataHealth?.rejected_by_reason || {};
  return ["unknown_surface", "unknown_component"]
    .reduce((sum, reason) => sum + (Number.isSafeInteger(rejected[reason]) ? rejected[reason] : 0), 0);
}

function selectedIsUninstrumented(query) {
  const surface = selectedEntry(performanceInventory.surfaces, "surface_id", query.filters.surface_id);
  const component = selectedEntry(performanceInventory.components, "component_id", query.filters.component_id);
  const selected = [surface, component].filter(Boolean);
  if (selected.length) return selected.every((entry) => entry.lifecycle_state !== "instrumented");
  return performanceAllowlist.collector?.production_enabled !== true;
}

function responseStatus(snapshot) {
  if (snapshot.status === "unavailable") return "unavailable";
  if (snapshot.status === "retention_partial" || snapshot.data_health?.status === "partial") return "partial";
  if (snapshot.status === "insufficient_sample") return "insufficient_sample";
  if (snapshot.status === "no_data") {
    return selectedIsUninstrumented(snapshot.query) ? "uninstrumented" : "no_data";
  }
  return "available";
}

export function parseAdminPerformanceRequest(req) {
  const params = new URL(req.url).searchParams;
  for (const key of new Set(params.keys())) {
    if (!REQUEST_PARAMETERS.has(key)) throw new PerformanceQueryError(`Unsupported query parameter: ${key}`);
    if (params.getAll(key).length > 1) throw new PerformanceQueryError(`Unsupported repeated query parameter: ${key}`);
  }
  const compare = params.get("compare") || "current-vs-previous";
  if (compare !== "current-vs-previous") {
    throw new PerformanceQueryError("Unsupported performance comparison");
  }
  const filters = {};
  for (const [parameter, filter] of Object.entries(PARAMETER_TO_FILTER)) {
    if (params.has(parameter)) filters[filter] = params.get(parameter);
  }
  return normalizePerformanceQuery({
    window: params.get("window") || "7d",
    filters,
    group_by: filters.metric_id ? null : "metric_id",
  });
}

export function buildAdminPerformanceResponse(snapshot) {
  if (!snapshot?.query || !ADMIN_PERFORMANCE_STATES.includes(responseStatus(snapshot))) {
    throw new PerformanceQueryError("Invalid performance snapshot");
  }
  const surface = selectedEntry(
    performanceInventory.surfaces,
    "surface_id",
    snapshot.query.filters.surface_id,
  );
  const component = selectedEntry(
    performanceInventory.components,
    "component_id",
    snapshot.query.filters.component_id,
  );
  const unknownCount = unclassifiedCount(snapshot.data_health);
  return {
    schema: ADMIN_PERFORMANCE_SCHEMA,
    generated_at: snapshot.freshness?.queried_at || null,
    status: responseStatus(snapshot),
    query: {
      window: snapshot.query.window,
      filters: snapshot.query.filters,
      result_dimension: snapshot.query.group_by,
      comparison: "current-vs-previous",
    },
    catalog: {
      schema: performanceInventory.schema,
      manifest_version: performanceInventory.manifest_version,
      registry_version: performanceInventory.registry_version,
      registry_hash: performanceInventory.registry_hash,
      metrics: performanceAllowlist.metrics,
      surfaces: performanceInventory.surfaces,
      components: performanceInventory.components,
    },
    coverage: {
      status: selectedIsUninstrumented(snapshot.query) ? "uninstrumented" : "available",
      registered: {
        surface_count: performanceInventory.surfaces.length,
        component_count: performanceInventory.components.length,
        surfaces_by_state: lifecycleCounts(performanceInventory.surfaces),
        components_by_state: lifecycleCounts(performanceInventory.components),
      },
      selection: { surface, component },
      unclassified_observations: {
        status: "unclassified",
        count: unknownCount,
        source: "bounded intake rejection counters",
      },
    },
    sample_floor: snapshot.sample_floor,
    sampling: snapshot.sampling,
    retention: snapshot.retention,
    series: snapshot.series,
    freshness: snapshot.freshness,
    data_health: snapshot.data_health,
    ...(snapshot.unavailable_reason ? { unavailable_reason: snapshot.unavailable_reason } : {}),
  };
}

export async function readAdminPerformance(env, req, options = {}) {
  const query = parseAdminPerformanceRequest(req);
  const readPerformance = options.readPerformance || readPerformanceAnalytics;
  const snapshot = await readPerformance(env, query, options);
  return buildAdminPerformanceResponse(snapshot);
}
