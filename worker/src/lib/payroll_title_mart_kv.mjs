// Live FY payroll title mart stored in ALERT_STATE.
// The 13:00 cron fetches the SODA group-by (never the 6.8M employee file) and
// writes payroll:title-mart:v1. Suggestion counting reads that key; missing,
// empty, unparseable, or failed KV uses the committed Worker twin so People /
// Staffing chips never go blank.

import {
  PAYROLL_SODA_DATASET,
  PAYROLL_TITLE_ALLOWED_FIELDS,
  PAYROLL_TITLE_FISCAL_YEAR,
  PAYROLL_TITLE_SCHEMA_VERSION,
  payrollTitleMartReady,
  payrollTitlePiiFindings,
  payrollTitleRows,
} from "../../../site/payroll_title_mart.mjs";
import payrollTitleMartFloor from "../data/payroll_title_warehouse_lookup.json" with { type: "json" };
import { readKvValue } from "./preset_fallback_kv.mjs";

export const PAYROLL_TITLE_MART_KV_KEY = "payroll:title-mart:v1";
export const PAYROLL_TITLE_SODA =
  `https://data.cityofnewyork.us/resource/${PAYROLL_SODA_DATASET}.json`;
export const PAYROLL_TITLE_MART_CANARIES = Object.freeze([
  "POLICE OFFICER",
  "FIREFIGHTER",
]);
export const PAYROLL_TITLE_MART_MIN_TITLES = 1000;
export const PAYROLL_TITLE_USER_AGENT =
  "CityScroll payroll-title-mart/1.0 (+https://cityscroll.org)";

const PUBLISHER_ROW_COUNT_FLOOR = 6_775_830;

export function committedPayrollTitleMartFloor() {
  return payrollTitleMartFloor;
}

function sodaNumber(row, keys) {
  for (const key of keys) {
    const n = Number(row?.[key]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function payrollTitleGroupByParams({
  fiscalYear = PAYROLL_TITLE_FISCAL_YEAR,
  limit = 50_000,
} = {}) {
  return {
    $select: [
      "title_description",
      "count(1) as n",
      "min(base_salary) as mn",
      "max(base_salary) as mx",
      "avg(base_salary) as avg",
    ].join(","),
    $where: `fiscal_year=${Number(fiscalYear)} AND base_salary > 0 AND title_description IS NOT NULL`,
    $group: "title_description",
    $order: "n DESC",
    $limit: String(limit),
  };
}

export function payrollTitleWindowCountParams(fiscalYear = PAYROLL_TITLE_FISCAL_YEAR) {
  return {
    $select: "count(1) as n",
    $where: payrollTitleGroupByParams({ fiscalYear }).$where,
  };
}

export function buildPayrollTitleMartDoc(rows, opts = {}) {
  const list = payrollTitleRows(rows).sort((left, right) =>
    right.n - left.n || left.title_description.localeCompare(right.title_description));
  const windowRowCount = Number.isFinite(Number(opts.windowRowCount))
    ? Number(opts.windowRowCount)
    : list.reduce((sum, row) => sum + row.n, 0);
  const publisherRowCount = Number.isFinite(Number(opts.publisherRowCount))
    ? Number(opts.publisherRowCount)
    : PUBLISHER_ROW_COUNT_FLOOR;
  return {
    schema_version: PAYROLL_TITLE_SCHEMA_VERSION,
    phase: "WH-optional-payroll-title",
    source: "soda_groupby",
    dataset_id: PAYROLL_SODA_DATASET,
    fiscal_year: PAYROLL_TITLE_FISCAL_YEAR,
    mode: opts.mode || "soda_groupby",
    materialized_at: opts.now || new Date().toISOString(),
    title_count: list.length,
    row_count: list.length,
    coverage: {
      publisher_row_count: publisherRowCount,
      window_row_count: windowRowCount,
      window:
        `fiscal_year=${PAYROLL_TITLE_FISCAL_YEAR} AND base_salary > 0 AND title_description IS NOT NULL`,
      note:
        "Bounded FY title projection — not the full multi-year employee file. No individual-employee rows.",
    },
    pii: {
      employee_rows: false,
      allowed_fields: [...PAYROLL_TITLE_ALLOWED_FIELDS],
    },
    rows: list,
  };
}

export function payrollTitleMartHasCanaries(doc) {
  const titles = new Set(payrollTitleRows(doc).map((row) => row.title_description));
  return PAYROLL_TITLE_MART_CANARIES.every((title) => titles.has(title));
}

export function payrollTitleMartKvAcceptable(doc) {
  if (!payrollTitleMartReady(doc)) return false;
  if (payrollTitlePiiFindings(doc).length) return false;
  if ((doc.rows || []).length < PAYROLL_TITLE_MART_MIN_TITLES) return false;
  return payrollTitleMartHasCanaries(doc);
}

export function parsePayrollTitleMartRecord(raw) {
  if (raw == null || raw === "") return null;
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!payrollTitleMartKvAcceptable(parsed)) return null;
  return parsed;
}

export async function loadPayrollTitleMart(env) {
  const floor = committedPayrollTitleMartFloor();
  const kv = env?.ALERT_STATE;
  if (!kv || typeof kv.get !== "function") {
    return { source: "committed_floor", record: floor };
  }
  try {
    const parsed = parsePayrollTitleMartRecord(
      await readKvValue(kv, PAYROLL_TITLE_MART_KV_KEY),
    );
    if (parsed) return { source: "kv", record: parsed };
  } catch {
    // Failed KV reads must not break People/Staffing suggestion counting.
  }
  return { source: "committed_floor", record: floor };
}

async function fetchSodaJson(params, fetchImpl) {
  const url = `${PAYROLL_TITLE_SODA}?${new URLSearchParams(params)}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": PAYROLL_TITLE_USER_AGENT,
      },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`Payroll SODA ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error("Payroll SODA returned a non-array response");
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPayrollTitleMartFromSoda(fetchImpl = fetch, now = new Date()) {
  const [titleRows, windowRows, publisherRows] = await Promise.all([
    fetchSodaJson(payrollTitleGroupByParams(), fetchImpl),
    fetchSodaJson(payrollTitleWindowCountParams(), fetchImpl),
    fetchSodaJson({ $select: "count(1) as n" }, fetchImpl),
  ]);
  return buildPayrollTitleMartDoc(titleRows, {
    mode: "soda_groupby",
    now: now.toISOString(),
    windowRowCount: sodaNumber(windowRows[0], ["n", "count"]),
    publisherRowCount: sodaNumber(publisherRows[0], ["n", "count"]),
  });
}

export async function refreshPayrollTitleMart(env, fetchImpl = fetch, now = new Date()) {
  if (!env?.ALERT_STATE || typeof env.ALERT_STATE.put !== "function") {
    return { status: "skipped", reason: "no-kv" };
  }
  const doc = await fetchPayrollTitleMartFromSoda(fetchImpl, now);
  if (!payrollTitleMartKvAcceptable(doc)) {
    return {
      status: "skipped",
      reason: "unusable-payload",
      title_count: doc?.title_count ?? 0,
    };
  }
  await env.ALERT_STATE.put(PAYROLL_TITLE_MART_KV_KEY, JSON.stringify(doc));
  return {
    status: "success",
    title_count: doc.title_count,
    window_row_count: doc.coverage?.window_row_count ?? null,
    materialized_at: doc.materialized_at,
  };
}
