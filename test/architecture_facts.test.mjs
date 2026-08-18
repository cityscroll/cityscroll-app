import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildFacts,
  buildObserverCoverage,
  dispatchRoutes,
  parseBindings,
  parseCrons,
  parseRoutes,
} from "../tools/build_architecture_facts.mjs";

const facts = buildFacts({ generatedAt: "2026-08-16T00:00:00Z", commit: "test-commit" });
const wrangler = readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
const worker = readFileSync(new URL("../worker/src/worker.mjs", import.meta.url), "utf8");

test("generated architecture facts contain every LA4 section", () => {
  for (const key of ["routes", "bindings", "crons", "warehouse", "migrations", "entity_resolution", "ontology", "observer_coverage"]) {
    assert.ok(key in facts, key);
  }
  assert.equal(facts.schema, "cityscroll.architecture.facts.v1");
  assert.equal(facts.generator.version, "1.1.0");
  assert.ok(facts.commit);
  assert.ok(facts.source_paths.includes("worker/wrangler.toml"));
});

test("extractor records active config and dispatch evidence", () => {
  const routes = parseRoutes(wrangler);
  const dispatch = dispatchRoutes(worker);
  assert.ok(routes.some((route) => route.pattern === "api.cityscroll.org" && route.custom_domain === true));
  assert.ok(dispatch.some((route) => route.path === "/hearings" && route.handler === "handleHearings"));
  assert.deepEqual(parseCrons(wrangler).map((cron) => cron.schedule), ["0 10 * * *", "0 13 * * *"]);
});

test("absent bindings remain explicit nulls", () => {
  const bindings = parseBindings(wrangler).environments;
  assert.equal(bindings.production.r2_buckets, null);
  assert.equal(bindings.beta.d1_databases, null);
  assert.equal(bindings.beta.kv_namespaces, null);
  assert.equal(bindings.production.queues.producers[0].binding, "DIGEST_QUEUE");
});

test("generated facts identify warehouse, migrations, ER, and ontology evidence", () => {
  assert.deepEqual(facts.warehouse.engines.map((engine) => engine.name).sort(), ["duckdb", "parquet"]);
  assert.ok(facts.warehouse.adapters.length > 0);
  assert.ok(facts.migrations.some((migration) => migration.file === "worker/migrations/0019_civic_time_events.sql"));
  assert.equal(facts.entity_resolution.package.path, "entity_resolution/index.mjs");
  assert.ok(facts.entity_resolution.importers.some((item) => item.file === "worker/src/entity_intelligence.mjs"));
  assert.equal(facts.ontology.registry.schema, "cityscroll.ontology.registry.v0");
  assert.ok(facts.ontology.sources.some((item) => item.name === "public_graph"));
});

test("observer_coverage lists known canaries and unmapped surfaces", () => {
  const coverage = facts.observer_coverage;
  assert.ok(coverage);
  assert.ok(Array.isArray(coverage.observed_paths));
  assert.ok(Array.isArray(coverage.known_canaries));
  assert.ok(Array.isArray(coverage.unmapped_surfaces));
  assert.deepEqual(coverage.observed_paths, facts.source_paths);
  assert.equal(coverage.source.path, "architecture/observer-canaries.json");
  assert.ok(coverage.known_canaries.length > 0);
  for (const canary of coverage.known_canaries) {
    assert.ok(canary.id);
    assert.ok(canary.path);
  }
  const listed = JSON.parse(readFileSync(new URL("../architecture/observer-canaries.json", import.meta.url), "utf8"));
  assert.equal(coverage.known_canaries.length, listed.canaries.length);
  for (const entry of listed.canaries) {
    assert.ok(entry.id);
    assert.ok(entry.path);
    assert.ok(entry.why);
  }
});

test("a canary path not in observed_paths lands in unmapped_surfaces", () => {
  const coverage = buildObserverCoverage(
    ["worker/wrangler.toml", "ontology/registry.v0.json"],
    [
      { id: "worker-bindings", path: "worker/wrangler.toml" },
      { id: "production-search", path: "worker/src/search.mjs" },
    ],
  );
  assert.deepEqual(coverage.unmapped_surfaces, [{ id: "production-search", path: "worker/src/search.mjs" }]);
  assert.deepEqual(coverage.known_canaries.map((item) => item.id).sort(), ["production-search", "worker-bindings"]);
  assert.equal(coverage.unmapped_surfaces.some((item) => item.id === "worker-bindings"), false);
});

test("current HEAD reports search, index, and constellation canaries as unmapped", () => {
  const unmapped = new Set(facts.observer_coverage.unmapped_surfaces.map((item) => item.path));
  for (const path of [
    "worker/src/search.mjs",
    "tools/build_keyword_search_index.mjs",
    "site/agency_search_producer.mjs",
    "site/agency_constellation_model.mjs",
  ]) {
    assert.ok(unmapped.has(path), path);
  }
  assert.equal(unmapped.has("ontology/registry.v0.json"), false);
  assert.equal(unmapped.has("worker/wrangler.toml"), false);
});

test("observer_coverage is stable across runs", () => {
  const first = buildFacts({ generatedAt: "2026-08-16T00:00:00Z", commit: "test-commit" });
  const second = buildFacts({ generatedAt: "2026-08-16T00:00:00Z", commit: "test-commit" });
  assert.deepEqual(first.observer_coverage, second.observer_coverage);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
