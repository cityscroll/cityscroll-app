#!/usr/bin/env node

/**
 * Replay frozen architecture-observer backtest cases.
 *
 * Standing observer-completeness check: known architecture-affecting PRs stay
 * visible to the current LA7–LA8 observer, and the land-action-collapse
 * semantic case stays red on the collapsed fixture. Change-history is
 * projected from committed watermarks without retaining full facts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  observeCanaryVisibility,
  projectCurrentCanaryObservation,
} from "./architecture_canary_visibility_observer.mjs";
import {
  loadWatermarkHistory,
  projectChangeHistory,
} from "./architecture_change_history.mjs";
import {
  loadJsonRepoPath,
  observeLandActionCollapse,
  projectCurrentLandActionObservation,
} from "./architecture_land_action_observer.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FROZEN_SET = "architecture/backtests/frozen-set.json";

export const REQUIRED_FROZEN_IDS = Object.freeze([
  "land-action-collapse",
  "pr-1076-constellation-ceiling",
  "pr-1058-committees-search",
  "pr-1056-exams-eligibility",
]);

const OBSERVERS = {
  "tools/architecture_land_action_observer.mjs": {
    observe: observeLandActionCollapse,
    projectCurrent(spec) {
      const actionRecord = spec.action_fixture
        ? loadJsonRepoPath(spec.action_fixture, ROOT)
        : null;
      const clockRecord = spec.clock_fixture
        ? loadJsonRepoPath(spec.clock_fixture, ROOT)
        : null;
      return projectCurrentLandActionObservation({
        actionRecord,
        clockRecord,
        mapIds: spec.land_ids?.map ?? null,
        listIds: spec.land_ids?.list ?? null,
      });
    },
  },
  "tools/architecture_canary_visibility_observer.mjs": {
    observe: observeCanaryVisibility,
    projectCurrent(spec) {
      return projectCurrentCanaryObservation(spec);
    },
  },
};

function json(repoPath, root = ROOT) {
  return JSON.parse(readFileSync(join(root, repoPath), "utf8"));
}

export function loadFrozenBacktestSet(root = ROOT) {
  const document = json(FROZEN_SET, root);
  if (document.schema !== "cityscroll.architecture.backtest_set.v1") {
    throw new Error(`unexpected frozen-set schema: ${document.schema}`);
  }
  if (!Array.isArray(document.cases) || document.cases.length === 0) {
    throw new Error("frozen backtest set must include at least one case");
  }
  return document;
}

export function loadBacktestCase(entry, root = ROOT) {
  const document = JSON.parse(readFileSync(join(root, entry.path), "utf8"));
  if (document.id !== entry.id) {
    throw new Error(`backtest case id mismatch: registry ${entry.id} vs ${document.id}`);
  }
  return document;
}

function findingTypes(report) {
  return [...new Set((report.findings || []).map((item) => item.type))];
}

function missingTypes(expected, actual) {
  return expected.filter((type) => !actual.includes(type));
}

export function runBacktestCase(entry, loaded, observer) {
  const expected = loaded.expected_finding_types || [];
  const collapsed = observer.observe(loaded.collapsed || {});
  const collapsedTypes = findingTypes(collapsed);
  const missing = missingTypes(expected, collapsedTypes);
  const conditionReports = {};
  for (const [type, observation] of Object.entries(loaded.conditions || {})) {
    const report = observer.observe(observation);
    conditionReports[type] = {
      status: report.status,
      findings: findingTypes(report),
      visible: findingTypes(report).includes(type),
    };
  }
  const currentObservation = loaded.current ? observer.projectCurrent(loaded.current) : null;
  const current = currentObservation ? observer.observe(currentObservation) : null;

  const failedConditions = Object.entries(conditionReports)
    .filter(([, report]) => !report.visible)
    .map(([type]) => type);
  const currentFailed = current ? current.status !== "healthy" : false;
  const ok = missing.length === 0 && failedConditions.length === 0 && !currentFailed;

  return {
    id: entry.id,
    card: entry.card ?? loaded.card ?? null,
    ok,
    collapsed: {
      status: collapsed.status,
      findings: collapsedTypes,
      missing,
    },
    conditions: conditionReports,
    current: current
      ? { status: current.status, findings: findingTypes(current) }
      : null,
  };
}

export function runFrozenBacktests({ root = ROOT } = {}) {
  const set = loadFrozenBacktestSet(root);
  const listed = new Set(set.cases.map((entry) => entry.id));
  const results = [];
  for (const id of REQUIRED_FROZEN_IDS) {
    if (!listed.has(id)) {
      results.push({
        id,
        ok: false,
        error: `required frozen canary missing: ${id}`,
      });
    }
  }
  for (const entry of set.cases) {
    const observer = OBSERVERS[entry.observer];
    if (!observer) {
      results.push({
        id: entry.id,
        ok: false,
        error: `no observer registered for ${entry.observer}`,
      });
      continue;
    }
    const loaded = loadBacktestCase(entry, root);
    results.push(runBacktestCase(entry, loaded, observer));
  }
  const history = projectChangeHistory(loadWatermarkHistory({ root }));
  return {
    schema: "cityscroll.architecture.backtest_receipt.v1",
    source: FROZEN_SET,
    status: results.every((item) => item.ok) ? "healthy" : "drift",
    results,
    history,
  };
}

function render(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const check = process.argv.includes("--check");
  const receipt = runFrozenBacktests();
  process.stdout.write(render(receipt));
  if (check && receipt.status !== "healthy") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { FROZEN_SET, OBSERVERS };
