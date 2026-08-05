#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "site/data/exam_sources/title_code_family_coverage.json");

export const HISTORICAL_EXAM_COVERAGE_FLOOR = 0.30;
export const AUDIT_PRECISION_FLOOR = 0.95;

const cleanCode = (value) => String(value || "").trim().toUpperCase();
const rate = (numerator, denominator) => denominator ? Number((numerator / denominator).toFixed(4)) : 0;

export function appointmentTitleCode(row = {}) {
  const match = String(row.additional_description_1 || "").match(/(?:^|;)\s*Title Code:\s*([^;]+)/i);
  return cleanCode(match?.[1]);
}

export function measureTitleCodeFamilyCoverage({
  historyRecords = [],
  appointmentRows = [],
  titleCrosswalk = [],
  generatedAt = new Date().toISOString().slice(0, 10),
} = {}) {
  const crosswalkCodes = new Set(titleCrosswalk.map((row) => cleanCode(row.title_code)).filter(Boolean));
  const exactExamRows = historyRecords.filter((row) => cleanCode(row.title_code));
  const appointmentCodes = appointmentRows.map(appointmentTitleCode).filter(Boolean);
  const exactExamCodes = exactExamRows.map((row) => cleanCode(row.title_code));
  const sharedCodes = new Set(exactExamCodes.filter((code) => appointmentCodes.includes(code)));
  const examCoverage = rate(exactExamRows.length, historyRecords.length);

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
    precision_audit: {
      reviewed: 0,
      correct: 0,
      precision: null,
      status: "not_run_below_coverage_floor",
      note: "The exact-key coverage gate failed, so no title-text candidate audit was used to promote a family surface.",
    },
    promotion: {
      historical_exam_coverage_floor: HISTORICAL_EXAM_COVERAGE_FLOOR,
      audit_precision_floor: AUDIT_PRECISION_FLOOR,
      coverage_passed: examCoverage >= HISTORICAL_EXAM_COVERAGE_FLOOR,
      precision_passed: false,
      passed: false,
      publish_family_ui: false,
      publish_entity_pivots: false,
      verdict: "STOP — exact historical exam coverage is below the 30% floor; title-code family UI and pivots remain disabled.",
    },
  };
  measurement.promotion.passed = measurement.promotion.coverage_passed
    && measurement.promotion.precision_passed;
  return measurement;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const [history, appointments, crosswalk] = await Promise.all([
    readJson(join(ROOT, "site/data/exam_sources/annual_schedule_history.json")),
    readJson(join(ROOT, "site/data/staffing_default_hires.json")),
    readJson(join(ROOT, "site/data/title_crosswalk.json")),
  ]);
  const artifact = measureTitleCodeFamilyCoverage({
    historyRecords: history.records,
    appointmentRows: appointments.notices,
    titleCrosswalk: crosswalk,
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
