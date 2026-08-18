/**
 * Bounded Citywide Payroll title mart (FY aggregate, no employee PII).
 *
 * Highest-value live-payroll deletion: title search / suggestion counts
 * currently group SODA `k397-673e` at request time. This reader searches a
 * committed title → {count, min/max/avg base} projection instead.
 *
 * Agency × title, median bands, and multi-FY history are follow-ons.
 */

export const PAYROLL_TITLE_SCHEMA_VERSION = 1;
export const PAYROLL_TITLE_FISCAL_YEAR = 2025;
export const PAYROLL_SODA_DATASET = "k397-673e";
export const PAYROLL_TITLE_ALLOWED_FIELDS = Object.freeze([
  "title_description",
  "n",
  "mn",
  "mx",
  "avg",
]);
export const PAYROLL_TITLE_PII_FIELDS = Object.freeze([
  "last_name",
  "first_name",
  "mid_init",
  "middle_initial",
  "employee_id",
  "payroll_number",
  "ssn",
  "social_security",
  "date_of_birth",
  "work_location",
]);

const TITLE_FIELD = "title_description";

export function normalizePayrollTitle(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function payrollTitleKey(value) {
  return normalizePayrollTitle(value).toUpperCase();
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function moneyNumber(value) {
  const number = finiteNumber(value);
  return number == null ? null : Math.round(number * 100) / 100;
}

/**
 * Keep only the aggregate title fields. Individual-employee columns never enter
 * the serve artifact.
 */
export function rowToPayrollTitleShape(row) {
  if (!row || typeof row !== "object") return null;
  const title_description = normalizePayrollTitle(row.title_description);
  if (!title_description) return null;
  const n = finiteNumber(row.n ?? row.headcount ?? row.count);
  if (n == null || n < 0) return null;
  return {
    title_description,
    n: Math.round(n),
    mn: moneyNumber(row.mn ?? row.base_min ?? row.min_base_salary),
    mx: moneyNumber(row.mx ?? row.base_max ?? row.max_base_salary),
    avg: moneyNumber(row.avg ?? row.base_avg ?? row.avg_base_salary),
  };
}

export function payrollTitleRows(docOrRows) {
  const rows = Array.isArray(docOrRows)
    ? docOrRows
    : Array.isArray(docOrRows?.rows)
      ? docOrRows.rows
      : [];
  return rows.map(rowToPayrollTitleShape).filter(Boolean);
}

function objectPiiFindings(value, path = "row") {
  const findings = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return findings;
  for (const key of Object.keys(value)) {
    const lower = String(key).toLowerCase();
    if (PAYROLL_TITLE_PII_FIELDS.includes(lower) || /(?:^|_)(?:first|last)_name$/.test(lower)) {
      findings.push(`${path} carries PII field ${JSON.stringify(key)}`);
    }
  }
  return findings;
}

/**
 * Fail closed when an employee-identifying field is present on the document or
 * any title row. Aggregate title / count / band fields are the only public keys.
 */
export function payrollTitlePiiFindings(docOrRow) {
  if (!docOrRow || typeof docOrRow !== "object") return [];
  if (Array.isArray(docOrRow?.rows)) {
    const findings = objectPiiFindings(docOrRow, "payroll title mart");
    docOrRow.rows.forEach((row, index) => {
      findings.push(...objectPiiFindings(row, `rows[${index}]`));
    });
    return findings;
  }
  return objectPiiFindings(docOrRow);
}

export function searchPayrollTitles(docOrRows, keyword, { limit = 40 } = {}) {
  const query = payrollTitleKey(keyword);
  const rows = payrollTitleRows(docOrRows);
  const matched = query
    ? rows.filter((row) => payrollTitleKey(row.title_description).includes(query))
    : rows.slice();
  matched.sort((left, right) => right.n - left.n
    || left.title_description.localeCompare(right.title_description));
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : matched.length;
  return matched.slice(0, cap);
}

/**
 * Title-search count used by suggestion fruitfulness (same universe as the
 * live SODA `count(1)` over FY title rows: sum of headcount, not distinct titles).
 */
export function countPayrollTitleMatches(docOrRows, keyword) {
  const rows = searchPayrollTitles(docOrRows, keyword, { limit: Infinity });
  const count = rows.reduce((sum, row) => sum + row.n, 0);
  return {
    hit: rows.length > 0 && count > 0,
    count,
    title_count: rows.length,
    rows,
  };
}

export function payrollTitleMartReady(doc) {
  if (!doc || typeof doc !== "object") return false;
  if (Number(doc.schema_version) !== PAYROLL_TITLE_SCHEMA_VERSION) return false;
  if (Number(doc.fiscal_year) !== PAYROLL_TITLE_FISCAL_YEAR) return false;
  return payrollTitleRows(doc).length > 0 && payrollTitlePiiFindings(doc).length === 0;
}
