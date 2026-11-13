/**
 * First-payment timing: how long after a registered contract's start date the
 * City first paid it, measured from the retained Checkbook payment population.
 *
 * Pure functions only. tools/build_first_payment_timing.mjs streams the
 * payment rows and calls these.
 *
 * A first payment is the earliest issue date of a positive check amount
 * recorded against the exact contract id. Reversals and zero amounts are not
 * payments. Payments are retained for whole fiscal years only, so a contract
 * is measured at a horizon (1, 6 or 12 months after its start date) only when
 * that horizon ends inside the retained payment years; otherwise it is not
 * counted for that horizon. A contract with no payment in the retained years is
 * reported as such, never as unpaid for longer than the retained years show.
 */

export const FIRST_PAYMENT_TIMING_SCHEMA = "cityscroll.analytics_first_payment_timing.v1";
export const FIRST_PAYMENT_TIMING_CONTRACTS_SCHEMA = "cityscroll.analytics_first_payment_timing_contracts.v1";
export const FIRST_PAYMENT_TIMING_URL = "data/analytics_first_payment_timing.json";
export const FIRST_PAYMENT_TIMING_CONTRACTS_URL = "data/analytics_first_payment_timing/contracts.json";
export const HORIZONS = Object.freeze([
  Object.freeze({ id: "within_1_month", months: 1 }),
  Object.freeze({ id: "within_6_months", months: 6 }),
  Object.freeze({ id: "within_12_months", months: 12 }),
]);
export const MEDIAN_HORIZON = "within_6_months";
export const MIN_CONTRACTS_FOR_MEDIAN = 10;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isoDate(value) {
  const text = String(value ?? "").trim().slice(0, 10);
  if (!DATE.test(text)) return null;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === text ? text : null;
}

export function addMonths(date, months) {
  const [year, month, day] = date.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

/** Last day inside a horizon: the day before the same calendar date `months` later. */
export function horizonEnd(start, months) {
  const next = addMonths(start, months);
  return new Date(Date.parse(`${next}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/** NYC fiscal year N runs July 1 of N-1 through June 30 of N. */
export function fiscalYearCoverage(fiscalYears) {
  const years = [...new Set((fiscalYears || []).map(Number))].filter(Number.isInteger).sort((a, b) => a - b);
  if (!years.length) throw new Error("first-payment timing requires the retained payment fiscal years");
  for (let i = 1; i < years.length; i += 1) {
    if (years[i] !== years[i - 1] + 1) throw new Error("first-payment timing requires consecutive retained payment fiscal years");
  }
  return { fiscal_years: years, from: `${years[0] - 1}-07-01`, through: `${years.at(-1)}-06-30` };
}

/**
 * Track the earliest positive payment per contract id. `accept` is called once
 * per payment row; rows for contracts outside `contractIds` are counted, not kept.
 */
export function createFirstPaymentTracker(contractIds) {
  const wanted = contractIds instanceof Set ? contractIds : new Set(contractIds);
  const first = new Map();
  const stats = { payment_rows: 0, positive_rows: 0, reversal_or_zero_rows: 0, undated_rows: 0, rows_for_measured_contracts: 0 };
  return {
    accept({ contractId, issueDate, amount }) {
      stats.payment_rows += 1;
      if (!(Number(amount) > 0)) { stats.reversal_or_zero_rows += 1; return; }
      stats.positive_rows += 1;
      const date = isoDate(issueDate);
      if (!date) { stats.undated_rows += 1; return; }
      const id = String(contractId ?? "").trim();
      if (!id || !wanted.has(id)) return;
      stats.rows_for_measured_contracts += 1;
      const current = first.get(id);
      if (!current || date < current) first.set(id, date);
    },
    firstPayments: first,
    stats,
  };
}

function median(sorted) {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Classify each registered contract against the retained payment years and
 * summarize per agency.
 */
export function firstPaymentTiming({ contracts, firstPayments, coverage, contractsSnapshot, paymentsSnapshot, paymentStats = null, generatedAt = null }) {
  const excluded = { start_before_payment_years: 0, start_after_payment_years: 0, missing_start_date: 0, missing_contract_id: 0, duplicate_contract_id: 0 };
  const seen = new Set();
  const measured = [];
  for (const row of contracts) {
    const id = String(row?.prime_contract_id ?? "").trim();
    if (!id) { excluded.missing_contract_id += 1; continue; }
    if (seen.has(id)) { excluded.duplicate_contract_id += 1; continue; }
    seen.add(id);
    const start = isoDate(row.start_date);
    if (!start) { excluded.missing_start_date += 1; continue; }
    if (start < coverage.from) { excluded.start_before_payment_years += 1; continue; }
    if (start > coverage.through) { excluded.start_after_payment_years += 1; continue; }
    const paid = firstPayments.get(id) || null;
    const days = paid ? daysBetween(start, paid) : null;
    measured.push({
      prime_contract_id: id,
      agency: row.agency || null,
      start_date: start,
      registration_date: isoDate(row.registration_date),
      first_payment_date: paid,
      days_to_first_payment: days,
      state: paid ? "paid_in_payment_years" : "no_payment_in_payment_years",
    });
  }
  measured.sort((a, b) => String(a.agency || "").localeCompare(String(b.agency || "")) || a.prime_contract_id.localeCompare(b.prime_contract_id));

  const byAgency = new Map();
  for (const row of measured) {
    const key = row.agency || "Unknown / not published";
    if (!byAgency.has(key)) byAgency.set(key, []);
    byAgency.get(key).push(row);
  }
  const summarize = (rows, label) => {
    const horizons = {};
    for (const { id, months } of HORIZONS) {
      const observable = rows.filter((row) => horizonEnd(row.start_date, months) <= coverage.through);
      const paidWithin = observable.filter((row) => row.first_payment_date && row.first_payment_date <= horizonEnd(row.start_date, months));
      horizons[id] = { observable_contracts: observable.length, first_paid_within: paidWithin.length, not_observable_contracts: rows.length - observable.length };
    }
    const paid = rows.filter((row) => row.first_payment_date).length;
    const medianObservable = rows.filter((row) => horizonEnd(row.start_date, 6) <= coverage.through);
    let medianDays = null;
    let medianState;
    if (medianObservable.length < MIN_CONTRACTS_FOR_MEDIAN) medianState = "too_few_contracts";
    else {
      const limit = (row) => horizonEnd(row.start_date, 6);
      const within = new Set(medianObservable.filter((row) => row.first_payment_date && row.first_payment_date <= limit(row)));
      // Contracts not first paid within six months rank after every measured wait.
      const waits = medianObservable.map((row) => (within.has(row) ? row.days_to_first_payment : Infinity)).sort((a, b) => a - b);
      const middle = median(waits);
      if (Number.isFinite(middle)) { medianDays = middle; medianState = "measured"; }
      else medianState = "over_6_months";
    }
    return {
      agency: label,
      contracts: rows.length,
      first_paid_in_payment_years: paid,
      no_payment_in_payment_years: rows.length - paid,
      horizons,
      median_basis_contracts: medianObservable.length,
      median_days_to_first_payment: medianDays,
      median_state: medianState,
    };
  };
  const agencies = [...byAgency.entries()].map(([agency, rows]) => summarize(rows, agency))
    .sort((a, b) => a.agency.localeCompare(b.agency));
  const all = summarize(measured, "All agencies");
  delete all.agency;
  return {
    summary: {
      schema: FIRST_PAYMENT_TIMING_SCHEMA,
      generated_at: generatedAt || paymentsSnapshot,
      snapshot_date: paymentsSnapshot,
      contracts_snapshot_date: contractsSnapshot,
      population_definition: `Registered Checkbook expense contracts whose start date falls inside the retained payment years (${coverage.from} to ${coverage.through}), one row per exact prime contract id.`,
      first_payment_definition: "The earliest issue date of a positive check amount recorded against the exact contract id. Reversals and zero amounts are not payments.",
      measured_from: "The contract start date published by Checkbook, not the date work began.",
      payment_years: coverage,
      horizon_rule: "Within N months means first paid before the same calendar date N months after the start date. A contract counts toward a horizon only when that whole period lies inside the retained payment years.",
      median_rule: `Median days from start to first payment over contracts observable for six months, with contracts not first paid within six months ranked after every measured wait; shown only for ${MIN_CONTRACTS_FOR_MEDIAN} or more such contracts and only when the middle value is a measured wait.`,
      limits: [
        "Payments recorded under another contract id (for example a master agreement) are not joined to this contract.",
        "A contract with no payment in the retained payment years may have been paid later; later payments are not retained here.",
      ],
      horizons: HORIZONS.map(({ id, months }) => ({ id, months })),
      min_contracts_for_median: MIN_CONTRACTS_FOR_MEDIAN,
      population: {
        registered_contracts_read: contracts.length,
        measured_contracts: measured.length,
        excluded,
        payment_rows: paymentStats,
      },
      all_agencies: all,
      agencies,
      contracts_path: FIRST_PAYMENT_TIMING_CONTRACTS_URL,
    },
    contracts: {
      schema: FIRST_PAYMENT_TIMING_CONTRACTS_SCHEMA,
      snapshot_date: paymentsSnapshot,
      contracts_snapshot_date: contractsSnapshot,
      row_count: measured.length,
      rows: measured,
    },
  };
}
