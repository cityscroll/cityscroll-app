import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildFacts } from "../tools/build_architecture_facts.mjs";
import {
  WATERMARK_RELATIVE,
  WATERMARK_SCHEMA,
  buildWatermark,
  isWatermark,
  loadWatermark,
  observerCoverageHash,
} from "../tools/architecture_watermark.mjs";

const facts = buildFacts({ generatedAt: "2026-08-16T00:00:00Z", commit: "test-commit" });
const committed = JSON.parse(readFileSync(new URL("../architecture/generated/watermark.json", import.meta.url), "utf8"));

test("committed watermark is compact, schema-stamped, and not a facts dump", () => {
  assert.equal(committed.schema, WATERMARK_SCHEMA);
  assert.equal(isWatermark(committed), true);
  assert.ok(committed.observer_coverage_hash);
  assert.equal(committed.observer_coverage_hash.length, 64);
  assert.ok(committed.canaries);
  assert.ok(committed.canaries["production-search"]);
  assert.ok(committed.canaries["production-search"].fingerprint);
  assert.equal(typeof committed.canaries["production-search"].count, "number");
  assert.ok(committed.ontology);
  assert.ok(Array.isArray(committed.bindings.topology));
  assert.ok(committed.bindings.topology.length > 0);
  assert.ok(committed.performance_observability);
  for (const key of [
    "routes",
    "crons",
    "warehouse",
    "migrations",
    "entity_resolution",
    "source_paths",
    "observer_coverage",
    "search",
    "constellation",
    "exams",
    "pages_edge",
    "materializers",
  ]) {
    assert.equal(key in committed, false, key);
  }
  const rendered = JSON.stringify(committed);
  assert.ok(rendered.length < 8000, `watermark should stay compact, got ${rendered.length}`);
  assert.ok(JSON.stringify(facts).length > rendered.length * 4);
});

test("watermark projection is structurally valid and regenerable from current facts", () => {
  // Fingerprint match against the committed file is the reconciler --check,
  // not a Unit gate. Advancement stays an explicit reviewed write.
  const watermark = buildWatermark(facts);
  assert.equal(watermark.schema, WATERMARK_SCHEMA);
  assert.equal(isWatermark(watermark), true);
  assert.equal(watermark.observer_coverage_hash, observerCoverageHash(facts.observer_coverage));
  assert.equal(watermark.observer_coverage_hash.length, 64);
  assert.ok(watermark.canaries["production-search"]);
  assert.ok(watermark.canaries["production-search"].fingerprint);
  assert.equal(typeof watermark.canaries["production-search"].count, "number");
  assert.equal(watermark.ontology.version, facts.ontology.registry.version);
  assert.ok(Array.isArray(watermark.bindings.topology));
  assert.ok(watermark.bindings.topology.length > 0);
  assert.equal(watermark.performance_observability.catalog.registry_hash, facts.performance_observability.catalog.registry_hash);
  assert.equal(watermark.performance_observability.registry.surface_count, facts.performance_observability.registry.surface_count);
  assert.equal(watermark.performance_observability.coverage_policy, "advisory");
  assert.equal(watermark.performance_observability.measurements_included, false);
  assert.equal("coverage" in watermark.performance_observability, false);
  const rendered = JSON.stringify(watermark.performance_observability).toLowerCase();
  for (const forbidden of ["p50", "p75", "p95", "percentile", "history", "unclassified_candidates"]) {
    assert.equal(rendered.includes(forbidden), false, forbidden);
  }
  const again = buildWatermark(facts);
  assert.deepEqual(again.canaries, watermark.canaries);
  assert.equal(again.observer_coverage_hash, watermark.observer_coverage_hash);
  assert.deepEqual(again.ontology, watermark.ontology);
  assert.deepEqual(again.bindings, watermark.bindings);
  assert.deepEqual(again.performance_observability, watermark.performance_observability);
  const loaded = loadWatermark();
  assert.equal(loaded.schema, WATERMARK_SCHEMA);
  assert.equal(isWatermark(loaded), true);
  assert.equal(WATERMARK_RELATIVE, "architecture/generated/watermark.json");
});

test("a new known canary changes the coverage hash and canary inventory", () => {
  const next = structuredClone(facts);
  next.observer_coverage.known_canaries = [
    ...next.observer_coverage.known_canaries,
    { id: "invented-canary", path: "site/invented.mjs" },
  ];
  next.observer_coverage.unmapped_surfaces = [
    ...next.observer_coverage.unmapped_surfaces,
    { id: "invented-canary", path: "site/invented.mjs" },
  ];
  const baseline = buildWatermark(facts);
  const watermark = buildWatermark(next);
  assert.notEqual(watermark.observer_coverage_hash, baseline.observer_coverage_hash);
  assert.ok(watermark.canaries["invented-canary"]);
  assert.equal(watermark.canaries["invented-canary"].count, 0);
});
