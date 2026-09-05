// Live civil-service exams JSON stored in ALERT_STATE.
// The 08:00 cron overlays SODA annual schedule + exam-level list group-by +
// OASys GetActiveExams onto the committed artifact and writes staffing:exams:v1.
// GET /staffing-exams and people/guide digest replay read that key; missing,
// empty, unparseable, or failed KV uses the committed JSON so Staffing never
// goes blank. Exam HTML under site/exams/** stays committed.

import staffingExamsFloor from "../../../site/data/staffing_exams.json" with { type: "json" };
import { listAggregateBelongsToExamCycle } from "../../../site/exam_process_spine.mjs";
import {
  buildListAggregateIndex,
  joinExamToListAggregate,
} from "./civil_service_list_join.mjs";
import {
  attachOasysDeepLink,
  buildOasysExamMap,
  OASY_API_ACTIVE_EXAMS,
} from "../../../tools/lib/oasys_exam_map.mjs";
import { readKvValue } from "./preset_fallback_kv.mjs";

export const STAFFING_EXAMS_KV_KEY = "staffing:exams:v1";
export const STAFFING_EXAMS_MAX_AGE_DAYS = 7;
export const STAFFING_EXAMS_MAX_AGE_MS = STAFFING_EXAMS_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
export const STAFFING_EXAMS_MIN_EXAMS = 100;
export const STAFFING_EXAMS_LIST_MIN_DISTINCT = 100;
export const STAFFING_EXAMS_SCHEMA_VERSION = 6;
/**
 * Shape floor for an accepted exams payload.
 *
 * This used to name three exam numbers. The published schedule rolls with each
 * fiscal year, and the day one of those exams left it the payload stopped being
 * acceptable: the scheduled refresh could no longer publish, and the endpoint
 * would have served the same committed floor indefinitely. The guard's real job
 * is to reject a truncated or half-joined payload, so it now measures the
 * population instead of naming rows in it.
 */
export const STAFFING_EXAMS_MIN_WINDOW_SHARE = 0.9;
export const STAFFING_EXAMS_MIN_NOTICE_ROWS = 5;
export const STAFFING_ANNUAL_SODA_ID = "4ptz-hmtc";
export const STAFFING_LIST_SODA_ID = "vx8i-nprf";
export const STAFFING_EXAMS_USER_AGENT =
  "CityScroll staffing-exams/1.0 (+https://cityscroll.org)";

const PII_FIELD = /first_name|last_name|middle_name|ssn|address|phone|email|list_rank/i;

export function committedStaffingExamsFloor() {
  return staffingExamsFloor;
}

function isoDate(value) {
  const day = String(value || "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function examNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^\d{1,4}$/.test(raw)) return raw.padStart(4, "0");
  return /^\d{4}$/.test(raw) ? raw : null;
}

export function staffingExamsContentHash(doc) {
  const rows = (Array.isArray(doc?.exams) ? doc.exams : []).map((exam) => [
    String(exam?.exam_number || ""),
    isoDate(exam?.application_start) || "",
    isoDate(exam?.application_end) || "",
    exam?.fee == null ? "" : String(exam.fee),
    exam?.list_aggregate?.list_count == null ? "" : String(exam.list_aggregate.list_count),
    String(exam?.official_application_url || ""),
  ]);
  rows.sort((left, right) => left[0].localeCompare(right[0]));
  return JSON.stringify(rows);
}

function rowHasPii(row) {
  return Object.keys(row || {}).some((key) => PII_FIELD.test(key));
}

export function staffingExamsHasCanaries(doc) {
  const exams = Array.isArray(doc?.exams) ? doc.exams : [];
  if (!exams.length) return false;
  // Identity survived the pipeline: every row still names one exam, and no
  // exam is duplicated.
  const ids = exams.map((exam) => String(exam?.exam_number || ""));
  if (!ids.every((id) => /^\d{4}$/.test(id))) return false;
  if (new Set(ids).size !== ids.length) return false;
  // The schedule join survived: almost every exam carries its filing window.
  const withWindow = exams.filter((exam) => exam?.application_start && exam?.application_end).length;
  if (withWindow < exams.length * STAFFING_EXAMS_MIN_WINDOW_SHARE) return false;
  // The Notice of Examination join survived: some exams still carry a notice
  // and the fee it states.
  const withNotice = exams.filter((exam) => exam?.notice_url && exam?.fee != null).length;
  return withNotice >= STAFFING_EXAMS_MIN_NOTICE_ROWS;
}

export function staffingExamsKvAcceptable(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  if (Number(doc.schema_version) !== STAFFING_EXAMS_SCHEMA_VERSION) return false;
  if (!Array.isArray(doc.exams) || doc.exams.length < STAFFING_EXAMS_MIN_EXAMS) return false;
  if (!Array.isArray(doc.interest_areas) || !Array.isArray(doc.sources)) return false;
  if (!staffingExamsHasCanaries(doc)) return false;
  const distinct = Number(
    doc.source_checks?.list_aggregates?.distinct_exams
    ?? doc.source_checks?.active_list?.distinct_exams
    ?? 0,
  );
  if (!(distinct >= STAFFING_EXAMS_LIST_MIN_DISTINCT)) return false;
  const sample = [
    ...doc.exams.slice(0, 25),
    ...(Array.isArray(doc.list_aggregates?.records) ? doc.list_aggregates.records.slice(0, 25) : []),
  ];
  if (sample.some(rowHasPii)) return false;
  return true;
}

export function parseStaffingExamsRecord(raw) {
  if (raw == null || raw === "") return null;
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!staffingExamsKvAcceptable(parsed)) return null;
  return parsed;
}

export async function loadStaffingExams(env) {
  const floor = committedStaffingExamsFloor();
  const kv = env?.ALERT_STATE;
  if (!kv || typeof kv.get !== "function") {
    return { source: "committed_floor", record: floor };
  }
  try {
    const parsed = parseStaffingExamsRecord(
      await readKvValue(kv, STAFFING_EXAMS_KV_KEY),
    );
    if (parsed) return { source: "kv", record: parsed };
  } catch {
    // Failed KV reads must not blank Staffing / exam digests.
  }
  return { source: "committed_floor", record: floor };
}

export function staffingExamsStale(record, nowMs = Date.now()) {
  const stamped = Date.parse(
    record?.kv_refreshed_at
    || (isoDate(record?.open_window_as_of) ? `${record.open_window_as_of}T00:00:00.000Z` : "")
    || (isoDate(record?.generated_at) ? `${record.generated_at}T00:00:00.000Z` : ""),
  );
  if (!Number.isFinite(stamped)) return true;
  return nowMs - stamped > STAFFING_EXAMS_MAX_AGE_MS;
}

function eligibilityFor(row) {
  const field = String(row.open_competitive_promotion || row.eligibility || "").trim();
  const title = String(row.exam_title || row.title || "");
  const promoTitle = /\(prom\)/i.test(title);
  const promoField = /promotion/i.test(field);
  const openField = /open[\s-]*competitive/i.test(field);
  const internalField = /\b(?:city\s+employees?|employees?\s+only|promotional|internal(?:\s+only)?|restricted|incumbents?)\b/i.test(field);
  if (promoField || promoTitle || internalField) {
    if (openField && !(promoField || promoTitle)) return "unknown";
    return "promotion";
  }
  if (openField) return "open_competitive";
  return "unknown";
}

function scheduleStatus(row) {
  const raw = String(row.open_competitive_promotion || row.application_notes || row.notes || "").toLowerCase();
  if (raw.includes("cancel")) return "canceled";
  if (raw.includes("postpon")) return "postponed";
  return "scheduled";
}

function joinListOntoExam(exam, listIndex) {
  const hit = joinExamToListAggregate(exam.exam_number, listIndex);
  if (!hit) return { ...exam, list_aggregate: exam.list_aggregate || null };
  const candidate = {
    list_count: hit.list_count,
    established_date: hit.established_date,
    extension_date: hit.extension_date,
    title_count: hit.title_count,
    source_id: "dcas-active-civil-service-list",
  };
  if (!listAggregateBelongsToExamCycle(exam, candidate)) {
    return { ...exam, list_aggregate: null };
  }
  return { ...exam, list_aggregate: candidate };
}

export function overlayStaffingExams(floor, {
  annualRows = [],
  listRecords = [],
  oasysPayload = null,
  now = new Date(),
} = {}) {
  const today = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  const byNumber = new Map();
  for (const exam of Array.isArray(floor?.exams) ? floor.exams : []) {
    const id = examNumber(exam?.exam_number);
    if (!id) continue;
    byNumber.set(id, { ...exam, exam_number: id });
  }
  for (const row of annualRows) {
    const id = examNumber(row?.exam_number);
    const title = String(row?.exam_title || row?.title || "").trim();
    if (!id || !title) continue;
    const existing = byNumber.get(id);
    const start = isoDate(row.application_period_start || row.application_start);
    const end = isoDate(row.application_period_end_date || row.application_end);
    if (existing) {
      byNumber.set(id, {
        ...existing,
        title: title || existing.title,
        title_code: String(row.title_code || "").trim() || existing.title_code || null,
        application_start: start || existing.application_start || null,
        application_end: end || existing.application_end || null,
        eligibility: eligibilityFor(row) !== "unknown" ? eligibilityFor(row) : existing.eligibility,
        schedule_status: scheduleStatus(row) !== "scheduled"
          ? scheduleStatus(row)
          : existing.schedule_status || "scheduled",
        sources: [...new Set([...(existing.sources || []), "dcas-annual-schedule"])],
      });
    } else {
      byNumber.set(id, {
        exam_number: id,
        title_code: String(row.title_code || "").trim() || null,
        title,
        application_start: start,
        application_end: end,
        eligibility: eligibilityFor(row),
        schedule_status: scheduleStatus(row),
        sources: ["dcas-annual-schedule"],
      });
    }
  }

  const listIndex = buildListAggregateIndex(listRecords);
  const oasysMap = oasysPayload ? buildOasysExamMap(oasysPayload).by_exam_number : null;
  const exams = [...byNumber.values()]
    .map((exam) => joinListOntoExam(exam, listIndex))
    .map((exam) => (oasysMap ? attachOasysDeepLink(exam, oasysMap) : exam))
    .sort((left, right) => String(left.exam_number).localeCompare(String(right.exam_number)));

  const latestEstablished = listRecords
    .map((row) => isoDate(row.established_date))
    .filter(Boolean)
    .sort()
    .at(-1) || floor?.list_current_as_of || null;
  const totalListRows = listRecords.reduce((sum, row) => sum + Number(row.list_count || 0), 0);
  const annualVintage = annualRows
    .map((row) => isoDate(row.data_current_as_of))
    .filter(Boolean)
    .sort()
    .at(-1) || floor?.annual_schedule_current_as_of || null;
  const refreshedAt = (now instanceof Date ? now : new Date(now)).toISOString();

  return {
    ...floor,
    schema_version: STAFFING_EXAMS_SCHEMA_VERSION,
    generated_at: today,
    open_window_as_of: today,
    list_current_as_of: latestEstablished,
    annual_schedule_current_as_of: annualVintage,
    data_current_as_of: [annualVintage, latestEstablished].filter(Boolean).sort().at(-1) || today,
    kv_refreshed_at: refreshedAt,
    refresh_mode: "worker_cron_overlay",
    exams,
    source_checks: {
      ...(floor?.source_checks || {}),
      list_aggregates: {
        distinct_exams: listRecords.length,
        total_list_rows_sum: totalListRows,
      },
    },
  };
}

async function fetchJson(url, fetchImpl, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": STAFFING_EXAMS_USER_AGENT,
      },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`staffing fetch ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function sodaUrl(dataset, params) {
  return `https://data.cityofnewyork.us/resource/${dataset}.json?${new URLSearchParams(params)}`;
}

export async function fetchAnnualScheduleRows(fetchImpl = fetch) {
  const latest = await fetchJson(sodaUrl(STAFFING_ANNUAL_SODA_ID, {
    $select: "max(data_current_as_of) as latest",
  }), fetchImpl);
  const vintage = isoDate(latest?.[0]?.latest);
  if (!vintage) throw new Error("annual schedule has no data_current_as_of value");
  const rows = await fetchJson(sodaUrl(STAFFING_ANNUAL_SODA_ID, {
    $where: `data_current_as_of='${vintage}'`,
    $order: "application_period_start asc,exam_title asc",
    $limit: "500",
  }), fetchImpl);
  if (!Array.isArray(rows)) throw new Error("annual schedule returned a non-array response");
  return rows;
}

export async function fetchCivilServiceListAggregateRecords(fetchImpl = fetch) {
  const records = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await fetchJson(sodaUrl(STAFFING_LIST_SODA_ID, {
      $select: [
        "exam_no",
        "count(*) as list_count",
        "max(established_date) as established_date",
        "max(extension_date) as extension_date",
        "count(distinct list_title_code) as title_count",
      ].join(","),
      $group: "exam_no",
      $order: "exam_no",
      $limit: "1000",
      $offset: String(offset),
    }), fetchImpl);
    if (!Array.isArray(page)) throw new Error("civil service list group-by returned a non-array response");
    for (const row of page) {
      const id = String(row.exam_no || "").trim();
      if (!id) continue;
      if (rowHasPii(row)) throw new Error("civil service list aggregate must not include PII fields");
      records.push({
        exam_number: id,
        exam_no_raw: id,
        list_count: Number(row.list_count || 0),
        established_date: isoDate(row.established_date),
        extension_date: isoDate(row.extension_date),
        title_count: Number(row.title_count || 0) || 0,
      });
    }
    if (page.length < 1000) break;
  }
  buildListAggregateIndex(records);
  return records;
}

export async function fetchOasysActiveExams(fetchImpl = fetch) {
  const payload = await fetchJson(OASY_API_ACTIVE_EXAMS, fetchImpl);
  return payload;
}

export async function refreshStaffingExams(env, {
  fetchImpl = fetch,
  now = new Date(),
  floor = committedStaffingExamsFloor(),
} = {}) {
  if (!env?.ALERT_STATE || typeof env.ALERT_STATE.put !== "function") {
    return { status: "skipped", reason: "no-kv" };
  }
  const [annualRows, listRecords, oasysPayload] = await Promise.all([
    fetchAnnualScheduleRows(fetchImpl),
    fetchCivilServiceListAggregateRecords(fetchImpl),
    fetchOasysActiveExams(fetchImpl).catch(() => null),
  ]);
  const doc = overlayStaffingExams(floor, {
    annualRows,
    listRecords,
    oasysPayload,
    now,
  });
  if (!staffingExamsKvAcceptable(doc)) {
    return {
      status: "skipped",
      reason: "unusable-payload",
      exam_count: doc?.exams?.length ?? 0,
    };
  }
  const previous = parseStaffingExamsRecord(
    await readKvValue(env.ALERT_STATE, STAFFING_EXAMS_KV_KEY),
  );
  const unchanged = previous
    ? staffingExamsContentHash(previous) === staffingExamsContentHash(doc)
    : false;
  await env.ALERT_STATE.put(STAFFING_EXAMS_KV_KEY, JSON.stringify(doc));
  return {
    status: "success",
    exam_count: doc.exams.length,
    unchanged,
    generated_at: doc.generated_at,
    kv_refreshed_at: doc.kv_refreshed_at,
  };
}
