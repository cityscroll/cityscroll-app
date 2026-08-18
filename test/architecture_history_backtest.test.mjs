/**
 * LA11: frozen architecture-canary backtest + watermark change-history.
 *
 * Verify: node --test test/architecture_history_backtest.test.mjs
 *         node tools/backtest_architecture_canaries.mjs --check
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildFacts } from "../tools/build_architecture_facts.mjs";
import {
  CANARY_VISIBILITY_FINDINGS,
  observeCanaryVisibility,
  projectCurrentCanaryObservation,
} from "../tools/architecture_canary_visibility_observer.mjs";
import {
  CHANGE_HISTORY_SCHEMA,
  diffWatermarks,
  projectChangeHistory,
} from "../tools/architecture_change_history.mjs";
import {
  REQUIRED_FROZEN_IDS,
  loadBacktestCase,
  loadFrozenBacktestSet,
  runFrozenBacktests,
} from "../tools/backtest_architecture_canaries.mjs";
import { WATERMARK_SCHEMA, buildWatermark } from "../tools/architecture_watermark.mjs";

const SEEDED_PRS = [1076, 1058, 1056];

test("frozen set includes the seeded architecture-affecting PRs and land-action collapse", () => {
  const set = loadFrozenBacktestSet();
  const ids = set.cases.map((entry) => entry.id);
  assert.deepEqual(ids.slice().sort(), [...REQUIRED_FROZEN_IDS].sort());
  assert.equal(set.cases[0].id, "land-action-collapse");
  for (const pr of SEEDED_PRS) {
    assert.ok(set.cases.some((entry) => entry.pr === pr), `missing PR ${pr}`);
  }
});

test("each seeded PR canary is visible to the current LA7-LA8 observer", () => {
  const set = loadFrozenBacktestSet();
  const facts = buildFacts({ generatedAt: "2026-08-16T00:00:00Z", commit: "test-commit" });
  for (const id of [
    "pr-1076-constellation-ceiling",
    "pr-1058-committees-search",
    "pr-1056-exams-eligibility",
  ]) {
    const entry = set.cases.find((item) => item.id === id);
    const loaded = loadBacktestCase(entry);
    const current = projectCurrentCanaryObservation(loaded.current, facts);
    const report = observeCanaryVisibility(current);
    assert.equal(report.status, "healthy", id);
    assert.deepEqual(report.findings, [], id);
    for (const path of loaded.current.required_paths) {
      assert.ok(facts.observer_coverage.observed_paths.includes(path), `${id} ${path}`);
      assert.equal(
        facts.observer_coverage.unmapped_surfaces.some((item) => item.path === path),
        false,
        `${id} unmapped ${path}`,
      );
    }
  }
});

test("historical collapsed fixtures stay visible as drift to the current observer", () => {
  const set = loadFrozenBacktestSet();
  for (const id of [
    "pr-1076-constellation-ceiling",
    "pr-1058-committees-search",
    "pr-1056-exams-eligibility",
  ]) {
    const entry = set.cases.find((item) => item.id === id);
    const loaded = loadBacktestCase(entry);
    const collapsed = observeCanaryVisibility(loaded.collapsed);
    assert.equal(collapsed.status, "drift", id);
    const types = new Set(collapsed.findings.map((item) => item.type));
    assert.ok(types.has(CANARY_VISIBILITY_FINDINGS.UNMAPPED_SURFACE), id);
    assert.ok(types.has(CANARY_VISIBILITY_FINDINGS.MISSING_SIGNAL), id);
  }
});

test("re-narrowing the observer makes a seeded canary invisible", () => {
  const set = loadFrozenBacktestSet();
  const entry = set.cases.find((item) => item.id === "pr-1058-committees-search");
  const loaded = loadBacktestCase(entry);
  const facts = buildFacts({ generatedAt: "2026-08-16T00:00:00Z", commit: "test-commit" });
  const narrowed = structuredClone(facts);
  narrowed.search.production.collection_families = narrowed.search.production.collection_families
    .filter((item) => item.family !== "committees");
  narrowed.search.keyword_index.families = narrowed.search.keyword_index.families
    .filter((family) => family !== "committees");
  const current = projectCurrentCanaryObservation(loaded.current, narrowed);
  const report = observeCanaryVisibility(current);
  assert.equal(report.status, "drift");
  assert.ok(report.findings.some((item) => (
    item.type === CANARY_VISIBILITY_FINDINGS.MISSING_SIGNAL
    && item.target === "committees_family"
  )));
});

test("frozen backtest --check is healthy and projects watermark history", () => {
  const receipt = runFrozenBacktests();
  assert.equal(receipt.status, "healthy");
  assert.equal(receipt.history.schema, CHANGE_HISTORY_SCHEMA);
  assert.ok(receipt.history.count >= 1);
  assert.equal(receipt.history.entries[0].changes.kind, "baseline");
  for (const id of REQUIRED_FROZEN_IDS) {
    const result = receipt.results.find((item) => item.id === id);
    assert.ok(result, id);
    assert.equal(result.ok, true, id);
    assert.equal(result.collapsed.status, "drift", id);
    assert.equal(result.current.status, "healthy", id);
  }
});

test("change-history is derivable from compact watermarks without full facts", () => {
  const facts = buildFacts({ generatedAt: "2026-08-16T00:00:00Z", commit: "test-commit" });
  const before = buildWatermark(facts, { generatedAt: "2026-08-16T00:00:00Z", commit: "aaa" });
  const afterFacts = structuredClone(facts);
  afterFacts.search.production.collection_families = [
    ...afterFacts.search.production.collection_families,
    { lens: "invented", family: "invented" },
  ];
  const after = buildWatermark(afterFacts, { generatedAt: "2026-08-17T00:00:00Z", commit: "bbb" });
  const history = projectChangeHistory([before, after]);
  assert.equal(history.schema, CHANGE_HISTORY_SCHEMA);
  assert.equal(history.count, 2);
  assert.equal(history.entries[1].changes.kind, "delta");
  assert.ok(history.entries[1].changes.canaries.some((item) => (
    item.id === "production-search" && item.change === "fingerprint"
  )));
  const added = buildWatermark({
    ...facts,
    observer_coverage: {
      ...facts.observer_coverage,
      known_canaries: [
        ...facts.observer_coverage.known_canaries,
        { id: "invented-canary", path: "site/invented.mjs" },
      ],
    },
  }, { commit: "ccc" });
  const grown = diffWatermarks(before, added);
  assert.ok(grown.canaries.some((item) => item.id === "invented-canary" && item.change === "added"));
  assert.equal(before.schema, WATERMARK_SCHEMA);
  assert.equal("search" in before, false);
  assert.equal("exams" in before, false);
});
