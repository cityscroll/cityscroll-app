import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildFacts, dispatchRoutes, parseBindings, parseCrons, parseRoutes } from "../tools/build_architecture_facts.mjs";

const facts = buildFacts({ generatedAt: "2026-08-16T00:00:00Z", commit: "test-commit" });
const wrangler = readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
const worker = readFileSync(new URL("../worker/src/worker.mjs", import.meta.url), "utf8");

test("generated architecture facts contain every LA4 section", () => {
  for (const key of ["routes", "bindings", "crons", "warehouse", "migrations", "entity_resolution", "ontology"]) {
    assert.ok(key in facts, key);
  }
  assert.equal(facts.schema, "cityscroll.architecture.facts.v1");
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
