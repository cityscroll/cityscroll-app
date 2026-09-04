#!/usr/bin/env node
/**
 * SEQRA-06: build/check the spatial and implementation-join receipt this
 * card's acceptance criteria (A1-A5) exercise, over the committed synthetic
 * fixture at warehouse/fixtures/seqra-spatial/sample_multi_lot_project.mjs.
 *
 * `npm run warehouse:seqra:ingest` (this card's `verify` field, shared with
 * SEQRA-03 and SEQRA-07) runs tools/build_seqra_structured_adapters.mjs,
 * which in turn execs this tool's own `--check` mode and unit test suites --
 * matching how that tool already delegates SEQRA-03's own A4 regression
 * check to tools/build_ceqr_project_milestone_reconciliation.mjs. This tool
 * is also independently runnable for the card's own development loop.
 *
 * No network access: every input is the committed synthetic fixture. That
 * fixture models one project whose original BBL is subdivided mid-review,
 * a per-layer vintage series for PLUTO/zoning/receptor/environmental-site/
 * disadvantaged-community/flood (one of which -- PLUTO -- deliberately has
 * no vintage before 2019-01-01, to exercise the refused-join path), and
 * DOB/ACRIS implementation events tied to the project's determination.
 *
 * Usage:
 *   node tools/build_seqra_spatial_implementation_joins.mjs [--check]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProjectBblHistory, bblFootprintAsOf } from "../warehouse/lib/seqra_bbl_lot_history.mjs";
import { joinProjectLayersAtCutoff, SEQRA_SPATIAL_LAYER_TYPES } from "../warehouse/lib/seqra_spatial_layer_joins.mjs";
import {
  buildImplementationEvent,
  joinImplementationEventsToDetermination,
  projectRemedyExposureAsOf,
} from "../warehouse/lib/seqra_implementation_remedy_projection.mjs";
import {
  DETERMINATION_DATE,
  DETERMINATION_KEY,
  ORIGINAL_BBL,
  PROJECT_KEY,
  SAMPLE_IMPLEMENTATION_EVENTS_RAW,
  SAMPLE_LOT_CHANGE_EVENTS,
  SAMPLE_PROJECT_INITIAL_DATE,
  SUBDIVIDED_BBL_A,
  SUBDIVIDED_BBL_B,
  SUBDIVISION_DATE,
  sampleLayerRegistry,
} from "../warehouse/fixtures/seqra-spatial/sample_multi_lot_project.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT = path.join(ROOT, "warehouse/receipts/proof/seqra_spatial_implementation_joins_latest.json");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function stringify(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, result: "pass", detail: detail ?? null });
  } catch (error) {
    checks.push({ name, result: "fail", message: error.message });
  }
}
function assertTrue(value, message) {
  if (!value) throw new Error(message);
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const history = buildProjectBblHistory({
  projectKey: PROJECT_KEY,
  initialBbls: [ORIGINAL_BBL],
  initialDate: SAMPLE_PROJECT_INITIAL_DATE,
  lotChangeEvents: SAMPLE_LOT_CHANGE_EVENTS,
});

// -- A1: every spatial feature carries the vintage of the layer it was derived from. --
check("A1: every joined spatial feature carries its layer vintage", () => {
  const result = joinProjectLayersAtCutoff({ history, cutoff: "2021-06-01", layerRegistry: sampleLayerRegistry() });
  assertTrue(result.features.length > 0, "at least one feature joined");
  for (const feature of result.features) {
    assertTrue(typeof feature.layer_vintage === "string" && feature.layer_vintage.length > 0, `${feature.feature_key}: missing layer_vintage`);
  }
  return { cutoff: result.cutoff, feature_count: result.features.length, gap_count: result.gaps.length };
});

// -- A2: current conditions cannot leak backward. --
check("A2: a historical cutoff resolves identically whether computed with only the vintages published by then, or with the full present-day series", () => {
  const cutoff = "2019-03-01";
  const fullRegistry = sampleLayerRegistry();
  const asOfThenRegistry = { ...fullRegistry, flood: { ...fullRegistry.flood, vintages: [fullRegistry.flood.vintages[0]] } };
  const then = joinProjectLayersAtCutoff({ history, cutoff, layerRegistry: asOfThenRegistry, layerTypes: ["flood"] });
  const today = joinProjectLayersAtCutoff({ history, cutoff, layerRegistry: fullRegistry, layerTypes: ["flood"] });
  assertEqual(JSON.stringify(stable(then.features)), JSON.stringify(stable(today.features)), "flood feature must be identical regardless of later vintages existing");
  return { cutoff, matched: true };
});

// -- A3: multi-lot and changing-lot project histories remain intact. --
check("A3: the pre-subdivision and post-subdivision footprints are both reachable, and the retired BBL is preserved", () => {
  const before = bblFootprintAsOf(history, "2019-01-01");
  const after = bblFootprintAsOf(history, "2021-01-01");
  assertEqual(before.bbls.length, 1, "pre-subdivision footprint is the single original BBL");
  assertEqual(before.bbls[0], ORIGINAL_BBL, "pre-subdivision footprint is the original BBL");
  assertEqual(after.bbls.length, 2, "post-subdivision footprint has both new BBLs");
  assertTrue(history.every_bbl_ever_held.includes(ORIGINAL_BBL), "retired original BBL stays in every_bbl_ever_held");
  return { subdivision_date: SUBDIVISION_DATE, before: before.bbls, after: after.bbls };
});

// -- A4: DOB and ACRIS implementation events join to the authorizing determination and support a remedy-exposure projection. --
check("A4: implementation events join to the authorizing determination and drive a remedy-exposure projection", () => {
  const events = SAMPLE_IMPLEMENTATION_EVENTS_RAW.map((raw) => buildImplementationEvent(raw));
  const { attributed_events: attributed, unattributed_events: unattributed } = joinImplementationEventsToDetermination({
    determinationKey: DETERMINATION_KEY,
    determinationDate: DETERMINATION_DATE,
    bbls: [SUBDIVIDED_BBL_A, SUBDIVIDED_BBL_B],
    events,
  });
  assertTrue(attributed.length > 0, "at least one event attributed to the determination");
  assertTrue(attributed.every((e) => e.authorizing_determination_key === DETERMINATION_KEY), "every attributed event names the determination");
  assertTrue(unattributed.length > 0, "the pre-determination filing on the pre-subdivision BBL stays unattributed");
  const projection = projectRemedyExposureAsOf({ determinationKey: DETERMINATION_KEY, cutoff: "2022-06-01", attributedEvents: attributed });
  assertTrue(projection.state !== "not_started", "remedy-exposure projection reaches a non-trivial state by 2022-06-01");
  assertTrue(projection.evidence_event_keys.length > 0, "remedy-exposure state names its supporting evidence events");
  return { attributed_count: attributed.length, unattributed_count: unattributed.length, remedy_state_2022_06_01: projection.state };
});

// -- A5: a join whose layer vintage is unknown is refused and reported as a coverage gap, never silently completed with current data. --
check("A5: an unknown-vintage layer join is refused and reported as a coverage gap, never completed with current data", () => {
  // The single-layer primitive (joinSpatialLayerAtCutoff) throws SeqraLayerVintageError directly;
  // the project-level join (joinProjectLayersAtCutoff) catches that and converts it into `gaps`
  // instead of raising, so a missing vintage for one layer never aborts the whole join.
  const result = joinProjectLayersAtCutoff({ history, cutoff: "2018-06-01", layerRegistry: sampleLayerRegistry(), layerTypes: ["pluto"] });
  assertEqual(result.features.length, 0, "no PLUTO feature is produced before its earliest vintage");
  assertEqual(result.gaps.length, 1, "exactly one coverage gap is reported");
  assertEqual(result.gaps[0].gap_detected, true, "the gap record states gap_detected");
  assertEqual(result.gaps[0].layer_type, "pluto", "the gap names the refused layer type");
  return { cutoff: "2018-06-01", gap: result.gaps[0] };
});

// -- Negative rule: do not replace historical data with current project or spatial conditions to make a join succeed. --
check("negative rule: PLUTO's current (post-2021) vintage is never substituted for a pre-2019 cutoff", () => {
  const result = joinProjectLayersAtCutoff({ history, cutoff: "2018-06-01", layerRegistry: sampleLayerRegistry(), layerTypes: ["pluto"] });
  assertTrue(result.features.every((f) => f.layer_vintage !== "21v1"), "the current PLUTO vintage never appears for a cutoff it does not cover");
  assertEqual(result.features.length, 0, "no feature at all is produced -- refusal, not a substitution");
  return { checked: true };
});

check("existing warehouse test suites for the modules this card introduces stay green", () => {
  for (const testFile of [
    "test/warehouse_seqra_layer_vintage.test.mjs",
    "test/warehouse_seqra_bbl_lot_history.test.mjs",
    "test/warehouse_seqra_spatial_layer_joins.test.mjs",
    "test/warehouse_seqra_implementation_remedy_projection.test.mjs",
  ]) {
    execFileSync(process.execPath, ["--test", testFile], { cwd: ROOT, stdio: "pipe" });
  }
  return { suites_run: 4 };
});

const failed = checks.filter((c) => c.result === "fail");
const gateResult = failed.length === 0 ? "pass" : "fail";

const receipt = {
  schema: "cityscroll.seqra_spatial_implementation_joins_receipt.v1",
  fixture_project_key: PROJECT_KEY,
  layer_types: SEQRA_SPATIAL_LAYER_TYPES,
  checks,
  gate: { result: gateResult, failed_check_count: failed.length },
};

const next = stringify(receipt);
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (arg !== "--check") throw new Error("Usage: node tools/build_seqra_spatial_implementation_joins.mjs [--check]");
}

if (args.has("--check")) {
  let current = null;
  try {
    current = readFileSync(RECEIPT, "utf8");
  } catch {
    current = null;
  }
  if (current !== next) {
    console.error(next);
    throw new Error(`${path.relative(ROOT, RECEIPT)} is stale; run: node tools/build_seqra_spatial_implementation_joins.mjs`);
  }
} else {
  mkdirSync(path.dirname(RECEIPT), { recursive: true });
  writeFileSync(RECEIPT, next);
}

if (gateResult !== "pass") {
  console.error(next);
  throw new Error(`SEQRA-06 spatial-implementation-joins gate failed: ${failed.map((c) => `${c.name}: ${c.message}`).join(" | ")}`);
}
console.log(`SEQRA spatial-implementation-joins gate OK (${checks.length} checks)`);
