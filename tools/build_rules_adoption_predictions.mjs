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
  fitAdoptionLagModel,
  runAdoptionLagBacktest,
  materializePredictionView,
  MODEL_NAME,
  MODEL_VERSION,
  BACKTEST_SPLIT_DATE,
} from "../worker/src/lib/rules_adoption_lag.mjs";

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node tools/build_rules_adoption_predictions.mjs [--input path] [--check]`);
    process.exit(0);
  }

  const { rows, path: sourcePath } = loadRows(args.input);
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
    .filter((o) => o.censored && o.comment_close >= "2025-01-01")
    .slice(0, 200)
    .map((o) => ({
      subject_ref: o.subject_ref,
      request_id: o.comment_close_request_id,
      agency: o.agency,
      comment_close: o.comment_close,
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
    source: {
      path: sourcePath.replace(`${ROOT}/`, ""),
      row_count: rows.length,
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

  const evidence = {
    metric: "rules_adoption_lag_backtest",
    model_name: MODEL_NAME,
    model_version: MODEL_VERSION,
    generated_at: generatedAt,
    source_row_count: rows.length,
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
    source_row_count: rows.length,
    observation_count: fullObs.length,
    event_count: fullModel.event_count,
    censored_count: fullModel.censored_count,
    agency_cohorts: Object.keys(fullModel.agencies).length,
    ship_bar_passed: backtestRun.ship_bar_passed,
    interval_coverage: backtestRun.local_scorecard.interval_coverage,
    resolved_backtest_predictions:
      backtestRun.local_scorecard.resolved_backtest_predictions,
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
    console.log("rules adoption-lag artifacts OK");
    process.exit(0);
  }

  writeJson(OUT_MODEL, modelArtifact);
  writeJson(OUT_VIEW, view);
  writeJson(OUT_EVIDENCE, evidence);
  writeJson(OUT_RECEIPT, receipt);

  console.log(JSON.stringify({
    ok: true,
    source_rows: rows.length,
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
  }, null, 2));
}

main();
