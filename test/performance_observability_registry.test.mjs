import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildPerformanceObservability,
  loadPerformanceRegistry,
  projectionOutputs,
  renderProjection,
  validatePerformanceRegistry,
} from "../tools/build_performance_observability.mjs";
import {
  classifyPerformanceComponent,
  classifyPerformancePathname,
} from "../site/performance_route_classifier.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const REGISTRY_PATH = new URL("../architecture/performance-observability.v1.json", import.meta.url).pathname;
const UNKNOWN_FIXTURE = JSON.parse(readFileSync(
  new URL("fixtures/performance_observability/unknown-route.json", import.meta.url),
  "utf8",
));

function registry() {
  return loadPerformanceRegistry(REGISTRY_PATH);
}

function keysDeep(value, found = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => keysDeep(item, found));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      found.add(key);
      keysDeep(item, found);
    }
  }
  return found;
}

test("canonical performance registry validates stable, privacy-safe identity", () => {
  const source = registry();
  assert.equal(validatePerformanceRegistry(source, { root: ROOT }), source);
  assert.ok(source.surfaces.length >= 25, "current route families are registered rather than grouped into home");
  assert.ok(source.components.some((entry) => entry.kind === "interaction"));
  const ids = [
    ...source.surfaces.map((entry) => entry.surface_id),
    ...source.components.map((entry) => entry.component_id),
  ];
  for (const id of ids) {
    assert.match(id, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
    assert.doesNotMatch(id, /\d{4,}|[:/?#%]/, `${id} must not encode record IDs or user input`);
  }
  for (const componentId of [
    "near-you-borough",
    "near-you-community-district",
    "near-you-council-district",
  ]) {
    assert.ok(source.components.some((entry) => entry.component_id === componentId), componentId);
  }
});

test("one source deterministically emits all three byte-stable projections", () => {
  const source = registry();
  const first = buildPerformanceObservability(source, { root: ROOT });
  const second = buildPerformanceObservability(JSON.parse(JSON.stringify(source)), { root: ROOT });
  assert.deepEqual(second, first);
  assert.equal(renderProjection(second.browser), renderProjection(first.browser));
  assert.equal(renderProjection(second.worker), renderProjection(first.worker));
  assert.equal(renderProjection(second.operator), renderProjection(first.operator));
  assert.equal(first.browser.registry_hash, first.worker.registry_hash);
  assert.equal(first.worker.registry_hash, first.operator.registry_hash);

  for (const [path, expected] of projectionOutputs(first, { root: ROOT })) {
    assert.equal(readFileSync(path, "utf8"), expected, `${path} must be generated from the registry`);
  }
});

test("unknown future routes remain unclassified instead of folding into home or Browse", () => {
  const { browser } = buildPerformanceObservability(registry(), { root: ROOT });
  for (const fixture of UNKNOWN_FIXTURE.cases) {
    const classification = classifyPerformancePathname(browser, fixture.pathname);
    assert.equal(classification.classification_state, fixture.expected_state, fixture.pathname);
    assert.equal(classification.surface_id, null, fixture.pathname);
    assert.notEqual(classification.surface_id, "home", fixture.pathname);
    assert.notEqual(classification.surface_id, "browse", fixture.pathname);
  }
  assert.equal(classifyPerformancePathname(browser, "/").surface_id, "home");
  assert.equal(classifyPerformancePathname(browser, "/browse/property/").surface_id, "browse-property");
  assert.equal(classifyPerformancePathname(browser, "/notices/opaque-record-value").surface_id, "notice");
  assert.equal(classifyPerformancePathname(browser, "/near-you/borough/queens/land/").surface_id, "near-you");
  assert.equal(classifyPerformancePathname(browser, "/search/?q=private").surface_id, null, "query-bearing input is rejected");
});

test("semantic component matching is bounded and has no generic fallback", () => {
  const { browser } = buildPerformanceObservability(registry(), { root: ROOT });
  assert.deepEqual(classifyPerformanceComponent(browser, "place-scope-community-district"), {
    classification_state: "registered_no_data",
    component_id: "near-you-community-district",
    kind: "component",
  });
  assert.deepEqual(classifyPerformanceComponent(browser, "future-component"), {
    classification_state: "unclassified",
    component_id: null,
    kind: null,
  });
});

test("browser projection excludes private operator and implementation fields", () => {
  const { browser, operator } = buildPerformanceObservability(registry(), { root: ROOT });
  const browserKeys = keysDeep(browser);
  for (const privateKey of [
    "operator_label",
    "owner_source_path",
    "architecture_container_ref",
    "definition",
    "reason",
  ]) {
    assert.equal(browserKeys.has(privateKey), false, privateKey);
  }
  assert.ok(operator.surfaces.every((entry) => entry.operator_label && entry.owner_source_path));
  assert.ok(operator.components.every((entry) => entry.semantic_readiness.definition));
});

test("aliases and supersedes preserve renamed identity across every consumer", () => {
  const source = registry();
  const zoning = source.surfaces.find((entry) => entry.surface_id === "browse-zoning");
  assert.deepEqual(zoning.supersedes, ["browse-land"]);
  const { browser, worker, operator } = buildPerformanceObservability(source, { root: ROOT });
  assert.equal(worker.surface_aliases["browse-land"], "browse-zoning");
  assert.ok(worker.accepted_surface_ids.includes("browse-land"));
  assert.equal(
    browser.surfaces.find((entry) => entry.surface_id === "browse-zoning").aliases[0].alias_id,
    "browse-land",
  );
  const privateZoning = operator.surfaces.find((entry) => entry.surface_id === "browse-zoning");
  assert.deepEqual(privateZoning.supersedes, ["browse-land"]);
  assert.match(privateZoning.aliases[0].reason, /historical observations/);
});

test("one canonical registration propagates to browser, Worker, and operator inventories", () => {
  const source = registry();
  const next = JSON.parse(JSON.stringify(source));
  next.surfaces.push({
    ...next.surfaces.find((entry) => entry.surface_id === "about"),
    surface_id: "future-civic-surface",
    operator_label: "Future civic surface",
    route_family: "future-civic-surface",
    public_safe_matcher: [{ kind: "exact", pathname: "/future-civic-surface" }],
    aliases: [],
    supersedes: [],
  });
  const projections = buildPerformanceObservability(next, { root: ROOT });
  assert.ok(projections.browser.surfaces.some((entry) => entry.surface_id === "future-civic-surface"));
  assert.ok(projections.worker.surface_ids.includes("future-civic-surface"));
  assert.ok(projections.operator.surfaces.some((entry) => entry.surface_id === "future-civic-surface"));
  assert.equal(
    classifyPerformancePathname(projections.browser, "/future-civic-surface/").surface_id,
    "future-civic-surface",
  );
  assert.equal(projections.browser.registry_hash, projections.worker.registry_hash);
  assert.equal(projections.worker.registry_hash, projections.operator.registry_hash);
});

test("Worker allowlist carries metric, delivery, component, and inherited parent constraints", () => {
  const { worker } = buildPerformanceObservability(registry(), { root: ROOT });
  assert.equal(worker.collector.production_enabled, false);
  assert.equal(worker.collector.library_version, "6.0.1");
  assert.deepEqual(worker.collector.device_classes, ["desktop", "mobile", "tablet", "unknown"]);
  assert.ok(worker.collector.navigation_types.includes("back-forward-cache"));
  assert.ok(worker.metric_ids.includes("content_ready_ms"));
  assert.deepEqual(worker.delivery_classes, ["hybrid", "pages_edge", "static", "worker_backed"]);
  assert.ok(worker.component_ids.includes("none"));
  assert.ok(worker.surfaces["browse-zoning"].allowed_component_ids.includes("browse-results"));
  assert.ok(worker.components["browse-filter-apply"].applicable_surface_ids.includes("browse-contracts"));
  assert.deepEqual(worker.components["near-you-community-district"].applicable_surface_ids, ["near-you"]);
});
