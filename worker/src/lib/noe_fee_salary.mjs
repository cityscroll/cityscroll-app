/**
 * Parse application fee and salary from Notice of Examination (NOE) body text.
 *
 * DCAS NOE PDFs label amounts as:
 *   APPLICATION FEE: $68.00
 *   The current minimum salary is $48,206 per annum.
 * PDF extraction sometimes inserts spaces after thousands separators
 * ("$48, 206") — same class of quirk as City Record subsidy hearing money.
 *
 * Pure: no fetch. Never fabricates amounts when labels are absent.
 */

/** Match a dollar amount with optional comma/space thousands groups and spaced decimals. */
const MONEY_CAPTURE =
  "\\$?\\s*(\\d{1,3}(?:\\s*,\\s*\\d{3})+(?:\\s*\\.\\s*\\d+)?|\\d+(?:\\s*\\.\\s*\\d+)?)";

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
  const minRe = new RegExp(
    `(?:the\\s+)?current\\s+minimum\\s+salary\\s+is\\s+${MONEY_CAPTURE}(?:\\s+per\\s+annum)?`,
    "i",
  );
  const minMatch = text.match(minRe);
  if (minMatch) {
    salaryMin = toMoneyAmount(minMatch[1]);
    salaryExcerpt = minMatch[0].trim();
    salaryNote = "Current minimum annual salary";
  } else {
    // "minimum salary: $48,206" / "starting salary is $48,206"
    const altMin = text.match(
      new RegExp(
        `(?:minimum|starting)\\s+salary\\s*(?:is|:)?\\s*${MONEY_CAPTURE}`,
        "i",
      ),
    );
    if (altMin) {
      salaryMin = toMoneyAmount(altMin[1]);
      salaryExcerpt = altMin[0].trim();
      salaryNote = "Minimum annual salary";
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
      const upper = toMoneyAmount(reachMatch[1]);
      if (upper != null && upper > salaryMin) {
        salaryMax = upper;
        if (!salaryExcerpt) salaryExcerpt = reachMatch[0].trim();
      }
    } else {
      const rangeRe = new RegExp(
        `${MONEY_CAPTURE}\\s*(?:–|-|to)\\s*${MONEY_CAPTURE}(?:\\s+per\\s+annum)?`,
        "i",
      );
      const rangeMatch = text.match(rangeRe);
      if (rangeMatch) {
        const a = toMoneyAmount(rangeMatch[1]);
        const b = toMoneyAmount(rangeMatch[2]);
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
