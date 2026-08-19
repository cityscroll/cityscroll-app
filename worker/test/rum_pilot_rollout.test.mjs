import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildAdminPerformanceResponse, readAdminPerformance } from "../src/admin_performance.mjs";
import {
  handlePerformanceEvents,
  normalizeRumBatch,
  rumDataPoint,
} from "../src/performance_events.mjs";
import {
  buildPerformanceSnapshot,
  performanceAnalyticsQueryPlan,
} from "../src/lib/performance_query.mjs";
import { projectProductionObservation } from "../../site/rum_production.mjs";

const MANIFEST = JSON.parse(readFileSync(
  new URL("../../site/data/performance-classification-manifest.v1.json", import.meta.url),
  "utf8",
));
const QUERY_FIXTURE = JSON.parse(readFileSync(
  new URL("./fixtures/performance_query_weighted.json", import.meta.url),
  "utf8",
));
const RELEASE_ID = "a".repeat(40);
const NOW_MS = Date.parse("2026-08-19T14:30:00Z");

function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
  };
}

function observation() {
  return projectProductionObservation({
    metric_id: "ttfb_ms",
    value: 123.5,
    surface_id: "home",
    component_id: "none",
    device_class: "mobile",
    navigation_type: "navigate",
    delivery_class: "static",
    result_state: "content",
  }, {
    manifest: MANIFEST,
    releaseId: RELEASE_ID,
  });
}

test("accepted production observation traces intake to weighted query to admin read model", async () => {
  const projected = observation();
  const normalized = normalizeRumBatch({
    schema: "cityscroll.rum.batch.v1",
    observations: [projected],
  });
  assert.equal(normalized.ok, true);
  const point = rumDataPoint(normalized.observations[0], "production");
  assert.equal(point.blobs[1], "ttfb_ms");
  assert.equal(point.blobs[2], "home");
  assert.equal(point.blobs[9], "production");
  assert.equal(point.indexes[0], "ttfb_ms|home|none");

  const written = [];
  const health = fakeKV();
  const response = await handlePerformanceEvents(new Request("https://api.cityscroll.org/performance-events", {
    method: "POST",
    headers: { Origin: "https://cityscroll.org", "Content-Type": "application/json" },
    body: JSON.stringify({ schema: "cityscroll.rum.batch.v1", observations: [projected] }),
  }), {
    RUM_INGEST_ENABLED: "true",
    ANALYTICS_ENVIRONMENT: "production",
    RUM_ANALYTICS: { writeDataPoint(value) { written.push(value); } },
    ALERT_STATE: health,
  }, { nowMs: NOW_MS });
  assert.equal(response.status, 204);
  assert.equal(written.length, 1);
  assert.deepEqual(written[0], point);
  assert.equal(health.store.get("rum:health:latest-accepted"), "2026-08-19T14:30:00.000Z");

  const queryPlan = performanceAnalyticsQueryPlan(QUERY_FIXTURE.query, {
    now: QUERY_FIXTURE.now,
    configuredSince: QUERY_FIXTURE.configured_since,
    sampleFloor: QUERY_FIXTURE.sample_floor,
  });
  const snapshot = buildPerformanceSnapshot(QUERY_FIXTURE.sql_results, queryPlan, {
    dataHealth: { status: "available", accepted: 10 },
  });
  const readModel = buildAdminPerformanceResponse(snapshot);
  assert.equal(readModel.schema, "cityscroll.admin.performance.v1");
  assert.ok(["available", "partial", "insufficient_sample"].includes(readModel.status));
  assert.equal(readModel.sampling.method, "cloudflare_weighted_adaptive_sampling");
  const series = readModel.series.find((row) => row.dimensions?.surface_id === "home") || readModel.series[0];
  assert.ok(series.current.percentiles.p50 > 0);
  assert.ok(series.current.sampled_count >= 1);
  assert.ok(series.current.estimated_count >= series.current.sampled_count);

  const body = await readAdminPerformance({}, new Request(
    "https://api.cityscroll.org/admin/performance?metric=ttfb_ms&surface=home",
  ), {
    readPerformance: async () => snapshot,
  });
  assert.equal(body.schema, "cityscroll.admin.performance.v1");
  assert.ok(body.series.length >= 1);
});

test("preview, local, disabled ingest, and disabled manifest write no residual points", async () => {
  const cases = [
    { origin: "https://cityscroll.org", env: { RUM_INGEST_ENABLED: "false", ANALYTICS_ENVIRONMENT: "production" } },
    { origin: "https://cityscroll.org", env: { RUM_INGEST_ENABLED: "true", ANALYTICS_ENVIRONMENT: "preview" } },
    { origin: "http://localhost:8000", env: { RUM_INGEST_ENABLED: "true", ANALYTICS_ENVIRONMENT: "production" } },
    { origin: "https://pr-14.cityscroll.pages.dev", env: { RUM_INGEST_ENABLED: "true", ANALYTICS_ENVIRONMENT: "production" } },
  ];
  for (const item of cases) {
    const points = [];
    const response = await handlePerformanceEvents(new Request("https://api.cityscroll.org/performance-events", {
      method: "POST",
      headers: { Origin: item.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ schema: "cityscroll.rum.batch.v1", observations: [observation()] }),
    }), {
      ...item.env,
      RUM_ANALYTICS: { writeDataPoint(value) { points.push(value); } },
      ALERT_STATE: fakeKV(),
    }, { nowMs: NOW_MS });
    assert.ok([204, 403].includes(response.status), item.origin);
    assert.deepEqual(points, [], item.origin);
  }
});
