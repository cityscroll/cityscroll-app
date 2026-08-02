#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildListAggregateIndex,
  joinExamToListAggregate,
} from "../worker/src/lib/civil_service_list_join.mjs";
import { applyNoeFeeSalaryFromBody } from "../worker/src/lib/noe_fee_salary.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = path.join(ROOT, "site", "data", "exam_sources");
const OUTPUT = path.join(ROOT, "site", "data", "staffing_exams.json");
const DENSIFY_RECEIPT_DIR = path.join(SOURCE_DIR, "verification_receipts");
const ANNUAL_ID = "4ptz-hmtc";
const OUTCOMES_ID = "dcas-annual-exam-outcomes";
const ACTIVE_LIST_ID = "vx8i-nprf";
const CITY_RECORD_ID = "dg92-zbpx";
const CURRENT_ID = "dcas-open-competitive";
const NOE_ID = "dcas-noe";
const NOE_DENSIFY_ID = "dcas-noe-fee-salary-densify";
const LIST_AGGREGATES_FILE = "civil_service_list_aggregates.json";
const LIST_DEPTH_CLOSED_FILE = "list_depth_closed_exams.json";
const NOE_DENSIFY_FILE = "noe_fee_salary_densify.json";
/** Bump when densify merge / fee-salary materialization shape changes (version-guard). */
export const STAFFING_EXAMS_SCHEMA_VERSION = 2;

/** Fields that only come from the Notice of Examination / open-competitive path. */
export const NOE_DETAIL_FIELDS = [
  "notice_url",
  "fee",
  "fee_waiver",
  "salary_min",
  "salary_max",
  "salary_note",
  "summary",
  "qualifications",
  "test_method",
  "noe_body",
];

// Re-export body densify so build callers and tests share one entry.
export {
  applyNoeFeeSalaryFromBody,
  parseNoeFeeSalaryFromBody,
  toMoneyAmount,
  extractNoeExamNumbers,
} from "../worker/src/lib/noe_fee_salary.mjs";

/**
 * Merge NOE body densify records onto exams missing structured fee/salary.
 * Never overwrites a non-null fee (incl. 0) or salary_min from open-competitive / prior.
 * @param {object} exam
 * @param {object|null|undefined} densifyRow
 * @returns {object}
 */
export function applyNoeDensifyRecord(exam, densifyRow) {
  if (!exam || !densifyRow) return exam;
  const out = { ...exam };
  let changed = false;
  if (out.fee == null && densifyRow.fee != null) {
    out.fee = densifyRow.fee;
    changed = true;
  }
  if (
    (out.salary_min == null || out.salary_min === "")
    && densifyRow.salary_min != null
    && densifyRow.salary_min !== ""
  ) {
    out.salary_min = densifyRow.salary_min;
    changed = true;
  }
  if (
    (out.salary_max == null || out.salary_max === "")
    && densifyRow.salary_max != null
    && densifyRow.salary_max !== ""
  ) {
    out.salary_max = densifyRow.salary_max;
    changed = true;
  }
  if (!out.salary_note && densifyRow.salary_note) {
    out.salary_note = densifyRow.salary_note;
    changed = true;
  }
  if (!out.notice_url && densifyRow.notice_url) {
    out.notice_url = densifyRow.notice_url;
    changed = true;
  }
  if (!changed) return exam;
  const sources = [...new Set([...(out.sources || []), NOE_ID, NOE_DENSIFY_ID])];
  out.sources = sources;
  if (densifyRow.densify_method) out.fee_salary_densify = densifyRow.densify_method;
  return out;
}

/**
 * Count exams with both fee and salary_min present (fee 0 counts).
 * @param {Array<object>} exams
 * @returns {{ total: number, both: number, rate: number }}
 */
export function feeSalaryNonNullStats(exams = []) {
  const total = exams.length;
  const both = exams.filter(
    (e) => e && e.fee != null && e.salary_min != null && e.salary_min !== "",
  ).length;
  return {
    total,
    both,
    rate: total ? both / total : 0,
  };
}

const INTEREST_RULES = [
  ["public-safety", /\b(police|correction|safety|special officer|fire|probation)\b/i],
  ["health-care", /\b(health|hospital|medical|dental|nurse|therap|emergency medical|mortuary|addiction)\b/i],
  ["engineering-construction", /\b(engineer|engineering|construction|architect|building|plan examiner|inspector|estim(?:ator))\b/i],
  ["technology-science", /\b(computer|technology|data|scientist|laboratory|research|telecommunication)\b/i],
  ["community-social-services", /\b(caseworker|social|youth|welfare|housing|community|counselor|child protective)\b/i],
  ["administration-finance", /\b(account|auditor|administrative|contract specialist|cashier|records|management|labor relations)\b/i],
  ["trades-operations", /\b(mechanic|electric|maintain|maintenance|operator|roofer|plaster|carpenter|machinist|blacksmith|metal|plant|deckhand|forester|exterminator)\b/i],
];

export function classifyInterest(title) {
  return (INTEREST_RULES.find(([, pattern]) => pattern.test(title || "")) || ["other"])[0];
}

export function isoDate(value) {
  return value ? String(value).slice(0, 10) : null;
}

export function eligibilityFor(row) {
  if (/promotion/i.test(row.open_competitive_promotion || "") || /\(prom\)/i.test(row.exam_title || "")) {
    return "promotion";
  }
  return "open_competitive";
}

export function scheduleStatus(row) {
  const raw = String(row.open_competitive_promotion || row.application_notes || row.notes || "").toLowerCase();
  if (raw.includes("cancel")) return "canceled";
  if (raw.includes("postpon")) return "postponed";
  return "scheduled";
}

export function sourceAgeDays(source, today) {
  const sourceDate = source.verified_at || source.data_current_as_of || source.fetched_at || source.data_publication_date;
  if (!sourceDate) return Infinity;
  const sourceEpoch = Date.parse(`${sourceDate}T00:00:00Z`);
  const todayEpoch = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(sourceEpoch) || !Number.isFinite(todayEpoch)) return Infinity;
  return Math.max(0, Math.floor((todayEpoch - sourceEpoch) / 86_400_000));
}

export function assertSourceFresh(source, today) {
  assert(source && source.id, `${JSON.stringify(source)}: source missing id`);
  assert(Number.isFinite(source.stale_after_days) && source.stale_after_days > 0, `${source.id}: stale_after_days must be positive`);
  const age = sourceAgeDays(source, today);
  assert(age <= source.stale_after_days, `${source.id}: source is stale (${age} days; limit ${source.stale_after_days})`);
}

export function examStatusFor(row, today) {
  if (row.schedule_status === "canceled") return "canceled";
  if (row.schedule_status === "postponed") return "postponed";
  if (!row.application_start || !row.application_end) return "unscheduled";
  if (today < row.application_start) return "upcoming";
  if (today <= row.application_end) return "open";
  return "closed";
}

export function normalizeAnnual(row) {
  const title = row.exam_title?.trim();
  const examNumber = String(row.exam_number || "").trim();
  assert(title && /^\d{4}$/.test(examNumber), `invalid annual exam row: ${JSON.stringify(row)}`);
  return {
    exam_number: examNumber,
    title_code: String(row.title_code || "").trim() || null,
    title,
    application_start: isoDate(row.application_period_start),
    application_end: isoDate(row.application_period_end_date),
    eligibility: eligibilityFor(row),
    schedule_status: scheduleStatus(row),
    interest_area: classifyInterest(title),
    sources: ["dcas-annual-schedule"],
  };
}

function normalizeCurrent(row) {
  const examNumber = String(row.exam_number || "").trim();
  assert(/^\d{4}$/.test(examNumber), `invalid current exam number: ${row.exam_number}`);
  // When a raw NOE body is present, densify missing fee/salary before merge.
  const densified = applyNoeFeeSalaryFromBody({
    exam_number: examNumber,
    ...row,
    application_start: isoDate(row.application_start),
    application_end: isoDate(row.application_end),
    schedule_status: scheduleStatus(row),
    sources: [
      "dcas-open-competitive",
      NOE_ID,
    ],
  });
  // Drop bulky body from the client artifact once structured fields are filled.
  if (densified.noe_body && densified.fee != null && densified.salary_min != null) {
    const { noe_body: _drop, body: _b, noe_text: _t, ...rest } = densified;
    return rest;
  }
  return densified;
}

function mergeCurrent(annualRow, currentRow) {
  const merged = {
    ...annualRow,
    ...currentRow,
    schedule_status: currentRow.schedule_status || annualRow.schedule_status || "scheduled",
  };
  merged.sources = [...new Set([...(annualRow?.sources || []), ...(currentRow?.sources || []), CURRENT_ID, NOE_ID])];
  merged.interest_area = currentRow.interest_area || annualRow.interest_area || classifyInterest(merged.title || "");
  return merged;
}

/**
 * Keep NOE fee/salary/notice fields when an exam drops off the open-competitive
 * snapshot but remains on the annual schedule. Without this, rebuilds wipe real
 * NOE amounts and the card falls through to a false "city does not publish" gap.
 */
export function retainNoeDetailFields(exam, prior) {
  if (!exam || !prior) return exam;
  const out = { ...exam };
  let retained = false;
  for (const field of NOE_DETAIL_FIELDS) {
    const currentMissing = out[field] == null || out[field] === "";
    const priorHas = prior[field] != null && prior[field] !== "";
    // fee may legitimately be 0 (no application fee) — treat 0 as present.
    if (field === "fee") {
      if (out.fee == null && prior.fee != null) {
        out.fee = prior.fee;
        retained = true;
      }
      continue;
    }
    if (currentMissing && priorHas) {
      out[field] = prior[field];
      retained = true;
    }
  }
  if (retained || out.notice_url || out.fee != null || out.salary_min != null) {
    const sources = [...(out.sources || [])];
    if (out.notice_url || out.fee != null || out.salary_min != null) {
      sources.push(NOE_ID);
      if (prior.sources?.includes(CURRENT_ID)) sources.push(CURRENT_ID);
    }
    out.sources = [...new Set(sources)];
  }
  return out;
}

/**
 * Classify fee/salary absence.
 * - Both present → no gap (NOE path delivered amounts).
 * - notice_url present but a field null → true NOE omit (class b rare).
 * - No NOE in the extract → not yet ingested (class a); annual schedule has no fee columns.
 */
export function feeSalaryGapFor(exam) {
  // Prefer structured fields; densify from body when the open-competitive extract
  // carried raw NOE text without pre-parsed amounts.
  const densified = applyNoeFeeSalaryFromBody(exam);
  const hasFee = densified?.fee != null;
  const hasSalary = densified?.salary_min != null && densified.salary_min !== "";
  if (hasFee && hasSalary) return null;
  const missing = [];
  if (!hasFee) missing.push("fee");
  if (!hasSalary) missing.push("salary_min");
  if (exam?.notice_url) {
    return {
      class: "not_published",
      missing,
      would_appear_in: "the Notice of Examination if DCAS stated the amount",
    };
  }
  return {
    class: "not_yet_ingested",
    missing,
    public_source: {
      name: "DCAS open-competitive exam schedule and Notices of Examination",
      access: "Open-competitive schedule page + linked Notice of Examination PDFs",
      landing_page: "https://www.nyc.gov/site/dcas/employment/exam-schedules-open-competitive-exams.page",
    },
  };
}

export function attachFeeSalaryGap(exam) {
  // Densify from NOE body first so gap classification sees structured amounts.
  const densified = applyNoeFeeSalaryFromBody(exam);
  const { noe_body: _body, body: _b, noe_text: _t, ...withoutBody } = densified;
  const base =
    densified.fee != null && densified.salary_min != null
      ? withoutBody
      : densified;
  const gap = feeSalaryGapFor(base);
  if (!gap) {
    const { fee_salary_gap: _drop, ...rest } = base;
    return { ...rest, fee_salary_gap: null };
  }
  return { ...base, fee_salary_gap: gap };
}

function normalizeOutcome(row) {
  const examNumber = String(row.exam_number || "").trim();
  assert(/^\d{4}$/.test(examNumber), `invalid outcome exam number: ${row.exam_number}`);
  return {
    exam_number: examNumber,
    application_cycle: row.application_cycle || row.cycles || "annual",
    applicant_count: Number(row.applicant_count || row.applicants || 0),
    list_establishment: Number(row.list_establishment || row.list_count || 0),
    certification_count: Number(row.certification_count || row.certified || 0),
    appointment_count: Number(row.appointment_count || row.appointments || 0),
    hire_count: Number(row.hire_count || row.hired || 0),
    published_on: row.published_on || null,
  };
}

function normalizedAmendmentChange(current, prior) {
  const notes = [];
  const fields = [
    ["application_start", "application start date"],
    ["application_end", "application end date"],
    ["schedule_status", "schedule status"],
    ["fee", "application fee"],
    ["salary_min", "minimum salary"],
  ];
  for (const [field, label] of fields) {
    const currentValue = String(current[field] ?? "");
    const priorValue = String(prior[field] ?? "");
    if (currentValue && priorValue && currentValue !== priorValue) {
      notes.push(`${label} changed from ${priorValue} to ${currentValue}`);
    }
  }
  return notes.join("; ");
}

function annotateAmendment(exam, prior) {
  const change = normalizedAmendmentChange(exam, prior);
  if (!change) return exam;
  const amendment = [prior.amendment, change].filter(Boolean).join(". ");
  return { ...exam, amendment };
}

function markWithdrawnPrior(prior, asOf) {
  if (prior.schedule_status === "canceled") return prior;
  if (examStatusFor(prior, asOf || "2026-07-29") === "closed") return prior;
  const reason = "DCAS annual/current source no longer contains this exam; it is treated as withdrawn until re-listed.";
  return {
    ...prior,
    schedule_status: "canceled",
    amendment: [prior.amendment, reason].filter(Boolean).join(". "),
    sources: [...new Set([...(prior.sources || []), "dcas-annual-schedule", CURRENT_ID, NOE_ID])],
  };
}

function buildOutcomes({ outcomes }) {
  const summary = {
    count: (outcomes.records || []).length,
  };
  return {
    source: outcomes.source,
    records: (outcomes.records || []).map(normalizeOutcome),
    summary,
  };
}

/** Join key is exam_number only. When multiple cycles share a number, prefer the latest published_on. */
export function outcomesByExamNumber(outcomeRecords) {
  const map = new Map();
  for (const row of outcomeRecords || []) {
    const normalized = normalizeOutcome(row);
    const existing = map.get(normalized.exam_number);
    if (!existing) {
      map.set(normalized.exam_number, normalized);
      continue;
    }
    const existingOn = existing.published_on || "";
    const nextOn = normalized.published_on || "";
    if (nextOn >= existingOn) map.set(normalized.exam_number, normalized);
  }
  return map;
}

/**
 * Attach a per-exam outcome object (or null) so cards never live-fetch the outcomes table.
 * Gap class is decided only after the list-aggregate join (see joinOutcomesAndListOntoExam):
 * public annual + list sources exist, so a miss is not automatically "city does not publish".
 */
export function joinOutcomeOntoExam(exam, outcomeMap) {
  const matched = outcomeMap.get(exam.exam_number) || null;
  if (!matched) {
    return {
      ...exam,
      outcome: null,
      // Placeholder until list join runs; joinOutcomesAndListOntoExam rewrites this.
      outcome_gap: {
        class: "not_yet_ingested",
        pending_stage: "list_establishment",
      },
    };
  }
  const { exam_number: _examNumber, ...counts } = matched;
  return {
    ...exam,
    outcome: counts,
    outcome_gap: null,
  };
}

/**
 * Attach privacy-safe Civil Service List aggregates (list_count + dates only).
 * Never copies per-applicant fields. When annual outcomes are absent but a list
 * is established, cards can render post-list depth without inventing hire counts.
 */
export function joinListAggregateOntoExam(exam, listIndex) {
  const hit = joinExamToListAggregate(exam.exam_number, listIndex);
  if (!hit) {
    return {
      ...exam,
      list_aggregate: null,
    };
  }
  return {
    ...exam,
    list_aggregate: {
      list_count: hit.list_count,
      established_date: hit.established_date,
      extension_date: hit.extension_date,
      title_count: hit.title_count,
      source_id: "dcas-active-civil-service-list",
    },
  };
}

/**
 * Prefer full annual outcome counts; else list-size depth; else class-(a) gap.
 *
 * Public sources (DCAS annual outcomes publication + Civil Service List Open Data)
 * exist for aggregate post-cycle depth. An empty slot is incomplete join / cycle
 * pending — never a false class-(b) "city does not publish" withhold. Individual
 * scores stay class-(b) elsewhere (exam-outcome-individual).
 */
export function joinOutcomesAndListOntoExam(exam, outcomeMap, listIndex) {
  const withOutcome = joinOutcomeOntoExam(exam, outcomeMap);
  const withList = joinListAggregateOntoExam(withOutcome, listIndex);
  if (withList.outcome) {
    return { ...withList, outcome_gap: null };
  }
  if (withList.list_aggregate && Number(withList.list_aggregate.list_count) > 0) {
    // list_joined UI path — no gap claim that the city withheld aggregates.
    return { ...withList, outcome_gap: null };
  }
  return {
    ...withList,
    outcome_gap: {
      class: "not_yet_ingested",
      pending_stage: "list_establishment",
      public_sources: [
        "dcas-annual-exam-outcomes",
        "dcas-active-civil-service-list",
      ],
    },
  };
}

/** Closed annual rows retained so list_aggregate joins survive FY snapshot roll-forward. */
export function normalizeListDepthClosed(row) {
  const raw = String(row.exam_number || "").trim();
  const examNumber = /^\d+$/.test(raw) ? raw.padStart(4, "0") : raw;
  assert(/^\d{4}$/.test(examNumber), `invalid list-depth exam number: ${row.exam_number}`);
  const title = String(row.title || row.exam_title || "").trim();
  assert(title, `list-depth exam ${examNumber} missing title`);
  return {
    exam_number: examNumber,
    title_code: String(row.title_code || "").trim() || null,
    title,
    application_start: isoDate(row.application_start || row.application_period_start),
    application_end: isoDate(row.application_end || row.application_period_end_date),
    eligibility: row.eligibility || eligibilityFor(row),
    schedule_status: "scheduled",
    interest_area: classifyInterest(title),
    sources: ["dcas-annual-closed-list-depth", "dcas-active-civil-service-list"],
    list_depth: true,
  };
}

function normalizeOutcomeSourceOutdatedCheck(source) {
  const publicationDate = source?.verified_at || source?.data_publication_date || source?.fetched_at;
  assert(publicationDate, `${source?.id || "source"}: outcomes source lacks a publication date`);
}

export function buildArtifact({
  annual,
  current,
  activeList,
  cityRecord,
  outcomes,
  listAggregates,
  listDepthClosed,
  noeDensify,
  priorArtifact,
  today,
}) {
  const generatedAt = today || new Date().toISOString().slice(0, 10);
  const latestSourceAt = [
    annual.source.fetched_at,
    current.source.verified_at,
    activeList.source.fetched_at,
    cityRecord.source.fetched_at,
    outcomes.source.fetched_at,
    outcomes.source.verified_at,
    outcomes.source.data_publication_date,
    listAggregates?.source?.fetched_at,
    listDepthClosed?.source?.fetched_at,
    noeDensify?.source?.fetched_at,
    noeDensify?.source?.verified_at,
  ]
    .filter(Boolean).sort().at(-1);

  const prior = new Map((priorArtifact?.exams || []).map((exam) => [exam.exam_number, exam]));

  const exams = new Map();
  for (const row of annual.records) {
    const normalized = normalizeAnnual(row);
    exams.set(
      normalized.exam_number,
      normalized,
    );
  }

  for (const row of current.records) {
    const normalized = normalizeCurrent(row);
    const existing = exams.get(normalized.exam_number) || {};
    const merged = mergeCurrent(existing, normalized);
    exams.set(normalized.exam_number, merged);
  }

  // Closed annual exams with list presence: keep post-list depth after the current
  // FY snapshot rolls forward (open 7xxx series has 0% list join by design).
  for (const row of listDepthClosed?.records || []) {
    const normalized = normalizeListDepthClosed(row);
    if (exams.has(normalized.exam_number)) continue;
    exams.set(normalized.exam_number, normalized);
  }

  // Snapshot priors before the mutation loop so retain can see original NOE fields.
  const priorByNumber = new Map((priorArtifact?.exams || []).map((exam) => [exam.exam_number, exam]));

  for (const [examNumber, priorRow] of prior.entries()) {
    const exam = exams.get(examNumber);
    if (exam) {
      const retained = retainNoeDetailFields(exam, priorRow);
      exams.set(examNumber, annotateAmendment(retained, priorRow));
    } else if (
      priorRow.schedule_status !== "canceled"
      && examStatusFor(priorRow, generatedAt) !== "closed"
      // Do not re-withdraw list-depth closed rows when prior still carries them.
      && !priorRow.list_depth
    ) {
      exams.set(examNumber, markWithdrawnPrior(priorRow, generatedAt));
    }
    prior.delete(examNumber);
  }

  // Also retain for exams already merged from current (no-op) and any prior that
  // remained in the map only as annual rows without re-entering the loop above.
  for (const [examNumber, exam] of exams.entries()) {
    const priorRow = priorByNumber.get(examNumber);
    if (priorRow) exams.set(examNumber, retainNoeDetailFields(exam, priorRow));
  }

  // Body densify cache: NOE PDF-parsed fee/salary for exams the open-competitive
  // snapshot does not already cover. Map first so a prior artifact's retained
  // densify amounts can be stripped for an honest before-rate.
  const densifyByNumber = new Map(
    (noeDensify?.records || []).map((row) => [String(row.exam_number).padStart(4, "0"), row]),
  );

  // Strip densify-only amounts retained from a prior artifact so the before rate
  // measures open-competitive/hand-structured NOE only (not a previous densify pass).
  // retainNoeDetailFields keeps fee/salary but may drop fee_salary_densify / densify
  // source ids — key off densify cache membership + no CURRENT_ID instead.
  for (const [examNumber, exam] of exams.entries()) {
    const sources = exam.sources || [];
    if (!densifyByNumber.has(examNumber)) continue;
    if (sources.includes(CURRENT_ID)) continue; // open-competitive path owns structured amounts
    const { fee: _f, salary_min: _s, salary_max: _x, salary_note: _n, fee_salary_densify: _d, ...rest } = exam;
    exams.set(examNumber, {
      ...rest,
      fee: null,
      salary_min: null,
      salary_max: null,
      salary_note: null,
      notice_url: null,
      sources: sources.filter((s) => s !== NOE_DENSIFY_ID && s !== NOE_ID),
    });
  }

  // Pre-densify fee/salary non-null rate (open-competitive + retained only).
  const beforeDensifyStats = feeSalaryNonNullStats([...exams.values()]);

  let densifyApplied = 0;
  for (const [examNumber, exam] of exams.entries()) {
    const densified = applyNoeDensifyRecord(exam, densifyByNumber.get(examNumber));
    if (densified !== exam) densifyApplied += 1;
    exams.set(examNumber, densified);
  }

  const outcomeMap = outcomesByExamNumber(outcomes.records);
  const listIndex = buildListAggregateIndex(listAggregates?.records || []);
  const records = [...exams.values()]
    .map((exam) => attachFeeSalaryGap(joinOutcomesAndListOntoExam(exam, outcomeMap, listIndex)))
    .sort((a, b) => {
      const ad = a.application_start || "9999-12-31";
      const bd = b.application_start || "9999-12-31";
      return ad.localeCompare(bd) || a.title.localeCompare(b.title) || a.exam_number.localeCompare(b.exam_number);
    });

  normalizeOutcomeSourceOutdatedCheck(outcomes.source);

  const afterDensifyStats = feeSalaryNonNullStats(records);
  const listSource = listAggregates?.source || activeList.source;
  const listJoinedCount = records.filter((e) => e.list_aggregate && Number(e.list_aggregate.list_count) > 0).length;
  const sources = [current.source, annual.source, activeList.source, cityRecord.source, outcomes.source];
  if (noeDensify?.source) sources.push(noeDensify.source);

  return {
    schema_version: STAFFING_EXAMS_SCHEMA_VERSION,
    generated_at: latestSourceAt,
    data_current_as_of: annual.source.data_current_as_of,
    interest_areas: [
      "public-safety", "health-care", "engineering-construction", "technology-science",
      "community-social-services", "administration-finance", "trades-operations", "other",
    ],
    sources,
    source_checks: {
      active_list: activeList.summary,
      city_record: cityRecord.summary,
      list_aggregates: listAggregates?.summary || {
        distinct_exams: listIndex.size ? new Set([...listIndex.values()].map((r) => r.exam_number)).size : 0,
      },
      list_depth_closed: {
        count: (listDepthClosed?.records || []).length,
        list_joined: listJoinedCount,
      },
      noe_fee_salary_densify: {
        densify_records: densifyByNumber.size,
        densify_applied: densifyApplied,
        fee_salary_non_null_before: beforeDensifyStats,
        fee_salary_non_null_after: afterDensifyStats,
      },
    },
    outcomes: buildOutcomes({ outcomes }),
    list_aggregates: {
      source: {
        id: listSource.id || "dcas-active-civil-service-list",
        name: listSource.name || "Civil Service List (Active) — exam-level aggregates only",
        dataset_id: listSource.dataset_id || ACTIVE_LIST_ID,
        landing_page: listSource.landing_page || `https://data.cityofnewyork.us/d/${ACTIVE_LIST_ID}`,
        fetched_at: listSource.fetched_at || activeList.source.fetched_at,
        privacy: "Only exam-level counts and list dates are retained; candidate records and names are not copied.",
      },
      summary: {
        ...(listAggregates?.summary || { distinct_exams: 0 }),
        exams_with_list_aggregate: listJoinedCount,
      },
    },
    exams: records,
  };
}

async function readJson(name) {
  return JSON.parse(await readFile(path.join(SOURCE_DIR, name), "utf8"));
}

async function readJsonOptional(name) {
  try {
    return await readJson(name);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function stableJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "user-agent": "crol-list-build/1.0" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

function sodaUrl(id, params) {
  return `https://data.cityofnewyork.us/resource/${id}.json?${new URLSearchParams(params)}`;
}

async function refreshSnapshots() {
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const annualMeta = await fetchJson(`https://data.cityofnewyork.us/api/views/${ANNUAL_ID}`);
  const latestAnnual = (await fetchJson(sodaUrl(ANNUAL_ID, {
    "$select": "max(data_current_as_of) as latest",
  })))[0]?.latest;
  assert(latestAnnual, "annual schedule has no data_current_as_of value");
  const currentRows = await fetchJson(sodaUrl(ANNUAL_ID, {
    "$where": `data_current_as_of='${latestAnnual}'`,
    "$order": "application_period_start asc,exam_title asc",
    "$limit": "500",
  }));
  const annual = {
    source: {
      id: "dcas-annual-schedule",
      name: annualMeta.name,
      dataset_id: ANNUAL_ID,
      url: `https://data.cityofnewyork.us/resource/${ANNUAL_ID}.json`,
      landing_page: `https://data.cityofnewyork.us/d/${ANNUAL_ID}`,
      fetched_at: fetchedAt,
      data_current_as_of: isoDate(currentRows[0]?.data_current_as_of),
      refresh_cadence: "DCAS says the public schedule is updated monthly; Open Data metadata says annual updates and quarterly data changes.",
      stale_after_days: 95,
    },
    records: currentRows,
  };

  const activeSummary = (await fetchJson(sodaUrl(ACTIVE_LIST_ID, {
    "$select": "count(*) as candidate_rows,count(distinct exam_no) as distinct_exams,count(distinct list_title_code) as distinct_titles,max(established_date) as latest_established,max(extension_date) as latest_extension",
  })))[0];
  const activeList = {
    source: {
      id: "dcas-active-civil-service-list",
      name: "Civil Service List (Active)",
      dataset_id: ACTIVE_LIST_ID,
      url: `https://data.cityofnewyork.us/resource/${ACTIVE_LIST_ID}.json`,
      fetched_at: fetchedAt,
      refresh_cadence: "Daily",
      stale_after_days: 3,
      privacy: "Only aggregate counts are retained; candidate records and names are not copied.",
    },
    summary: activeSummary,
  };

  const cityCandidates = (await fetchJson(sodaUrl(CITY_RECORD_ID, {
    "$select": "count(*) as candidate_rows",
    "$where": "upper(short_title) like '%EXAM%' OR upper(additional_description_1) like '%NOTICE OF EXAMINATION%' OR upper(other_info_1) like '%NOTICE OF EXAMINATION%'",
  })))[0];
  const cityRecord = {
    source: {
      id: "city-record-exam-check",
      name: "City Record Online exam-announcement check",
      dataset_id: CITY_RECORD_ID,
      url: `https://data.cityofnewyork.us/resource/${CITY_RECORD_ID}.json`,
      landing_page: `https://data.cityofnewyork.us/d/${CITY_RECORD_ID}`,
      fetched_at: fetchedAt,
      refresh_cadence: "Daily",
      stale_after_days: 3,
      role: "Negative control: keyword candidates are reviewed so unrelated contracts and uses of “examination” are not presented as civil-service exam announcements.",
    },
    summary: {
      candidate_rows: cityCandidates.candidate_rows,
      accepted_exam_announcements: 0,
      finding: "The City Record dataset does not expose DCAS Notices of Examination as a notice section. DCAS schedule pages and NOEs are the authoritative application sources.",
    },
  };

  const outcomes = {
    source: {
      id: OUTCOMES_ID,
      name: "DCAS Civil-Service Exam Outcomes (Annual Publication)",
      landing_page: "https://a860-gpp.nyc.gov/concern/nyc_government_publications/zk51vm65n",
      fetched_at: fetchedAt,
      data_publication_date: fetchedAt,
      refresh_cadence: "Annual publication with rolling corrections during each fiscal-year outcomes cycle.",
      stale_after_days: 365,
    },
    records: [],
  };

  await mkdir(SOURCE_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(SOURCE_DIR, "annual_schedule.json"), stableJson(annual)),
    writeFile(path.join(SOURCE_DIR, "active_list_summary.json"), stableJson(activeList)),
    writeFile(path.join(SOURCE_DIR, "city_record_check.json"), stableJson(cityRecord)),
  ]);
  if (!(await readJsonOptional("dcas_exam_outcomes.json"))) {
    await writeFile(path.join(SOURCE_DIR, "dcas_exam_outcomes.json"), stableJson(outcomes));
  }
}

function validateSources(today, sources) {
  for (const source of sources) {
    if (source.freshness_required === false) continue;
    assertSourceFresh(source, today);
  }
}

async function writeDensifyReceipt(artifact) {
  const stats = artifact?.source_checks?.noe_fee_salary_densify;
  if (!stats) return null;
  const receipt = {
    schema_version: 1,
    source_contract_id: NOE_DENSIFY_ID,
    verified_at: new Date().toISOString().slice(0, 10),
    verified_at_utc: new Date().toISOString(),
    fee_salary_non_null_before: stats.fee_salary_non_null_before,
    fee_salary_non_null_after: stats.fee_salary_non_null_after,
    densify_records: stats.densify_records,
    densify_applied: stats.densify_applied,
    policy: {
      public_noe_path_only: true,
      annual_schedule_has_no_fee_columns: true,
      never_fabricate: true,
    },
    note: "Before = after open-competitive merge + retainNoeDetailFields; after = plus NOE body densify cache.",
  };
  await mkdir(DENSIFY_RECEIPT_DIR, { recursive: true });
  const outPath = path.join(DENSIFY_RECEIPT_DIR, "noe_fee_salary_densify_latest.json");
  await writeFile(outPath, stableJson(receipt));
  return outPath;
}

async function main() {
  const check = process.argv.includes("--check");
  if (process.argv.includes("--refresh")) await refreshSnapshots();
  const [annual, current, activeList, cityRecord, outcomes, listAggregates, listDepthClosed, noeDensify, priorArtifact] = await Promise.all([
    readJson("annual_schedule.json"),
    readJson("dcas_open_competitive.json"),
    readJson("active_list_summary.json"),
    readJson("city_record_check.json"),
    readJson("dcas_exam_outcomes.json"),
    readJsonOptional(LIST_AGGREGATES_FILE),
    readJsonOptional(LIST_DEPTH_CLOSED_FILE),
    readJsonOptional(NOE_DENSIFY_FILE),
    (async () => {
      try {
        return JSON.parse(await readFile(OUTPUT, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    })(),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  validateSources(today, [
    annual.source,
    { ...current.source, stale_after_days: current.source.stale_after_days ?? 35 },
    activeList.source,
    cityRecord.source,
    outcomes.source,
  ]);
  if (listAggregates?.source) {
    // Aggregates snapshot: fail closed if older than active-list freshness window.
    assertSourceFresh({
      ...listAggregates.source,
      stale_after_days: listAggregates.source.stale_after_days ?? activeList.source.stale_after_days ?? 3,
    }, today);
  }
  if (listDepthClosed?.source) {
    assertSourceFresh({
      ...listDepthClosed.source,
      stale_after_days: listDepthClosed.source.stale_after_days ?? annual.source.stale_after_days ?? 95,
    }, today);
  }
  // Densify cache is optional offline evidence — skip freshness hard-fail when absent or flagged.
  if (noeDensify?.source && noeDensify.source.freshness_required !== false) {
    assertSourceFresh({
      ...noeDensify.source,
      stale_after_days: noeDensify.source.stale_after_days ?? 45,
    }, today);
  }
  const artifact = buildArtifact({
    annual,
    current,
    activeList,
    cityRecord,
    outcomes,
    listAggregates,
    listDepthClosed,
    noeDensify,
    priorArtifact,
    today,
  });
  const rendered = stableJson(artifact);
  if (check) {
    assert.equal(await readFile(OUTPUT, "utf8"), rendered, "data/staffing_exams.json is stale; rebuild it");
    console.log("staffing exam artifact is current");
  } else {
    await writeFile(OUTPUT, rendered);
    const receiptPath = await writeDensifyReceipt(artifact);
    const densify = artifact.source_checks?.noe_fee_salary_densify;
    console.log(`wrote ${path.relative(ROOT, OUTPUT)}`);
    if (densify) {
      console.log(
        `fee/salary non-null: ${densify.fee_salary_non_null_before.both}/${densify.fee_salary_non_null_before.total}`
        + ` → ${densify.fee_salary_non_null_after.both}/${densify.fee_salary_non_null_after.total}`
        + ` (applied ${densify.densify_applied})`,
      );
    }
    if (receiptPath) console.log(`wrote ${path.relative(ROOT, receiptPath)}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
