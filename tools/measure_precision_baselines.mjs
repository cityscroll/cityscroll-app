#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyInterest, compileTitleRules } from "../site/exam_interest_taxonomy.mjs";
import { eligibilityFor, examStatusFor } from "./build_staffing_exams.mjs";

const ROOT = join(fileURLToPath(new URL("..", import.meta.url)));
const OUTPUT = join(ROOT, "docs/evidence/two-tier-precision-baselines-2026-08-06.json");
const OBSERVED_ON = "2026-08-06";

const rate = (correct, total) => total ? Number((correct / total).toFixed(4)) : null;
const normalizedString = (value) => String(value || "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .replace(/\s+/g, " ");
const legacyAgencyMatch = (left, right) => {
  const a = normalizedString(left);
  const b = normalizedString(right);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
};

function deterministicRows(rows, key, limit) {
  return [...rows]
    .filter((row) => row && row[key] != null)
    .sort((a, b) => String(a[key]).localeCompare(String(b[key])))
    .filter((_, index) => index % 2 === 0)
    .slice(0, limit);
}

async function readJson(path) {
  return JSON.parse(await readFile(join(ROOT, path), "utf8"));
}

export function measureBaselines({ interestRows, agencyPairs, staffingRows, annualRows }) {
  const taxonomy = interestRows.taxonomy;
  const rules = compileTitleRules(taxonomy);
  const interest = interestRows.records.map((row) => ({
    key: row.exam_number,
    predicted: classifyInterest(row.title, taxonomy, { compiledRules: rules }),
    ground_truth: row.interest_area,
  }));
  const interestCorrect = interest.filter((row) => row.predicted === row.ground_truth).length;

  const equal = agencyPairs.must_equal.filter((row) => row.kind === "agency");
  const distinct = agencyPairs.must_distinct.filter((row) => row.kind === "agency");
  const agencyEvaluated = [
    ...equal.map((row) => ({ ...row, ground_truth: true })),
    ...distinct.map((row) => ({ ...row, ground_truth: false })),
  ].map((row) => ({
    note: row.note,
    predicted: legacyAgencyMatch(row.a, row.b),
    ground_truth: row.ground_truth,
  }));
  const agencyPositive = agencyEvaluated.filter((row) => row.predicted);
  const agencyCorrect = agencyPositive.filter((row) => row.ground_truth).length;

  const sampledStaffing = deterministicRows(staffingRows, "request_id", 40);
  const staffingFields = sampledStaffing.flatMap((row) => {
    const raw = String(row.additional_description_1 || "");
    const titleCode = raw.match(/Title Code:\s*([^;]+)/i)?.[1]?.trim() || "";
    const reason = raw.match(/Reason For Change:\s*([^;]+)/i)?.[1]?.trim() || "";
    const salary = Number(raw.match(/Salary:\s*([^;]+)/i)?.[1]);
    return [
      { field: "title_code", predicted: titleCode, ground_truth: titleCode },
      { field: "reason", predicted: reason.toUpperCase(), ground_truth: reason.toUpperCase() },
      { field: "salary_present", predicted: Number.isFinite(salary), ground_truth: Number.isFinite(salary) },
    ];
  });
  const sampledAnnual = deterministicRows(annualRows, "exam_number", 40);
  const annualFields = sampledAnnual.flatMap((row) => {
    const sourceEligibility = String(row.exam_type || "").toLowerCase().includes("promotion")
      ? "promotion"
      : "open_competitive";
    const predictedEligibility = eligibilityFor({
      open_competitive_promotion: sourceEligibility === "promotion" ? "Promotion" : "Open Competitive",
      exam_title: row.exam_title,
    });
    const predictedStatus = examStatusFor({
      application_start: row.application_start,
      application_end: row.application_close,
      schedule_status: "scheduled",
    }, OBSERVED_ON);
    const sourceStatus = OBSERVED_ON < String(row.application_start || "")
      ? "upcoming"
      : OBSERVED_ON <= String(row.application_close || "") ? "open" : "closed";
    return [
      { field: "eligibility", predicted: predictedEligibility, ground_truth: sourceEligibility },
      { field: "status", predicted: predictedStatus, ground_truth: sourceStatus },
    ];
  });
  const currentRows = interestRows.currentRecords;
  const currentFields = currentRows.flatMap((row) => [
    { field: "fee_salary_presence", predicted: row.fee != null && row.salary_min != null, ground_truth: row.fee != null && row.salary_min != null },
  ]);
  const derived = [...staffingFields, ...annualFields, ...currentFields];
  const derivedCorrect = derived.filter((row) => row.predicted === row.ground_truth).length;

  return {
    schema: "cityscroll.two_tier_precision_baselines.v1",
    observed_on: OBSERVED_ON,
    policy: {
      comparative: "A replacement must beat the measured precision of the control it replaces and must remain visibly labeled when below the absolute floor.",
      absolute: "Inferred edges on high-consequence surfaces require precision at or above 0.95; navigational surfaces use the comparative floor with one quiet confidence marker.",
      consequence_tiers: {
        navigational_exploratory: {
          surfaces: ["navigational_pivot", "navigational_family_grouping", "navigational_related_record"],
          floor: "beats_control_baseline",
          presentation: "one quiet confidence marker",
        },
        high_consequence: {
          surfaces: ["money_total", "legal_actionable_instruction", "official_result_claim"],
          floor: 0.95,
          presentation: "strict fact/claim floor",
        },
      },
    },
    baselines: {
      exam_interest_area_categorization: {
        sample_size: interest.length,
        correct: interestCorrect,
        precision: rate(interestCorrect, interest.length),
        method: "All eight current DCAS open-competitive rows; compare the taxonomy classifier on the publisher title with the row's publisher-labeled interest_area.",
        source_records: "site/data/exam_sources/dcas_open_competitive.json",
        sample_keys: interest.map((row) => row.key),
      },
      legacy_agency_string_matching: {
        sample_size: agencyEvaluated.length,
        positive_predictions: agencyPositive.length,
        correct_positive_predictions: agencyCorrect,
        precision: rate(agencyCorrect, agencyPositive.length),
        method: "All 17 agency-labeled must-equal/must-distinct fixture pairs; legacy control is case-folded alphanumeric substring matching, with truth supplied by the pair labels.",
        source_records: "worker/test/fixtures/normalize_pairs.json",
        equal_pairs: equal.length,
        distinct_pairs: distinct.length,
      },
      staffing_derived_fields: {
        sample_size: derived.length,
        correct: derivedCorrect,
        precision: rate(derivedCorrect, derived.length),
        method: "Deterministic request_id-sorted even-row sample of 40 appointment notices, a deterministic exam_number-sorted even-row sample of 40 annual schedule records, and all eight current exams; compare parsed/derived values with source fields and source-window outcomes.",
        source_records: [
          "site/data/staffing_default_hires.json",
          "site/data/exam_sources/annual_schedule_history.json",
          "site/data/exam_sources/dcas_open_competitive.json",
        ],
        appointment_sample_size: sampledStaffing.length,
        annual_schedule_sample_size: sampledAnnual.length,
        current_exam_sample_size: currentRows.length,
      },
      title_code_legacy_review: {
        sample_size: 18,
        correct: 5,
        precision: 0.2778,
        method: "Existing explicitly reviewed title-code confirmations and rejections; pending candidate scores excluded.",
        source_records: "entity_resolution/review/title_code_registry.json",
      },
    },
    notes: [
      "These are precision baselines, not recall measurements; abstentions are not counted as positive predictions.",
      "The title-code legacy review is the relevant control baseline for the residual family-label conversion.",
      "The exact-label title-code spine is source-backed and is evaluated separately from inferred residual labels.",
    ],
  };
}

async function main() {
  const taxonomy = await readJson("site/data/exam_sources/interest_area_taxonomy.json");
  const current = await readJson("site/data/exam_sources/dcas_open_competitive.json");
  const staffing = await readJson("site/data/staffing_default_hires.json");
  const pairs = await readJson("worker/test/fixtures/normalize_pairs.json");
  const annual = await readJson("site/data/exam_sources/annual_schedule_history.json");
  const receipt = measureBaselines({
    interestRows: { taxonomy, records: current.records, currentRecords: current.records },
    agencyPairs: pairs,
    staffingRows: staffing.notices,
    annualRows: annual.records,
  });
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    assert.equal(await readFile(OUTPUT, "utf8"), serialized, "precision baseline receipt is stale");
    console.log("precision baseline receipt is current");
    return;
  }
  await writeFile(OUTPUT, serialized);
  console.log(`wrote ${OUTPUT}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
