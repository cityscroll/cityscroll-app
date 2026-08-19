import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MAX_PERFORMANCE_GROUPS,
  MAX_PERFORMANCE_TREND_DAYS,
  PERFORMANCE_SAMPLING_SEMANTICS,
  PerformanceQueryError,
  buildPerformanceSnapshot,
  normalizePerformanceQuery,
  performanceAnalyticsQueryPlan,
  readPerformanceAnalytics,
} from "../src/lib/performance_query.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/performance_query_weighted.json", import.meta.url),
  "utf8",
));

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, value); },
  };
}

function plan(overrides = {}) {
  return performanceAnalyticsQueryPlan(overrides.query || fixture.query, {
    now: overrides.now || fixture.now,
    configuredSince: overrides.configuredSince || fixture.configured_since,
    sampleFloor: overrides.sampleFloor ?? fixture.sample_floor,
    dataset: overrides.dataset,
  });
}

function findSeries(snapshot, surfaceId) {
  return snapshot.series.find((series) => series.dimensions.surface_id === surfaceId);
}

test("bounded SQL uses per-row adaptive weights for counts and distributions", () => {
  const queryPlan = plan();
  assert.deepEqual(queryPlan.requests.map(({ id }) => id), ["current", "trend", "previous"]);

  for (const { sql } of queryPlan.requests) {
    assert.match(sql, /FROM crol_rum_observations_v1/);
    assert.match(sql, /blob1 = 'cityscroll\.performance_observation\.v1'/);
    assert.match(sql, /blob2 = 'ttfb_ms'/);
    assert.match(sql, /blob6 = 'mobile'/);
    assert.match(sql, /blob10 = 'production'/);
    assert.match(sql, /count\(\) AS sampled_count/);
    assert.match(sql, /sum\(_sample_interval\) AS estimated_count/);
    assert.match(sql, /quantileExactWeighted\(0\.50\)\(double1, _sample_interval\) AS p50/);
    assert.match(sql, /quantileExactWeighted\(0\.75\)\(double1, _sample_interval\) AS p75/);
    assert.match(sql, /quantileExactWeighted\(0\.95\)\(double1, _sample_interval\) AS p95/);
    assert.doesNotMatch(sql, /sum\(_sample_interval \* double1\)/, "usage-count aggregation is invalid for latency distributions");
  }

  const summary = queryPlan.requests.find(({ id }) => id === "current").sql;
  const trend = queryPlan.requests.find(({ id }) => id === "trend").sql;
  assert.match(summary, new RegExp(`LIMIT ${MAX_PERFORMANCE_GROUPS + 1}$`));
  assert.match(trend, new RegExp(`LIMIT ${MAX_PERFORMANCE_GROUPS * MAX_PERFORMANCE_TREND_DAYS + 1}$`));
  assert.match(trend, /GROUP BY day, surface_id/);

  assert.equal(PERFORMANCE_SAMPLING_SEMANTICS.method, "cloudflare_weighted_adaptive_sampling");
  assert.match(PERFORMANCE_SAMPLING_SEMANTICS.sufficiency, /estimated_count is never used/);
});

test("fixture-backed rows expose weighted percentiles, daily trends, and equal-window comparison", () => {
  const queryPlan = plan();
  const snapshot = buildPerformanceSnapshot(fixture.sql_results, queryPlan, {
    dataHealth: { status: "available", accepted: 10 },
  });
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.retention.current.status, "complete");
  assert.equal(snapshot.retention.previous.status, "complete");

  const source = fixture.weighted_source_examples.current_home;
  const home = findSeries(snapshot, "home");
  assert.equal(home.current.sampled_count, source.length);
  assert.equal(home.current.estimated_count, source.reduce((sum, row) => sum + row.sample_interval, 0));
  assert.deepEqual(home.current.percentiles, { p50: 240, p75: 360, p95: 480 });
  assert.deepEqual(home.comparison.percentiles.p50, {
    current: 240,
    previous: 200,
    delta: 40,
    relative_change: 0.2,
  });
  assert.equal(home.trend.length, 8, "an exact 7-day interval can overlap eight UTC dates");
  assert.deepEqual(home.trend.find(({ day }) => day === "2026-08-13").percentiles, {
    p50: 210,
    p75: 300,
    p95: 430,
  });
  assert.equal(home.trend.find(({ day }) => day === "2026-08-14").status, "no_data");
  assert.equal(snapshot.freshness.latest_observation_at, "2026-08-19T14:00:00.000Z");
  assert.equal(snapshot.freshness.age_seconds, 1800);
});

test("the sampled-row floor withholds a heavily weighted low-sample distribution", () => {
  const snapshot = buildPerformanceSnapshot(fixture.sql_results, plan());
  const browse = findSeries(snapshot, "browse-contracts");
  assert.deepEqual(browse.current, {
    status: "insufficient_sample",
    sampled_count: 2,
    estimated_count: 100,
    sample_floor: 4,
  });
  assert.equal(browse.comparison.status, "insufficient_sample");
  assert.equal(Object.hasOwn(browse.current, "percentiles"), false);
  assert.equal(Object.hasOwn(browse.current, "p50"), false);
  assert.doesNotMatch(JSON.stringify(browse), /"p(?:50|75|95)":0/);
});

test("no-data and retention-partial windows never synthesize zero percentiles", () => {
  const noData = buildPerformanceSnapshot({ current: [], previous: [], trend: [] }, plan({
    query: { window: "24h", filters: { metric_id: "lcp_ms" } },
  }));
  assert.equal(noData.status, "no_data");
  assert.deepEqual(noData.series[0].current, { status: "no_data" });
  assert.deepEqual(noData.series[0].previous, { status: "no_data" });

  const providerEmptyAggregate = buildPerformanceSnapshot({
    current: [{
      sampled_count: 0,
      estimated_count: null,
      p50: null,
      p75: null,
      p95: null,
      first_observation_at: null,
      latest_observation_at: null,
    }],
    previous: [],
    trend: [],
  }, plan({ query: { window: "24h", filters: { metric_id: "lcp_ms" } } }));
  assert.deepEqual(providerEmptyAggregate.series[0].current, { status: "no_data" });

  assert.throws(() => buildPerformanceSnapshot({
    current: [{
      sampled_count: 4,
      estimated_count: 4,
      p50: null,
      p75: 100,
      p95: 200,
      first_observation_at: "2026-08-19T12:00:00Z",
      latest_observation_at: "2026-08-19T13:00:00Z"
    }],
    previous: [],
    trend: [],
  }, plan({ query: { window: "24h", filters: { metric_id: "lcp_ms" } } })), /invalid-query-result/);

  const partialPlan = plan({ configuredSince: "2026-08-18T20:00:00.000Z" });
  const partial = buildPerformanceSnapshot(fixture.sql_results, partialPlan);
  assert.equal(partial.status, "retention_partial");
  assert.equal(partial.retention.current.status, "partial");
  for (const series of partial.series) {
    assert.equal(series.current.status, "retention_partial");
    assert.equal(Object.hasOwn(series.current, "percentiles"), false);
    assert.equal(series.comparison.status, "retention_partial");
  }
  assert.doesNotMatch(JSON.stringify(partial), /"p(?:50|75|95)":0/);

  const ninetyDay = plan({
    query: { window: "90d", filters: { metric_id: "ttfb_ms" } },
    configuredSince: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(ninetyDay.current.status, "complete");
  assert.equal(ninetyDay.previous.status, "partial");
  assert.equal(ninetyDay.requests.some(({ id }) => id === "previous"), false);
});

test("query grammar rejects arbitrary windows, dimensions, filters, and unsafe scopes", () => {
  const invalid = [
    { window: "365d", filters: { metric_id: "ttfb_ms" } },
    { window: "7d", filters: { metric_id: "ttfb_ms", sql: "DROP TABLE x" } },
    { window: "7d", filters: { metric_id: "ttfb_ms" }, group_by: "visitor_id" },
    { window: "7d", filters: { surface_id: "home" } },
    { window: "7d", filters: { metric_id: "speed_score" } },
    { window: "7d", filters: { metric_id: "ttfb_ms", release_id: "not-a-release" } },
    { window: "7d", filters: { metric_id: "ttfb_ms", surface_id: "home" }, future: true },
  ];
  for (const input of invalid) assert.throws(() => normalizePerformanceQuery(input), PerformanceQueryError);
  assert.throws(() => plan({ dataset: "rum; SELECT *" }), PerformanceQueryError);
  assert.throws(() => plan({ sampleFloor: 0 }), PerformanceQueryError);

  assert.deepEqual(normalizePerformanceQuery({
    window: "30d",
    filters: { metric_id: "ttfb_ms", surface_id: "browse-money" },
  }).filters, { metric_id: "ttfb_ms", surface_id: "browse-contracts" });
});

test("read adapter keeps credentials server-side and returns explicit unavailable states", async () => {
  const secret = "your-analytics-read-token-here";
  const kv = fakeKV({
    "stats:rum_health.accepted:2026-08-19": "7",
    "stats:rum_health.invalid_value:2026-08-19": "2",
    "stats:rum_health.storage_configured:2026-08-19": "3",
    "stats:rum_health.storage_unavailable:2026-08-19": "1",
    "rum:health:latest-accepted": "2026-08-19T14:29:00.000Z",
  });
  const resultQueue = [fixture.sql_results.current, fixture.sql_results.trend, fixture.sql_results.previous];
  const calls = [];
  const snapshot = await readPerformanceAnalytics({
    ANALYTICS_ACCOUNT_ID: "a".repeat(32),
    ANALYTICS_READ_TOKEN: secret,
    RUM_ANALYTICS_DATASET: "crol_rum_observations_v1",
    RUM_MEASURED_SINCE: fixture.configured_since,
    ALERT_STATE: kv,
  }, fixture.query, {
    now: new Date(fixture.now),
    sampleFloor: fixture.sample_floor,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, async json() { return { data: resultQueue.shift() }; } };
    },
  });

  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ init }) => init.headers.Authorization === `Bearer ${secret}`));
  assert.equal(snapshot.status, "available");
  assert.equal(snapshot.data_health.accepted, 7);
  assert.equal(snapshot.data_health.rejected, 2);
  assert.equal(snapshot.data_health.storage.status, "degraded");
  assert.equal(snapshot.data_health.ingestion_delay_seconds, 60);
  assert.equal(snapshot.data_health.latest_query_at, fixture.now);
  assert.equal(kv.store.get("rum:health:latest-query"), fixture.now);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(snapshot), /analytics_engine\/sql|SELECT|crol_rum_observations_v1/);

  const unavailable = await readPerformanceAnalytics({ ALERT_STATE: kv }, {
    window: "7d",
    filters: { metric_id: "ttfb_ms" },
  }, { now: new Date(fixture.now) });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.unavailable_reason, "not-configured");
  assert.deepEqual(unavailable.series, []);
  assert.equal(Object.hasOwn(unavailable, "percentiles"), false);

  const sqlFailure = await readPerformanceAnalytics({
    ANALYTICS_ACCOUNT_ID: "a".repeat(32),
    ANALYTICS_READ_TOKEN: secret,
    RUM_MEASURED_SINCE: fixture.configured_since,
  }, { window: "7d", filters: { metric_id: "ttfb_ms" } }, {
    now: new Date(fixture.now),
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(sqlFailure.status, "unavailable");
  assert.equal(sqlFailure.unavailable_reason, "sql-503");
  assert.equal(sqlFailure.data_health.status, "unavailable");
});
