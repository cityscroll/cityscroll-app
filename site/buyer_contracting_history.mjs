// Buyer contracting history for the pursuit decision.
//
// A vendor deciding whether to bid asks one question of a buyer: what has this
// buyer actually registered, and how many of those contracts were registered
// after the work was supposed to start? Answering it honestly needs a real
// denominator. This module derives the whole scoped population from the
// existing registered-contract projection before any pagination or optional
// enrichment, so a conveniently linked subset can never stand in for the
// buyer's track record.
//
// What this module deliberately does not do:
//   * It never counts a contract twice. Identity is the publisher's exact
//     prime_contract_id, so the subvendor slices of one contract collapse into
//     the single contract they belong to.
//   * It never gates the count on an optional PASSPort or City Record join. A
//     contract with no cross-source link is still counted and still inspectable
//     from its own source record.
//   * It never turns a missing measurement into a zero. A population that
//     carries no dates yet reports its denominator and withholds the timing
//     metric; it does not report "0 registered after start".
//   * It never reads "registered after start" as delay, fault, blame, invoice
//     timing, or a forecast for the reader's own opportunity. It is the signed
//     difference between two published dates on the current contract version.

import {
  filterAnalyticalContracts,
  registrationLagDaysBetween,
  registrationTimingSummary,
  analyticalDrillThroughHref,
} from "./analytical_projection.mjs";
import { readerDimensionValue } from "./analytical_projection_contract.mjs";

export const BUYER_CONTRACTING_HISTORY_SCHEMA = "cityscroll.buyer_contracting_history.v1";

/** Reuses the existing repair lineage; this is not a second maintainer board. */
export const BUYER_HISTORY_REPAIR_GUARD = "buyer-contracting-history";

export const BUYER_HISTORY_TIMING_STATES = Object.freeze({
  MEASURED: "measured",
  PARTIALLY_MEASURED: "partially_measured",
  NOT_MATERIALIZED: "not_materialized",
  NO_CONTRACTS: "no_contracts",
});

export const BUYER_HISTORY_METRIC_MEANING = "Registered after start counts contracts whose "
  + "published registration date is later than the published contract start date, on the "
  + "current published contract version. It is not an invoice delay, a fault finding, or a "
  + "prediction about a future award.";

const UNAVAILABLE = null;

function trimmed(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function selectedScope(options = {}) {
  return {
    industry: trimmed(options.industry),
    award_method: trimmed(options.award_method),
    contract_amount_band: trimmed(options.contract_amount_band),
    min_amount: options.min_amount == null || options.min_amount === "" ? null : Number(options.min_amount),
    max_amount: options.max_amount == null || options.max_amount === "" ? null : Number(options.max_amount),
  };
}

function scopeIsNarrowed(scope) {
  return Object.values(scope).some((value) => value != null);
}

/**
 * One inspectable case. Every field comes from the buyer's own source record,
 * so a case stays useful when no procurement or PASSPort destination exists.
 */
export function buyerContractingHistoryCase(row) {
  if (!row?.prime_contract_id) return null;
  const lag = row.registration_lag_days == null
    ? registrationLagDaysBetween(row.registration_date, row.start_date)
    : Number(row.registration_lag_days);
  const hasLag = Number.isFinite(lag);
  return {
    source_contract_id: row.prime_contract_id,
    buyer: row.agency || UNAVAILABLE,
    vendor: row.prime_vendor || UNAVAILABLE,
    purpose: row.contract_purpose || UNAVAILABLE,
    industry: row.industry || UNAVAILABLE,
    award_method: row.award_method || UNAVAILABLE,
    current_registered_amount: Number.isFinite(Number(row.current_registered_amount))
      ? Number(row.current_registered_amount) : UNAVAILABLE,
    contract_start_date: row.start_date || UNAVAILABLE,
    registration_date: row.registration_date || UNAVAILABLE,
    registration_lag_days: hasLag ? lag : UNAVAILABLE,
    registration_timing: hasLag ? (lag > 0 ? "registered_after_start" : "registered_before_or_on_start") : UNAVAILABLE,
    registration_fiscal_year: Number.isInteger(Number(row.registration_fiscal_year))
      ? Number(row.registration_fiscal_year) : UNAVAILABLE,
    // Contract type and version are source semantics: a release against a
    // master agreement is its own instrument and is never summed into one.
    contract_version: row.contract_version || UNAVAILABLE,
    parent_contract_id: row.parent_contract_id || UNAVAILABLE,
    document_code: row.document_code || UNAVAILABLE,
    // Conflicting slice observations stay visible rather than being coalesced.
    date_observations: row.date_ownership || null,
  };
}

function timingStateOf(summary) {
  if (!summary.total_contract_count) return BUYER_HISTORY_TIMING_STATES.NO_CONTRACTS;
  if (!summary.eligible_contract_count) return BUYER_HISTORY_TIMING_STATES.NOT_MATERIALIZED;
  if (summary.missing_date_contract_count) return BUYER_HISTORY_TIMING_STATES.PARTIALLY_MEASURED;
  return BUYER_HISTORY_TIMING_STATES.MEASURED;
}

/**
 * Derive the buyer's scoped registered-contract history.
 *
 * `rows` is the complete registered-contract projection. The count is taken
 * over the whole matching population, so the denominator is the buyer's real
 * one and not the length of whatever page the reader happens to be looking at.
 */
export function buyerContractingHistory(rows, options = {}) {
  const buyerLabel = trimmed(options.agency);
  const fiscalYear = options.registration_fiscal_year == null || options.registration_fiscal_year === ""
    ? null : Number(options.registration_fiscal_year);
  const scope = selectedScope(options);
  const filters = {
    agency: buyerLabel,
    registration_fiscal_year: Number.isInteger(fiscalYear) ? fiscalYear : null,
    industry: scope.industry,
    award_method: scope.award_method,
    contract_amount_band: scope.contract_amount_band,
    min_amount: scope.min_amount,
    max_amount: scope.max_amount,
  };
  const matched = filterAnalyticalContracts(Array.isArray(rows) ? rows : [], filters);
  // The denominator is the deduplicated population, taken before any case
  // limit. registrationTimingSummary already collapses to one row per exact
  // contract id, so ten source slices of one contract count once.
  const summary = registrationTimingSummary(matched);
  const unique = [...new Map(matched
    .filter((row) => row?.prime_contract_id)
    .map((row) => [row.prime_contract_id, row])).values()];
  const state = timingStateOf(summary);
  const measured = state === BUYER_HISTORY_TIMING_STATES.MEASURED
    || state === BUYER_HISTORY_TIMING_STATES.PARTIALLY_MEASURED;
  const caseLimit = Number.isInteger(Number(options.case_limit)) && Number(options.case_limit) > 0
    ? Number(options.case_limit) : null;
  const ordered = [...unique].sort((left, right) => {
    const leftLag = left.registration_lag_days == null ? -Infinity : Number(left.registration_lag_days);
    const rightLag = right.registration_lag_days == null ? -Infinity : Number(right.registration_lag_days);
    return rightLag - leftLag || String(left.prime_contract_id).localeCompare(String(right.prime_contract_id));
  });
  const hrefFor = (retroactive) => analyticalDrillThroughHref({
    agency: buyerLabel,
    registration_fiscal_year: Number.isInteger(fiscalYear) ? fiscalYear : undefined,
    industry: scope.industry || undefined,
    award_method: scope.award_method || undefined,
    contract_amount_band: scope.contract_amount_band || undefined,
    min_amount: scope.min_amount == null ? undefined : scope.min_amount,
    max_amount: scope.max_amount == null ? undefined : scope.max_amount,
    ...(retroactive ? { retroactive: true } : {}),
  });
  return {
    schema: BUYER_CONTRACTING_HISTORY_SCHEMA,
    state: "available",
    buyer: {
      label: buyerLabel,
      display_label: buyerLabel ? readerDimensionValue(buyerLabel) : null,
    },
    registration_fiscal_year: Number.isInteger(fiscalYear) ? fiscalYear : null,
    scope,
    scope_is_narrowed: scopeIsNarrowed(scope),
    // The honest denominator: every matching registered contract, counted once.
    contract_count: summary.total_contract_count,
    timing: {
      state,
      measurable: measured,
      metric_meaning: BUYER_HISTORY_METRIC_MEANING,
      after_start_count: measured ? summary.retroactive_contract_count : UNAVAILABLE,
      early_on_time_count: measured ? summary.early_on_time_contract_count : UNAVAILABLE,
      measured_contract_count: summary.eligible_contract_count,
      unmeasured_contract_count: summary.missing_date_contract_count,
      after_start_share: measured ? summary.retroactive_share : UNAVAILABLE,
    },
    cases: (caseLimit ? ordered.slice(0, caseLimit) : ordered)
      .map(buyerContractingHistoryCase).filter(Boolean),
    case_total: unique.length,
    all_cases_href: hrefFor(false),
    after_start_cases_href: measured ? hrefFor(true) : null,
    source_observation: {
      snapshot_date: trimmed(options.snapshot_date),
      generated_at: trimmed(options.generated_at),
      population_definition: trimmed(options.population_definition),
    },
    repair_observation: state === BUYER_HISTORY_TIMING_STATES.NOT_MATERIALIZED
      ? buyerHistoryRepairObservation({
        reason: "registration-timing-not-materialized",
        registration_fiscal_year: Number.isInteger(fiscalYear) ? fiscalYear : null,
        contract_count: summary.total_contract_count,
        source_revision: options.source_revision,
        snapshot_date: trimmed(options.snapshot_date),
      })
      : null,
  };
}

/**
 * A failed history request keeps the reader's selection and offers a retry.
 * It never renders as "0 contracts": an unavailable answer and an answer of
 * zero are different claims about the buyer.
 */
export function buyerContractingHistoryFailure(options = {}) {
  const buyerLabel = trimmed(options.agency);
  const fiscalYear = options.registration_fiscal_year == null || options.registration_fiscal_year === ""
    ? null : Number(options.registration_fiscal_year);
  const scope = selectedScope(options);
  return {
    schema: BUYER_CONTRACTING_HISTORY_SCHEMA,
    state: "unavailable",
    buyer: {
      label: buyerLabel,
      display_label: buyerLabel ? readerDimensionValue(buyerLabel) : null,
    },
    registration_fiscal_year: Number.isInteger(fiscalYear) ? fiscalYear : null,
    scope,
    scope_is_narrowed: scopeIsNarrowed(scope),
    contract_count: UNAVAILABLE,
    timing: {
      state: BUYER_HISTORY_TIMING_STATES.NOT_MATERIALIZED,
      measurable: false,
      metric_meaning: BUYER_HISTORY_METRIC_MEANING,
      after_start_count: UNAVAILABLE,
      early_on_time_count: UNAVAILABLE,
      measured_contract_count: UNAVAILABLE,
      unmeasured_contract_count: UNAVAILABLE,
      after_start_share: UNAVAILABLE,
    },
    cases: [],
    case_total: UNAVAILABLE,
    retry: {
      // The retry reproduces the same request, so the reader does not have to
      // re-choose a buyer, a year, or a narrowed comparison.
      available: true,
      agency: buyerLabel,
      registration_fiscal_year: Number.isInteger(fiscalYear) ? fiscalYear : null,
      scope,
    },
    repair_observation: buyerHistoryRepairObservation({
      reason: trimmed(options.reason) || "source-request-failed",
      registration_fiscal_year: Number.isInteger(fiscalYear) ? fiscalYear : null,
      detail: trimmed(options.detail),
      source_revision: options.source_revision,
      snapshot_date: trimmed(options.snapshot_date),
    }),
  };
}

/**
 * Stable fingerprint for one shape of source defect.
 *
 * The fingerprint deliberately excludes the buyer and the reader's narrowed
 * scope: a projection that carries no dates is one defect in the shared
 * materialization, not one defect per reader who happened to look at it. The
 * existing repair queue groups repeat observations by this signature, so the
 * hundredth reader to hit it advances a repeat count rather than opening a
 * hundredth item.
 */
export function buyerHistoryFingerprint({ reason, registration_fiscal_year } = {}) {
  const year = Number.isInteger(Number(registration_fiscal_year))
    ? `fy${Number(registration_fiscal_year)}` : "all-years";
  return `${BUYER_HISTORY_REPAIR_GUARD}:checkbook:${year}:${trimmed(reason) || "unspecified"}`;
}

const BUYER_HISTORY_REPAIR_MESSAGES = Object.freeze({
  "registration-timing-not-materialized": "The registered-contract projection carries no start "
    + "dates for this fiscal year, so registration timing cannot be measured. The contract count "
    + "itself is unaffected.",
  "source-request-failed": "The registered-contract projection could not be read for this "
    + "buyer history request.",
});

/** Structured observation for the existing repair lineage. One per fingerprint. */
export function buyerHistoryRepairObservation(input = {}) {
  const reason = trimmed(input.reason) || "unspecified";
  const signature = buyerHistoryFingerprint(input);
  const findings = [{
    message: BUYER_HISTORY_REPAIR_MESSAGES[reason]
      || `Buyer contracting history could not be measured: ${reason}.`,
    ...(input.detail ? { detail: trimmed(input.detail) } : {}),
    ...(Number.isFinite(Number(input.contract_count))
      ? { observed_contract_count: Number(input.contract_count) } : {}),
    ...(input.snapshot_date ? { snapshot_date: trimmed(input.snapshot_date) } : {}),
  }];
  return {
    signature,
    guard: BUYER_HISTORY_REPAIR_GUARD,
    stage: "materialization",
    reason,
    findings,
    ...(input.source_revision ? { source_revision: trimmed(input.source_revision) } : {}),
  };
}
