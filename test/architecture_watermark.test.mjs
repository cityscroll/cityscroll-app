import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { buildFacts } from "../tools/build_architecture_facts.mjs";
import {
  WATERMARK_RELATIVE,
  WATERMARK_DIRECTORY_RELATIVE,
  WATERMARK_SHARD_SCHEMA,
  aggregateWatermarkShards,
  WATERMARK_SCHEMA,
  buildWatermark,
  isWatermark,
  loadWatermark,
  loadWatermarkShards,
  observerCoverageHash,
  writeWatermarkShards,
} from "../tools/architecture_watermark.mjs";

const facts = buildFacts({ generatedAt: "2026-08-16T00:00:00Z", commit: "test-commit" });
const committed = loadWatermark();

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
  assert.equal(WATERMARK_DIRECTORY_RELATIVE, "architecture/watermark.d");
  assert.equal(WATERMARK_RELATIVE, "architecture/generated/watermark.json");
});

test("reviewed watermark shards have deterministic ids, owners, and paths", () => {
  const shards = loadWatermarkShards();
  assert.ok(shards.length > 4);
  assert.ok(shards.every((shard) => shard.schema === WATERMARK_SHARD_SCHEMA));
  assert.ok(shards.every((shard) => shard.owner === shard.id));
  assert.deepEqual(aggregateWatermarkShards(shards), committed);
  const rendered = `${JSON.stringify(committed, null, 2)}\n`;
  assert.equal(createHash("sha256").update(rendered).digest("hex"), "228b12e28ffde0ec646c870373194f6ee691eedc4296e1eda9dfa0ed84caf88a");
});

test("same-key candidates fail instead of resolving by order", () => {
  const shard = loadWatermarkShards().find((entry) => entry.id === "ontology");
  assert.throws(
    () => aggregateWatermarkShards([...loadWatermarkShards(), structuredClone(shard)]),
    /duplicate semantic key ontology; reviewed handoff required/,
  );
});

test("projection metadata uses chronological shard time across timezone offsets", () => {
  const shards = structuredClone(loadWatermarkShards());
  for (const shard of shards) {
    shard.updated_at = "2026-08-31T11:57:44Z";
    shard.commit = "older";
  }
  const ontology = shards.find((entry) => entry.id === "ontology");
  ontology.updated_at = "2026-08-31T10:09:01-04:00";
  ontology.commit = "newer";
  const projected = aggregateWatermarkShards(shards);
  assert.equal(projected.generated_at, "2026-08-31T10:09:01-04:00");
  assert.equal(projected.commit, "newer");
});

test("reviewed advancement is explicit and changes only the selected owner shard", () => {
  const root = mkdtempSync(join(tmpdir(), "watermark-write-"));
  mkdirSync(join(root, "architecture"), { recursive: true });
  cpSync(new URL("../architecture/watermark.d", import.meta.url), join(root, "architecture", "watermark.d"), { recursive: true });
  cpSync(new URL("../architecture/observer-canaries.json", import.meta.url), join(root, "architecture", "observer-canaries.json"));
  const before = new Map(loadWatermarkShards({ root }).map((shard) => [shard.id, JSON.stringify(shard)]));
  const next = structuredClone(committed);
  next.generated_at = "2026-09-01T00:00:00.000Z";
  next.commit = "reviewed-next";
  next.canaries["production-search"].count += 1;
  try {
    assert.throws(() => writeWatermarkShards(next, { root }), /requires at least one explicit/);
    writeWatermarkShards(next, { root, keys: ["canary:production-search"] });
    const after = new Map(loadWatermarkShards({ root }).map((shard) => [shard.id, JSON.stringify(shard)]));
    const changed = [...after.keys()].filter((id) => before.get(id) !== after.get(id));
    assert.deepEqual(changed, ["canary:production-search"]);
    assert.equal(loadWatermark({ root }).canaries["production-search"].count, committed.canaries["production-search"].count + 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("independent cards own disjoint watermark and evidence shard paths", () => {
  const cardA = ["architecture/watermark.d/canary--production-search.json", "architecture/evidence.d/work-a--card-a.json"];
  const cardB = ["architecture/watermark.d/canary--agency-search-producer.json", "architecture/evidence.d/work-b--card-b.json"];
  assert.deepEqual(cardA.filter((path) => cardB.includes(path)), []);
  for (const paths of [cardA, cardB]) {
    assert.equal(paths.some((path) => path === WATERMARK_RELATIVE), false);
    assert.equal(paths.some((path) => path.startsWith("architecture-evidence/")), false);
  }
});

test("malformed, duplicate, id/path-mismatched, unsupported, and missing shards fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "watermark-shards-"));
  const source = new URL("../architecture/watermark.d", import.meta.url);
  const target = join(root, "architecture", "watermark.d");
  mkdirSync(join(root, "architecture"), { recursive: true });
  cpSync(source, target, { recursive: true });
  try {
    writeFileSync(join(target, "wrong.json"), JSON.stringify({ ...loadWatermarkShards()[0], id: "canary:production-search" }));
    assert.throws(() => loadWatermarkShards({ root }), /id\/path mismatch|duplicate semantic key/);
    rmSync(join(target, "wrong.json"));
    writeFileSync(join(target, "canary--production-search.json"), "{");
    assert.throws(() => loadWatermarkShards({ root }), /malformed JSON/);
    cpSync(source, target, { recursive: true, force: true });
    rmSync(join(target, "ontology.json"));
    assert.throws(() => loadWatermarkShards({ root }), /missing required baseline key ontology/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reintroduced generated watermark is rejected as a second baseline", () => {
  const root = mkdtempSync(join(tmpdir(), "watermark-legacy-"));
  mkdirSync(join(root, "architecture", "generated"), { recursive: true });
  mkdirSync(join(root, "architecture"), { recursive: true });
  cpSync(new URL("../architecture/watermark.d", import.meta.url), join(root, "architecture", "watermark.d"), { recursive: true });
  writeFileSync(join(root, WATERMARK_RELATIVE), JSON.stringify(committed));
  try {
    assert.throws(() => loadWatermark({ root }), /must not be present as baseline input/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
