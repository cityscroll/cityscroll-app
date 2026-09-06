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
import { resolveAgencyIdentity } from "./agency_identity.mjs";

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

/** Selection query keys. These never filter the counted cohort. */
export const BUYER_HISTORY_CASES_QUERY_KEY = "ap_cases";
export const BUYER_HISTORY_INSPECT_QUERY_KEY = "ap_inspect";

/** Retained exact-ID Checkbook/PASSPort start-date conflicts from the preflight. */
export const CHECKBOOK_PASSPORT_DATE_CONFLICT_IDS = Object.freeze([
  "CT182620278801514",
  "CT182620268808879",
  "CT182620268808015",
]);

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
 * Notice and Checkbook spellings of the same public institution count as one
 * buyer. An unmatched label still matches only itself, so it cannot become a
 * clean zero by being compared to a different institution's rows.
 */
export function buyerAgenciesMatch(rowAgency, selectedAgency) {
  if (selectedAgency == null || selectedAgency === "") return true;
  const selected = readerDimensionValue(selectedAgency);
  const row = readerDimensionValue(rowAgency);
  if (row === selected) return true;
  const left = resolveAgencyIdentity(rowAgency);
  const right = resolveAgencyIdentity(selectedAgency);
  return Boolean(left.matched && right.matched && left.canonical_id === right.canonical_id);
}

function sourceOwnedBuyerLabel(rows, selectedAgency) {
  const counts = new Map();
  for (const row of rows) {
    if (!buyerAgenciesMatch(row?.agency, selectedAgency)) continue;
    const label = trimmed(row.agency);
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]
    || selectedAgency;
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
    pin: row.pin || UNAVAILABLE,
    // Conflicting slice observations stay visible rather than being coalesced.
    date_observations: row.date_ownership || null,
    exact_destinations: Array.isArray(row.exact_destinations) ? row.exact_destinations.map(normalizeDestination).filter(Boolean) : [],
  };
}

function publicHref(value) {
  const href = trimmed(value);
  if (!href) return null;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  if (/^https:\/\//i.test(href)) return href;
  return null;
}

function normalizeDestination(entry) {
  if (!entry || typeof entry !== "object") return null;
  const href = publicHref(entry.href);
  if (!href) return null;
  const kind = trimmed(entry.kind) === "notice" ? "notice" : "procurement";
  return {
    href,
    kind,
    basis: trimmed(entry.basis) || "exact_contract_id",
    label: trimmed(entry.label),
  };
}

function destinationKey(destination) {
  return `${destination.kind}:${destination.href}`;
}

function exactContractId(value) {
  const key = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return key || null;
}

/**
 * Exact procurement/notice destinations for one counted contract.
 *
 * Only an exact contract-id match may contribute a destination. A shared PIN
 * is a procurement-family relationship: it may be classified elsewhere, but it
 * never becomes this contract's detail URL and never copies dates.
 */
export function exactCountedContractDestinations(caseRecord, candidates = []) {
  const contractId = trimmed(caseRecord?.source_contract_id);
  if (!contractId) return [];
  const found = [];
  const seen = new Set();
  const add = (destination) => {
    const normalized = normalizeDestination(destination);
    if (!normalized || normalized.basis !== "exact_contract_id") return;
    const key = destinationKey(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    found.push(normalized);
  };
  for (const destination of caseRecord?.exact_destinations || []) add(destination);
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate) continue;
    const candidateId = candidate.contract_id || candidate.prime_contract_id
      || candidate.source_contract_id || candidate.id
      || candidate.identity_keys?.contract_ids?.[0];
    const basis = exactContractId(contractId) && exactContractId(contractId) === exactContractId(candidateId)
      ? "exact_contract_id"
      : null;
    if (basis !== "exact_contract_id") continue;
    add({ href: candidate.canonical_href || candidate.compatibility?.canonical_href, kind: "procurement", basis });
    for (const href of [
      ...(Array.isArray(candidate.city_record_notice_hrefs) ? candidate.city_record_notice_hrefs : []),
      ...(Array.isArray(candidate.compatibility?.city_record_notice_hrefs)
        ? candidate.compatibility.city_record_notice_hrefs : []),
    ]) {
      add({ href, kind: "notice", basis });
    }
    if (candidate.request_id && publicHref(`/notices/${candidate.request_id}`)) {
      add({ href: `/notices/${candidate.request_id}`, kind: "notice", basis });
    }
    if (candidate.href) {
      add({
        href: candidate.href,
        kind: trimmed(candidate.kind) === "notice" || /\/notices\//.test(String(candidate.href)) ? "notice" : "procurement",
        basis,
      });
    }
  }
  return found;
}

export function withBuyerHistoryCases(href) {
  const text = String(href || "");
  const [path, query] = text.split("?", 2);
  const params = new URLSearchParams(query || "");
  params.set(BUYER_HISTORY_CASES_QUERY_KEY, "1");
  return `${path}?${params.toString()}`;
}

export function buyerHistoryInspectHref(cohortHref, contractId) {
  const id = trimmed(contractId);
  if (!id) return withBuyerHistoryCases(cohortHref);
  const text = String(cohortHref || "");
  const [path, query] = text.split("?", 2);
  const params = new URLSearchParams(query || "");
  params.set(BUYER_HISTORY_CASES_QUERY_KEY, "1");
  params.set(BUYER_HISTORY_INSPECT_QUERY_KEY, id);
  return `${path}?${params.toString()}`;
}

export function buyerHistoryDismissInspectHref(href) {
  const text = String(href || "");
  const [path, query] = text.split("?", 2);
  const params = new URLSearchParams(query || "");
  params.delete(BUYER_HISTORY_INSPECT_QUERY_KEY);
  const next = params.toString();
  return next ? `${path}?${next}` : path;
}

/**
 * The opened case list is a view of the already-counted cohort. Retroactive
 * listing narrows which rows are shown; it does not change the denominator.
 */
export function openedBuyerHistoryCases(history, { retroactive } = {}) {
  const cases = Array.isArray(history?.cases) ? history.cases : [];
  if (retroactive === true || String(retroactive).toLowerCase() === "true") {
    return cases.filter((entry) => entry.registration_timing === "registered_after_start");
  }
  return cases;
}

export function inspectBuyerHistoryCaseFailure(options = {}) {
  const sourceContractId = trimmed(options.source_contract_id);
  const buyerLabel = trimmed(options.agency);
  const fiscalYear = options.registration_fiscal_year == null || options.registration_fiscal_year === ""
    ? null : Number(options.registration_fiscal_year);
  const scope = selectedScope(options);
  return {
    schema: BUYER_CONTRACTING_HISTORY_SCHEMA,
    state: "unavailable",
    source_contract_id: sourceContractId,
    buyer: {
      label: buyerLabel,
      display_label: buyerLabel ? readerDimensionValue(buyerLabel) : null,
    },
    registration_fiscal_year: Number.isInteger(fiscalYear) ? fiscalYear : null,
    scope,
    destinations: [],
    case: null,
    retry: {
      available: true,
      source_contract_id: sourceContractId,
      agency: buyerLabel,
      registration_fiscal_year: Number.isInteger(fiscalYear) ? fiscalYear : null,
      scope,
    },
    repair_observation: buyerHistoryRepairObservation({
      reason: trimmed(options.reason) || "requested-case-unavailable",
      registration_fiscal_year: Number.isInteger(fiscalYear) ? fiscalYear : null,
      source_contract_id: sourceContractId,
      detail: trimmed(options.detail),
    }),
  };
}

/**
 * Open one counted Checkbook case without changing the cohort it came from.
 * Optional destination lookup may fail while the source case stays readable.
 */
export function inspectBuyerHistoryCase(history, contractId, options = {}) {
  const requestedId = trimmed(contractId);
  if (!requestedId) return { state: "idle", source_contract_id: null, case: null, destinations: [] };
  if (!history || history.state !== "available") {
    return inspectBuyerHistoryCaseFailure({
      ...options,
      source_contract_id: requestedId,
      agency: history?.buyer?.label || options.agency,
      registration_fiscal_year: history?.registration_fiscal_year ?? options.registration_fiscal_year,
      reason: "source-request-failed",
    });
  }
  const record = (history.cases || []).find((entry) => entry.source_contract_id === requestedId);
  if (!record) {
    return inspectBuyerHistoryCaseFailure({
      ...options,
      source_contract_id: requestedId,
      agency: history.buyer?.label,
      registration_fiscal_year: history.registration_fiscal_year,
      reason: "requested-case-unavailable",
    });
  }
  let destinations = record.exact_destinations || [];
  try {
    destinations = exactCountedContractDestinations(record, options.candidates);
  } catch {
    destinations = record.exact_destinations || [];
  }
  return {
    schema: BUYER_CONTRACTING_HISTORY_SCHEMA,
    state: "available",
    source_contract_id: requestedId,
    case: record,
    destinations,
    cohort: {
      contract_count: history.contract_count,
      after_start_count: history.timing?.after_start_count ?? null,
      early_on_time_count: history.timing?.early_on_time_count ?? null,
    },
    repair_observation: sourceDateConflictRepairObservation(record, options.source_conflicts),
  };
}

export function countedContractsAreDistinctInstruments(left, right) {
  const leftId = trimmed(left?.source_contract_id || left?.prime_contract_id || left?.contract_id);
  const rightId = trimmed(right?.source_contract_id || right?.prime_contract_id || right?.contract_id);
  return Boolean(leftId && rightId && leftId !== rightId);
}

export function sourceDateConflictRepairObservation(record, conflicts = []) {
  const contractId = trimmed(record?.source_contract_id);
  const listed = Array.isArray(conflicts) ? conflicts : [];
  const match = listed.find((entry) => trimmed(entry?.id || entry?.source_contract_id) === contractId)
    || (CHECKBOOK_PASSPORT_DATE_CONFLICT_IDS.includes(contractId) ? { id: contractId } : null);
  if (!match) return null;
  const observations = Array.isArray(match.date_sources) ? match.date_sources.map(trimmed).filter(Boolean) : [];
  return buyerHistoryRepairObservation({
    reason: "source-date-conflict",
    source_contract_id: contractId,
    detail: observations.length
      ? `Checkbook and PASSPort publish different start dates for ${contractId}: ${observations.join(", ")}.`
      : `Checkbook and PASSPort publish conflicting dates for ${contractId}.`,
  });
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
    registration_fiscal_year: Number.isInteger(fiscalYear) ? fiscalYear : null,
    industry: scope.industry,
    award_method: scope.award_method,
    contract_amount_band: scope.contract_amount_band,
    min_amount: scope.min_amount,
    max_amount: scope.max_amount,
  };
  // Agency identity is applied after the other filters so a notice spelling
  // and a Checkbook spelling of the same buyer share one denominator, while
  // industry, method, and amount still intersect the full registered cohort
  // before any case limit.
  const matched = filterAnalyticalContracts(Array.isArray(rows) ? rows : [], filters)
    .filter((row) => buyerAgenciesMatch(row.agency, buyerLabel));
  // The denominator is the deduplicated population, taken before any case
  // limit. registrationTimingSummary already collapses to one row per exact
  // contract id, so ten source slices of one contract count once.
  const summary = registrationTimingSummary(matched);
  const unique = [...new Map(matched
    .filter((row) => row?.prime_contract_id)
    .map((row) => [row.prime_contract_id, row])).values()];
  const sourceBuyerLabel = sourceOwnedBuyerLabel(unique, buyerLabel);
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
    agency: sourceBuyerLabel,
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
      label: sourceBuyerLabel,
      selected_label: buyerLabel,
      display_label: sourceBuyerLabel ? readerDimensionValue(sourceBuyerLabel) : null,
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
    all_cases_href: withBuyerHistoryCases(hrefFor(false)),
    after_start_cases_href: measured ? withBuyerHistoryCases(hrefFor(true)) : null,
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
export function buyerHistoryFingerprint({ reason, registration_fiscal_year, source_contract_id } = {}) {
  const year = Number.isInteger(Number(registration_fiscal_year))
    ? `fy${Number(registration_fiscal_year)}` : "all-years";
  const code = trimmed(reason) || "unspecified";
  const contract = trimmed(source_contract_id);
  if ((code === "source-date-conflict" || code === "requested-case-unavailable") && contract) {
    return `${BUYER_HISTORY_REPAIR_GUARD}:checkbook:${year}:${code}:${contract}`;
  }
  return `${BUYER_HISTORY_REPAIR_GUARD}:checkbook:${year}:${code}`;
}

const BUYER_HISTORY_REPAIR_MESSAGES = Object.freeze({
  "registration-timing-not-materialized": "The registered-contract projection carries no start "
    + "dates for this fiscal year, so registration timing cannot be measured. The contract count "
    + "itself is unaffected.",
  "source-request-failed": "The registered-contract projection could not be read for this "
    + "buyer history request.",
  "requested-case-unavailable": "A requested registered-contract case could not be opened from "
    + "the counted Checkbook population.",
  "source-date-conflict": "Checkbook and PASSPort publish different dates for the same exact "
    + "contract id. Both observations are retained; neither overwrites the other.",
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
