#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = path.join(ROOT, "data", "exam_sources");
const OUTPUT = path.join(ROOT, "data", "staffing_exams.json");
const ANNUAL_ID = "4ptz-hmtc";
const OUTCOMES_ID = "dcas-annual-exam-outcomes";
const ACTIVE_LIST_ID = "vx8i-nprf";
const CITY_RECORD_ID = "dg92-zbpx";
const CURRENT_ID = "dcas-open-competitive";
const NOE_ID = "dcas-noe";

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
  return {
    exam_number: examNumber,
    ...row,
    application_start: isoDate(row.application_start),
    application_end: isoDate(row.application_end),
    schedule_status: scheduleStatus(row),
    sources: [
      "dcas-open-competitive",
      NOE_ID,
    ],
  };
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

function normalizeOutcomeSourceOutdatedCheck(source) {
  const publicationDate = source?.verified_at || source?.data_publication_date || source?.fetched_at;
  assert(publicationDate, `${source?.id || "source"}: outcomes source lacks a publication date`);
}

export function buildArtifact({ annual, current, activeList, cityRecord, outcomes, priorArtifact, today }) {
  const generatedAt = today || new Date().toISOString().slice(0, 10);
  const latestSourceAt = [
    annual.source.fetched_at,
    current.source.verified_at,
    activeList.source.fetched_at,
    cityRecord.source.fetched_at,
    outcomes.source.fetched_at,
    outcomes.source.verified_at,
    outcomes.source.data_publication_date,
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

  for (const [examNumber, priorRow] of prior.entries()) {
    const exam = exams.get(examNumber);
    if (exam) exams.set(examNumber, annotateAmendment(exam, priorRow));
    else if (
      priorRow.schedule_status !== "canceled"
      && examStatusFor(priorRow, generatedAt) !== "closed"
    ) {
      exams.set(examNumber, markWithdrawnPrior(priorRow, generatedAt));
    }
    prior.delete(examNumber);
  }

  const records = [...exams.values()].sort((a, b) => {
    const ad = a.application_start || "9999-12-31";
    const bd = b.application_start || "9999-12-31";
    return ad.localeCompare(bd) || a.title.localeCompare(b.title) || a.exam_number.localeCompare(b.exam_number);
  });

  normalizeOutcomeSourceOutdatedCheck(outcomes.source);

  return {
    schema_version: 1,
    generated_at: latestSourceAt,
    data_current_as_of: annual.source.data_current_as_of,
    interest_areas: [
      "public-safety", "health-care", "engineering-construction", "technology-science",
      "community-social-services", "administration-finance", "trades-operations", "other",
    ],
    sources: [current.source, annual.source, activeList.source, cityRecord.source, outcomes.source],
    source_checks: {
      active_list: activeList.summary,
      city_record: cityRecord.summary,
    },
    outcomes: buildOutcomes({ outcomes }),
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

async function main() {
  const check = process.argv.includes("--check");
  if (process.argv.includes("--refresh")) await refreshSnapshots();
  const [annual, current, activeList, cityRecord, outcomes, priorArtifact] = await Promise.all([
    readJson("annual_schedule.json"),
    readJson("dcas_open_competitive.json"),
    readJson("active_list_summary.json"),
    readJson("city_record_check.json"),
    readJson("dcas_exam_outcomes.json"),
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
  const rendered = stableJson(buildArtifact({
    annual,
    current,
    activeList,
    cityRecord,
    outcomes,
    priorArtifact,
    today,
  }));
  if (check) {
    assert.equal(await readFile(OUTPUT, "utf8"), rendered, "data/staffing_exams.json is stale; rebuild it");
    console.log("staffing exam artifact is current");
  } else {
    await writeFile(OUTPUT, rendered);
    console.log(`wrote ${path.relative(ROOT, OUTPUT)}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
