#!/usr/bin/env node
/**
 * Batch-build rules adoption-lag model + precomputed prediction views.
 *
 * Data sources (first hit wins):
 *   1) --input path (JSON array of City Record Agency Rules rows)
 *   2) warehouse/fixtures/city-record-agency-rules/agency_rules_history.json
 *   3) warehouse DuckDB table city_record filtered to Agency Rules (when registered)
 *
 * Usage:
 *   node tools/build_rules_adoption_predictions.mjs
 *   node tools/build_rules_adoption_predictions.mjs --check
 *   node tools/build_rules_adoption_predictions.mjs --input path/to/rows.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRulemakingGapObservations,
  cityRecordRowToRuleRecord,
  fitAdoptionLagModel,
  runAdoptionLagBacktest,
  materializePredictionView,
  MODEL_NAME,
  MODEL_VERSION,
  BACKTEST_SPLIT_DATE,
} from "../worker/src/lib/rules_adoption_lag.mjs";
import { classifyRulemakingRole } from "../worker/src/lib/rules.mjs";
import {
  buildRulesExplorerEntries,
  classifyCityRecordRuleStage,
  countRulesProcessStages,
  filterRulesExplorerEntries,
  rulesProcessStage,
} from "../site/rules_explorer.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FIXTURE = join(
  ROOT,
  "warehouse/fixtures/city-record-agency-rules/agency_rules_history.json",
);
const OUT_MODEL = join(ROOT, "site/data/rules_adoption_lag_model.json");
const OUT_VIEW = join(ROOT, "site/data/rules_adoption_predictions.json");
const OUT_EVIDENCE = join(
  ROOT,
  "docs/evidence/rules-adoption-lag/backtest.json",
);
const OUT_RECEIPT = join(
  ROOT,
  "warehouse/receipts/proof/rules_adoption_lag_latest.json",
);

function parseArgs(argv) {
  const args = { input: null, check: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--input") {
      if (!argv[i + 1]) throw new Error("--input requires a path");
      args.input = argv[++i];
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return args;
}

function loadRows(inputPath) {
  const path = inputPath || DEFAULT_FIXTURE;
  if (!existsSync(path)) {
    throw new Error(
      `Agency Rules history not found at ${path}. `
      + "Provide --input or place warehouse/fixtures/city-record-agency-rules/agency_rules_history.json",
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error("input must be a JSON array of rows");
  return { rows: raw, path };
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stableStringify(value));
}

const CENSUS_STAGES = [
  "all",
  "proposal",
  "public_process",
  "adoption",
  "effective",
  "unstaged",
];

function lifecycleRowsAndCensus(rows) {
  const lifecycleRows = rows.map((row) => {
    const stage = classifyCityRecordRuleStage(row);
    const enriched = { ...row, stage };
    const phase = rulesProcessStage(enriched) || "unstaged";
    return {
      ...enriched,
      _lifecycle_phase: phase === "unstaged" ? null : phase,
      _adoption_stage_eligible: phase === "adoption",
    };
  });
  const entries = buildRulesExplorerEntries(lifecycleRows, null);
  const stepperCounts = countRulesProcessStages(entries);
  const scopeCounts = Object.fromEntries(CENSUS_STAGES.map((stage) => [
    stage,
    filterRulesExplorerEntries(entries, { process: stage }).length,
  ]));
  const recordCensus = { all: lifecycleRows.length };
  for (const stage of CENSUS_STAGES.slice(1)) recordCensus[stage] = 0;
  for (const row of lifecycleRows) {
    const stage = row._lifecycle_phase || "unstaged";
    recordCensus[stage] += 1;
  }

  const legacyAdoption = new Set();
  const stepperAdoption = new Set();
  for (const [index, row] of lifecycleRows.entries()) {
    const id = String(row.request_id || "");
    if (classifyRulemakingRole(cityRecordRowToRuleRecord(rows[index])) === "adoption") {
      legacyAdoption.add(id);
    }
    if (row._adoption_stage_eligible) stepperAdoption.add(id);
  }
  const outsideStepper = [...legacyAdoption].filter((id) => !stepperAdoption.has(id));
  const newlyIncluded = [...stepperAdoption].filter((id) => !legacyAdoption.has(id));
  const phaseById = new Map(lifecycleRows.map((row) => [
    String(row.request_id || ""),
    row._lifecycle_phase || "unstaged",
  ]));
  const honestGapCounts = {};
  for (const id of outsideStepper) {
    const phase = phaseById.get(id) || "unstaged";
    honestGapCounts[phase] = (honestGapCounts[phase] || 0) + 1;
  }
  const equal = CENSUS_STAGES.every((stage) => (
    stepperCounts[stage] === scopeCounts[stage]
    && stepperCounts[stage] === recordCensus[stage]
  ));

  return {
    rows: lifecycleRows,
    census: {
      classifier: "rulesProcessStage/classifyCityRecordRuleStage",
      record_census: recordCensus,
      stepper_counts: Object.fromEntries(CENSUS_STAGES.map((stage) => [stage, stepperCounts[stage]])),
      filter_scope_counts: scopeCounts,
      count_equals_scope: equal,
      adoption_parity: {
        legacy_role_count: legacyAdoption.size,
        stepper_stage_count: stepperAdoption.size,
        net_delta: stepperAdoption.size - legacyAdoption.size,
        newly_included_stale_records: newlyIncluded.length,
        legacy_signals_outside_stepper: outsideStepper.length,
        honest_gap_counts_by_stepper_stage: honestGapCounts,
        honest_gap_request_ids: outsideStepper.slice(0, 20),
      },
    },
  };
}

function assertionStatusCounts(view) {
  const counts = { open: 0, expired: 0, resolved: 0, other: 0 };
  for (const item of view?.items || []) {
    const status = item?.assertion?.status;
    if (status in counts && status !== "other") counts[status] += 1;
    else counts.other += 1;
  }
  return counts;
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node tools/build_rules_adoption_predictions.mjs [--input path] [--check]`);
    process.exit(0);
  }

  const { rows: sourceRows, path: sourcePath } = loadRows(args.input);
  const { rows, census: lifecycleCensus } = lifecycleRowsAndCensus(sourceRows);
  if (!lifecycleCensus.count_equals_scope) {
    throw new Error("rules lifecycle stepper counts do not equal filter scope");
  }
  const priorModel = readJsonIfPresent(OUT_MODEL);
  const priorView = readJsonIfPresent(OUT_VIEW);
  const priorEvidence = readJsonIfPresent(OUT_EVIDENCE);
  const generatedAt = new Date().toISOString();
  const scoreEnd = "2026-07-31";

  // Full-corpus model for product (train through latest score end).
  const fullObs = buildRulemakingGapObservations(rows, { cutoffDay: scoreEnd });
  const fullModel = fitAdoptionLagModel(fullObs, {
    trainFrom: fullObs.reduce(
      (min, o) => (!min || o.comment_close < min) ? o.comment_close : min,
      null,
    ),
    trainTo: scoreEnd,
  });

  // Time-split backtest (train pre-2025, score 2025-26).
  const backtestRun = runAdoptionLagBacktest(rows, {
    splitDate: BACKTEST_SPLIT_DATE,
    scoreEnd,
  });

  // Demo open matters for the precomputed view: censored (not yet adopted) with
  // comment_close in 2025-26 — product will also attach live from /rules.
  const openMatters = fullObs
    .filter((o) => (
      o.censored
      && o.comment_close >= "2025-01-01"
      && o.lifecycle_phase === "public_process"
    ))
    .slice(0, 200)
    .map((o) => ({
      subject_ref: o.subject_ref,
      request_id: o.comment_close_request_id,
      agency: o.agency,
      comment_close: o.comment_close,
      lifecycle_phase: o.lifecycle_phase,
      evidence_event_ids: [
        `cte:rules.comment_close:${o.subject_ref}:${o.comment_close}`,
      ],
    }));

  const view = materializePredictionView(openMatters, fullModel, {
    generatedAt,
    shipBarPassed: backtestRun.ship_bar_passed,
    now: scoreEnd,
  });

  const modelArtifact = {
    ...fullModel,
    lifecycle_census: lifecycleCensus,
    source: {
      path: sourcePath.replace(`${ROOT}/`, ""),
      row_count: sourceRows.length,
      observed_at: generatedAt,
    },
    backtest: {
      split_date: backtestRun.split_date,
      ship_bar_passed: backtestRun.ship_bar_passed,
      public_projection: backtestRun.public_projection,
      resolved: backtestRun.local_scorecard.resolved_backtest_predictions,
      interval_coverage: backtestRun.local_scorecard.interval_coverage,
      median_absolute_error_p50_days:
        backtestRun.local_scorecard.median_absolute_error_p50_days,
    },
  };

  const baseline = priorEvidence?.refresh_measurement?.baseline || {
    generated_at: priorEvidence?.generated_at || null,
    event_count: priorModel?.event_count ?? null,
    censored_count: priorModel?.censored_count ?? null,
    agency_cohorts: Object.keys(priorModel?.agencies || {}).length,
    interval_coverage: priorEvidence?.local_scorecard?.interval_coverage ?? null,
    resolved_backtest_predictions:
      priorEvidence?.local_scorecard?.resolved_backtest_predictions ?? null,
    open_view_items: priorView?.count ?? null,
    assertion_status_counts: assertionStatusCounts(priorView),
    public_projection: priorEvidence?.public_projection || null,
  };
  const currentMeasurement = {
    generated_at: generatedAt,
    event_count: fullModel.event_count,
    censored_count: fullModel.censored_count,
    agency_cohorts: Object.keys(fullModel.agencies).length,
    interval_coverage: backtestRun.local_scorecard.interval_coverage,
    resolved_backtest_predictions:
      backtestRun.local_scorecard.resolved_backtest_predictions,
    open_view_items: view.count,
    assertion_status_counts: assertionStatusCounts(view),
    public_projection: backtestRun.public_projection,
  };
  const numericDelta = (key) => (
    typeof baseline[key] === "number"
      ? Math.round((currentMeasurement[key] - baseline[key]) * 10_000) / 10_000
      : null
  );
  const refreshMeasurement = {
    baseline,
    current: currentMeasurement,
    delta: {
      event_count: numericDelta("event_count"),
      censored_count: numericDelta("censored_count"),
      agency_cohorts: numericDelta("agency_cohorts"),
      interval_coverage: numericDelta("interval_coverage"),
      resolved_backtest_predictions: numericDelta("resolved_backtest_predictions"),
      open_view_items: numericDelta("open_view_items"),
    },
    lifecycle_census: lifecycleCensus,
    reader_copy: {
      baseline_projection: baseline.public_projection,
      current_projection: currentMeasurement.public_projection,
      changed: baseline.public_projection !== currentMeasurement.public_projection,
      note: "Per-matter timing remains gated by the existing calibration ship bar.",
    },
  };

  const evidence = {
    metric: "rules_adoption_lag_backtest",
    model_name: MODEL_NAME,
    model_version: MODEL_VERSION,
    generated_at: generatedAt,
    source_row_count: sourceRows.length,
    protocol: backtestRun.protocol,
    train_observations: backtestRun.train_observations,
    open_at_split: backtestRun.open_at_split,
    open_at_split_resolved_later: backtestRun.open_at_split_resolved_later,
    score_realized_adoptions: backtestRun.score_realized_adoptions,
    predictions_emitted: backtestRun.predictions_emitted,
    split_date: backtestRun.split_date,
    train_to: backtestRun.train_to,
    score_from: backtestRun.score_from,
    score_end: backtestRun.score_end,
    local_scorecard: backtestRun.local_scorecard,
    headline_split: backtestRun.headline_split,
    ship_bar_passed: backtestRun.ship_bar_passed,
    public_projection: backtestRun.public_projection,
    note: backtestRun.note,
    refresh_measurement: refreshMeasurement,
    backtest_summary: {
      domain: backtestRun.backtest.domain,
      split_date: backtestRun.backtest.split_date,
      grace_days: backtestRun.backtest.grace_days,
      open_event_kinds: backtestRun.backtest.open_event_kinds,
      terminal_event_kinds: backtestRun.backtest.terminal_event_kinds,
      prediction_count: backtestRun.backtest.predictions.length,
      event_count: backtestRun.backtest.events.length,
      protocol: backtestRun.backtest.protocol,
    },
    // Scorecard-consumable payload (predictions + synthetic events).
    backtest: backtestRun.backtest,
    citywide_cohort: fullModel.citywide,
    agency_cohorts: Object.fromEntries(
      Object.entries(fullModel.agencies).map(([k, v]) => [k, {
        n: v.n,
        p10_days: v.p10_days,
        p50_days: v.p50_days,
        p90_days: v.p90_days,
        probability_adoption_365d: v.probability_adoption_365d,
      }]),
    ),
  };

  const receipt = {
    schema_version: 1,
    dataset: "rules_adoption_lag",
    model_name: MODEL_NAME,
    model_version: MODEL_VERSION,
    observed_at: generatedAt,
    source_row_count: sourceRows.length,
    observation_count: fullObs.length,
    event_count: fullModel.event_count,
    censored_count: fullModel.censored_count,
    agency_cohorts: Object.keys(fullModel.agencies).length,
    ship_bar_passed: backtestRun.ship_bar_passed,
    interval_coverage: backtestRun.local_scorecard.interval_coverage,
    resolved_backtest_predictions:
      backtestRun.local_scorecard.resolved_backtest_predictions,
    refresh_measurement: refreshMeasurement,
    artifacts: {
      model: "site/data/rules_adoption_lag_model.json",
      view: "site/data/rules_adoption_predictions.json",
      evidence: "docs/evidence/rules-adoption-lag/backtest.json",
    },
  };

  if (args.check) {
    if (!existsSync(OUT_MODEL) || !existsSync(OUT_VIEW) || !existsSync(OUT_EVIDENCE)) {
      console.error("missing committed artifacts — run without --check to rebuild");
      process.exit(1);
    }
    const committed = JSON.parse(readFileSync(OUT_EVIDENCE, "utf8"));
    const keys = [
      "ship_bar_passed",
      "predictions_emitted",
      "train_observations",
      "open_at_split",
    ];
    for (const key of keys) {
      if (committed[key] !== evidence[key]) {
        console.error(`drift on ${key}: committed=${committed[key]} rebuilt=${evidence[key]}`);
        process.exit(1);
      }
    }
    const covC = committed.local_scorecard?.interval_coverage;
    const covR = evidence.local_scorecard?.interval_coverage;
    if (covC !== covR) {
      console.error(`interval_coverage drift: ${covC} vs ${covR}`);
      process.exit(1);
    }
    const parity = committed.refresh_measurement?.lifecycle_census;
    if (!parity?.count_equals_scope) {
      console.error("committed lifecycle census is missing count-equals-scope parity");
      process.exit(1);
    }
    for (const stage of CENSUS_STAGES) {
      if (parity.stepper_counts?.[stage] !== lifecycleCensus.stepper_counts[stage]) {
        console.error(
          `lifecycle stage drift on ${stage}: committed=${parity.stepper_counts?.[stage]} rebuilt=${lifecycleCensus.stepper_counts[stage]}`,
        );
        process.exit(1);
      }
    }
    console.log("rules adoption-lag artifacts OK");
    process.exit(0);
  }

  writeJson(OUT_MODEL, modelArtifact);
  writeJson(OUT_VIEW, view);
  writeJson(OUT_EVIDENCE, evidence);
  writeJson(OUT_RECEIPT, receipt);

  console.log(JSON.stringify({
    ok: true,
    source_rows: sourceRows.length,
    observations: fullObs.length,
    events: fullModel.event_count,
    censored: fullModel.censored_count,
    agency_cohorts: Object.keys(fullModel.agencies).length,
    citywide_p50: fullModel.citywide?.p50_days,
    backtest_resolved: backtestRun.local_scorecard.resolved_backtest_predictions,
    interval_coverage: backtestRun.local_scorecard.interval_coverage,
    ship_bar: backtestRun.local_scorecard.ship_bar.status,
    public_projection: backtestRun.public_projection,
    open_view_items: view.count,
    lifecycle_census: lifecycleCensus,
  }, null, 2));
}

main();
