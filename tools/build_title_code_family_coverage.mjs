#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "site/data/exam_sources/title_code_family_coverage.json");
const REVIEW_REGISTRY = join(ROOT, "entity_resolution/review/title_code_registry.json");
const NOE_NOTICE_TEXT_DIR = join(ROOT, "site/data/exam_sources/fixtures/noe_text");

export const HISTORICAL_EXAM_COVERAGE_FLOOR = 0.30;
export const AUDIT_PRECISION_FLOOR = 0.95;

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
} = {}) {
  const crosswalkCodes = new Set(titleCrosswalk.map((row) => cleanCode(row.title_code)).filter(Boolean));
  const exactExamRows = historyRecords.filter((row) => cleanCode(row.title_code));
  const appointmentCodes = appointmentRows.map(appointmentTitleCode).filter(Boolean);
  const exactExamCodes = exactExamRows.map((row) => cleanCode(row.title_code));
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
    },
    historical_exams: {
      cohort: historyRecords.length,
      exact_title_code: exactExamRows.length,
      exact_title_code_rate: examCoverage,
      missing_title_code: historyRecords.length - exactExamRows.length,
      unique_exact_families: new Set(exactExamCodes).size,
      crosswalk_named: exactExamCodes.filter((code) => crosswalkCodes.has(code)).length,
      reviewed_confirmed: reviewedConfirmedCount,
      exact_plus_confirmed: exactPlusConfirmed,
      exact_plus_confirmed_rate: exactPlusConfirmedCoverage,
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
        Math.ceil(historyRecords.length * HISTORICAL_EXAM_COVERAGE_FLOOR) - exactExamRows.length,
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
    precision_audit: {
      reviewed: reviewedRows.length,
      correct: reviewedCorrect,
      precision: reviewPrecision,
      status: reviewedRows.length ? "reviewed_labels_recorded" : "not_run",
      note: reviewedRows.length
        ? "Explicit review labels are measured separately from publisher-supplied exact title codes; pending labels are excluded from precision."
        : "No explicit review labels were recorded.",
    },
    promotion: {
      historical_exam_coverage_floor: HISTORICAL_EXAM_COVERAGE_FLOOR,
      audit_precision_floor: AUDIT_PRECISION_FLOOR,
      coverage_passed: exactPlusConfirmedCoverage >= HISTORICAL_EXAM_COVERAGE_FLOOR,
      precision_passed: reviewPrecision != null && reviewPrecision >= AUDIT_PRECISION_FLOOR,
      passed: false,
      publish_family_ui: false,
      publish_entity_pivots: false,
      verdict: exactPlusConfirmedCoverage >= HISTORICAL_EXAM_COVERAGE_FLOOR
        && reviewPrecision != null
        && reviewPrecision >= AUDIT_PRECISION_FLOOR
        ? "PASS — exact and explicitly reviewed title-code coverage and precision clear the promotion bars."
        : "STOP — exact plus reviewed historical exam coverage or reviewed precision is below the promotion bar; title-code family UI and pivots remain disabled.",
    },
  };
  measurement.promotion.passed = measurement.promotion.coverage_passed
    && measurement.promotion.precision_passed;
  measurement.promotion.publish_family_ui = measurement.promotion.passed;
  measurement.promotion.publish_entity_pivots = measurement.promotion.passed;
  return measurement;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const [history, annualSchedule, listDepth, openCompetitive, appointments, crosswalk, oasysExamMap] = await Promise.all([
    readJson(join(ROOT, "site/data/exam_sources/annual_schedule_history.json")),
    readJson(join(ROOT, "site/data/exam_sources/annual_schedule.json")),
    readJson(join(ROOT, "site/data/exam_sources/list_depth_closed_exams.json")),
    readJson(join(ROOT, "site/data/exam_sources/dcas_open_competitive.json")),
    readJson(join(ROOT, "site/data/staffing_default_hires.json")),
    readJson(join(ROOT, "site/data/title_crosswalk.json")),
    readJson(join(ROOT, "site/data/exam_sources/oasys_exam_map.json")),
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
    generatedAt: history.source.fetched_at,
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
