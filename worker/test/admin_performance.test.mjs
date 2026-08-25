import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  handleAdminPerformance,
} from "../src/admin.mjs";
import {
  ADMIN_PERFORMANCE_SCHEMA,
  ADMIN_PERFORMANCE_OPERATIONAL_STATES,
  ADMIN_PERFORMANCE_STATES,
  buildAdminPerformanceResponse,
  parseAdminPerformanceRequest,
} from "../src/admin_performance.mjs";
import {
  buildPerformanceSnapshot,
  performanceAnalyticsQueryPlan,
} from "../src/lib/performance_query.mjs";
import worker from "../src/worker.mjs";

const NOW = "2026-08-19T14:30:00.000Z";
const RELEASE_ID = "a".repeat(40);
const AVAILABLE_FIXTURE = JSON.parse(readFileSync(
  new URL("./fixtures/admin_performance_available.v1.json", import.meta.url),
  "utf8",
));
const STATE_FIXTURE = JSON.parse(readFileSync(
  new URL("./fixtures/admin_performance_states.v1.json", import.meta.url),
  "utf8",
));
const QUERY_FIXTURE = JSON.parse(readFileSync(
  new URL("./fixtures/performance_query_weighted.json", import.meta.url),
  "utf8",
));

function availableSnapshot(query = {
  window: "7d",
  filters: { metric_id: "ttfb_ms", surface_id: "home" },
  group_by: null,
}) {
  return {
    schema: "cityscroll.performance.query_result.v1",
    status: "available",
    query,
    sample_floor: 30,
    sampling: {
      method: "cloudflare_weighted_adaptive_sampling",
      sampled_count: "retained rows",
      estimated_count: "weighted observations",
      percentiles: "provider-weighted quantiles",
      sufficiency: "sampled rows determine sufficiency",
    },
    retention: {
      retention_days: 90,
      current: { status: "complete" },
      previous: { status: "complete" },
    },
    series: [{
      dimensions: {},
      current: {
        status: "available",
        sampled_count: 42,
        estimated_count: 57,
        percentiles: { p50: 120, p75: 180, p95: 310 },
      },
      previous: {
        status: "available",
        sampled_count: 38,
        estimated_count: 49,
        percentiles: { p50: 100, p75: 160, p95: 300 },
      },
      comparison: {
        status: "available",
        percentiles: {
          p50: { current: 120, previous: 100, delta: 20, relative_change: 0.2 },
          p75: { current: 180, previous: 160, delta: 20, relative_change: 0.125 },
          p95: { current: 310, previous: 300, delta: 10, relative_change: 1 / 30 },
        },
      },
      trend: [{
        day: "2026-08-19",
        status: "available",
        sampled_count: 30,
        estimated_count: 35,
        percentiles: { p50: 120, p75: 180, p95: 310 },
      }],
      first_observation_at: "2026-08-12T15:00:00.000Z",
      latest_observation_at: "2026-08-19T14:00:00.000Z",
    }],
    freshness: {
      status: "available",
      queried_at: NOW,
      latest_observation_at: "2026-08-19T14:00:00.000Z",
      age_seconds: 1800,
    },
    data_health: {
      status: "available",
      accepted: 100,
      rejected: 2,
      rejected_by_reason: { unknown_surface: 1, unknown_component: 1 },
    },
  };
}

test("request parser exposes only the bounded operator vocabulary", () => {
  const parsed = parseAdminPerformanceRequest(new Request(
    `https://w/admin/performance?key=secret&window=30d&surface=home&component=none&metric=ttfb_ms&device=mobile&nav=reload&delivery=static&release=${RELEASE_ID}&compare=current-vs-previous`,
  ));
  assert.deepEqual(parsed, {
    window: "30d",
    filters: {
      surface_id: "home",
      component_id: "none",
      metric_id: "ttfb_ms",
      device_class: "mobile",
      navigation_type: "reload",
      delivery_class: "static",
      release_id: RELEASE_ID,
    },
    group_by: null,
  });

  const catalogRequest = parseAdminPerformanceRequest(new Request(
    "https://w/admin/performance?key=secret&window=24h",
  ));
  assert.equal(catalogRequest.group_by, "metric_id");

  for (const query of [
    "sql=select+1",
    "group_by=surface_id",
    "window=365d",
    "metric=unknown",
    "compare=none",
    "window=7d&window=30d",
  ]) {
    assert.throws(
      () => parseAdminPerformanceRequest(new Request(`https://w/admin/performance?key=secret&${query}`)),
      /Unsupported|repeated/,
      query,
    );
  }
});

test("admin response is a dedicated versioned read model with registered inventory", () => {
  const body = buildAdminPerformanceResponse(availableSnapshot());
  assert.equal(body.schema, ADMIN_PERFORMANCE_SCHEMA);
  assert.equal(body.status, "available");
  assert.equal(body.operational_status, "flowing");
  assert.equal(body.implementation_status, "code_complete");
  assert.deepEqual(body.coarse_summary.rows[0], {
    metric_id: "ttfb_ms",
    sampled_count: 42,
    latest_observation_at: "2026-08-19T14:00:00.000Z",
    status: "flowing",
    p50: 120,
    p75: 180,
    p95: 310,
  });
  assert.equal(body.query.comparison, "current-vs-previous");
  assert.equal(body.catalog.metrics.length, 13);
  assert.equal(body.coverage.registered.surface_count, 36);
  assert.equal(body.coverage.registered.component_count, 20);
  assert.equal(body.coverage.selection.surface.surface_id, "home");
  assert.equal(body.coverage.selection.surface.lifecycle_state, "instrumented");
  assert.equal(body.coverage.unclassified_observations.status, "unclassified");
  assert.equal(body.coverage.unclassified_observations.count, 2);
  assert.deepEqual(body.series[0].current.percentiles, { p50: 120, p75: 180, p95: 310 });
  assert.equal(Object.hasOwn(body, "credentials"), false);
});

test("operational states separate code completion from observed flow", () => {
  assert.deepEqual(ADMIN_PERFORMANCE_OPERATIONAL_STATES, [
    "code_complete",
    "flowing",
    "no_data",
    "insufficient_sample",
    "uninstrumented",
    "unavailable",
  ]);
});

test("committed available response fixture stays byte-structurally compatible for Desk", () => {
  const plan = performanceAnalyticsQueryPlan(QUERY_FIXTURE.query, {
    now: QUERY_FIXTURE.now,
    configuredSince: QUERY_FIXTURE.configured_since,
    sampleFloor: QUERY_FIXTURE.sample_floor,
  });
  const snapshot = buildPerformanceSnapshot(QUERY_FIXTURE.sql_results, plan, {
    dataHealth: {
      status: "available",
      window_days: 7,
      accepted: 100,
      rejected: 2,
      rejected_by_reason: { unknown_surface: 1, unknown_component: 1 },
      unsupported: 0,
      excluded: { developer: 0, disabled: 0, non_production: 0 },
      storage: { status: "configured", configured_checks: 7, unavailable_checks: 0 },
      latest_accepted_at: "2026-08-19T14:00:00.000Z",
      latest_query_at: QUERY_FIXTURE.now,
      ingestion_delay_seconds: 1800,
    },
  });
  assert.deepEqual(buildAdminPerformanceResponse(snapshot), AVAILABLE_FIXTURE);
});

test("admin contract names every honest display state and never manufactures missing percentiles", () => {
  assert.deepEqual(ADMIN_PERFORMANCE_STATES, [
    "available",
    "partial",
    "insufficient_sample",
    "no_data",
    "uninstrumented",
    "unclassified",
    "unavailable",
  ]);
  assert.equal(STATE_FIXTURE.response_schema, ADMIN_PERFORMANCE_SCHEMA);
  assert.deepEqual(
    [...new Set(STATE_FIXTURE.cases.flatMap((entry) => [
      entry.expected_status,
      entry.expected_coverage_status,
    ]).filter(Boolean))].sort(),
    [...ADMIN_PERFORMANCE_STATES].sort(),
  );
  for (const fixtureCase of STATE_FIXTURE.cases.filter((entry) => entry.percentiles_present === false)) {
    assert.equal(fixtureCase.p50, undefined, fixtureCase.name);
    assert.equal(fixtureCase.p75, undefined, fixtureCase.name);
    assert.equal(fixtureCase.p95, undefined, fixtureCase.name);
  }

  for (const [queryStatus, expected] of [
    ["retention_partial", "partial"],
    ["insufficient_sample", "insufficient_sample"],
    ["no_data", "no_data"],
    ["unavailable", "unavailable"],
  ]) {
    const snapshot = availableSnapshot();
    snapshot.status = queryStatus;
    snapshot.series = queryStatus === "unavailable" ? [] : [{
      dimensions: {},
      current: { status: queryStatus },
      previous: { status: queryStatus },
      comparison: { status: queryStatus },
      trend: [],
      first_observation_at: null,
      latest_observation_at: null,
    }];
    if (queryStatus === "unavailable") snapshot.unavailable_reason = "not-configured";
    const body = buildAdminPerformanceResponse(snapshot);
    assert.equal(body.status, expected);
    assert.equal(body.operational_status, {
      retention_partial: "unavailable",
      insufficient_sample: "insufficient_sample",
      no_data: "no_data",
      unavailable: "unavailable",
    }[queryStatus]);
    assert.equal(body.coarse_summary.status, body.operational_status);
    assert.doesNotMatch(JSON.stringify(body), /"p(?:50|75|95)":0/);
  }
});

test("planned selections stay uninstrumented even when the query has no rows", () => {
  const snapshot = availableSnapshot({
    window: "7d",
    filters: { metric_id: "ttfb_ms", surface_id: "about" },
    group_by: null,
  });
  snapshot.status = "no_data";
  snapshot.series = [{
    dimensions: {},
    current: { status: "no_data" },
    previous: { status: "no_data" },
    comparison: { status: "no_data" },
    trend: [],
    first_observation_at: null,
    latest_observation_at: null,
  }];
  const body = buildAdminPerformanceResponse(snapshot);
  assert.equal(body.status, "uninstrumented");
  assert.equal(body.operational_status, "uninstrumented");
  assert.equal(body.implementation_status, "uninstrumented");
  assert.deepEqual(body.coarse_summary.rows[0], {
    metric_id: "ttfb_ms",
    sampled_count: null,
    latest_observation_at: null,
    status: "uninstrumented",
  });
});

test("GET /admin/performance uses the shared gate, is private no-store, and leaks no AE credentials", async () => {
  assert.equal((await handleAdminPerformance(new Request("https://w/admin/performance"), {})).status, 404);
  assert.equal((await handleAdminPerformance(
    new Request("https://w/admin/performance?key=wrong"),
    { ADMIN_KEY: "secret" },
  )).status, 401);
  assert.equal((await handleAdminPerformance(
    new Request("https://w/admin/performance?key=secret", { method: "POST" }),
    { ADMIN_KEY: "secret" },
  )).status, 405);

  let received;
  const env = {
    ADMIN_KEY: "secret",
    ANALYTICS_ACCOUNT_ID: "b".repeat(32),
    ANALYTICS_READ_TOKEN: "ae-super-secret",
  };
  const response = await handleAdminPerformance(
    new Request("https://w/admin/performance?key=secret&metric=ttfb_ms&surface=home"),
    env,
    {
      readPerformance: async (_env, query) => {
        received = query;
        return availableSnapshot(query);
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.match(response.headers.get("Content-Type"), /application\/json/);
  assert.deepEqual(received, {
    window: "7d",
    filters: { metric_id: "ttfb_ms", surface_id: "home" },
    group_by: null,
  });
  const text = await response.text();
  assert.doesNotMatch(text, /ae-super-secret|ANALYTICS_READ_TOKEN|ANALYTICS_ACCOUNT_ID|analytics_engine\/sql|SELECT/);
  const body = JSON.parse(text);
  assert.equal(body.schema, ADMIN_PERFORMANCE_SCHEMA);
  assert.equal(body.status, "available");
});

test("invalid filters are authenticated before returning a bounded 400", async () => {
  const hidden = await handleAdminPerformance(
    new Request("https://w/admin/performance?sql=select+1"),
    {},
  );
  assert.equal(hidden.status, 404);

  const invalid = await handleAdminPerformance(
    new Request("https://w/admin/performance?key=secret&sql=select+1"),
    { ADMIN_KEY: "secret" },
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await invalid.json(), {
    schema: ADMIN_PERFORMANCE_SCHEMA,
    status: "invalid_request",
    error: "Unsupported query parameter: sql",
  });
});

test("worker dispatch registers /admin/performance without adding a public performance route", async () => {
  const response = await worker.fetch(
    new Request("https://w/admin/performance?key=secret&window=24h&metric=lcp_ms"),
    { ADMIN_KEY: "secret" },
    {},
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal((await response.json()).schema, ADMIN_PERFORMANCE_SCHEMA);

  const publicAttempt = await worker.fetch(
    new Request("https://w/performance?window=24h&metric=lcp_ms"),
    {},
    {},
  );
  assert.equal(publicAttempt.status, 404);
});
