// POST /performance-events — strict, independently gated field-performance intake.

import performanceAllowlist from "./data/performance-validation-allowlist.v1.json" with { type: "json" };
import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { bumpStat } from "./lib/stats.mjs";
import { isRumProductionOrigin } from "../../site/rum_production.mjs";

export const RUM_BATCH_SCHEMA = "cityscroll.rum.batch.v1";
export const RUM_OBSERVATION_SCHEMA = "cityscroll.performance_observation.v1";
export const RUM_MAX_BATCH_SIZE = 16;
export const RUM_MAX_REQUEST_BYTES = 8 * 1024;
export const RUM_DEV_HEADER = "X-CROL-Analytics-Dev";
export const RUM_TRAFFIC_CLASS_QUERY = "traffic_class";
export const RUM_TRAFFIC_CLASSES = Object.freeze(["production", "lab"]);

// These are transport corruption bounds, not speed thresholds. They prevent a malformed
// observation from consuming an unbounded numeric domain while preserving generous headroom.
export const RUM_VALUE_MAXIMUM = Object.freeze({
  ms: 24 * 60 * 60 * 1000,
  score: 100,
});
const DEV_TOKEN_VERSION = "v1";
const DEV_TOKEN_CONTEXT = "crol-analytics-dev-exclusion";
const DEV_TOKEN_MAX_AGE_SECONDS = 5 * 60;
const DEV_TOKEN_FUTURE_SKEW_SECONDS = 30;

export const RUM_HEALTH_REASONS = Object.freeze([
  "accepted",
  "developer",
  "disabled",
  "forbidden_key",
  "incompatible_metric",
  "invalid_batch",
  "invalid_enum",
  "invalid_unit",
  "invalid_value",
  "non_production",
  "storage_configured",
  "storage_unavailable",
  "unknown_component",
  "unknown_key",
  "unknown_manifest",
  "unknown_metric",
  "unknown_surface",
  "unsupported_schema",
]);

const HEALTH_REASON_SET = new Set(RUM_HEALTH_REASONS);
const RELEASE_ID = /^[a-f0-9]{40}$/;
const OBSERVATION_KEYS = Object.freeze([
  "collector_version",
  "component_id",
  "delivery_class",
  "device_class",
  "manifest_version",
  "metric_id",
  "metric_version",
  "navigation_type",
  "release_id",
  "result_state",
  "schema",
  "state",
  "surface_id",
  "unit",
  "value",
]);
const OPTIONAL_OBSERVATION_KEYS = Object.freeze(["owner_timestamp_ms"]);
const BATCH_KEYS = Object.freeze(["observations", "schema"]);
const FORBIDDEN_KEYS = new Set([
  "account",
  "account_id",
  "ad_id",
  "advertising_id",
  "attribution",
  "correlation_id",
  "css_path",
  "css_selector",
  "device_id",
  "dom_path",
  "dom_text",
  "entries",
  "entity_id",
  "error",
  "exception",
  "geolocation",
  "hash",
  "href",
  "id",
  "interaction_target",
  "ip",
  "latitude",
  "longitude",
  "navigation_url",
  "notice_id",
  "parcel_id",
  "path",
  "pathname",
  "project_id",
  "query",
  "record_id",
  "referrer",
  "resource_url",
  "screen_height",
  "screen_width",
  "search",
  "search_term",
  "selector",
  "session_id",
  "subscription_id",
  "target",
  "text",
  "token",
  "url",
  "user_agent",
  "vendor_id",
  "visitor",
  "visitor_id",
]);

const metricById = new Map((performanceAllowlist.metrics || []).map((metric) => [metric.metric_id, metric]));
const acceptedSurfaceIds = new Set(performanceAllowlist.accepted_surface_ids || []);
const acceptedComponentIds = new Set(performanceAllowlist.accepted_component_ids || []);
const deviceClasses = new Set(performanceAllowlist.collector?.device_classes || []);
const navigationTypes = new Set(performanceAllowlist.collector?.navigation_types || []);
const deliveryClasses = new Set(performanceAllowlist.delivery_classes || []);
const resultStates = new Set(performanceAllowlist.result_states || []);

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
    const decoded = atob(base64);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hasValidDeveloperExclusion(req, env, nowMs) {
  const secret = String(env?.ANALYTICS_DEV_KEY || "");
  const token = req.headers.get(RUM_DEV_HEADER) || "";
  if (secret.length < 32 || token.length > 160) return false;

  const [version, timestampRaw, signatureRaw, ...extra] = token.split(".");
  const timestamp = Number(timestampRaw);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (
    version !== DEV_TOKEN_VERSION
    || extra.length
    || !Number.isSafeInteger(timestamp)
    || timestamp < nowSeconds - DEV_TOKEN_MAX_AGE_SECONDS
    || timestamp > nowSeconds + DEV_TOKEN_FUTURE_SKEW_SECONDS
  ) return false;

  const signature = decodeBase64Url(signatureRaw || "");
  if (!signature) return false;
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      encoder.encode(`${DEV_TOKEN_CONTEXT}\n${timestampRaw}`),
    );
  } catch {
    return false;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, optional = []) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const allowed = new Set([...expected, ...optional]);
  return expected.every((key) => actual.includes(key)) && actual.every((key) => allowed.has(key));
}

function hasForbiddenKey(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (!isRecord(value)) return false;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).toLowerCase();
    if (
      FORBIDDEN_KEYS.has(normalized)
      || /(?:^|_)(?:account|advertising|correlation|session|visitor)(?:_|$)/.test(normalized)
      || /(?:^|_)(?:exception|referrer|selector|target|token|url)(?:_|$)/.test(normalized)
    ) return true;
    if (hasForbiddenKey(child)) return true;
  }
  return false;
}

function canonicalSurfaceId(surfaceId) {
  return performanceAllowlist.surface_aliases?.[surfaceId] || surfaceId;
}

function canonicalComponentId(componentId) {
  return performanceAllowlist.component_aliases?.[componentId] || componentId;
}

function rejected(reason) {
  return { ok: false, reason };
}

function normalizeObservation(input) {
  if (!exactKeys(input, OBSERVATION_KEYS, OPTIONAL_OBSERVATION_KEYS)) return rejected("unknown_key");
  if (
    input.schema !== RUM_OBSERVATION_SCHEMA
    || input.state !== "measured"
    || input.collector_version !== performanceAllowlist.collector?.collector_version
  ) return rejected("unsupported_schema");
  if (input.manifest_version !== performanceAllowlist.manifest_version) return rejected("unknown_manifest");

  const metric = metricById.get(input.metric_id);
  if (!metric) return rejected("unknown_metric");
  if (input.metric_version !== metric.metric_version) return rejected("unsupported_schema");
  if (input.unit !== metric.unit) return rejected("invalid_unit");
  if (
    !Number.isFinite(input.value)
    || input.value < metric.minimum
    || input.value > RUM_VALUE_MAXIMUM[metric.unit]
    || !RELEASE_ID.test(input.release_id || "")
  ) return rejected("invalid_value");
  if (
    Object.hasOwn(input, "owner_timestamp_ms")
    && (!Number.isFinite(input.owner_timestamp_ms)
      || input.owner_timestamp_ms < 0
      || input.owner_timestamp_ms > RUM_VALUE_MAXIMUM.ms)
  ) return rejected("invalid_value");

  if (!acceptedSurfaceIds.has(input.surface_id)) return rejected("unknown_surface");
  if (!acceptedComponentIds.has(input.component_id)) return rejected("unknown_component");
  if (
    !deviceClasses.has(input.device_class)
    || !navigationTypes.has(input.navigation_type)
    || !deliveryClasses.has(input.delivery_class)
    || !resultStates.has(input.result_state)
  ) return rejected("invalid_enum");

  const surfaceId = canonicalSurfaceId(input.surface_id);
  const componentId = canonicalComponentId(input.component_id);
  const surface = performanceAllowlist.surfaces?.[surfaceId];
  if (!surface) return rejected("unknown_surface");
  if (input.delivery_class !== surface.delivery_class) return rejected("invalid_enum");

  if (componentId === "none") {
    if (!surface.applicable_metric_ids.includes(input.metric_id)) return rejected("incompatible_metric");
  } else {
    const component = performanceAllowlist.components?.[componentId];
    if (!component) return rejected("unknown_component");
    if (
      !component.applicable_surface_ids.includes(surfaceId)
      || !component.applicable_metric_ids.includes(input.metric_id)
      || !surface.allowed_component_ids.includes(componentId)
    ) return rejected("incompatible_metric");
  }

  const samplingIndex = `${input.metric_id}|${surfaceId}|${componentId}`;
  if (new TextEncoder().encode(samplingIndex).byteLength > 96) return rejected("invalid_value");
  return {
    ok: true,
    observation: {
      schema: input.schema,
      metricId: input.metric_id,
      surfaceId,
      componentId,
      unit: input.unit,
      deviceClass: input.device_class,
      navigationType: input.navigation_type,
      deliveryClass: input.delivery_class,
      resultState: input.result_state,
      collectorVersion: input.collector_version,
      manifestVersion: input.manifest_version,
      releaseId: input.release_id,
      value: input.value,
      samplingIndex,
      ...(Object.hasOwn(input, "owner_timestamp_ms")
        ? { ownerTimestampMs: input.owner_timestamp_ms }
        : {}),
    },
  };
}

export function normalizeRumBatch(input) {
  if (hasForbiddenKey(input)) return rejected("forbidden_key");
  if (!exactKeys(input, BATCH_KEYS)) return rejected(isRecord(input) ? "unknown_key" : "invalid_batch");
  if (input.schema !== RUM_BATCH_SCHEMA) return rejected("unsupported_schema");
  if (
    !Array.isArray(input.observations)
    || input.observations.length < 1
    || input.observations.length > RUM_MAX_BATCH_SIZE
  ) return rejected("invalid_batch");

  const observations = [];
  for (const inputObservation of input.observations) {
    const result = normalizeObservation(inputObservation);
    if (!result.ok) return result;
    observations.push(result.observation);
  }
  return { ok: true, observations };
}

export function rumDataPoint(observation, trafficClass = "production") {
  return {
    blobs: [
      observation.schema,
      observation.metricId,
      observation.surfaceId,
      observation.componentId,
      observation.unit,
      observation.deviceClass,
      observation.navigationType,
      observation.deliveryClass,
      observation.resultState,
      trafficClass,
      observation.collectorVersion,
      observation.manifestVersion,
      observation.releaseId,
    ],
    doubles: [
      observation.value,
      ...(Number.isFinite(observation.ownerTimestampMs) && observation.ownerTimestampMs >= 0
        ? [observation.ownerTimestampMs]
        : []),
    ],
    indexes: [observation.samplingIndex],
  };
}

function requestTrafficClass(req) {
  try {
    return new URL(req.url).searchParams.get(RUM_TRAFFIC_CLASS_QUERY) === "lab"
      ? "lab"
      : "production";
  } catch {
    return "production";
  }
}

async function recordHealth(env, reason, now, count = 1) {
  if (!HEALTH_REASON_SET.has(reason) || !env?.ALERT_STATE) return;
  // bumpStat is a KV read-modify-write operation, so serialize the bounded increments inside
  // one request rather than racing each observation against the same starting value.
  const increments = Math.max(1, Math.min(count, RUM_MAX_BATCH_SIZE));
  for (let index = 0; index < increments; index += 1) {
    await bumpStat(env.ALERT_STATE, `rum_health.${reason}`, now);
  }
}

async function recordLatestAccepted(env, now) {
  if (!env?.ALERT_STATE) return;
  try {
    await env.ALERT_STATE.put("rum:health:latest-accepted", now.toISOString());
  } catch {
    // Health telemetry is best-effort and must never change intake behavior.
  }
}

function acceptedResponse(cors) {
  return new Response(null, { status: 204, headers: cors });
}

export async function handlePerformanceEvents(req, env, options = {}) {
  const origin = req.headers.get("Origin") || "";
  const cors = corsHeaders(origin, env, {
    headers: `Content-Type, ${RUM_DEV_HEADER}`,
    maxAge: "86400",
    cacheControl: "no-store",
  });
  if (!isAllowedRequestOrigin(origin, env)) {
    return new Response("Origin not allowed", { status: 403, headers: cors });
  }
  if (req.method === "OPTIONS") return acceptedResponse(cors);
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  const declaredLength = Number(req.headers.get("Content-Length") || 0);
  if (declaredLength > RUM_MAX_REQUEST_BYTES) {
    return new Response("Performance batch too large", { status: 413, headers: cors });
  }

  let input;
  try {
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength > RUM_MAX_REQUEST_BYTES) {
      return new Response("Performance batch too large", { status: 413, headers: cors });
    }
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return new Response("Invalid performance batch", { status: 400, headers: cors });
  }

  const nowMs = options.nowMs ?? Date.now();
  const now = new Date(nowMs);
  const normalized = normalizeRumBatch(input);
  if (!normalized.ok) {
    await recordHealth(env, normalized.reason, now);
    return acceptedResponse(cors);
  }
  if (env?.RUM_INGEST_ENABLED !== "true") {
    await recordHealth(env, "disabled", now);
    return acceptedResponse(cors);
  }
  if (env?.ANALYTICS_ENVIRONMENT !== "production") {
    await recordHealth(env, "non_production", now);
    return acceptedResponse(cors);
  }
  if (!isRumProductionOrigin(origin)) {
    await recordHealth(env, "non_production", now);
    return acceptedResponse(cors);
  }
  if (await hasValidDeveloperExclusion(req, env, nowMs)) {
    await recordHealth(env, "developer", now);
    return acceptedResponse(cors);
  }
  if (!env?.RUM_ANALYTICS || typeof env.RUM_ANALYTICS.writeDataPoint !== "function") {
    await recordHealth(env, "storage_unavailable", now);
    return acceptedResponse(cors);
  }

  await recordHealth(env, "storage_configured", now);
  const trafficClass = requestTrafficClass(req);
  try {
    for (const observation of normalized.observations) {
      await env.RUM_ANALYTICS.writeDataPoint(rumDataPoint(observation, trafficClass));
    }
  } catch {
    await recordHealth(env, "storage_unavailable", now);
    return acceptedResponse(cors);
  }

  await recordHealth(env, "accepted", now, normalized.observations.length);
  await recordLatestAccepted(env, now);
  return acceptedResponse(cors);
}
