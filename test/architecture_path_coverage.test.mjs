import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildFacts,
  loadObserverCanaries,
} from "../tools/build_architecture_facts.mjs";
import { loadWatermark } from "../tools/architecture_watermark.mjs";
import {
  CANARY_LIST,
  RECONCILIATION_WORKFLOW,
  parseReconciliationTriggerPaths,
  pathMatchesTriggerFilter,
  uncoveredCanaryPaths,
} from "../tools/architecture_path_coverage.mjs";

const facts = buildFacts({ generatedAt: "2026-08-16T00:00:00Z", commit: "test-commit" });
const listed = loadObserverCanaries();
const patterns = parseReconciliationTriggerPaths();

test("every known-canary path is inside the reconciliation workflow trigger filter", () => {
  assert.equal(CANARY_LIST, "architecture/observer-canaries.json");
  assert.equal(RECONCILIATION_WORKFLOW, ".github/workflows/architecture-reconciliation.yml");
  const missing = uncoveredCanaryPaths({ canaries: listed, patterns });
  assert.deepEqual(
    missing,
    [],
    missing.map((entry) => `${entry.id}:${entry.path}`).join(", "),
  );
});

test("filter covers site search, constellation, and materialization canaries", () => {
  assert.ok(patterns.includes("site/**"), "expected site/** on the reconciliation trigger");
  assert.ok(
    patterns.some((pattern) => pathMatchesTriggerFilter("tools/build_keyword_search_index.mjs", [pattern])),
    "expected a tools/build_* pattern on the reconciliation trigger",
  );
  for (const path of [
    "site/agency_constellation_model.mjs",
    "site/agency_search_producer.mjs",
    "site/exams_surface.mjs",
    "site/pages_edge.mjs",
    "site/_routes.json",
    "tools/build_agency_constellation_documents.mjs",
    "tools/build_keyword_search_index.mjs",
    "tools/build_primary_documents.mjs",
  ]) {
    assert.ok(pathMatchesTriggerFilter(path, patterns), path);
  }
});

test("trigger-path parser keeps comments between pull_request and paths", () => {
  const parsed = parseReconciliationTriggerPaths(`
on:
  pull_request:
    # canary list is the single registration
    paths:
      - "site/**"
      - "tools/build_*.mjs"
  merge_group:
`);
  assert.deepEqual(parsed, ["site/**", "tools/build_*.mjs"]);
});

test("a canary path absent from the trigger filter is a red coverage finding", () => {
  const invented = { id: "invented-canary", path: "docs/unrelated.md" };
  assert.equal(pathMatchesTriggerFilter(invented.path, patterns), false);
  assert.deepEqual(
    uncoveredCanaryPaths({ canaries: [invented], patterns }),
    [invented],
  );
});

test("one canary registration stays in sync across facts, filter, and watermark", () => {
  const listedIds = listed.map((entry) => entry.id).sort();
  assert.deepEqual(
    facts.observer_coverage.known_canaries.map((entry) => entry.id).sort(),
    listedIds,
  );
  const watermark = loadWatermark();
  assert.ok(watermark);
  assert.deepEqual(Object.keys(watermark.canaries).sort(), listedIds);
  assert.deepEqual(uncoveredCanaryPaths({ canaries: listed, patterns }), []);
  const document = JSON.parse(readFileSync(new URL("../architecture/observer-canaries.json", import.meta.url), "utf8"));
  assert.equal(document.canaries.length, listed.length);
});
