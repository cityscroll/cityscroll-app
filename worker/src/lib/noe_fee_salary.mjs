/**
 * Parse application fee and salary from Notice of Examination (NOE) body text.
 *
 * DCAS NOE PDFs label amounts as:
 *   APPLICATION FEE: $68.00
 *   The current minimum salary is $48,206 per annum.
 * PDF extraction sometimes inserts spaces after thousands separators
 * ("$48, 206") — same class of quirk as City Record subsidy hearing money.
 * Multi-exam NOEs list several Exam No. values under one fee/salary block
 * (e.g. Police Officer 7311–7322).
 *
 * Pure: no fetch. Never fabricates amounts when labels are absent.
 */

/** Match a dollar amount with optional comma/space thousands groups and spaced decimals. */
const MONEY_CAPTURE =
  "\\$?\\s*(\\d{1,3}(?:\\s*,\\s*\\d{3})+(?:\\s*\\.\\s*\\d+)?|\\d+(?:\\s*\\.\\s*\\d+)?)";

/** Same amount shape, but only when the notice actually prints a dollar sign. */
const DOLLAR_MONEY_CAPTURE =
  "\\$\\s*(\\d{1,3}(?:\\s*,\\s*\\d{3})+(?:\\s*\\.\\s*\\d+)?|\\d+(?:\\s*\\.\\s*\\d+)?)";

/**
 * DCAS states some salaries as a rate rather than a year: "the current minimum
 * salary is $41.40 per hour for a 40-hour work week". Reading that as an annual
 * minimum understates the job by roughly a factor of two thousand, so a rate is
 * left unrecorded rather than relabelled.
 */
const RATE_BASIS = /^[\s,]*(?:per\s+hour|an\s+hour|hourly|\/\s*hour|per\s+session|per\s+diem|per\s+day|a\s+day|per\s+week|a\s+week)/i;

/**
 * Floor for treating a parsed figure as an annual salary. A full-time year at
 * the New York State minimum wage is already well above this, so anything
 * lower is a rate, a fee, or a stray number rather than an annual salary.
 */
const MIN_PLAUSIBLE_ANNUAL_SALARY = 20000;

/** True when the amount that just matched is annual, not a printed rate. */
function statedPerYear(text, match) {
  return !RATE_BASIS.test(text.slice(match.index + match[0].length));
}

/** Keep only figures that can be an annual salary. */
function annualSalary(value) {
  return value != null && value >= MIN_PLAUSIBLE_ANNUAL_SALARY ? value : null;
}

/**
 * Normalize a captured money token to a finite number, or null.
 * Handles "$68.00", "48,206", "48, 206", "$10, 667, 606".
 * @param {string|number|null|undefined} value
 * @returns {number|null}
 */
export function toMoneyAmount(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const normalized = String(value)
    .trim()
    .replace(/[$,]/g, "")
    .replace(/\s+/g, "");
  if (!normalized) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function plainText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract 4-digit exam numbers from a multi-exam NOE header line.
 * Example: "Exam No. 7311, 7312, 7313, …, and 7322" → ["7311", …, "7322"].
 * @param {string} bodyText
 * @returns {string[]}
 */
export function extractNoeExamNumbers(bodyText) {
  const text = plainText(bodyText);
  if (!text) return [];
  const header = text.match(
    /Exam\s+No\.?\s*((?:\d{4}(?:\s*,\s*|\s+and\s+|\s+)+)*\d{4})/i,
  );
  if (!header) {
    const single = text.match(/Exam\s+No\.?\s*(\d{4})\b/i);
    return single ? [single[1]] : [];
  }
  const nums = [...header[1].matchAll(/\b(\d{4})\b/g)].map((m) => m[1]);
  return [...new Set(nums)];
}

/**
 * Extract fee + salary fields from raw NOE body / PDF text.
 *
 * @param {string} bodyText
 * @returns {{
 *   fee: number|null,
 *   salary_min: number|null,
 *   salary_max: number|null,
 *   salary_note: string|null,
 *   fee_excerpt: string|null,
 *   salary_excerpt: string|null,
 * }}
 */
export function parseNoeFeeSalaryFromBody(bodyText) {
  const text = plainText(bodyText);
  const empty = {
    fee: null,
    salary_min: null,
    salary_max: null,
    salary_note: null,
    fee_excerpt: null,
    salary_excerpt: null,
  };
  if (!text) return empty;

  let fee = null;
  let feeExcerpt = null;
  // Primary: labeled APPLICATION FEE (DCAS header block).
  const feeRe = new RegExp(
    `APPLICATION\\s+FEE\\s*:?\\s*${MONEY_CAPTURE}`,
    "i",
  );
  const feeMatch = text.match(feeRe);
  if (feeMatch) {
    fee = toMoneyAmount(feeMatch[1]);
    feeExcerpt = feeMatch[0].trim();
  } else {
    // Fallback wording seen on some older / amended notices.
    const altFee = text.match(
      new RegExp(
        `(?:the\\s+)?application\\s+fee\\s+(?:is|of)\\s+${MONEY_CAPTURE}`,
        "i",
      ),
    );
    if (altFee) {
      fee = toMoneyAmount(altFee[1]);
      feeExcerpt = altFee[0].trim();
    }
  }

  let salaryMin = null;
  let salaryMax = null;
  let salaryNote = null;
  let salaryExcerpt = null;

  // Primary: "The current minimum salary is $48,206 per annum."
  // Also: "for which the current minimum salary is $48,719 per annum" (assignment-level).
  const minRe = new RegExp(
    `(?:(?:for\\s+which|to\\s+which)\\s+)?(?:the\\s+)?current\\s+minimum\\s+salary\\s+is\\s+${MONEY_CAPTURE}(?:\\s+per\\s+annum)?`,
    "i",
  );
  const minMatch = text.match(minRe);
  if (minMatch && statedPerYear(text, minMatch)) {
    salaryMin = annualSalary(toMoneyAmount(minMatch[1]));
    if (salaryMin != null) {
      salaryExcerpt = minMatch[0].trim();
      salaryNote = "Current minimum annual salary";
    }
  }
  if (salaryMin == null) {
    // "minimum salary: $48,206" / "starting salary is $48,206" / "annual salary of $48,206"
    const altMin = text.match(
      new RegExp(
        `(?:minimum|starting|annual)\\s+salary\\s*(?:is|of|:)?\\s*${MONEY_CAPTURE}`,
        "i",
      ),
    );
    if (altMin && statedPerYear(text, altMin)) {
      salaryMin = annualSalary(toMoneyAmount(altMin[1]));
      if (salaryMin != null) {
        salaryExcerpt = altMin[0].trim();
        salaryNote = "Minimum annual salary";
      }
    }
  }

  // Optional upper bound: "reaching $58,345 per annum" / "to $58,345" / range dash.
  if (salaryMin != null) {
    const reachRe = new RegExp(
      `(?:reaching|up\\s+to|maximum(?:\\s+salary)?(?:\\s+is)?)\\s+${MONEY_CAPTURE}(?:\\s+per\\s+annum)?`,
      "i",
    );
    const reachMatch = text.match(reachRe);
    if (reachMatch) {
      const upper = annualSalary(toMoneyAmount(reachMatch[1]));
      if (upper != null && upper > salaryMin && statedPerYear(text, reachMatch)) {
        salaryMax = upper;
        if (!salaryExcerpt) salaryExcerpt = reachMatch[0].trim();
      }
    } else {
      const rangeRe = new RegExp(
        `${DOLLAR_MONEY_CAPTURE}\\s*(?:–|-|to)\\s*${DOLLAR_MONEY_CAPTURE}(?:\\s+per\\s+annum)?`,
        "i",
      );
      const rangeMatch = text.match(rangeRe);
      if (rangeMatch && statedPerYear(text, rangeMatch)) {
        const a = annualSalary(toMoneyAmount(rangeMatch[1]));
        const b = annualSalary(toMoneyAmount(rangeMatch[2]));
        if (a != null && b != null && b > a) {
          // Prefer labeled min when already set; only fill max from range.
          if (salaryMin === a || salaryMin === null) {
            salaryMin = a;
            salaryMax = b;
            salaryExcerpt = salaryExcerpt || rangeMatch[0].trim();
            salaryNote = salaryNote || "Annual salary range";
          } else if (b > salaryMin) {
            salaryMax = b;
          }
        }
      }
    }
  }

  return {
    fee,
    salary_min: salaryMin,
    salary_max: salaryMax,
    salary_note: salaryNote,
    fee_excerpt: feeExcerpt,
    salary_excerpt: salaryExcerpt,
  };
}

/**
 * Merge body-parsed fee/salary onto an exam row when structured fields are missing.
 * Never overwrites a non-null structured amount. fee 0 is a real value (no fee).
 *
 * @param {object} exam
 * @param {string} [bodyText] — optional override; else exam.noe_body / exam.body
 * @returns {object} shallow-copied exam (or original when nothing to densify)
 */
export function applyNoeFeeSalaryFromBody(exam = {}, bodyText) {
  if (!exam || typeof exam !== "object") return exam;
  const body =
    bodyText != null
      ? bodyText
      : exam.noe_body || exam.body || exam.noe_text || "";
  if (!String(body || "").trim()) return exam;

  const parsed = parseNoeFeeSalaryFromBody(body);
  const out = { ...exam };
  let changed = false;

  if (out.fee == null && parsed.fee != null) {
    out.fee = parsed.fee;
    changed = true;
  }
  if (
    (out.salary_min == null || out.salary_min === "")
    && parsed.salary_min != null
  ) {
    out.salary_min = parsed.salary_min;
    changed = true;
  }
  if (
    (out.salary_max == null || out.salary_max === "")
    && parsed.salary_max != null
  ) {
    out.salary_max = parsed.salary_max;
    changed = true;
  }
  if (!out.salary_note && parsed.salary_note) {
    out.salary_note = parsed.salary_note;
    changed = true;
  }

  if (!changed) return exam;

  const sources = [...new Set([...(out.sources || []), "dcas-noe"])];
  out.sources = sources;
  return out;
}
