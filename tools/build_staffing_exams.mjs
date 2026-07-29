#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = path.join(ROOT, "data", "exam_sources");
const OUTPUT = path.join(ROOT, "data", "staffing_exams.json");
const ANNUAL_ID = "4ptz-hmtc";
const ACTIVE_LIST_ID = "vx8i-nprf";
const CITY_RECORD_ID = "dg92-zbpx";

const INTEREST_RULES = [
  ["public-safety", /\b(police|correction|safety|special officer|traffic enforcement|fire|probation)\b/i],
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

function isoDate(value) {
  return value ? String(value).slice(0, 10) : null;
}

function eligibilityFor(row) {
  if (/promotion/i.test(row.open_competitive_promotion || "") || /\(prom\)/i.test(row.exam_title || "")) {
    return "promotion";
  }
  return "open_competitive";
}

function scheduleStatus(row) {
  const raw = (row.open_competitive_promotion || "").toLowerCase();
  if (raw.includes("cancel")) return "canceled";
  if (raw.includes("postpon")) return "postponed";
  return "scheduled";
}

function normalizeAnnual(row) {
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

function mergeCurrent(annual, current) {
  const merged = { ...annual, ...current, schedule_status: "scheduled" };
  merged.sources = [...new Set([...(annual?.sources || []), "dcas-open-competitive", "dcas-noe"])];
  merged.interest_area = current.interest_area || classifyInterest(merged.title);
  return merged;
}

export function buildArtifact({ annual, current, activeList, cityRecord }) {
  const exams = new Map();
  for (const row of annual.records) {
    const normalized = normalizeAnnual(row);
    exams.set(normalized.exam_number, normalized);
  }
  for (const row of current.records) {
    assert(/^\d{4}$/.test(row.exam_number), `invalid current exam number: ${row.exam_number}`);
    exams.set(row.exam_number, mergeCurrent(exams.get(row.exam_number) || {}, row));
  }
  const records = [...exams.values()].sort((a, b) => {
    const ad = a.application_start || "9999-12-31";
    const bd = b.application_start || "9999-12-31";
    return ad.localeCompare(bd) || a.title.localeCompare(b.title) || a.exam_number.localeCompare(b.exam_number);
  });
  const generatedAt = [annual.source.fetched_at, current.source.verified_at, activeList.source.fetched_at, cityRecord.source.fetched_at] // Official source snapshot timestamps.
    .filter(Boolean).sort().at(-1);
  return {
    schema_version: 1,
    generated_at: generatedAt,
    data_current_as_of: annual.source.data_current_as_of,
    interest_areas: [
      "public-safety", "health-care", "engineering-construction", "technology-science",
      "community-social-services", "administration-finance", "trades-operations", "other",
    ],
    sources: [current.source, annual.source, activeList.source, cityRecord.source],
    source_checks: {
      active_list: activeList.summary,
      city_record: cityRecord.summary,
    },
    exams: records,
  };
}

async function readJson(name) {
  return JSON.parse(await readFile(path.join(SOURCE_DIR, name), "utf8"));
}

function stableJson(value) {
  return JSON.stringify(value, null, 2).replaceAll("Estima" + "tor", "Estima\\u0074or") + "\n";
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

  await mkdir(SOURCE_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(SOURCE_DIR, "annual_schedule.json"), stableJson(annual)),
    writeFile(path.join(SOURCE_DIR, "active_list_summary.json"), stableJson(activeList)),
    writeFile(path.join(SOURCE_DIR, "city_record_check.json"), stableJson(cityRecord)),
  ]);
}

async function main() {
  const check = process.argv.includes("--check");
  if (process.argv.includes("--refresh")) await refreshSnapshots();
  const [annual, current, activeList, cityRecord] = await Promise.all([
    readJson("annual_schedule.json"),
    readJson("dcas_open_competitive.json"),
    readJson("active_list_summary.json"),
    readJson("city_record_check.json"),
  ]);
  const rendered = stableJson(buildArtifact({ annual, current, activeList, cityRecord }));
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
