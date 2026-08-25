const RUM_BATCH_SCHEMA = "cityscroll.rum.batch.v1";
const RUM_OBSERVATION_SCHEMA = "cityscroll.performance_observation.v1";
const RELEASE_ID = /^[a-f0-9]{40}$/;
const RESULT_STATES = new Set(["content", "empty", "unavailable", "error"]);
const DEV_TOKEN_STORAGE_KEY = "crol_analytics_dev_token_v1";
const MAX_BATCH = 16;
const MAX_BUFFERED_MILESTONES = 32;
export const RUM_IDLE_FLUSH_MS = 5000;

export const RUM_PRODUCTION_HOSTS = Object.freeze([
  "cityscroll.org",
  "www.cityscroll.org",
  "cityscroll.pages.dev",
]);

export const RUM_PRODUCTION_ORIGINS = Object.freeze(
  RUM_PRODUCTION_HOSTS.map((host) => `https://${host}`),
);

export function isRumProductionHost(hostname) {
  return RUM_PRODUCTION_HOSTS.includes(String(hostname || "").toLowerCase());
}

export function isRumProductionOrigin(origin) {
  return RUM_PRODUCTION_ORIGINS.includes(String(origin || ""));
}

export function rumCollectionEnabled(manifest, { ingestEnabled, analyticsEnvironment } = {}) {
  return manifest?.collector?.production_enabled === true
    && ingestEnabled === "true"
    && analyticsEnvironment === "production";
}

export function resolveRumReleaseId(runtime = globalThis) {
  const configured = runtime?.CROL_RELEASE_ID;
  if (RELEASE_ID.test(configured || "")) return configured;
  try {
    const meta = runtime?.document?.querySelector?.('meta[name="crol-release-id"]');
    const fromMeta = meta?.content;
    if (RELEASE_ID.test(fromMeta || "")) return fromMeta;
  } catch {
    // Meta lookup is best-effort.
  }
  return null;
}

export async function loadRumReleaseId(runtime = globalThis, { releaseLoader } = {}) {
  const immediate = resolveRumReleaseId(runtime);
  if (immediate) return immediate;
  if (typeof releaseLoader !== "function" && typeof runtime?.fetch !== "function") return null;
  try {
    const loaded = releaseLoader
      ? await releaseLoader()
      : await runtime.fetch("/data/performance-release.json", {
        cache: "no-store",
        credentials: "same-origin",
      }).then((response) => (response.ok ? response.json() : null));
    const releaseId = loaded?.release_id;
    return RELEASE_ID.test(releaseId || "") ? releaseId : null;
  } catch {
    return null;
  }
}

export function developerExclusionToken(runtime = globalThis) {
  try {
    return runtime?.localStorage?.getItem?.(DEV_TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function metricCatalog(manifest) {
  return new Map((manifest?.metrics || []).map((metric) => [metric.metric_id, metric]));
}

export function projectProductionObservation(record, {
  manifest,
  classification,
  releaseId,
  deviceClass,
} = {}) {
  if (!record || !manifest || !RELEASE_ID.test(releaseId || "")) return null;
  const metricId = record.metric_id;
  const catalog = metricCatalog(manifest).get(metricId);
  if (!catalog) return null;
  if (!Number.isFinite(record.value) || record.value < 0) return null;
  const surfaceId = record.surface_id || classification?.surface_id;
  if (!surfaceId) return null;
  const resultState = RESULT_STATES.has(record.result_state) ? record.result_state : "content";
  const navigationType = record.navigation_type
    || classification?.navigation_type
    || "unknown";
  return {
    schema: RUM_OBSERVATION_SCHEMA,
    state: "measured",
    metric_id: metricId,
    metric_version: catalog.metric_version,
    unit: catalog.unit,
    value: record.value,
    surface_id: surfaceId,
    component_id: record.component_id || "none",
    device_class: record.device_class || deviceClass || "unknown",
    navigation_type: navigationType,
    delivery_class: record.delivery_class || classification?.delivery_class || "static",
    result_state: resultState,
    collector_version: manifest.collector.collector_version,
    manifest_version: manifest.manifest_version,
    release_id: releaseId,
  };
}

export function createProductionObservationSink({
  manifest,
  classification,
  releaseId,
  deviceClass,
  deliver,
  schedule = globalThis.setTimeout,
  cancelSchedule = globalThis.clearTimeout,
  idleFlushMs = RUM_IDLE_FLUSH_MS,
} = {}) {
  const pending = [];
  let flushing = false;
  let flushTimer = null;

  function cancelIdleFlush() {
    if (flushTimer === null) return;
    try { cancelSchedule?.(flushTimer); } catch { /* best effort */ }
    flushTimer = null;
  }

  function scheduleIdleFlush() {
    if (flushTimer !== null || !pending.length || typeof schedule !== "function") return;
    try {
      flushTimer = schedule(() => {
        flushTimer = null;
        void flush();
      }, idleFlushMs);
      // Node-based callers should not be kept alive by an observational timer. Browsers return
      // numeric timer handles, so this is a no-op there.
      flushTimer?.unref?.();
    } catch {
      flushTimer = null;
    }
  }

  async function flush() {
    if (flushing || !pending.length || typeof deliver !== "function") return { state: "idle" };
    cancelIdleFlush();
    flushing = true;
    try {
      while (pending.length) {
        const observations = pending.splice(0, MAX_BATCH);
        await deliver({ schema: RUM_BATCH_SCHEMA, observations });
      }
      return { state: "flushed" };
    } catch {
      return { state: "unavailable" };
    } finally {
      flushing = false;
    }
  }

  return Object.freeze({
    record(value) {
      const observation = projectProductionObservation(value, {
        manifest,
        classification,
        releaseId,
        deviceClass,
      });
      if (!observation) return { state: "ignored" };
      pending.push(observation);
      if (pending.length >= MAX_BATCH) void flush();
      else scheduleIdleFlush();
      return { state: "queued" };
    },
    flush,
    size() {
      return pending.length;
    },
  });
}

export function createBufferedSemanticMilestones(runtime = globalThis) {
  const existing = runtime?.CROLRumSemanticBuffer;
  if (existing && typeof existing.surfaceReady === "function") return existing;

  const queued = [];
  function enqueue(kind, args) {
    if (queued.length >= MAX_BUFFERED_MILESTONES) return { state: "disabled" };
    queued.push({ kind, args });
    return { state: "buffered" };
  }

  const buffer = Object.freeze({
    state: "buffering",
    surfaceReady(args) {
      return enqueue("surfaceReady", args);
    },
    componentReady(args) {
      return enqueue("componentReady", args);
    },
    interactionStart() {
      return Object.freeze({
        state: "disabled",
        visualFeedback() { return { state: "disabled" }; },
        settled() { return { state: "disabled" }; },
        cancel() { return { state: "disabled" }; },
      });
    },
    drain(target) {
      if (!target) return 0;
      let replayed = 0;
      while (queued.length) {
        const item = queued.shift();
        if (typeof target[item.kind] === "function") {
          target[item.kind](item.args);
          replayed += 1;
        }
      }
      return replayed;
    },
  });
  try {
    runtime.CROLRumSemanticBuffer = buffer;
  } catch {
    // Assignment can fail in frozen test runtimes.
  }
  return buffer;
}
