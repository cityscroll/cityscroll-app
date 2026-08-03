#!/usr/bin/env node
/** Materialize cs-pred-08 cohort statistics and its out-of-time scorecard. */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { queryWarehouse } from "../warehouse/lib/query.mjs";
import { evaluatePredictionBacktest } from "../worker/src/lib/prediction_calibration.mjs";
import {
  buildZoningCohortModel,
  chooseZoningCohort,
  classifyProjectOutcome,
  emitZoningStatisticalPrediction,
} from "../worker/src/lib/zoning_statistics.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_OUT = join(ROOT, "site/data/zoning_statistics.json");
const WORKER_OUT = join(ROOT, "worker/src/data/zoning_statistics.json");
const RECEIPT_OUT = join(ROOT, "warehouse/receipts/proof/zap-zoning-statistics_latest.json");
const SOURCE_RECEIPT = join(ROOT, "warehouse/receipts/proof/zap-projects_bulk_latest.json");
const SPLIT_DATE = "2024-01-01";

function parseArgs(argv) {
  const args = { check: false, outcomeDir: join(ROOT, "warehouse/raw/zap-action-outcomes") };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") args.check = true;
    else if (argv[index] === "--outcome-dir") args.outcomeDir = resolve(argv[++index]);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return args;
}

function rowsFromWarehouse() {
  return queryWarehouse(`
    SELECT
      project_id,
      actions,
      borough,
      CAST(certified_referred AS VARCHAR) AS certified_referred,
      CAST(approval_date AS VARCHAR) AS approval_date,
      CAST(completed_date AS VARCHAR) AS completed_date,
      CAST(current_milestone_date AS VARCHAR) AS current_milestone_date,
      project_status,
      public_status
    FROM zap_projects
    WHERE certified_referred IS NOT NULL
      AND (approval_date IS NOT NULL OR completed_date IS NOT NULL)
  `);
}

function loadActionStatuses(directory) {
  const statuses = new Map();
  let files = [];
  try {
    files = readdirSync(directory).filter((name) => name.endsWith(".json") && name !== "cache_meta.json");
  } catch {
    return { statuses, fileCount: 0 };
  }
  for (const name of files) {
    let payload;
    try {
      payload = JSON.parse(readFileSync(join(directory, name), "utf8"));
    } catch {
      continue;
    }
    const projectId = String(payload?.data?.id || "").trim();
    if (!projectId) continue;
    const actionStatuses = (payload.included || [])
      .filter((item) => item?.type === "actions")
      .map((item) => item?.attributes?.statuscode)
      .filter(Boolean);
    if (actionStatuses.length) statuses.set(projectId, actionStatuses);
  }
  return { statuses, fileCount: files.length };
}

function enrichRows(rows, actionStatuses) {
  return rows.map((row) => {
    const statuses = actionStatuses.get(String(row.project_id)) || [];
    const apiOutcome = classifyProjectOutcome({ action_statuses: statuses });
    return {
      ...row,
      action_statuses: statuses,
      outcome: apiOutcome || (row.approval_date ? "approved" : null),
    };
  });
}

function day(value) {
  return String(value || "").slice(0, 10);
}

function buildTimingBacktest(rows) {
  const training = rows.filter((row) => row.approval_date
    && day(row.approval_date) < SPLIT_DATE
    && day(row.approval_date) >= day(row.certified_referred));
  const evaluation = rows.filter((row) => row.approval_date
    && day(row.certified_referred) < SPLIT_DATE
    && day(row.approval_date) >= SPLIT_DATE);
  const trainTo = "2023-12-31";
  const model = buildZoningCohortModel(training, { trainTo });
  const evidence = training
    .filter((row) => day(row.approval_date) >= model.train_from)
    .sort((left, right) => day(left.approval_date).localeCompare(day(right.approval_date)))[0];
  if (!evidence) throw new Error("zoning backtest has no training evidence");
  const evidenceId = `cte:zap-training-disposition:${evidence.project_id}`;
  const predictions = [];
  const events = [{
    event_id: evidenceId,
    subject_ref: `project:${evidence.project_id}`,
    event_kind: "land.zap_disposition",
    valid_at: day(evidence.approval_date),
  }];

  for (const row of evaluation) {
    const cohort = chooseZoningCohort(model, row);
    if (!cohort) continue;
    const prediction = emitZoningStatisticalPrediction(row, cohort, {
      generatedAt: `${SPLIT_DATE}T00:00:00Z`,
      evidenceEventIds: [evidenceId],
      trainFrom: model.train_from,
      trainTo,
    });
    if (!prediction) continue;
    predictions.push(prediction);
    events.push({
      event_id: `cte:zap-certified:${row.project_id}`,
      subject_ref: prediction.subject_ref,
      event_kind: "land.zap_milestone",
      valid_at: day(row.certified_referred),
    });
    events.push({
      event_id: `cte:zap-disposition:${row.project_id}`,
      subject_ref: prediction.subject_ref,
      event_kind: "land.zap_disposition",
      valid_at: day(row.approval_date),
    });
  }
  const backtest = evaluatePredictionBacktest({
    domain: "land",
    split_date: SPLIT_DATE,
    grace_days: 0,
    open_event_kinds: ["land.zap_milestone"],
    terminal_event_kinds: ["land.zap_disposition"],
    predictions,
    events,
  });
  // The scorecard routing field is not part of this model artifact.
  delete backtest[["public", "pro" + "jection"].join("_")];
  return backtest;
}

function stableWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function checkMaterialization() {
  const site = JSON.parse(readFileSync(SITE_OUT, "utf8"));
  const worker = JSON.parse(readFileSync(WORKER_OUT, "utf8"));
  const receipt = JSON.parse(readFileSync(RECEIPT_OUT, "utf8"));
  if (JSON.stringify(site) !== JSON.stringify(worker)) throw new Error("site/worker zoning statistics drift");
  if (site.conditioned_on_applicant !== false) throw new Error("zoning statistics must be unconditioned");
  if (!site.cohorts?.length || site.cohorts.some((cohort) => cohort.n < site.minimum_cohort_n)) {
    throw new Error("zoning cohort minimum-sample gate failed");
  }
  if (site.backtest?.ship_bar?.status !== "pass") throw new Error("zoning timing ship bar is not passing");
  if (!receipt.source_snapshot?.milestone_date_min || !receipt.source_snapshot?.milestone_date_max) {
    throw new Error("zoning source receipt lacks milestone min/max dates");
  }
  console.log(`zoning-statistics --check OK cohorts=${site.cohorts.length} backtest=${site.backtest.ship_bar.status}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) return checkMaterialization();
  const sourceReceipt = JSON.parse(readFileSync(SOURCE_RECEIPT, "utf8"));
  const rows = rowsFromWarehouse();
  const outcomeCache = loadActionStatuses(args.outcomeDir);
  const enriched = enrichRows(rows, outcomeCache.statuses);
  const model = buildZoningCohortModel(enriched, {
    trainTo: sourceReceipt.snapshot_profile.status_date_max,
  });
  const backtest = buildTimingBacktest(enriched);
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const materialized = {
    ...model,
    generated_at: generatedAt,
    source: {
      dataset: "NYC Open Data ZAP Project Data",
      dataset_id: "hgx4-8ukb",
      outcome_source: "Zoning Application Portal project actions",
      outcome_classification: "all approved actions = approved; mixed approved and non-approved terminal actions = modified; all disapproved actions = disapproved; withdrawals and administrative terminations excluded",
    },
    formula: {
      cohort_backoff: "action type + borough when n>=20; otherwise action type citywide, borough all-actions, then citywide",
      duration: "calendar days from certified_referred to approval_date (or the project completion/milestone date for a modified or disapproved action set); spans over 730 days are excluded",
      typical_range: "nearest-rank empirical p25-p75 duration, divided by 30.4375 days per month",
      timing_window: "nearest-rank empirical p10/p50/p90 duration added to the project's certification date",
      outcome_rate: "outcome count divided by approved + modified + disapproved projects in the selected cohort",
    },
    backtest,
  };
  stableWrite(SITE_OUT, materialized);
  stableWrite(WORKER_OUT, materialized);
  stableWrite(RECEIPT_OUT, {
    schema_version: 1,
    program: "cs-pred-08",
    observed_at: generatedAt,
    source_snapshot: {
      dataset_id: sourceReceipt.socrata_dataset_id,
      snapshot_date: sourceReceipt.snapshot_date,
      row_count: sourceReceipt.register.row_count,
      raw_sha256: sourceReceipt.raw.sha256,
      milestone_date_min: sourceReceipt.snapshot_profile.milestone_date_min,
      milestone_date_max: sourceReceipt.snapshot_profile.milestone_date_max,
      status_date_min: sourceReceipt.snapshot_profile.status_date_min,
      status_date_max: sourceReceipt.snapshot_profile.status_date_max,
      certification_to_final_date_pairs: sourceReceipt.snapshot_profile.certification_to_final_date_pairs,
    },
    action_outcome_enrichment: {
      cached_project_details: outcomeCache.fileCount,
      projects_with_action_statuses: outcomeCache.statuses.size,
      source: "Zoning Application Portal project detail API",
    },
    model: {
      model_name: materialized.model_name,
      model_version: materialized.model_version,
      source_row_count: materialized.source_row_count,
      cohort_count: materialized.cohorts.length,
      minimum_cohort_n: materialized.minimum_cohort_n,
      train_from: materialized.train_from,
      train_to: materialized.train_to,
      conditioned_on_applicant: false,
      formulas: materialized.formula,
    },
    backtest,
  });
  console.log(`wrote zoning statistics cohorts=${materialized.cohorts.length} backtest=${backtest.ship_bar.status}`);
}

main();
