import {
  ANALYTICAL_PROJECTION_SCHEMA,
  REGISTERED_CONTRACT_PROJECTION,
  UNKNOWN_DIMENSION_LABEL,
  readerDimensionValue,
} from "./analytical_projection_contract.mjs";
import {
  analyticalDrillThroughHref as capabilityAnalyticalDrillThroughHref,
  cityRecordCoverage as capabilityCityRecordCoverage,
  filterAnalyticalContracts as capabilityFilterAnalyticalContracts,
  groupAnalyticalContracts as capabilityGroupAnalyticalContracts,
} from "../capabilities/contracts_analysis_provider.mjs";

export const ANALYTICAL_PROJECTION_URL = "data/analytics_registered_contracts.json";
export const ANALYTICAL_GROUPS = Object.freeze({
  agency: "agency",
  vendor: "prime_vendor",
  registration_fiscal_year: "registration_fiscal_year",
  amount_band: "contract_amount_band",
});
export const ANALYTICAL_PROJECTION_QUERY_KEYS = Object.freeze([
  "ap_fact", "ap_payment_view", "ap_agency", "ap_vendor", "ap_fy", "ap_amount_band", "ap_min", "ap_max",
  "retroactive", "ap_city_record_match", "ap_contract_id",
]);
export const ANALYTICAL_MEASURES = Object.freeze({
  count: "unique_contract_count",
  current: "sum_current_registered_amount",
  original: "sum_original_registered_amount",
});
export const ANALYTICAL_VALUE_MEASURES = Object.freeze({
  current: "current_registered_amount",
  original: "original_registered_amount",
});
export const CITY_RECORD_MATCHES = Object.freeze({
  exact: "exact",
  none: "none",
  missingPin: "cannot_evaluate_missing_pin",
});
export const CITY_RECORD_COVERAGE_DEFAULT_THRESHOLD = 100000;

/** Preserve analytical drill-through parameters while a document URL crosses the shared scope hash. */
export function preserveAnalyticalProjectionQuery(source, target) {
  const sourceParams = new URLSearchParams(String(source || "").split("?", 2)[1] || "");
  const targetParts = String(target || "").split("?", 2);
  const targetParams = new URLSearchParams(targetParts[1] || "");
  if (targetParts[0].replace(/^#/, "") !== "money") return target;
  for (const key of ANALYTICAL_PROJECTION_QUERY_KEYS) {
    if (sourceParams.has(key)) targetParams.set(key, sourceParams.get(key));
  }
  const query = targetParams.toString();
  return `${targetParts[0]}${query ? `?${query}` : ""}`;
}

export function registrationFiscalYear(value) {
  const match = String(value || "").slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return year + (month >= 7 ? 1 : 0);
}

export function contractAmountBand(value) {
  if (value == null || String(value).trim() === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  if (amount < 100_000) return "Under $100,000";
  if (amount < 1_000_000) return "$100,000–$999,999";
  if (amount < 10_000_000) return "$1 million–$9.99 million";
  return "$10 million or more";
}

export function normalizeAnalyticalContractRow(row) {
  const contractId = String(row?.prime_contract_id || row?.contract_id || row?.id || "").trim();
  if (!contractId) return null;
  const registeredDate = row?.registered || row?.registration_date || null;
  const startDate = row?.start || row?.start_date || null;
  const current = Number(row?.current ?? row?.current_amount ?? row?.current_registered_amount);
  const original = Number(row?.original ?? row?.original_amount ?? row?.original_registered_amount);
  const registrationFiscalYearValue = row?.registration_fiscal_year
    ?? registrationFiscalYear(registeredDate);
  // Recompute from the two published dates so a stale or hand-authored lag
  // can never turn a missing-date row into an eligible observation.
  const registrationLagDays = registrationLagDaysBetween(registeredDate, startDate);
  const hasRegistrationLag = Number.isFinite(registrationLagDays);
  return {
    prime_contract_id: contractId,
    agency: row?.agency || null,
    prime_vendor: row?.prime_vendor || row?.vendor || null,
    pin: row?.pin || row?.prime_contract_pin || null,
    registration_date: registeredDate || null,
    start_date: startDate || null,
    registration_fiscal_year: Number.isInteger(Number(registrationFiscalYearValue))
      ? Number(registrationFiscalYearValue) : null,
    contract_amount_band: row?.contract_amount_band || contractAmountBand(current),
    award_method: row?.award_method || row?.awardMethod || null,
    registration_lag_days: hasRegistrationLag ? registrationLagDays : null,
    registration_timing: row?.registration_timing
      || (hasRegistrationLag
        ? Number(registrationLagDays) > 0 ? "retroactive" : "early_on_time"
        : null),
    current_registered_amount: Number.isFinite(current) ? current : null,
    original_registered_amount: Number.isFinite(original) ? original : null,
    source_fiscal_years: Array.isArray(row?.source_fiscal_years) ? [...row.source_fiscal_years] : [],
    source: "checkbook-contracts",
    ...(row?.city_record_match ? { city_record_match: row.city_record_match } : {}),
  };
}

function dateOnly(value) {
  const match = String(value || "").slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return timestamp;
}

export function registrationLagDaysBetween(registrationDate, startDate) {
  const registration = dateOnly(registrationDate);
  const start = dateOnly(startDate);
  if (registration == null || start == null) return null;
  return Math.round((registration - start) / 86_400_000);
}

export function filterAnalyticalContracts(rows, filters = {}) {
  return capabilityFilterAnalyticalContracts(rows, filters);
}

function nearestRank(values, percentile) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)];
}

export function registrationTimingSummary(rows) {
  const uniqueRows = [...new Map((Array.isArray(rows) ? rows : [])
    .filter((row) => row?.prime_contract_id)
    .map((row) => [row.prime_contract_id, row])).values()];
  const eligibleRows = uniqueRows.filter((row) => row.registration_lag_days != null && Number.isFinite(Number(row.registration_lag_days)));
  const lags = eligibleRows.map((row) => Number(row.registration_lag_days));
  const retroactiveCount = lags.filter((lag) => lag > 0).length;
  const missingDateCount = uniqueRows.length - eligibleRows.length;
  return {
    total_contract_count: uniqueRows.length,
    eligible_contract_count: eligibleRows.length,
    missing_date_contract_count: missingDateCount,
    retroactive_contract_count: retroactiveCount,
    early_on_time_contract_count: lags.filter((lag) => lag <= 0).length,
    retroactive_share: eligibleRows.length ? retroactiveCount / eligibleRows.length : null,
    missing_date_share: uniqueRows.length ? missingDateCount / uniqueRows.length : null,
    median_lag_days: nearestRank(lags, 0.5),
    p75_lag_days: nearestRank(lags, 0.75),
    p90_lag_days: nearestRank(lags, 0.9),
    excluded_row_count: missingDateCount,
  };
}

export function groupAnalyticalContracts(rows, { groupBy = "agency", measure = "current", topN = 10 } = {}) {
  return capabilityGroupAnalyticalContracts(rows, { groupBy, measure, topN });
}

function uniqueAnalyticalRows(rows) {
  const unique = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.prime_contract_id || "").trim();
    if (id && !unique.has(id)) unique.set(id, row);
  }
  return [...unique.values()];
}

function shareOf(value, denominator) {
  return denominator > 0 ? value / denominator : 0;
}

/**
 * Calculate an auditable agency → prime-vendor concentration view.
 * The denominator is always the explicit selected-scope value total, including
 * unclassified vendor rows; top-N shares rank named vendors only.
 */
export function vendorConcentration(rows, { measure = "current", topN = 10 } = {}) {
  const valueField = ANALYTICAL_VALUE_MEASURES[measure] || measure;
  if (!Object.values(ANALYTICAL_VALUE_MEASURES).includes(valueField)) {
    throw new Error(`Unsupported vendor concentration measure: ${measure}`);
  }
  const uniqueRows = uniqueAnalyticalRows(rows);
  const groups = new Map();
  let excludedValueCount = 0;
  for (const row of uniqueRows) {
    const value = Number(row?.[valueField]);
    if (!Number.isFinite(value)) {
      excludedValueCount += 1;
      continue;
    }
    const label = readerDimensionValue(row?.prime_vendor);
    if (!groups.has(label)) groups.set(label, {
      label,
      vendor_name: label === UNKNOWN_DIMENSION_LABEL ? null : label,
      contract_ids: [],
      registered_value: 0,
    });
    const group = groups.get(label);
    group.registered_value += value;
    group.contract_ids.push(row.prime_contract_id);
  }
  const denominator = [...groups.values()].reduce((sum, group) => sum + group.registered_value, 0);
  const unclassified = groups.get(UNKNOWN_DIMENSION_LABEL) || {
    label: UNKNOWN_DIMENSION_LABEL,
    vendor_name: null,
    contract_ids: [],
    registered_value: 0,
  };
  const named = [...groups.values()]
    .filter((group) => group.label !== UNKNOWN_DIMENSION_LABEL)
    .sort((left, right) => right.registered_value - left.registered_value
      || left.label.localeCompare(right.label));
  const vendors = named.concat(unclassified.registered_value || unclassified.contract_ids.length ? [unclassified] : [])
    .map((group, index) => ({
      label: group.label,
      vendor_name: group.vendor_name,
      contract_ids: [...group.contract_ids],
      contract_count: new Set(group.contract_ids).size,
      registered_value: group.registered_value,
      share: shareOf(group.registered_value, denominator),
      rank: group.label === UNKNOWN_DIMENSION_LABEL ? null : index + 1,
      unclassified: group.label === UNKNOWN_DIMENSION_LABEL,
    }));
  const namedValue = (count) => named.slice(0, count).reduce((sum, group) => sum + group.registered_value, 0);
  return {
    measure,
    value_field: valueField,
    vendors,
    denominator,
    denominator_contract_count: uniqueRows.length,
    denominator_value_count: uniqueRows.length - excludedValueCount,
    excluded_value_count: excludedValueCount,
    unclassified_value: unclassified.registered_value,
    unclassified_share: shareOf(unclassified.registered_value, denominator),
    top_5_value: namedValue(5),
    top_5_share: shareOf(namedValue(5), denominator),
    top_10_value: namedValue(10),
    top_10_share: shareOf(namedValue(10), denominator),
  };
}

export function populationSummary(rows, { snapshot_date, population_definition } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const current = list.map((row) => Number(row.current_registered_amount)).filter(Number.isFinite);
  const years = list.map((row) => Number(row.registration_fiscal_year)).filter(Number.isInteger);
  const yearLabel = years.length ? `registration FY${Math.min(...years)}–FY${Math.max(...years)}` : "registration fiscal year unavailable";
  return {
    contract_count: new Set(list.map((row) => row.prime_contract_id)).size,
    current_registered_value: current.reduce((sum, value) => sum + value, 0),
    year_label: yearLabel,
    snapshot_date: snapshot_date || null,
    population_definition: population_definition || REGISTERED_CONTRACT_PROJECTION.source.population_basis,
  };
}

export function analyticalDrillThroughHref({ agency, prime_vendor, registration_fiscal_year, contract_amount_band, min_amount, max_amount, retroactive, city_record_match } = {}) {
  return capabilityAnalyticalDrillThroughHref({ agency, prime_vendor, registration_fiscal_year, contract_amount_band, min_amount, max_amount, retroactive, city_record_match });
}

function coverageBucket(row) {
  return Object.values(CITY_RECORD_MATCHES).includes(row?.city_record_match)
    ? row.city_record_match
    : CITY_RECORD_MATCHES.missingPin;
}

function coverageStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const buckets = Object.fromEntries(Object.values(CITY_RECORD_MATCHES).map((bucket) => [bucket, {
    contract_count: 0,
    registered_value: 0,
  }]));
  for (const row of list) {
    const bucket = buckets[coverageBucket(row)];
    bucket.contract_count += 1;
    bucket.registered_value += Number(row?.current_registered_amount) || 0;
  }
  const matched = buckets.exact.contract_count;
  const evaluable = matched + buckets.none.contract_count;
  return {
    eligible_contract_count: list.length,
    eligible_registered_value: list.reduce((sum, row) => sum + (Number(row?.current_registered_amount) || 0), 0),
    matched_contract_count: matched,
    matched_registered_value: buckets.exact.registered_value,
    unmatched_contract_count: buckets.none.contract_count,
    unmatched_registered_value: buckets.none.registered_value,
    missing_pin_contract_count: buckets.cannot_evaluate_missing_pin.contract_count,
    missing_pin_registered_value: buckets.cannot_evaluate_missing_pin.registered_value,
    match_rate: list.length ? matched / list.length : null,
    evaluable_match_rate: evaluable ? matched / evaluable : null,
    buckets,
  };
}

export function cityRecordCoverage(rows, { min_amount = CITY_RECORD_COVERAGE_DEFAULT_THRESHOLD, registration_fiscal_year, contract_amount_band, agency } = {}) {
  return capabilityCityRecordCoverage(rows, { min_amount, registration_fiscal_year, contract_amount_band, agency });
}

export function groupCityRecordCoverage(rows, { groupBy = "agency", min_amount = CITY_RECORD_COVERAGE_DEFAULT_THRESHOLD, registration_fiscal_year, contract_amount_band, agency } = {}) {
  const filtered = cityRecordCoverage(rows, { min_amount, registration_fiscal_year, contract_amount_band, agency }).rows;
  const dimension = ANALYTICAL_GROUPS[groupBy] || groupBy;
  const groups = new Map();
  for (const row of filtered) {
    const label = readerDimensionValue(row?.[dimension]);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(row);
  }
  const result = [...groups.entries()].map(([label, groupRows]) => ({
    label,
    ...coverageStats(groupRows),
  }));
  result.sort((a, b) => b.eligible_registered_value - a.eligible_registered_value || a.label.localeCompare(b.label));
  return { groups: result, rows: filtered };
}

export function formatRegisteredValue(value) {
  return `$${Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function analyticalReaderLabel(measure = "current") {
  const id = ANALYTICAL_MEASURES[measure] || measure;
  return REGISTERED_CONTRACT_PROJECTION.measures[id]?.reader_label || "Registered contract measure";
}

export const CHECKBOOK_DIMENSION_PROFILE_FIELDS = Object.freeze([
  { id: "agency", source_tag: "prime_contracting_agency", field: "agency", usefulness: "required by AP-04" },
  { id: "prime_vendor", source_tag: "prime_vendor", field: "prime_vendor", usefulness: "required by AP-04" },
  { id: "registration_fiscal_year", source_tag: "prime_contract_registration_date", field: "registration_fiscal_year", usefulness: "required by AP-04; derived" },
  { id: "contract_amount_band", source_tag: "prime_contract_current_amount", field: "contract_amount_band", usefulness: "required by AP-04; derived" },
  { id: "award_method", source_tag: "prime_contract_award_method", field: "award_method", usefulness: "retained when published" },
  { id: "mwbe_category", source_tag: "prime_vendor_mwbe_category", field: "mwbe_category", usefulness: "deferred reader control" },
  { id: "duration", source_tag: "prime_contract_duration|prime_contract_term", field: "duration", usefulness: "deferred reader control" },
  { id: "includes_subvendors", source_tag: "contract_includes_sub_vendors", field: "includes_subvendors", usefulness: "deferred reader control" },
]);

export function profileDimension(rows, field) {
  const values = (Array.isArray(rows) ? rows : []).map((row) => readerDimensionValue(row?.[field]));
  const unknown = values.filter((value) => value === UNKNOWN_DIMENSION_LABEL).length;
  const counts = new Map();
  for (const value of values) {
    if (value === UNKNOWN_DIMENSION_LABEL) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const top_values = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([value, count]) => ({ value, count }));
  return {
    field,
    row_count: values.length,
    distinct_count: counts.size,
    null_count: unknown,
    null_rate: values.length ? unknown / values.length : null,
    top_values,
  };
}
