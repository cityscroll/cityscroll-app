import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import worker from "../src/worker.mjs";
import {
  RUM_BATCH_SCHEMA,
  RUM_HEALTH_REASONS,
  RUM_MAX_BATCH_SIZE,
  RUM_MAX_REQUEST_BYTES,
  RUM_OBSERVATION_SCHEMA,
  RUM_VALUE_MAXIMUM,
  handlePerformanceEvents,
  normalizeRumBatch,
} from "../src/performance_events.mjs";

const NOW_MS = Date.parse("2026-08-19T14:30:00Z");
const DAY = "2026-08-19";
const DEV_SECRET = "test-only-rum-developer-exclusion-key";

function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
  };
}

function analyticsBinding(points, { fail = false } = {}) {
  return {
    writeDataPoint(point) {
      if (fail) throw new Error("analytics unavailable");
      points.push(point);
    },
  };
}

function observation(overrides = {}) {
  return {
    schema: RUM_OBSERVATION_SCHEMA,
    state: "measured",
    metric_id: "ttfb_ms",
    metric_version: "1.0.0",
    unit: "ms",
    value: 123.5,
    surface_id: "home",
    component_id: "none",
    device_class: "mobile",
    navigation_type: "navigate",
    delivery_class: "static",
    result_state: "content",
    collector_version: "rum-browser-v1",
    manifest_version: "rum-surfaces-v1",
    release_id: "a".repeat(40),
    ...overrides,
  };
}

function batch(observations = [observation()], overrides = {}) {
  return {
    schema: RUM_BATCH_SCHEMA,
    observations,
    ...overrides,
  };
}

function devToken(secret = DEV_SECRET, nowMs = NOW_MS) {
  const timestamp = Math.floor(nowMs / 1000);
  const signature = createHmac("sha256", secret)
    .update(`crol-analytics-dev-exclusion\n${timestamp}`)
    .digest("base64url");
  return `v1.${timestamp}.${signature}`;
}

function healthCount(kv, reason) {
  return Number(kv.store.get(`stats:rum_health.${reason}:${DAY}`) || 0);
}

async function post(payload, {
  env = {},
  headers = {},
  rawBody,
  method = "POST",
  origin = "https://cityscroll.org",
} = {}) {
  return handlePerformanceEvents(new Request("https://api.cityscroll.org/performance-events", {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...headers,
    },
    ...(method === "GET" || method === "HEAD" ? {} : {
      body: rawBody ?? JSON.stringify(payload),
    }),
  }), env, { nowMs: NOW_MS });
}

test("enabled production intake writes one normalized point per numeric observation", async () => {
  const points = [];
  const health = fakeKV();
  const env = {
    RUM_ANALYTICS: analyticsBinding(points),
    RUM_INGEST_ENABLED: "true",
    ANALYTICS_ENVIRONMENT: "production",
    ALERT_STATE: health,
  };
  const response = await post(batch([
    observation(),
    observation({
      metric_id: "component_ready_ms",
      value: 456,
      surface_id: "browse-money",
      component_id: "browse-results",
      delivery_class: "hybrid",
    }),
  ]), { env });

  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  assert.equal(points.length, 2);
  assert.deepEqual(points[0], {
    blobs: [
      RUM_OBSERVATION_SCHEMA,
      "ttfb_ms",
      "home",
      "none",
      "ms",
      "mobile",
      "navigate",
      "static",
      "content",
      "production",
      "rum-browser-v1",
      "rum-surfaces-v1",
      "a".repeat(40),
    ],
    doubles: [123.5],
    indexes: ["ttfb_ms|home|none"],
  });
  assert.equal(points[1].blobs[2], "browse-contracts", "registered aliases normalize before storage");
  assert.equal(points[1].blobs[3], "browse-results");
  assert.equal(healthCount(health, "accepted"), 2);
  assert.equal(health.store.get("rum:health:latest-accepted"), new Date(NOW_MS).toISOString());
});

test("semantic owner timestamps are additive and occupy the second Analytics Engine double", () => {
  const semantic = observation({
    metric_id: "content_ready_ms",
    value: 456,
    owner_timestamp_ms: 137.5,
  });
  const normalized = normalizeRumBatch(batch([semantic]));
  assert.equal(normalized.ok, true);
  assert.equal(normalized.observations[0].ownerTimestampMs, 137.5);
  assert.deepEqual(rumDataPoint(normalized.observations[0]), {
    blobs: [
      RUM_OBSERVATION_SCHEMA,
      "content_ready_ms",
      "home",
      "none",
      "ms",
      "mobile",
      "navigate",
      "static",
      "content",
      "production",
      "rum-browser-v1",
      "rum-surfaces-v1",
      "a".repeat(40),
    ],
    doubles: [456, 137.5],
    indexes: ["content_ready_ms|home|none"],
  });
  assert.deepEqual(normalizeRumBatch(batch([observation({
    metric_id: "content_ready_ms",
    owner_timestamp_ms: -1,
  })])), { ok: false, reason: "invalid_value" });
});

test("controlled lab intake is retained and tagged separately from field traffic", async () => {
  const points = [];
  const response = await post(batch(), {
    env: {
      RUM_ANALYTICS: analyticsBinding(points),
      RUM_INGEST_ENABLED: "true",
      ANALYTICS_ENVIRONMENT: "production",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(points[0].blobs[9], "production");

  const labResponse = await handlePerformanceEvents(new Request(
    "https://api.cityscroll.org/performance-events?traffic_class=lab",
    {
      method: "POST",
      headers: { Origin: "https://cityscroll.org", "Content-Type": "application/json" },
      body: JSON.stringify(batch()),
    },
  ), {
    RUM_ANALYTICS: analyticsBinding(points),
    RUM_INGEST_ENABLED: "true",
    ANALYTICS_ENVIRONMENT: "production",
  }, { nowMs: NOW_MS });
  assert.equal(labResponse.status, 204);
  assert.equal(points[1].blobs[9], "lab");
});

test("strict batch validation rejects private, unknown, incompatible, and corrupt data without writes", async (t) => {
  const cases = [
    ["forbidden nested key", batch([{ ...observation(), metadata: { visitor_id: "private" } }]), "forbidden_key"],
    ["unknown key", batch([{ ...observation(), future_dimension: "no" }]), "unknown_key"],
    ["unknown metric", batch([observation({ metric_id: "speed_score" })]), "unknown_metric"],
    ["unknown surface", batch([observation({ surface_id: "future-surface" })]), "unknown_surface"],
    ["unknown component", batch([observation({ component_id: "private-widget" })]), "unknown_component"],
    ["component outside surface", batch([observation({ component_id: "browse-results" })]), "incompatible_metric"],
    ["wrong metric unit", batch([observation({ unit: "score" })]), "invalid_unit"],
    ["metric not applicable to surface", batch([observation({ metric_id: "component_ready_ms" })]), "incompatible_metric"],
    ["wrong delivery class", batch([observation({ delivery_class: "worker_backed" })]), "invalid_enum"],
    ["unknown manifest", batch([observation({ manifest_version: "rum-surfaces-v2" })]), "unknown_manifest"],
    ["wrong collector", batch([observation({ collector_version: "rum-browser-v2" })]), "unsupported_schema"],
    ["wrong observation schema", batch([observation({ schema: "cityscroll.performance_observation.v2" })]), "unsupported_schema"],
    ["wrong batch schema", batch(undefined, { schema: "cityscroll.rum.batch.v2" }), "unsupported_schema"],
    ["negative", batch([observation({ value: -1 })]), "invalid_value"],
    ["over corruption bound", batch([observation({ value: 86_400_001 })]), "invalid_value"],
    ["bad release", batch([observation({ release_id: "not-a-release" })]), "invalid_value"],
    ["empty batch", batch([]), "invalid_batch"],
    ["oversized batch", batch(Array.from({ length: RUM_MAX_BATCH_SIZE + 1 }, () => observation())), "invalid_batch"],
  ];

  for (const [name, payload, reason] of cases) {
    await t.test(name, async () => {
      const points = [];
      const health = fakeKV();
      const response = await post(payload, {
        env: {
          RUM_ANALYTICS: analyticsBinding(points),
          RUM_INGEST_ENABLED: "true",
          ANALYTICS_ENVIRONMENT: "production",
          ALERT_STATE: health,
        },
      });
      assert.equal(response.status, 204);
      assert.deepEqual(points, []);
      assert.equal(healthCount(health, reason), 1);
    });
  }

  const nonFinite = normalizeRumBatch(batch([observation({ value: Number.POSITIVE_INFINITY })]));
  assert.deepEqual(nonFinite, { ok: false, reason: "invalid_value" });

  const points = [];
  const health = fakeKV();
  const rawNonFinite = JSON.stringify(batch()).replace('"value":123.5', '"value":1e999');
  const response = await post(null, {
    rawBody: rawNonFinite,
    env: {
      RUM_ANALYTICS: analyticsBinding(points),
      RUM_INGEST_ENABLED: "true",
      ANALYTICS_ENVIRONMENT: "production",
      ALERT_STATE: health,
    },
  });
  assert.equal(response.status, 204);
  assert.deepEqual(points, []);
  assert.equal(healthCount(health, "invalid_value"), 1);

  assert.equal(RUM_VALUE_MAXIMUM.ms, 86_400_000);
  assert.equal(RUM_VALUE_MAXIMUM.score, 100);
  assert.equal(normalizeRumBatch(batch([observation({
    metric_id: "cls_score",
    metric_version: "1.0.0",
    unit: "score",
    value: 100.001,
  })])).reason, "invalid_value");
});

test("origin, method, syntax, and byte-size limits retain protocol diagnostics", async () => {
  const env = { RUM_INGEST_ENABLED: "true", ANALYTICS_ENVIRONMENT: "production" };
  assert.equal((await post(batch(), { env, origin: "https://attacker.example" })).status, 403);
  assert.equal((await post(batch(), { env, method: "GET" })).status, 405);
  assert.equal((await post(null, { env, rawBody: "{" })).status, 400);
  assert.equal((await post(null, { env, rawBody: `{"padding":"${"x".repeat(RUM_MAX_REQUEST_BYTES)}"}` })).status, 413);

  const preflight = await handlePerformanceEvents(new Request(
    "https://api.cityscroll.org/performance-events",
    { method: "OPTIONS", headers: { Origin: "https://cityscroll.org" } },
  ), env);
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("Access-Control-Allow-Headers"), /X-CROL-Analytics-Dev/);
});

test("intake gates production, preview, developer, missing binding, and storage failure uniformly", async (t) => {
  const scenarios = [
    ["disabled", { RUM_INGEST_ENABLED: "false", ANALYTICS_ENVIRONMENT: "production" }, {}, "disabled"],
    ["preview", { RUM_INGEST_ENABLED: "true", ANALYTICS_ENVIRONMENT: "preview" }, {}, "non_production"],
    ["missing binding", { RUM_INGEST_ENABLED: "true", ANALYTICS_ENVIRONMENT: "production" }, {}, "storage_unavailable"],
    ["storage failure", { RUM_INGEST_ENABLED: "true", ANALYTICS_ENVIRONMENT: "production" }, { fail: true }, "storage_unavailable"],
  ];

  for (const [name, baseEnv, bindingOptions, reason] of scenarios) {
    await t.test(name, async () => {
      const points = [];
      const health = fakeKV();
      const response = await post(batch(), {
        env: {
          ...baseEnv,
          ...(name === "missing binding" ? {} : { RUM_ANALYTICS: analyticsBinding(points, bindingOptions) }),
          ALERT_STATE: health,
        },
      });
      assert.equal(response.status, 204);
      assert.equal(await response.text(), "");
      assert.deepEqual(points, []);
      assert.equal(healthCount(health, reason), 1);
    });
  }
});

test("developer-token validity is undisclosed and valid developer observations are excluded", async () => {
  const headers = { "X-CROL-Analytics-Dev": devToken() };
  const baseEnv = {
    RUM_INGEST_ENABLED: "true",
    ANALYTICS_ENVIRONMENT: "production",
    ANALYTICS_DEV_KEY: DEV_SECRET,
  };

  const developerPoints = [];
  const developerHealth = fakeKV();
  const excluded = await post(batch(), {
    headers,
    env: { ...baseEnv, RUM_ANALYTICS: analyticsBinding(developerPoints), ALERT_STATE: developerHealth },
  });

  const productionPoints = [];
  const productionHealth = fakeKV();
  const accepted = await post(batch(), {
    headers: { "X-CROL-Analytics-Dev": devToken(`${DEV_SECRET}-wrong`) },
    env: { ...baseEnv, RUM_ANALYTICS: analyticsBinding(productionPoints), ALERT_STATE: productionHealth },
  });

  assert.equal(excluded.status, 204);
  assert.equal(accepted.status, 204);
  assert.equal(await excluded.text(), await accepted.text());
  assert.deepEqual(developerPoints, []);
  assert.equal(healthCount(developerHealth, "developer"), 1);
  assert.equal(productionPoints.length, 1);
  assert.equal(productionPoints[0].blobs[9], "production");
});

test("Worker route and wrangler bindings are visibly separate while usage stays byte-shaped and only production ingest is on", async () => {
  const points = [];
  const response = await worker.fetch(new Request("https://api.cityscroll.org/performance-events", {
    method: "POST",
    headers: { Origin: "https://cityscroll.org", "Content-Type": "application/json" },
    body: JSON.stringify(batch()),
  }), {
    RUM_ANALYTICS: analyticsBinding(points),
    RUM_INGEST_ENABLED: "true",
    ANALYTICS_ENVIRONMENT: "production",
  }, {});
  assert.equal(response.status, 204);
  assert.equal(points.length, 1);

  const usagePoints = [];
  const usageResponse = await worker.fetch(new Request("https://api.cityscroll.org/events", {
    method: "POST",
    headers: { Origin: "https://cityscroll.org", "Content-Type": "application/json" },
    body: JSON.stringify({ event: "page_view", surface: "home" }),
  }), {
    USAGE_ANALYTICS: analyticsBinding(usagePoints),
    ANALYTICS_ENVIRONMENT: "production",
  }, {});
  assert.equal(usageResponse.status, 204);
  assert.deepEqual(usagePoints[0], {
    blobs: ["page_view", "none", "none", "none", "home", "1.3.0", "production"],
    doubles: [1],
    indexes: ["page_view"],
  });

  const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(wrangler, /binding = "USAGE_ANALYTICS"\s+dataset = "crol_usage_events_v1"/);
  assert.match(wrangler, /binding = "RUM_ANALYTICS"\s+dataset = "crol_rum_observations_v1"/);
  assert.match(wrangler, /^RUM_INGEST_ENABLED = "true"$/m);
  assert.doesNotMatch(wrangler, /\[env\.beta/);
  const publicManifest = JSON.parse(readFileSync(
    new URL("../../site/data/performance-classification-manifest.v1.json", import.meta.url),
    "utf8",
  ));
  assert.equal(publicManifest.collector.production_enabled, true);
  assert.ok(RUM_HEALTH_REASONS.includes("forbidden_key"));
  assert.ok(RUM_HEALTH_REASONS.includes("storage_unavailable"));
});
