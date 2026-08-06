#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTitleCodeCatalog,
  buildTitleCodeContext,
  calibrateTitleCodeScorer,
  generateTitleCodeCandidates,
  measurePotentialLift,
} from "../entity_resolution/candidate_generation/published_walls.mjs";
import { normalizeTitleLabel } from "./build_title_code_alias_registry.mjs";
import { evaluateTwoTierPrecision } from "./two_tier_precision_gate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "site/data/exam_sources/title_code_family_coverage.json");
const REVIEW_REGISTRY = join(ROOT, "entity_resolution/review/title_code_registry.json");
const ALIAS_REGISTRY = join(ROOT, "site/data/exam_sources/title_code_alias_registry.json");
const NOE_NOTICE_TEXT_DIR = join(ROOT, "site/data/exam_sources/fixtures/noe_text");

export const HISTORICAL_EXAM_COVERAGE_FLOOR = 0.30;
export const AUDIT_PRECISION_FLOOR = 0.95;
export const TWO_TIER_BASELINE_RECEIPT = "docs/evidence/two-tier-precision-baselines-2026-08-06.json";

const cleanCode = (value) => String(value || "").trim().toUpperCase();
const rate = (numerator, denominator) => denominator ? Number((numerator / denominator).toFixed(4)) : 0;
const normalizeExamNumber = (value) => String(Number(value || 0)).replace(/^0+/, "") || "0";

export function publisherTitleCode(row = {}) {
  return cleanCode(
    row.title_code
      || row.titleCode
      || row.appointmentTitleCode
      || row.list_title_code
      || row.listTitleCode
      || row.title_code_no
      || row.titleCodeNo,
  );
}

function collectBackfillCandidates({
  historyRecords = [],
  annualScheduleRows = [],
  listDepthRows = [],
  openCompetitiveRows = [],
  noticeCorpusRows = [],
}) {
  const historicalMissing = historyRecords.filter((row) => !cleanCode(row.title_code));
  const missingSet = new Set(historicalMissing.map((row) => normalizeExamNumber(row.exam_number)));
  const sourceScan = {
    "dcas-annual-schedule": { source: "annual_schedule.json", matches: 0 },
    "dcas-open-competitive": { source: "dcas_open_competitive.json", matches: 0 },
    "dcas-annual-closed-list-depth": { source: "list_depth_closed_exams.json", matches: 0 },
    "dcas-noe-notice-body": { source: "fixtures/noe_text", matches: 0 },
  };
  const backfillRows = [];

  const inspectRows = (rows, source) => {
    for (const row of rows) {
      const exam = normalizeExamNumber(row.exam_number || row.examNumber || row.exam_no || row.examNo);
      if (!exam || !missingSet.has(exam)) continue;
      const code = publisherTitleCode(row);
      if (!code) continue;
      sourceScan[source].matches += 1;
      backfillRows.push({
        source,
        source_file: sourceScan[source].source,
        exam_number: exam,
        title_code: code,
        source_date: row.data_current_as_of || row.application_period_end_date || row.application_end || row.updatedDate || null,
      });
    }
  };

  inspectRows(annualScheduleRows, "dcas-annual-schedule");
  inspectRows(openCompetitiveRows, "dcas-open-competitive");
  inspectRows(listDepthRows, "dcas-annual-closed-list-depth");
  for (const row of noticeCorpusRows) {
    const exam = normalizeExamNumber(row.exam_number);
    if (!exam || !missingSet.has(exam)) continue;
    if (!cleanCode(row.title_code)) continue;
    const source = "dcas-noe-notice-body";
    sourceScan[source].matches += 1;
    backfillRows.push({
      source,
      source_file: row.source_file,
      source_url: row.source_url,
      exam_number: exam,
      title_code: cleanCode(row.title_code),
      source_date: row.source_date,
      source_exam_id: row.oasys_exam_id || null,
    });
  }

  return {
    candidate_count: backfillRows.length,
    candidates: backfillRows,
    sources: Object.entries(sourceScan).map(([id, row]) => ({ id, ...row })),
  };
}

export function appointmentTitleCode(row = {}) {
  const match = String(row.additional_description_1 || "").match(/(?:^|;)\s*Title Code:\s*([^;]+)/i);
  return cleanCode(match?.[1]);
}

function exactAliasCode(title, aliasRegistry) {
  const codes = aliasRegistry?.alias_index?.[normalizeTitleLabel(title)] || [];
  return codes.length === 1 ? cleanCode(codes[0]) : null;
}

function residualFellegiSunter({ historyRecords, annualScheduleRows, appointmentRows, aliasRegistry }) {
  if (!aliasRegistry?.canonical_titles?.length) return null;
  const aliasResolved = new Set(
    historyRecords
      .filter((row) => !cleanCode(row.title_code))
      .map((row) => exactAliasCode(row.exam_title, aliasRegistry))
      .filter(Boolean),
  );
  const aliasResolvedRows = historyRecords.filter((row) => !cleanCode(row.title_code)
    && exactAliasCode(row.exam_title, aliasRegistry));
  const residualGold = historyRecords.filter((row) => cleanCode(row.title_code)
    && !exactAliasCode(row.exam_title, aliasRegistry));
  const residualMissing = historyRecords.filter((row) => !cleanCode(row.title_code)
    && !exactAliasCode(row.exam_title, aliasRegistry));
  const catalog = buildTitleCodeCatalog(aliasRegistry.canonical_titles.flatMap((row) => row.descriptions.map((description) => ({
    title_code: row.title_code,
    official_title: description,
    name_source: "nzjr-3966",
  }))));
  const context = buildTitleCodeContext({ historyRecords, annualScheduleRows, appointmentRows });
  const calibration = calibrateTitleCodeScorer(residualGold, catalog, context);
  const candidates = generateTitleCodeCandidates(residualMissing, catalog, context, {
    maxCandidates: 8,
    weights: calibration.feature_parameters,
  });
  return {
    alias_resolved_rows: aliasResolvedRows.length,
    alias_resolved_unique_codes: aliasResolved.size,
    residual_gold_rows: residualGold.length,
    residual_missing_rows: residualMissing.length,
    candidates: candidates.length,
    calibration,
    potential: measurePotentialLift({
      baseline: historyRecords.filter((row) => cleanCode(row.title_code)).length + aliasResolvedRows.length,
      denominator: historyRecords.length,
      rows: candidates,
      threshold: 0.8,
      minAgreements: 2,
    }),
  };
}

export function parseNoeNoticeTextNoticeId(fileName) {
  const match = String(fileName || "").match(/examId_(\d+)\.txt$/);
  return match?.[1] || null;
}

function parseNoeNoticeExamNumber(text) {
  const match = String(text || "").match(/Exam No\.?\s*([0-9]+)/i);
  return match?.[1] || null;
}

function parseNoeNoticeTitleCode(text) {
  const match = String(text || "").match(/Title Code No\.?\s*([0-9A-Z]{4,6})/i);
  return cleanCode(match?.[1]);
}

export async function collectNoticeCorpusRows({
  oasysExamMapRows = [],
  noticeTextDir = NOE_NOTICE_TEXT_DIR,
}) {
  const files = await readdir(noticeTextDir, { encoding: "utf8", withFileTypes: true });
  const byNoticeId = new Map(
    oasysExamMapRows
      .map((row) => [String(row.oasys_exam_id || ""), row])
      .filter(([key, row]) => key && row?.exam_number),
  );
  const rows = [];

  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".txt")) continue;
    const filePath = join(noticeTextDir, file.name);
    const body = await readFile(filePath, "utf8");
    const noticeId = parseNoeNoticeTextNoticeId(file.name);
    const mapped = byNoticeId.get(noticeId) || {};
    const exam = parseNoeNoticeExamNumber(body) || normalizeExamNumber(mapped.exam_number);
    const titleCode = parseNoeNoticeTitleCode(body);
    rows.push({
      oasys_exam_id: noticeId || mapped.oasys_exam_id,
      exam_number: exam,
      title_code: titleCode,
      source_file: file.name,
      source_url: mapped.notice_url || mapped.noe_page_url || null,
      source_date: mapped.filing_end || mapped.application_end || mapped.data_current_as_of || null,
    });
  }

  return rows;
}

export function measureTitleCodeFamilyCoverage({
  historyRecords = [],
  appointmentRows = [],
  titleCrosswalk = [],
  generatedAt = new Date().toISOString().slice(0, 10),
  annualScheduleRows = [],
  listDepthRows = [],
  openCompetitiveRows = [],
  noticeCorpusRows = [],
  reviewedRegistry = null,
  aliasRegistry = null,
} = {}) {
  const crosswalkCodes = new Set(titleCrosswalk.map((row) => cleanCode(row.title_code)).filter(Boolean));
  const exactExamRows = historyRecords.filter((row) => cleanCode(row.title_code));
  const appointmentCodes = appointmentRows.map(appointmentTitleCode).filter(Boolean);
  const exactExamCodes = exactExamRows.map((row) => cleanCode(row.title_code));
  const aliasRows = historyRecords.filter((row) => !cleanCode(row.title_code)
    && exactAliasCode(row.exam_title, aliasRegistry));
  const aliasCodes = aliasRows.map((row) => exactAliasCode(row.exam_title, aliasRegistry));
  const residualFs = residualFellegiSunter({
    historyRecords,
    annualScheduleRows,
    appointmentRows,
    aliasRegistry,
  });
  const sharedCodes = new Set(exactExamCodes.filter((code) => appointmentCodes.includes(code)));
  const examCoverage = rate(exactExamRows.length, historyRecords.length);
  const confirmedRows = Array.isArray(reviewedRegistry?.confirmations)
    ? reviewedRegistry.confirmations
    : [];
  const exactExamNumbers = new Set(exactExamRows.map((row) => normalizeExamNumber(row.exam_number)));
  const confirmedExamNumbers = new Set(
    confirmedRows
      .map((row) => normalizeExamNumber(row.exam_number))
      .filter((exam) => exam && !exactExamNumbers.has(exam)),
  );
  const reviewedConfirmedCount = confirmedExamNumbers.size;
  const exactPlusConfirmed = exactExamRows.length + reviewedConfirmedCount;
  const exactPlusConfirmedCoverage = rate(exactPlusConfirmed, historyRecords.length);
  const reviewedRows = [
    ...(Array.isArray(reviewedRegistry?.confirmations) ? reviewedRegistry.confirmations : []),
    ...(Array.isArray(reviewedRegistry?.rejections) ? reviewedRegistry.rejections : []),
  ];
  const reviewedCorrect = Array.isArray(reviewedRegistry?.confirmations)
    ? reviewedRegistry.confirmations.length
    : 0;
  const reviewPrecision = reviewedRows.length ? rate(reviewedCorrect, reviewedRows.length) : null;
  const residualPrecision = residualFs?.calibration?.held_out_top1_precision ?? reviewPrecision;
  const legacyControlPrecision = reviewPrecision;
  const twoTier = evaluateTwoTierPrecision({
    candidatePrecision: residualPrecision,
    controlBaseline: legacyControlPrecision,
    candidateSampleSize: residualFs?.calibration?.held_out_target_codes_in_catalog ?? reviewedRows.length,
    controlSampleSize: reviewedRows.length,
    labelMode: "labeled",
    candidateReceipt: "site/data/exam_sources/title_code_family_coverage.json#precision_audit",
    controlReceipt: `${TWO_TIER_BASELINE_RECEIPT}#baselines.title_code_legacy_review`,
  });
  const backfillCandidates = collectBackfillCandidates({
    historyRecords,
    annualScheduleRows,
    listDepthRows,
    openCompetitiveRows,
    noticeCorpusRows,
  });

  const measurement = {
    schema_version: 1,
    generated_at: generatedAt,
    method: {
      family_key: "exact publisher-supplied title_code",
      exam_revision_key: "exact normalized exam_number",
      title_text_matching: false,
      confidence: "strong only when title_code is present in the source row",
    },
    sources: {
      historical_exams: "annual_schedule_history.json",
      appointments: "../staffing_default_hires.json",
      title_names: "../title_crosswalk.json",
      title_code_alias_registry: "title_code_alias_registry.json",
    },
    historical_exams: {
      cohort: historyRecords.length,
      exact_title_code: exactExamRows.length,
      exact_title_code_rate: examCoverage,
      missing_title_code: historyRecords.length - exactExamRows.length,
      unique_exact_families: new Set(exactExamCodes).size,
      crosswalk_named: exactExamCodes.filter((code) => crosswalkCodes.has(code)).length,
      alias_registry_exact: aliasRows.length,
      alias_registry_exact_rate: rate(aliasRows.length, historyRecords.length),
      alias_registry_unique_codes: new Set(aliasCodes).size,
      reviewed_confirmed: reviewedConfirmedCount,
      exact_plus_confirmed: exactPlusConfirmed,
      exact_plus_confirmed_rate: exactPlusConfirmedCoverage,
      exact_plus_alias: exactExamRows.length + aliasRows.length,
      exact_plus_alias_rate: rate(exactExamRows.length + aliasRows.length, historyRecords.length),
    },
    appointments: {
      cohort: appointmentRows.length,
      exact_title_code: appointmentCodes.length,
      exact_title_code_rate: rate(appointmentCodes.length, appointmentRows.length),
      unique_exact_families: new Set(appointmentCodes).size,
      crosswalk_named: appointmentCodes.filter((code) => crosswalkCodes.has(code)).length,
      crosswalk_named_rate: rate(
        appointmentCodes.filter((code) => crosswalkCodes.has(code)).length,
        appointmentRows.length,
      ),
    },
    constellation: {
      shared_exact_families: sharedCodes.size,
      shared_title_codes: [...sharedCodes].sort(),
    },
    backfill: {
      shortfall_to_30pct: Math.max(
        0,
        Math.ceil(historyRecords.length * HISTORICAL_EXAM_COVERAGE_FLOOR)
          - (exactExamRows.length + aliasRows.length),
      ),
      candidate_rows_found: backfillCandidates.candidate_count,
      // These are exact-source candidates, not reviewed labels. Keeping this
      // at zero prevents candidate discovery from inflating the audit scope.
      reviewed_rows: 0,
      source_scan: backfillCandidates.sources,
      backfill_rows: backfillCandidates.candidates,
      note: backfillCandidates.candidate_count
        ? "exact publisher-supplied exam_number->title_code candidates found for historical misses"
        : "no exact publisher-supplied exam_number->title_code candidates found in checked official sources",
    },
    precision_audit: residualFs ? {
      method: residualFs.calibration.method,
      cohort: "historical residuals after exact-label alias resolution",
      reviewed: residualFs.calibration.held_out_target_codes_in_catalog,
      correct: residualFs.calibration.held_out_top1_correct,
      precision: residualFs.calibration.held_out_top1_precision,
      status: "residual_only_held_out",
      alias_registry_exact_precision: aliasRows.length ? 1 : null,
      residual_gold_rows: residualFs.residual_gold_rows,
      residual_missing_rows: residualFs.residual_missing_rows,
      calibration: residualFs.calibration,
      note: "Fellegi–Sunter is calibrated and evaluated only on historical rows not resolved by the exact publisher-labeled alias registry; candidate scores never authorize a public fact.",
      legacy_review: {
        reviewed: reviewedRows.length,
        correct: reviewedCorrect,
        precision: reviewPrecision,
      },
    } : {
      reviewed: reviewedRows.length,
      correct: reviewedCorrect,
      precision: reviewPrecision,
      status: reviewedRows.length ? "reviewed_labels_recorded" : "not_run",
      note: reviewedRows.length
        ? "Explicit review labels are measured separately from publisher-supplied exact title codes; pending labels are excluded from precision."
        : "No explicit review labels were recorded.",
    },
    residual_fellegi_sunter: residualFs,
    promotion: {
      historical_exam_coverage_floor: HISTORICAL_EXAM_COVERAGE_FLOOR,
      audit_precision_floor: AUDIT_PRECISION_FLOOR,
      coverage_rate: residualFs
        ? rate(exactExamRows.length + aliasRows.length, historyRecords.length)
        : exactPlusConfirmedCoverage,
      coverage_passed: (residualFs
        ? rate(exactExamRows.length + aliasRows.length, historyRecords.length)
        : exactPlusConfirmedCoverage) >= HISTORICAL_EXAM_COVERAGE_FLOOR,
      precision_passed: (residualFs
        ? residualFs.calibration.held_out_top1_precision
        : reviewPrecision) != null
        && (residualFs
          ? residualFs.calibration.held_out_top1_precision
          : reviewPrecision) >= AUDIT_PRECISION_FLOOR,
      two_tier: {
        ...twoTier,
        labeled_surface: "title_code_family",
        unlabeled_surface: "title_code_entity_pivot",
        baseline_method: "existing reviewed title-code control, measured against explicit confirmations and rejections",
        baseline_receipt: TWO_TIER_BASELINE_RECEIPT,
      },
      passed: false,
      publish_family_ui: false,
      publish_entity_pivots: false,
      verdict: (residualFs
        ? rate(exactExamRows.length + aliasRows.length, historyRecords.length)
        : exactPlusConfirmedCoverage) >= HISTORICAL_EXAM_COVERAGE_FLOOR
        && (residualFs ? residualFs.calibration.held_out_top1_precision : reviewPrecision) != null
        && (residualFs ? residualFs.calibration.held_out_top1_precision : reviewPrecision) >= AUDIT_PRECISION_FLOOR
        ? "PASS — exact-label coverage and residual precision clear the promotion bars."
        : "STOP — exact-label coverage or residual precision is below the promotion bar; title-code family UI and pivots remain disabled.",
    },
  };
  measurement.promotion.passed = measurement.promotion.coverage_passed
    && measurement.promotion.precision_passed;
  // The family UI may ship with a visible inference label once the residual
  // conversion beats its measured control. Entity pivots still require the
  // absolute unlabeled-fact floor.
  measurement.promotion.publish_family_ui = measurement.promotion.coverage_passed
    && measurement.promotion.two_tier.can_ship_labeled;
  measurement.promotion.publish_entity_pivots = measurement.promotion.coverage_passed
    && measurement.promotion.two_tier.can_ship_unlabeled;
  measurement.promotion.passed = measurement.promotion.publish_entity_pivots;
  measurement.promotion.verdict = measurement.promotion.publish_family_ui
    ? "COMPARATIVE PASS — exact publisher labels may render as facts; residual family labels may ship visibly inferred; unlabeled pivots remain below the 95% floor."
    : measurement.promotion.verdict;
  return measurement;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const [history, annualSchedule, listDepth, openCompetitive, appointments, crosswalk, oasysExamMap, aliasRegistry] = await Promise.all([
    readJson(join(ROOT, "site/data/exam_sources/annual_schedule_history.json")),
    readJson(join(ROOT, "site/data/exam_sources/annual_schedule.json")),
    readJson(join(ROOT, "site/data/exam_sources/list_depth_closed_exams.json")),
    readJson(join(ROOT, "site/data/exam_sources/dcas_open_competitive.json")),
    readJson(join(ROOT, "site/data/staffing_default_hires.json")),
    readJson(join(ROOT, "site/data/title_crosswalk.json")),
    readJson(join(ROOT, "site/data/exam_sources/oasys_exam_map.json")),
    readJson(ALIAS_REGISTRY),
  ]);
  const noticeCorpusRows = await collectNoticeCorpusRows({ oasysExamMapRows: oasysExamMap.records || [] });
  const reviewedRegistry = await readJson(REVIEW_REGISTRY);
  const artifact = measureTitleCodeFamilyCoverage({
    historyRecords: history.records,
    annualScheduleRows: annualSchedule.records || [],
    listDepthRows: listDepth.records || [],
    openCompetitiveRows: openCompetitive.records || [],
    noticeCorpusRows,
    appointmentRows: appointments.notices,
    titleCrosswalk: crosswalk,
    reviewedRegistry,
    aliasRegistry,
    generatedAt: aliasRegistry.generated_at,
  });
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const existing = await readFile(OUTPUT, "utf8");
    assert.equal(existing, serialized, "title-code family coverage artifact is stale");
    console.log("title-code family coverage artifact is current");
    return;
  }
  await writeFile(OUTPUT, serialized);
  console.log(`wrote ${OUTPUT.slice(ROOT.length + 1)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
