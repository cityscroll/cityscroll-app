/**
 * First worked living-architecture drift case: land action-ontology collapse.
 *
 * The LA4/LA8 topology observer cannot see these surfaces. This observer must
 * fail each collapse condition and stay green on the post-#1081/#1082 modules.
 * Verify: node --test test/architecture_land_action_collapse.test.mjs
 *         node tools/backtest_architecture_canaries.mjs --check
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildFacts } from "../tools/build_architecture_facts.mjs";
import {
  LAND_ACTION_COLLAPSE_FINDINGS,
  isMapListProcedureDivergence,
  isPrimaryCollapse,
  isWrongProcedureClock,
  loadJsonRepoPath,
  observeLandActionCollapse,
  projectCurrentLandActionObservation,
} from "../tools/architecture_land_action_observer.mjs";
import {
  loadBacktestCase,
  loadFrozenBacktestSet,
  runFrozenBacktests,
} from "../tools/backtest_architecture_canaries.mjs";
import { parseWorkspace, reconcileArchitecture } from "../tools/reconcile_architecture.mjs";
import { filterLandSnapshot } from "../site/resident_snapshot_queries.mjs";

const CASE_ID = "land-action-collapse";
const BLIND_PATHS = [
  "site/land_use_action_type.mjs",
  "site/ulurp_statutory_clock.mjs",
  "site/resident_snapshot_queries.mjs",
];

function frozenCase() {
  const set = loadFrozenBacktestSet();
  const entry = set.cases.find((item) => item.id === CASE_ID);
  assert.ok(entry, "land-action-collapse must be in the frozen backtest set");
  return { entry, loaded: loadBacktestCase(entry) };
}

test("land-action-collapse is the first frozen architecture backtest case", () => {
  const set = loadFrozenBacktestSet();
  assert.equal(set.schema, "cityscroll.architecture.backtest_set.v1");
  assert.equal(set.cases[0].id, CASE_ID);
  assert.equal(
    set.cases[0].card,
    "cityscroll-internal-label/cs-living-architecture-observer-land-action-collapse",
  );
  const { loaded } = frozenCase();
  assert.deepEqual(loaded.expected_finding_types, [
    LAND_ACTION_COLLAPSE_FINDINGS.PRIMARY_COLLAPSE,
    LAND_ACTION_COLLAPSE_FINDINGS.WRONG_PROCEDURE_CLOCK,
    LAND_ACTION_COLLAPSE_FINDINGS.MAP_LIST_PROCEDURE_DIVERGENCE,
  ]);
});

test("each collapse condition produces its own failing signal", () => {
  const { loaded } = frozenCase();
  for (const type of loaded.expected_finding_types) {
    const report = observeLandActionCollapse(loaded.conditions[type]);
    assert.equal(report.status, "drift", type);
    assert.ok(
      report.findings.some((item) => item.type === type),
      `expected ${type} finding`,
    );
  }
  assert.equal(isPrimaryCollapse(loaded.conditions.primary_collapse.action), true);
  assert.equal(isWrongProcedureClock(loaded.conditions.wrong_procedure_clock.clock), true);
  assert.equal(
    isMapListProcedureDivergence(loaded.conditions.map_list_procedure_divergence.land_ids),
    true,
  );
});

test("the combined collapsed fixture fails all three collapse conditions", () => {
  const { loaded } = frozenCase();
  const report = observeLandActionCollapse(loaded.collapsed);
  assert.equal(report.status, "drift");
  const types = new Set(report.findings.map((item) => item.type));
  for (const type of loaded.expected_finding_types) {
    assert.ok(types.has(type), type);
  }
});

test("post-#1081/#1082 product modules pass the land-action observer", () => {
  const { loaded } = frozenCase();
  const observation = projectCurrentLandActionObservation({
    actionRecord: loadJsonRepoPath(loaded.current.action_fixture),
    clockRecord: loadJsonRepoPath(loaded.current.clock_fixture),
    mapIds: loaded.current.land_ids.map,
    listIds: loaded.current.land_ids.list,
  });
  assert.ok(observation.action.families.includes("disposition"));
  assert.ok(observation.action.families.includes("acquisition"));
  assert.notEqual(observation.action.primary, "rezoning");
  assert.equal(observation.action.is_rezoning, false);
  assert.equal(observation.clock.ulurp_non, "ELURP");
  assert.equal(observation.clock.status, "ineligible");
  assert.equal(observation.clock.reason, "wrong_procedure");
  assert.deepEqual(observation.clock.phases, []);
  const report = observeLandActionCollapse(observation);
  assert.equal(report.status, "healthy");
  assert.deepEqual(report.findings, []);
});

test("LA4/LA8 topology observer stays blind to the land-collapse surfaces", () => {
  const facts = buildFacts({ generatedAt: "2026-08-16T00:00:00Z", commit: "test-commit" });
  for (const path of BLIND_PATHS) {
    assert.equal(facts.source_paths.includes(path), false, path);
    assert.equal(
      facts.observer_coverage.observed_paths.includes(path),
      false,
      path,
    );
  }
  const observed = structuredClone(facts);
  observed.observer_coverage = { ...observed.observer_coverage, unmapped_surfaces: [] };
  const model = parseWorkspace(readFileSync(new URL("../architecture/workspace.dsl", import.meta.url), "utf8"));
  const report = reconcileArchitecture({
    facts: observed,
    baselineFacts: observed,
    model,
  });
  assert.equal(report.status, "healthy");
  const { loaded } = frozenCase();
  assert.equal(observeLandActionCollapse(loaded.collapsed).status, "drift");
});

test("filterLandSnapshot dropping ELURP while the map keeps it is map/list drift", () => {
  const rows = [
    {
      project_id: "2026R0127",
      ulurp_non: "ULURP",
      project_status: "Active",
      public_status: "In Public Review",
    },
    {
      project_id: "2024Q0356",
      ulurp_non: "ELURP",
      project_status: "Active",
      public_status: "Noticed",
    },
  ];
  const list = filterLandSnapshot(rows, { status: "all", stage: "any", limit: 40 })
    .map((row) => row.project_id);
  const map = rows.map((row) => row.project_id);
  const report = observeLandActionCollapse({ land_ids: { map, list } });
  assert.deepEqual(list, ["2026R0127"]);
  assert.equal(report.status, "drift");
  assert.ok(report.findings.some((item) => (
    item.type === LAND_ACTION_COLLAPSE_FINDINGS.MAP_LIST_PROCEDURE_DIVERGENCE
    && item.map_only.includes("2024Q0356")
  )));
});

test("frozen backtest --check is healthy on the post-#1081/#1082 case", () => {
  const receipt = runFrozenBacktests();
  assert.equal(receipt.status, "healthy");
  const land = receipt.results.find((item) => item.id === CASE_ID);
  assert.ok(land);
  assert.equal(land.ok, true);
  assert.equal(land.collapsed.status, "drift");
  assert.equal(land.current.status, "healthy");
  for (const type of Object.keys(land.conditions)) {
    assert.equal(land.conditions[type].visible, true, type);
  }
});
