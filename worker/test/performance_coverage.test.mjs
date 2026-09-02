import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PERFORMANCE_ATTRIBUTION_PHASES,
  PERFORMANCE_COVERAGE_DEVICE_CLASSES,
  PERFORMANCE_COVERAGE_METRICS,
  PERFORMANCE_COVERAGE_SAMPLE_FLOOR,
  PERFORMANCE_COVERAGE_STATES,
  PERFORMANCE_COVERAGE_SURFACES,
  buildPerformanceCoverageLattice,
  classifyPerformanceCoverage,
} from "../src/lib/performance_coverage.mjs";
import {
  performanceCoverageQueryPlan,
  readPerformanceAnalytics,
} from "../src/lib/performance_query.mjs";

const pcts = { p50: 10, p75: 20, p95: 30 };
const historical = JSON.parse(readFileSync(
  new URL("./fixtures/performance_coverage_historical.v1.json", import.meta.url),
  "utf8",
));

test("the focused production plan reads readiness, device, and phase aggregates without widening the schema", () => {
  const plan = performanceCoverageQueryPlan({
    now: "2026-08-26T15:30:00.000Z",
    configuredSince: "2026-08-01T00:00:00.000Z",
  });
  assert.deepEqual(plan.requests.map(({ id }) => id), ["readiness", "devices", "phases"]);
  const readiness = plan.requests.find(({ id }) => id === "readiness").sql;
  const devices = plan.requests.find(({ id }) => id === "devices").sql;
  const phases = plan.requests.find(({ id }) => id === "phases").sql;
  for (const sql of [readiness, devices, phases]) {
    assert.match(sql, /blob10 = 'production'/);
    assert.match(sql, /blob2 IN \('content_ready_ms', 'component_ready_ms',/);
    assert.match(sql, /blob3 IN \('home', 'near-you', 'following', 'browse-contracts', 'notice', 'agency'\)/);
    assert.match(sql, /count\(\) AS sampled_count/);
    assert.match(sql, /sum\(_sample_interval\) AS estimated_count/);
  }
  assert.match(readiness, /GROUP BY metric_id, surface_id, component_id/);
  assert.match(devices, /GROUP BY metric_id, surface_id, device_class/);
  assert.match(phases, /GROUP BY metric_id, surface_id/);
  assert.doesNotMatch(readiness, /trace|record|session|query/i);
});

test("the registered contract enumerates six surfaces, both readiness metrics, devices, and phases", () => {
  assert.deepEqual(PERFORMANCE_COVERAGE_SURFACES.map(({ surface_id }) => surface_id), [
    "home", "near-you", "following", "browse-contracts", "notice", "agency",
  ]);
  assert.deepEqual(PERFORMANCE_COVERAGE_METRICS.map(({ metric_id }) => metric_id), [
    "content_ready_ms", "component_ready_ms",
  ]);
  assert.deepEqual(PERFORMANCE_COVERAGE_DEVICE_CLASSES, ["desktop", "mobile", "tablet", "unknown"]);
  assert.deepEqual(PERFORMANCE_ATTRIBUTION_PHASES.map(({ phase_id }) => phase_id), [
    "route-import", "response", "owner-settlement", "semantic-readiness",
  ]);
  assert.deepEqual(PERFORMANCE_COVERAGE_STATES, ["measured", "insufficient_sample", "no_data"]);
});

test("the shared classifier handles 0, 1, 29, 30, and above-30 retained rows", () => {
  for (const sampled_count of [0, 1, 29]) {
    const result = classifyPerformanceCoverage({ sampled_count, estimated_count: sampled_count * 50, ...pcts });
    assert.equal(result.state, sampled_count === 0 ? "no_data" : "insufficient_sample");
    assert.equal(result.percentiles, undefined);
  }
  assert.equal(classifyPerformanceCoverage({ sampled_count: 30, estimated_count: 90, ...pcts }).state, "measured");
  assert.equal(classifyPerformanceCoverage({ sampled_count: 31, estimated_count: 31, ...pcts }).state, "measured");
  assert.equal(
    classifyPerformanceCoverage({ sampled_count: 30, estimated_count: 300, ...pcts }).state,
    "measured",
    "weight does not replace retained-row sufficiency but does not invalidate a sufficient sample",
  );
});

test("missing measurements and zero-valued measurements stay distinct", () => {
  assert.equal(classifyPerformanceCoverage(null).state, "no_data");
  assert.equal(classifyPerformanceCoverage({ sampled_count: 30, estimated_count: 30, p50: 0, p75: 0, p95: 0 }).state, "measured");
  assert.equal(classifyPerformanceCoverage({ sampled_count: 30, estimated_count: 30, p50: null, p75: 1, p95: 2 }).state, "insufficient_sample");
  assert.equal(
    classifyPerformanceCoverage({ sampled_count: 30, estimated_count: 30, ...pcts }, { windowStatus: "partial" }).state,
    "insufficient_sample",
  );
});

test("the lattice emits every target cell, including zero-row Near You and Agency", () => {
  const lattice = buildPerformanceCoverageLattice({
    readinessRows: [
      { dimensions: { surface_id: "home", metric_id: "content_ready_ms", component_id: "none" }, current: { sampled_count: 30, estimated_count: 31, percentiles: pcts } },
      { dimensions: { surface_id: "agency", metric_id: "content_ready_ms", component_id: "none" }, current: { sampled_count: 0, estimated_count: 0 } },
      { dimensions: { surface_id: "near-you", metric_id: "component_ready_ms", component_id: "near-you-map" }, current: { sampled_count: 1, estimated_count: 50, percentiles: pcts } },
    ],
    sampleFloor: PERFORMANCE_COVERAGE_SAMPLE_FLOOR,
  });

  assert.equal(lattice.readiness.cells.filter((cell) => cell.surface_id === "home" && cell.metric_id === "content_ready_ms").length, 1);
  for (const surface of ["near-you", "agency"]) {
    for (const metric of ["content_ready_ms", "component_ready_ms"]) {
      assert.ok(lattice.readiness.cells.some((cell) => cell.surface_id === surface && cell.metric_id === metric));
    }
  }
  const nearYouPage = lattice.readiness.cells.find((cell) => cell.surface_id === "near-you" && cell.metric_id === "content_ready_ms");
  const agencyPage = lattice.readiness.cells.find((cell) => cell.surface_id === "agency" && cell.metric_id === "content_ready_ms");
  assert.equal(nearYouPage.state, "no_data");
  assert.equal(agencyPage.state, "no_data");
  assert.deepEqual(lattice.readiness.state_counts, { measured: 1, insufficient_sample: 1, no_data: 21 });
  assert.equal(lattice.devices.cells.length, 6 * 2 * 4);
  assert.equal(lattice.phases.cells.length, 6 * (1 + 2 + 1 + 2));
});

test("the 487-row historical snapshot remains a regression fixture, not a live-data promise", () => {
  assert.equal(historical.retained_rows, 487);
  assert.equal(historical.estimated_observations, 489);
  assert.equal(
    historical.readiness_groups.reduce((sum, group) => sum + group.sampled_count, 0),
    487,
  );
  assert.deepEqual(historical.coverage_facts["near-you"], { content_ready_ms: 0, component_ready_ms: 0 });
  assert.deepEqual(historical.coverage_facts.agency, { content_ready_ms: 0, component_ready_ms: 0 });
  const lattice = buildPerformanceCoverageLattice({
    readinessRows: historical.readiness_groups,
    sampleFloor: historical.sample_floor,
  });
  assert.equal(lattice.readiness.cells.find((cell) => cell.surface_id === "near-you" && cell.metric_id === "content_ready_ms").state, "no_data");
  assert.equal(lattice.readiness.cells.find((cell) => cell.surface_id === "agency" && cell.metric_id === "content_ready_ms").state, "no_data");
  assert.equal(lattice.readiness.cells.find((cell) => cell.surface_id === "following" && cell.component_id === "following-watch-list").state, "insufficient_sample");
  assert.equal(lattice.readiness.cells.find((cell) => cell.surface_id === "following" && cell.component_id === "following-watch-list").percentiles, undefined);
});

test("thin mobile, desktop, and unknown device groups are explicit and weighted rows are not duplicated", () => {
  const lattice = buildPerformanceCoverageLattice({
    deviceRows: [
      { surface_id: "home", metric_id: "content_ready_ms", device_class: "mobile", sampled_count: 29, estimated_count: 290, ...pcts },
      { surface_id: "home", metric_id: "content_ready_ms", device_class: "desktop", sampled_count: 30, estimated_count: 300, ...pcts },
      { surface_id: "home", metric_id: "content_ready_ms", device_class: "unknown", sampled_count: 1, estimated_count: 1000, ...pcts },
    ],
  });
  const cells = lattice.devices.cells.filter((cell) => cell.surface_id === "home" && cell.metric_id === "content_ready_ms");
  assert.equal(cells.find((cell) => cell.device_class === "mobile").state, "insufficient_sample");
  assert.equal(cells.find((cell) => cell.device_class === "desktop").state, "measured");
  assert.equal(cells.find((cell) => cell.device_class === "unknown").state, "insufficient_sample");
  assert.equal(cells.find((cell) => cell.device_class === "unknown").sampled_count, 1);
  assert.equal(cells.find((cell) => cell.device_class === "unknown").estimated_count, 1000);
  assert.equal(cells.find((cell) => cell.device_class === "unknown").percentiles, undefined);
});

test("each attribution phase is present or absent without collapsing into a generic bucket", () => {
  const lattice = buildPerformanceCoverageLattice({
    phaseRows: [
      { surface_id: "home", metric_id: "ttfb_ms", sampled_count: 30, estimated_count: 30, ...pcts },
      { surface_id: "home", metric_id: "first_render_to_main_ms", sampled_count: 29, estimated_count: 29, ...pcts },
      { surface_id: "home", metric_id: "main_to_useful_ms", sampled_count: 30, estimated_count: 30, ...pcts },
      { surface_id: "home", metric_id: "content_ready_ms", sampled_count: 30, estimated_count: 30, ...pcts },
    ],
  });
  const home = lattice.phases.cells.filter((cell) => cell.surface_id === "home");
  assert.equal(home.find((cell) => cell.phase_id === "route-import").state, "insufficient_sample");
  assert.equal(home.find((cell) => cell.phase_id === "response" && cell.metric_id === "ttfb_ms").state, "measured");
  assert.equal(home.find((cell) => cell.phase_id === "response" && cell.metric_id === "response_to_first_render_ms").state, "no_data");
  assert.equal(home.find((cell) => cell.phase_id === "owner-settlement").state, "measured");
  assert.equal(home.find((cell) => cell.phase_id === "semantic-readiness" && cell.metric_id === "content_ready_ms").state, "measured");
  assert.equal(home.find((cell) => cell.phase_id === "semantic-readiness" && cell.metric_id === "component_ready_ms").state, "no_data");
});

test("lattice ordering and output are deterministic and privacy-preserving", () => {
  const input = {
    readinessRows: [{
      dimensions: { surface_id: "home", metric_id: "content_ready_ms", component_id: "none" },
      current: { sampled_count: 30, estimated_count: 30, percentiles: pcts },
      route: "/notices/secret", record_id: "record-secret", query: "private", session_id: "session-secret",
    }],
  };
  const first = buildPerformanceCoverageLattice(input);
  const second = buildPerformanceCoverageLattice(input);
  assert.deepEqual(first, second);
  const output = JSON.stringify(first);
  for (const secret of ["/notices/secret", "record-secret", "private", "session-secret"]) {
    assert.equal(output.includes(secret), false);
  }
  assert.equal(first.readiness.cells[0].surface_id, "home");
  assert.equal(first.readiness.cells[0].metric_id, "content_ready_ms");
});

test("the authenticated read path attaches coverage without exposing query or trace payloads", async () => {
  const kv = new Map();
  const responses = [
    [], [], [], // ordinary current, trend, and previous series
    [{ metric_id: "content_ready_ms", surface_id: "home", component_id: "none", sampled_count: 30, estimated_count: 90, ...pcts }],
    [{ metric_id: "content_ready_ms", surface_id: "home", device_class: "mobile", sampled_count: 29, estimated_count: 290, ...pcts }],
    [{ metric_id: "ttfb_ms", surface_id: "home", sampled_count: 30, estimated_count: 30, ...pcts }],
  ];
  const calls = [];
  const snapshot = await readPerformanceAnalytics({
    ANALYTICS_ACCOUNT_ID: "a".repeat(32),
    ANALYTICS_READ_TOKEN: "opaque-test-token",
    RUM_MEASURED_SINCE: "2026-08-01T00:00:00.000Z",
    ALERT_STATE: {
      async get(key) { return kv.get(key) ?? null; },
      async put(key, value) { kv.set(key, value); },
    },
  }, {
    window: "7d",
    filters: { metric_id: "content_ready_ms" },
    group_by: "surface_id",
  }, {
    now: new Date("2026-08-26T15:30:00.000Z"),
    coverage: true,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body });
      return { ok: true, status: 200, async json() { return { data: responses.shift() }; } };
    },
  });
  assert.equal(calls.length, 6);
  assert.equal(snapshot.coverage_lattice.read_status, "available");
  assert.equal(snapshot.coverage_lattice.readiness.cells.find((cell) => cell.surface_id === "home" && cell.metric_id === "content_ready_ms" && cell.component_id === "none").state, "measured");
  assert.equal(snapshot.coverage_lattice.devices.cells.find((cell) => cell.surface_id === "home" && cell.metric_id === "content_ready_ms" && cell.device_class === "mobile").state, "insufficient_sample");
  assert.equal(snapshot.coverage_lattice.phases.cells.find((cell) => cell.surface_id === "home" && cell.phase_id === "response" && cell.metric_id === "ttfb_ms").state, "measured");
  assert.equal(JSON.stringify(snapshot).includes("opaque-test-token"), false);
  assert.equal(JSON.stringify(snapshot).includes("SELECT"), false);
  assert.ok(calls.every(({ body }) => !/trace|record|session|query/i.test(body)));
});

test("an unavailable provider still returns every coverage cell with explicit states", async () => {
  const snapshot = await readPerformanceAnalytics({}, {
    window: "7d",
    filters: { metric_id: "content_ready_ms", traffic_class: "production" },
    group_by: "surface_id",
  }, {
    now: new Date("2026-08-26T15:30:00.000Z"),
    coverage: true,
  });
  assert.equal(snapshot.status, "unavailable");
  assert.equal(snapshot.coverage_lattice.read_status, "unavailable");
  for (const dimension of ["readiness", "devices", "phases"]) {
    assert.ok(snapshot.coverage_lattice[dimension].cells.every((cell) => cell.state === "no_data"));
  }
});
