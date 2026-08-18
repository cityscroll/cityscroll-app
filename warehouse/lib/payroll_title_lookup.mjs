/**
 * Payroll title mart serve: SODA group-by export → committed lookup.
 *
 * This is a bounded FY projection, not a 6.8M-row warehouse pack. Agency ×
 * title, median bands, and a full citywide-payroll optional pack remain
 * follow-ons. The Worker never opens DuckDB; host tooling writes JSON twins.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { WAREHOUSE_DIR } from "./catalog.mjs";
import {
  SERVE_LOOKUP_CONTRACTS,
  servePublishFindings,
} from "./serve_publish_contract.mjs";
import {
  PAYROLL_SODA_DATASET,
  PAYROLL_TITLE_FISCAL_YEAR,
  PAYROLL_TITLE_SCHEMA_VERSION,
  countPayrollTitleMatches,
  payrollTitlePiiFindings,
  payrollTitleRows,
  rowToPayrollTitleShape,
} from "../../site/payroll_title_mart.mjs";

export const PAYROLL_TITLE_SODA =
  `https://data.cityofnewyork.us/resource/${PAYROLL_SODA_DATASET}.json`;

/** Full publisher census (scout + live probe 2026-08-18). */
export const PAYROLL_PUBLISHER_ROW_COUNT = 6_775_830;
/** FY2025 title-search universe (base_salary > 0, titled rows). */
export const PAYROLL_TITLE_WINDOW_ROW_COUNT = 550_219;
/** Distinct titles in that window. */
export const PAYROLL_TITLE_PUBLISHER_TITLE_COUNT = 1557;
export const PAYROLL_TITLE_MIN_TITLE_COUNT = 1000;
export const PAYROLL_TITLE_MIN_WINDOW_ROWS = 400_000;
export const PAYROLL_TITLE_COUNT_DRIFT_ABS = 200;
export const PAYROLL_TITLE_FULL_MODES = Object.freeze(["soda_groupby"]);

export const PAYROLL_TITLE_MAX_AGE_DAYS =
  SERVE_LOOKUP_CONTRACTS.payroll_title.max_age_days;
export const PAYROLL_TITLE_CANARIES = Object.freeze(
  SERVE_LOOKUP_CONTRACTS.payroll_title.canaries.map((canary) => canary.value),
);

export function payrollTitleGroupBySelect() {
  return [
    "title_description",
    "count(1) as n",
    "min(base_salary) as mn",
    "max(base_salary) as mx",
    "avg(base_salary) as avg",
  ].join(",");
}

export function payrollTitleGroupByWhere(fiscalYear = PAYROLL_TITLE_FISCAL_YEAR) {
  return `fiscal_year=${Number(fiscalYear)} AND base_salary > 0 AND title_description IS NOT NULL`;
}

export function payrollTitleGroupByParams({
  fiscalYear = PAYROLL_TITLE_FISCAL_YEAR,
  limit = 50_000,
} = {}) {
  return {
    $select: payrollTitleGroupBySelect(),
    $where: payrollTitleGroupByWhere(fiscalYear),
    $group: "title_description",
    $order: "n DESC",
    $limit: String(limit),
  };
}

export function payrollTitleWindowCountParams(fiscalYear = PAYROLL_TITLE_FISCAL_YEAR) {
  return {
    $select: "count(1) as n",
    $where: payrollTitleGroupByWhere(fiscalYear),
  };
}

export function loadProductSeedRows() {
  const path = join(WAREHOUSE_DIR, "fixtures", "citywide-payroll", "product_seed.json");
  if (!existsSync(path)) return [];
  const doc = JSON.parse(readFileSync(path, "utf8"));
  return payrollTitleRows(doc);
}

export function payrollTitleServeGateFindings(doc, opts = {}) {
  const findings = servePublishFindings(
    doc,
    SERVE_LOOKUP_CONTRACTS.payroll_title,
    opts,
  );
  findings.push(...payrollTitlePiiFindings(doc));
  const rows = payrollTitleRows(doc);
  const titleCount = Number.isFinite(Number(doc?.title_count))
    ? Number(doc.title_count)
    : rows.length;
  const windowRows = Number(doc?.coverage?.window_row_count);
  const mode = String(doc?.mode || "");

  if (Number(doc?.schema_version) !== PAYROLL_TITLE_SCHEMA_VERSION) {
    findings.push(
      `Payroll title mart schema_version ${JSON.stringify(doc?.schema_version)} is not ${PAYROLL_TITLE_SCHEMA_VERSION}`,
    );
  }
  if (Number(doc?.fiscal_year) !== PAYROLL_TITLE_FISCAL_YEAR) {
    findings.push(
      `Payroll title mart fiscal_year ${JSON.stringify(doc?.fiscal_year)} is not ${PAYROLL_TITLE_FISCAL_YEAR}`,
    );
  }
  if (mode === "live_fallback" || titleCount === 0) {
    findings.push(
      `Payroll title mart is empty/live_fallback (title_count=${titleCount}); rebuild via --from-soda group-by`,
    );
  }
  if (titleCount < PAYROLL_TITLE_MIN_TITLE_COUNT) {
    findings.push(
      `Payroll title mart title_count ${titleCount} below floor ${PAYROLL_TITLE_MIN_TITLE_COUNT}`,
    );
  }
  if (PAYROLL_TITLE_FULL_MODES.includes(mode)) {
    const drift = Math.abs(titleCount - PAYROLL_TITLE_PUBLISHER_TITLE_COUNT);
    if (drift > PAYROLL_TITLE_COUNT_DRIFT_ABS) {
      findings.push(
        `Payroll title mart title_count ${titleCount} drifts ${drift} from publisher ${PAYROLL_TITLE_PUBLISHER_TITLE_COUNT}`,
      );
    }
    if (Number.isFinite(windowRows) && windowRows < PAYROLL_TITLE_MIN_WINDOW_ROWS) {
      findings.push(
        `Payroll title mart window_row_count ${windowRows} below floor ${PAYROLL_TITLE_MIN_WINDOW_ROWS}`,
      );
    }
  }
  if (!PAYROLL_TITLE_FULL_MODES.includes(mode) && titleCount >= PAYROLL_TITLE_MIN_TITLE_COUNT) {
    findings.push(
      `Payroll title mart mode ${JSON.stringify(mode)} is not a full-catalog mode (${PAYROLL_TITLE_FULL_MODES.join("|")})`,
    );
  }
  return findings;
}

export function assertPayrollTitleServeGate(doc, opts = {}) {
  const findings = payrollTitleServeGateFindings(doc, opts);
  if (findings.length) throw new Error(findings.join("; "));
  return true;
}

export function buildMaterializationDoc(rows, opts = {}) {
  const list = payrollTitleRows(rows);
  const windowRowCount = list.reduce((sum, row) => sum + row.n, 0);
  const publisherRowCount = Number.isFinite(Number(opts.publisherRowCount))
    ? Number(opts.publisherRowCount)
    : PAYROLL_PUBLISHER_ROW_COUNT;
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
      window_row_count: Number.isFinite(Number(opts.windowRowCount))
        ? Number(opts.windowRowCount)
        : windowRowCount,
      window:
        `fiscal_year=${PAYROLL_TITLE_FISCAL_YEAR} AND base_salary > 0 AND title_description IS NOT NULL`,
      note:
        "Bounded FY title projection — not the full multi-year employee file. No individual-employee rows.",
    },
    pii: {
      employee_rows: false,
      allowed_fields: ["title_description", "n", "mn", "mx", "avg"],
    },
    follow_ons: [
      "agency × title rollup",
      "median / percentile compensation bands",
      "multi-FY title history",
      "optional WH pack of the 6.8M employee file (never public-served as rows)",
    ],
    replaces_live_fetch: {
      worker: "worker/src/lib/suggestions.mjs#suggestionCountParams",
      soda_dataset: PAYROLL_SODA_DATASET,
      description:
        "People title/payroll suggestion counts — committed FY title mart first; live SODA only on miss",
    },
    rows: list,
  };
}

export function loadLastKnownGoodDoc(sitePath, workerPath) {
  for (const filePath of [sitePath, workerPath].filter(Boolean)) {
    if (!existsSync(filePath)) continue;
    try {
      const doc = JSON.parse(readFileSync(filePath, "utf8"));
      if (payrollTitleServeGateFindings(doc).length === 0) return doc;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function lookupPayrollTitleCount(doc, keyword) {
  if (!doc) return { hit: false, count: 0, title_count: 0, rows: [] };
  return countPayrollTitleMatches(doc, keyword);
}

export { rowToPayrollTitleShape, payrollTitleRows };
