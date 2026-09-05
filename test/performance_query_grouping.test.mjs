import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildPerformanceSnapshot,
  performanceAnalyticsQueryPlan,
  performanceCoverageQueryPlan,
} from "../worker/src/lib/performance_query.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/rum_refresh_03_grouping.v1.json", import.meta.url),
  "utf8",
));
const GROUPS = ["metric_id", "surface_id", "component_id"];

test("the production readiness query groups both semantic metrics by surface and component", () => {
  const plan = performanceCoverageQueryPlan({
    now: fixture.now,
    configuredSince: fixture.configured_since,
    sampleFloor: fixture.sample_floor,
  });
  const readiness = plan.requests.find(({ id }) => id === "readiness");
  assert.deepEqual(readiness.group_by, GROUPS);
  assert.match(readiness.sql, /blob2 IN \('content_ready_ms', 'component_ready_ms'\)/);
  assert.match(readiness.sql, /blob3 IN \('home', 'near-you', 'following', 'browse-contracts', 'notice', 'agency'\)/);
  assert.match(readiness.sql, /count\(\) AS sampled_count/);
  assert.match(readiness.sql, /quantileExactWeighted\(0\.50\)\(double1, _sample_interval\) AS p50/);
  assert.match(readiness.sql, /quantileExactWeighted\(0\.75\)\(double1, _sample_interval\) AS p75/);
  assert.match(readiness.sql, /quantileExactWeighted\(0\.95\)\(double1, _sample_interval\) AS p95/);
  assert.match(readiness.sql, /max\(double2\) AS latest_timestamp/);
});

test("grouped read-back keeps six surface owners and the Notice component owner distinct", () => {
  const plan = performanceAnalyticsQueryPlan({
    window: "7d",
    filters: { traffic_class: "production" },
    group_by: GROUPS,
  }, {
    now: fixture.now,
    configuredSince: fixture.configured_since,
    sampleFloor: fixture.sample_floor,
  });
  const snapshot = buildPerformanceSnapshot({
    current: fixture.rows,
    previous: [],
    trend: [],
  }, plan);

  const contentRows = snapshot.series.filter(({ dimensions }) => dimensions.metric_id === "content_ready_ms");
  assert.deepEqual(
    contentRows.map(({ dimensions }) => dimensions.surface_id).sort(),
    ["agency", "browse-contracts", "following", "home", "near-you", "notice"],
  );
  const noticeContext = snapshot.series.find(({ dimensions }) =>
    dimensions.metric_id === "component_ready_ms"
      && dimensions.surface_id === "notice"
      && dimensions.component_id === "notice-context");
  assert.ok(noticeContext);
  assert.deepEqual(noticeContext.current, {
    status: "available",
    sampled_count: 4,
    estimated_count: 10,
    percentiles: { p50: 1200, p75: 2400, p95: 5200 },
  });
  assert.equal(noticeContext.latest_timestamp, 890);
  assert.equal(snapshot.series.find(({ dimensions }) => dimensions.surface_id === "home").current.percentiles.p75, 360);
  assert.equal(snapshot.series.find(({ dimensions }) => dimensions.surface_id === "home").current.sampled_count, 4);
  assert.equal(snapshot.series.find(({ dimensions }) => dimensions.surface_id === "home").latest_timestamp, 410);
});
