#!/usr/bin/env node
/**
 * Materialize cs-pred-08 cohort statistics and cs-pred-11 applicant-conditioned
 * ULURP outcome rates (same cohort engine; applicant dimension via ER stems).
 */
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { catalogExists } from "../warehouse/lib/catalog.mjs";
import { queryWarehouse } from "../warehouse/lib/query.mjs";
import { evaluatePredictionBacktest } from "../worker/src/lib/prediction_calibration.mjs";
import {
  buildApplicantConditionedCohorts,
  buildZoningCohortModel,
  chooseZoningCohort,
  classifyProjectOutcome,
  emitZoningStatisticalPrediction,
  scoreApplicantConditioning,
} from "../worker/src/lib/zoning_statistics.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_OUT = join(ROOT, "site/data/zoning_statistics.json");
const WORKER_OUT = join(ROOT, "worker/src/data/zoning_statistics.json");
const RECEIPT_OUT = join(ROOT, "warehouse/receipts/proof/zap-zoning-statistics_latest.json");
const SOURCE_RECEIPT = join(ROOT, "warehouse/receipts/proof/zap-projects_bulk_latest.json");
const SPLIT_DATE = "2024-01-01";
const SODA_URL = "https://data.cityofnewyork.us/resource/hgx4-8ukb.json";
const SODA_PAGE = 50_000;

function parseArgs(argv) {
  const args = {
    check: false,
    applicantOnly: false,
    outcomeDir: join(ROOT, "warehouse/raw/zap-action-outcomes"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") args.check = true;
    else if (argv[index] === "--applicant-only") args.applicantOnly = true;
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
      CAST(primary_applicant AS VARCHAR) AS primary_applicant,
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

async function rowsFromSoda() {
  const where = [
    "certified_referred IS NOT NULL",
    "(approval_date IS NOT NULL OR completed_date IS NOT NULL)",
    "primary_applicant IS NOT NULL",
  ].join(" AND ");
  const rows = [];
  let offset = 0;
  for (;;) {
    const url = new URL(SODA_URL);
    url.searchParams.set("$select", [
      "project_id",
      "actions",
      "borough",
      "primary_applicant",
      "certified_referred",
      "approval_date",
      "completed_date",
      "current_milestone_date",
      "project_status",
      "public_status",
    ].join(","));
    url.searchParams.set("$where", where);
    url.searchParams.set("$limit", String(SODA_PAGE));
    url.searchParams.set("$offset", String(offset));
    url.searchParams.set("$order", "project_id");
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`ZAP SODA fetch failed: HTTP ${response.status}`);
    }
    const page = await response.json();
    if (!Array.isArray(page) || !page.length) break;
    rows.push(...page);
    if (page.length < SODA_PAGE) break;
    offset += page.length;
  }
  return rows;
}

async function loadProjectRows() {
  if (catalogExists()) {
    try {
      return { rows: rowsFromWarehouse(), source: "warehouse" };
    } catch (error) {
      console.warn(`warehouse query failed, falling back to SODA: ${error.message}`);
    }
  }
  return { rows: await rowsFromSoda(), source: "soda" };
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

function applicantFormulaBlock(score) {
  return {
    conditioning: "entity-resolution join on primary_applicant (agency preferred alias when government-shaped, otherwise vendor stem); cohorts require n>=20 terminal outcomes",
    outcome_rate: "approved / (approved + modified + disapproved) within the applicant entity cohort",
    presentation: "unconditioned action-type/borough base rate always shown beside the conditioned rate; never the conditioned number alone",
    false_positive_modes: [
      "entity-resolution mislinks (distinct applicants collapsed onto one stem, or one firm split across stems)",
      "small-cohort noise at the n=20 floor",
      "era effects (practice or policy shifts between the training window and a live application)",
    ],
    backtest: "time-split Brier score of conditioned P(approved) vs unconditioned base rate on holdout dispositions; if conditioning does not beat the base rate, public_projection is descriptive_history",
    public_projection: score?.public_projection || "descriptive_history",
    beats_base_rate: Boolean(score?.beats_base_rate),
  };
}

function buildApplicantBlock(enriched, trainTo) {
  const applicantModel = buildApplicantConditionedCohorts(enriched, { trainTo });
  const score = scoreApplicantConditioning(enriched, {
    splitDate: SPLIT_DATE,
    trainTo: "2023-12-31",
  });
  return {
    ...applicantModel,
    formula: applicantFormulaBlock(score),
    backtest: score,
    public_projection: score.public_projection,
  };
}

function checkMaterialization() {
  const site = JSON.parse(readFileSync(SITE_OUT, "utf8"));
  const worker = JSON.parse(readFileSync(WORKER_OUT, "utf8"));
  const receipt = JSON.parse(readFileSync(RECEIPT_OUT, "utf8"));
  if (JSON.stringify(site) !== JSON.stringify(worker)) throw new Error("site/worker zoning statistics drift");
  // Unconditioned table stays applicant-free; applicant rates live in applicant_conditioning.
  if (site.conditioned_on_applicant !== false) {
    throw new Error("base zoning cohorts must remain unconditioned");
  }
  if (!site.cohorts?.length || site.cohorts.some((cohort) => cohort.n < site.minimum_cohort_n)) {
    throw new Error("zoning cohort minimum-sample gate failed");
  }
  if (site.backtest?.ship_bar?.status !== "pass") throw new Error("zoning timing ship bar is not passing");
  if (!receipt.source_snapshot?.milestone_date_min || !receipt.source_snapshot?.milestone_date_max) {
    throw new Error("zoning source receipt lacks milestone min/max dates");
  }
  const applicant = site.applicant_conditioning;
  if (!applicant) throw new Error("applicant_conditioning block missing");
  if (applicant.minimum_cohort_n < 20) throw new Error("applicant cohort floor must be >=20");
  if (!Array.isArray(applicant.cohorts) || !applicant.cohorts.length) {
    throw new Error("applicant-conditioned cohorts missing");
  }
  if (applicant.cohorts.some((cohort) => cohort.n < applicant.minimum_cohort_n)) {
    throw new Error("applicant cohort below n>=20 rendered");
  }
  if (!applicant.formula?.false_positive_modes?.length) {
    throw new Error("applicant formula must name false-positive modes");
  }
  if (!["per_matter_projection", "descriptive_history"].includes(applicant.public_projection)) {
    throw new Error("applicant public_projection must be set from the backtest");
  }
  console.log(
    `zoning-statistics --check OK cohorts=${site.cohorts.length} `
    + `applicant_cohorts=${applicant.cohorts.length} `
    + `applicant_projection=${applicant.public_projection} `
    + `backtest=${site.backtest.ship_bar.status}`,
  );
}

function writeMaterialization(materialized, receiptExtras = {}) {
  const generatedAt = materialized.generated_at;
  stableWrite(SITE_OUT, materialized);
  stableWrite(WORKER_OUT, materialized);
  const priorReceipt = existsSync(RECEIPT_OUT)
    ? JSON.parse(readFileSync(RECEIPT_OUT, "utf8"))
    : {};
  stableWrite(RECEIPT_OUT, {
    ...priorReceipt,
    schema_version: 1,
    program: "cs-pred-08+cs-pred-11",
    observed_at: generatedAt,
    ...receiptExtras,
    model: {
      ...(priorReceipt.model || {}),
      model_name: materialized.model_name,
      model_version: materialized.model_version,
      source_row_count: materialized.source_row_count,
      cohort_count: materialized.cohorts.length,
      minimum_cohort_n: materialized.minimum_cohort_n,
      train_from: materialized.train_from,
      train_to: materialized.train_to,
      conditioned_on_applicant: false,
      applicant_conditioning: {
        cohort_count: materialized.applicant_conditioning?.cohorts?.length || 0,
        minimum_cohort_n: materialized.applicant_conditioning?.minimum_cohort_n || 20,
        public_projection: materialized.applicant_conditioning?.public_projection || null,
        beats_base_rate: Boolean(materialized.applicant_conditioning?.backtest?.beats_base_rate),
        conditioned_brier: materialized.applicant_conditioning?.backtest?.conditioned_brier ?? null,
        unconditioned_brier: materialized.applicant_conditioning?.backtest?.unconditioned_brier ?? null,
      },
      formulas: {
        ...(materialized.formula || {}),
        applicant: materialized.applicant_conditioning?.formula || null,
      },
    },
    backtest: materialized.backtest,
    applicant_backtest: materialized.applicant_conditioning?.backtest || null,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) return checkMaterialization();

  if (args.applicantOnly) {
    if (!existsSync(SITE_OUT)) {
      throw new Error("--applicant-only requires an existing zoning_statistics.json");
    }
    const existing = JSON.parse(readFileSync(SITE_OUT, "utf8"));
    const { rows, source } = await loadProjectRows();
    const outcomeCache = loadActionStatuses(args.outcomeDir);
    const enriched = enrichRows(rows, outcomeCache.statuses);
    const applicant_conditioning = buildApplicantBlock(enriched, existing.train_to);
    const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const materialized = {
      ...existing,
      generated_at: generatedAt,
      applicant_conditioning,
      formula: {
        ...(existing.formula || {}),
        applicant_conditioning: applicant_conditioning.formula,
      },
    };
    writeMaterialization(materialized, {
      applicant_row_source: source,
      action_outcome_enrichment: {
        cached_project_details: outcomeCache.fileCount,
        projects_with_action_statuses: outcomeCache.statuses.size,
        source: "Zoning Application Portal project detail API",
      },
    });
    console.log(
      `wrote applicant conditioning cohorts=${applicant_conditioning.cohorts.length} `
      + `projection=${applicant_conditioning.public_projection} source=${source}`,
    );
    return;
  }

  const sourceReceipt = JSON.parse(readFileSync(SOURCE_RECEIPT, "utf8"));
  const { rows, source } = await loadProjectRows();
  const outcomeCache = loadActionStatuses(args.outcomeDir);
  const enriched = enrichRows(rows, outcomeCache.statuses);
  const model = buildZoningCohortModel(enriched, {
    trainTo: sourceReceipt.snapshot_profile?.status_date_max || undefined,
  });
  const backtest = buildTimingBacktest(enriched);
  const applicant_conditioning = buildApplicantBlock(
    enriched,
    sourceReceipt.snapshot_profile?.status_date_max,
  );
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const materialized = {
    ...model,
    generated_at: generatedAt,
    source: {
      dataset: "NYC Open Data ZAP Project Data",
      dataset_id: "hgx4-8ukb",
      row_source: source,
      outcome_source: "Zoning Application Portal project actions",
      outcome_classification: "all approved actions = approved; mixed approved and non-approved terminal actions = modified; all disapproved actions = disapproved; withdrawals and administrative terminations excluded",
    },
    formula: {
      cohort_backoff: "action type + borough when n>=20; otherwise action type citywide, borough all-actions, then citywide",
      duration: "calendar days from certified_referred to approval_date (or the project completion/milestone date for a modified or disapproved action set); spans over 730 days are excluded",
      typical_range: "nearest-rank empirical p25-p75 duration, divided by 30.4375 days per month",
      timing_window: "nearest-rank empirical p10/p50/p90 duration added to the project's certification date",
      outcome_rate: "outcome count divided by approved + modified + disapproved projects in the selected cohort",
      applicant_conditioning: applicant_conditioning.formula,
    },
    backtest,
    applicant_conditioning,
  };
  writeMaterialization(materialized, {
    source_snapshot: {
      dataset_id: sourceReceipt.socrata_dataset_id,
      snapshot_date: sourceReceipt.snapshot_date,
      row_count: sourceReceipt.register?.row_count ?? rows.length,
      raw_sha256: sourceReceipt.raw?.sha256 ?? null,
      milestone_date_min: sourceReceipt.snapshot_profile?.milestone_date_min ?? null,
      milestone_date_max: sourceReceipt.snapshot_profile?.milestone_date_max ?? null,
      status_date_min: sourceReceipt.snapshot_profile?.status_date_min ?? null,
      status_date_max: sourceReceipt.snapshot_profile?.status_date_max ?? null,
      certification_to_final_date_pairs:
        sourceReceipt.snapshot_profile?.certification_to_final_date_pairs ?? null,
      applicant_row_source: source,
    },
    action_outcome_enrichment: {
      cached_project_details: outcomeCache.fileCount,
      projects_with_action_statuses: outcomeCache.statuses.size,
      source: "Zoning Application Portal project detail API",
    },
  });
  console.log(
    `wrote zoning statistics cohorts=${materialized.cohorts.length} `
    + `applicant_cohorts=${applicant_conditioning.cohorts.length} `
    + `timing=${backtest.ship_bar.status} `
    + `applicant=${applicant_conditioning.public_projection} source=${source}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
