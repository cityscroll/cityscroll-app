import { classifyPerformancePathname } from "./performance_route_classifier.mjs";

export { classifyPerformancePathname };

const WEB_VITAL_NAMES = Object.freeze({
  CLS: "cls_score",
  FCP: "fcp_ms",
  INP: "inp_ms",
  LCP: "lcp_ms",
  TTFB: "ttfb_ms",
});

const NAVIGATION_TYPE_ALIASES = Object.freeze({
  back_forward: "back-forward",
  back_forward_cache: "back-forward-cache",
  bfcache: "back-forward-cache",
});

function copy(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function safeRecord(sink, record) {
  try {
    const result = sink?.record?.(record);
    if (result && typeof result.catch === "function") void result.catch(() => {});
  } catch {
    // A debug sink is observational. Its failure can never affect the page.
  }
}

function validManifest(manifest) {
  return Boolean(
    manifest
    && manifest.schema === "cityscroll.performance.browser_manifest.v1"
    && typeof manifest.manifest_version === "string"
    && typeof manifest.collector?.production_enabled === "boolean"
    && Array.isArray(manifest.collector?.field_metric_ids)
    && Array.isArray(manifest.metrics)
    && Array.isArray(manifest.surfaces),
  );
}

function metricCatalog(manifest) {
  return new Map((manifest.metrics || []).map((metric) => [metric.metric_id, metric]));
}

function navigationType(metric, runtime, allowed) {
  let candidate = metric?.navigationType;
  if (!candidate) {
    try {
      candidate = runtime?.performance?.getEntriesByType?.("navigation")?.[0]?.type;
    } catch {
      candidate = null;
    }
  }
  const normalized = NAVIGATION_TYPE_ALIASES[candidate] || candidate;
  return allowed.has(normalized) ? normalized : "unknown";
}

export function coarseDeviceClass(runtime, allowedClasses = ["desktop", "mobile", "tablet", "unknown"]) {
  const allowed = new Set(allowedClasses);
  try {
    if (runtime?.matchMedia?.("(max-width: 599px)")?.matches) return allowed.has("mobile") ? "mobile" : "unknown";
    if (runtime?.matchMedia?.("(max-width: 1023px)")?.matches) return allowed.has("tablet") ? "tablet" : "unknown";
    return allowed.has("desktop") ? "desktop" : "unknown";
  } catch {
    return "unknown";
  }
}

export function createLocalRumDebugSink() {
  const records = [];
  return Object.freeze({
    record(value) {
      records.push(copy(value));
    },
    snapshot() {
      return copy(records);
    },
  });
}

function classificationRecord(classification, manifest) {
  return {
    record_type: "classification",
    schema: "cityscroll.performance.debug_classification.v1",
    classification_state: classification.classification_state,
    surface_id: classification.surface_id,
    route_family: classification.route_family,
    delivery_class: classification.delivery_class,
    manifest_version: manifest.manifest_version,
    collector_version: manifest.collector.collector_version,
  };
}

/**
 * Register the five lifecycle-aware web-vitals callbacks for a local test run.
 *
 * There is intentionally no network transport in this module. Callers must
 * present the explicit test-only capability and an in-memory sink. The
 * standard web-vitals library owns lifecycle finalization; an absent callback
 * is absence, never a fabricated numeric observation.
 */
export async function startBrowserRumCollector({
  testOnly = false,
  production = false,
  manifest,
  pathname,
  runtime = globalThis,
  sink,
  webVitals,
} = {}) {
  if (testOnly !== true && production !== true) return { state: "disabled" };
  if (production === true && manifest?.collector?.production_enabled !== true) {
    return { state: "disabled" };
  }
  if (!validManifest(manifest)) {
    safeRecord(sink, {
      record_type: "classification",
      schema: "cityscroll.performance.debug_classification.v1",
      classification_state: "manifest_unavailable",
      surface_id: null,
      route_family: null,
      delivery_class: null,
      manifest_version: null,
      collector_version: null,
    });
    return { state: "manifest_unavailable" };
  }

  const classification = classifyPerformancePathname(
    manifest,
    pathname ?? runtime?.location?.pathname ?? "",
  );
  safeRecord(sink, classificationRecord(classification, manifest));
  if (!classification.surface_id || classification.classification_state === "retired") {
    return { state: classification.classification_state, classification };
  }

  const configuredMetricIds = new Set(manifest.collector.field_metric_ids);
  const applicableMetricIds = new Set(
    manifest.surfaces.find((surface) => surface.surface_id === classification.surface_id)
      ?.applicable_metric_ids || [],
  );
  const metrics = metricCatalog(manifest);
  const allowedNavigationTypes = new Set(manifest.collector.navigation_types || []);
  const deviceClass = coarseDeviceClass(runtime, manifest.collector.device_classes);
  const reported = new Set();

  for (const [webVitalName, metricId] of Object.entries(WEB_VITAL_NAMES)) {
    if (!configuredMetricIds.has(metricId) || !applicableMetricIds.has(metricId)) continue;
    const catalogEntry = metrics.get(metricId);
    const register = webVitals?.[`on${webVitalName}`];
    if (!catalogEntry || typeof register !== "function") continue;
    try {
      register((metric) => {
        const value = metric?.value;
        if (!Number.isFinite(value) || value < 0) return;
        const navType = navigationType(metric, runtime, allowedNavigationTypes);
        const privateLifecycleId = typeof metric?.id === "string" && metric.id
          ? metric.id
          : `${webVitalName}:${navType}`;
        const dedupeKey = `${metricId}:${privateLifecycleId}`;
        if (reported.has(dedupeKey)) return;
        reported.add(dedupeKey);
        safeRecord(sink, {
          record_type: "observation",
          schema: "cityscroll.performance_observation.v1",
          state: "measured",
          metric_id: metricId,
          metric_version: catalogEntry.metric_version,
          unit: catalogEntry.unit,
          value,
          surface_id: classification.surface_id,
          component_id: "none",
          device_class: deviceClass,
          navigation_type: navType,
          delivery_class: classification.delivery_class,
          traffic_class: production === true ? "production" : "test",
          collector_version: manifest.collector.collector_version,
          manifest_version: manifest.manifest_version,
        });
      });
    } catch {
      // Unsupported or partially implemented performance APIs are absence.
    }
  }

  return { state: "collecting", classification };
}
