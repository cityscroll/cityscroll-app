import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  checkDeclaredModelDrift,
  evaluateDependencyRules,
  parseC4Model,
  runArchitectureFitness,
} from "../tools/architecture_fitness.mjs";

const modelText = readFileSync(new URL("../architecture/workspace.dsl", import.meta.url), "utf8");
const facts = JSON.parse(readFileSync(new URL("../architecture/generated/facts.json", import.meta.url), "utf8"));

test("current generated facts cover the declared active C4 containers", () => {
  const report = checkDeclaredModelDrift({ facts, modelText });
  assert.deepEqual(report.additions, []);
  assert.deepEqual(report.removals, []);
  assert.deepEqual(report.contradictions, []);
});

test("drift reports additions, removals, and contradictions separately", () => {
  const alteredFacts = {
    ...facts,
    source_paths: [...facts.source_paths, "new_runtime/module.mjs"],
    bindings: {
      ...facts.bindings,
      environments: {
        ...facts.bindings.environments,
        production: { ...facts.bindings.environments.production, r2_buckets: [{ binding: "SOURCE_VAULT" }] },
      },
    },
  };
  const report = checkDeclaredModelDrift({ facts: alteredFacts, modelText });
  assert.ok(report.additions.includes("source-root:new_runtime"));
  assert.ok(report.contradictions.some((item) => item.startsWith("r2_source_vault:")));
  const missing = { ...facts, ontology: {} };
  assert.ok(checkDeclaredModelDrift({ facts: missing, modelText }).removals.includes("ontology_registry"));
});

test("fitness rules report source, target, and rule name", () => {
  const violations = evaluateDependencyRules([
    { from: "worker/src/handler.mjs", to: "warehouse/scripts/ingest.py" },
  ]);
  assert.deepEqual(violations.map(({ rule, source, target }) => ({ rule, source, target })), [{
    rule: "worker-must-not-import-warehouse-batch-jobs",
    source: "worker/src/handler.mjs",
    target: "warehouse/scripts/ingest.py",
  }]);
});

test("C4 parser retains declared containers and relationships", () => {
  const model = parseC4Model(modelText);
  assert.ok(model.elements.some((element) => element.id === "browser_site" && element.type === "container"));
  assert.ok(model.relationships.some((relationship) => relationship.from === "worker_api" && relationship.to === "entity_resolution"));
});

test("repository fitness gate is green", () => {
  assert.doesNotThrow(() => runArchitectureFitness());
});
