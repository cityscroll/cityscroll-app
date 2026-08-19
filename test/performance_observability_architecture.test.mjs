import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildFacts,
  buildPerformanceObservabilityFacts,
} from "../tools/build_architecture_facts.mjs";
import { buildWatermark } from "../tools/architecture_watermark.mjs";
import {
  buildPerformanceObservability,
  loadPerformanceRegistry,
} from "../tools/build_performance_observability.mjs";
import {
  parseWorkspace,
  reconcileArchitecture,
} from "../tools/reconcile_architecture.mjs";
import { classifyPerformancePathname } from "../site/performance_route_classifier.mjs";

const FIXTURE = JSON.parse(readFileSync(
  new URL("../architecture/backtests/rum-future-surface.json", import.meta.url),
  "utf8",
));
const MODEL = readFileSync(new URL("../architecture/workspace.dsl", import.meta.url), "utf8");

test("frozen future public surface stays unclassified instead of folding to Home or Browse", () => {
  assert.equal(FIXTURE.schema, "cityscroll.performance_observability.future_surface_backtest.v1");
  const performance = buildPerformanceObservabilityFacts({
    candidatePathnames: FIXTURE.candidates.map((entry) => entry.pathname),
  });
  assert.equal(performance.coverage.policy, "advisory");
  assert.equal(performance.coverage.merge_blocking, false);
  assert.deepEqual(performance.coverage.unclassified_candidates, [{
    pathname: "/future-civic-surface/",
    classification_state: "unclassified",
    surface_id: null,
  }]);
  assert.equal(performance.coverage.classification_counts.registered_no_data, 1);
  assert.equal(performance.coverage.classification_counts.unclassified, 1);
  assert.equal(performance.coverage.unclassified_candidates[0].surface_id, null);

  const { browser } = buildPerformanceObservability(loadPerformanceRegistry());
  for (const expected of FIXTURE.candidates) {
    const actual = classifyPerformancePathname(browser, expected.pathname);
    assert.equal(actual.classification_state, expected.expected_classification_state, expected.pathname);
    assert.equal(actual.surface_id, expected.expected_surface_id, expected.pathname);
    if (expected.expected_surface_id === null) {
      assert.notEqual(actual.surface_id, "home", expected.pathname);
      assert.notEqual(actual.surface_id, "browse", expected.pathname);
    }
  }
});

test("future-surface coverage remains visible in evidence without entering a hard reconciliation gate", () => {
  const current = buildFacts({ generatedAt: "2026-08-18T00:00:00Z", commit: "current" });
  const future = buildFacts({
    generatedAt: "2026-08-18T00:00:00Z",
    commit: "future",
    performanceCandidatePaths: FIXTURE.candidates.map((entry) => entry.pathname),
  });
  const finding = future.performance_observability.coverage.unclassified_candidates[0];
  assert.equal(finding.pathname, "/future-civic-surface/");
  assert.equal(finding.classification_state, "unclassified");
  assert.deepEqual(future.observer_coverage.unmapped_surfaces, []);

  const report = reconcileArchitecture({
    facts: future,
    baselineFacts: buildWatermark(current),
    model: parseWorkspace(MODEL),
  });
  assert.equal(report.status, "healthy");
  assert.deepEqual(report.outcomes.unmapped, []);
  assert.deepEqual(report.proposals, []);
});

test("C4 names the separate registry, collector path, intake, store, private endpoint, and Desk relationship", () => {
  const model = parseWorkspace(MODEL);
  for (const id of ["performance_registry", "rum_analytics", "private_desk"]) {
    assert.ok(model.elements.some((entry) => entry.id === id), id);
  }
  assert.ok(model.relationships.some((entry) => (
    entry.source === "browser_site"
    && entry.target === "worker_api"
    && entry.description.includes("/performance-events")
    && entry.description.includes("no network transport")
  )));
  assert.ok(model.relationships.some((entry) => (
    entry.source === "private_desk"
    && entry.target === "worker_api"
    && entry.description.includes("/admin/performance")
  )));
  assert.ok(model.relationships.some((entry) => (
    entry.source === "worker_api"
    && entry.target === "rum_analytics"
    && entry.description.includes("RUM_ANALYTICS")
  )));
});
