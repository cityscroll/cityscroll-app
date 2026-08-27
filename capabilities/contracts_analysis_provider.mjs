// Transport-neutral provider for the bounded Contracts analytical capability.
// The UI, HTTP, and MCP adapters all use this projection; delivery code does
// not reconstruct grouping, measure, denominator, or coverage semantics.

import {
  CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
  CONTRACTS_ANALYSIS_LIMITS,
  CONTRACTS_ANALYSIS_PROVIDER_ID,
} from "./contracts_analysis.mjs";

const ANALYTICAL_PROJECTION_SCHEMA = "cityscroll.analytical_projection.v1";
const UNKNOWN_DIMENSION_LABEL = "Unknown / not published";
const ANALYTICAL_GROUPS = Object.freeze({
  agency: "agency",
  vendor: "prime_vendor",
  registration_fiscal_year: "registration_fiscal_year",
  amount_band: "contract_amount_band",
});
const ANALYTICAL_MEASURES = Object.freeze({
  count: "unique_contract_count",
  current: "sum_current_registered_amount",
  original: "sum_original_registered_amount",
});
const MEASURE_DEFINITIONS = Object.freeze({
  current: Object.freeze({
    id: "sum_current_registered_amount",
    label: "Current registered contract value",
    reader_label: "Current registered contract value",
    aggregation: "sum",
    source_field: "prime_contract_current_amount",
    unit: "USD",
  }),
  original: Object.freeze({
    id: "sum_original_registered_amount",
    label: "Original registered contract value",
    reader_label: "Original registered contract value",
    aggregation: "sum",
    source_field: "prime_contract_original_amount",
    unit: "USD",
  }),
  count: Object.freeze({
    id: "unique_contract_count",
    label: "Unique registered contracts",
    reader_label: "Contracts",
    aggregation: "count_distinct",
    source_field: "prime_contract_id",
    unit: "contracts",
  }),
});

function readerDimensionValue(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || UNKNOWN_DIMENSION_LABEL;
}

function registrationTimingSummary(rows) {
  const uniqueRows = [...new Map((Array.isArray(rows) ? rows : [])
    .filter((row) => row?.prime_contract_id)
    .map((row) => [row.prime_contract_id, row])).values()];
  const eligibleRows = uniqueRows.filter((row) => row.registration_lag_days != null && Number.isFinite(Number(row.registration_lag_days)));
  const lags = eligibleRows.map((row) => Number(row.registration_lag_days)).sort((a, b) => a - b);
  const nearestRank = (percentile) => lags.length ? lags[Math.max(0, Math.ceil(lags.length * percentile) - 1)] : null;
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
    median_lag_days: nearestRank(0.5),
    p75_lag_days: nearestRank(0.75),
    p90_lag_days: nearestRank(0.9),
    excluded_row_count: missingDateCount,
  };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function filterAnalyticalContracts(rows, filters = {}) {
  const min = filters.min_amount == null || filters.min_amount === "" ? null : Number(filters.min_amount);
  const max = filters.max_amount == null || filters.max_amount === "" ? null : Number(filters.max_amount);
  const fiscalYear = filters.fiscal_year ?? filters.registration_fiscal_year;
  const fy = fiscalYear == null || fiscalYear === "" ? null : Number(fiscalYear);
  const agency = filters.agency == null || filters.agency === "" ? null : String(filters.agency);
  const vendor = filters.prime_vendor == null || filters.prime_vendor === "" ? null : String(filters.prime_vendor);
  const contractId = filters.contract_id == null || filters.contract_id === "" ? null : String(filters.contract_id);
  const amountBand = filters.contract_amount_band || null;
  const retroactive = filters.retroactive == null || filters.retroactive === ""
    ? null : String(filters.retroactive).toLowerCase() === "true";
  const cityRecordMatch = filters.city_record_match || null;
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const current = Number(row?.current_registered_amount);
    if (fy != null && row.registration_fiscal_year !== fy) return false;
    if (agency != null && readerDimensionValue(row.agency) !== agency) return false;
    if (vendor != null && readerDimensionValue(row.prime_vendor) !== vendor) return false;
    if (contractId != null && readerDimensionValue(row.prime_contract_id) !== contractId) return false;
    if (amountBand && readerDimensionValue(row.contract_amount_band) !== amountBand) return false;
    if (retroactive === true && row.registration_timing !== "retroactive") return false;
    if (retroactive === false && row.registration_timing !== "early_on_time") return false;
    if (min != null && (!Number.isFinite(current) || current < min)) return false;
    if (max != null && (!Number.isFinite(current) || current > max)) return false;
    if (cityRecordMatch && row.city_record_match !== cityRecordMatch) return false;
    return true;
  });
}

export function groupAnalyticalContracts(rows, { groupBy = "agency", measure = "current", topN = 10 } = {}) {
  const dimension = ANALYTICAL_GROUPS[groupBy] || groupBy;
  const measureId = ANALYTICAL_MEASURES[measure] || measure;
  if (!Object.values(ANALYTICAL_GROUPS).includes(dimension)) throw new Error(`Unsupported analytical dimension: ${dimension}`);
  if (!Object.values(ANALYTICAL_MEASURES).includes(measureId)) throw new Error(`Unsupported analytical measure: ${measureId}`);
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const label = readerDimensionValue(row?.[dimension]);
    if (!groups.has(label)) groups.set(label, { label, contract_ids: [], rows: [] });
    const group = groups.get(label);
    group.rows.push(row);
    group.contract_ids.push(row.prime_contract_id);
  }
  const result = [...groups.values()].map((group) => {
    const current = group.rows.map((row) => Number(row.current_registered_amount)).filter(Number.isFinite);
    const original = group.rows.map((row) => Number(row.original_registered_amount)).filter(Number.isFinite);
    return {
      label: group.label,
      contract_ids: group.contract_ids,
      contract_count: new Set(group.contract_ids).size,
      sum_current_registered_amount: current.reduce((sum, value) => sum + value, 0),
      sum_original_registered_amount: original.reduce((sum, value) => sum + value, 0),
      median_current_registered_amount: median(current),
      ...registrationTimingSummary(group.rows),
    };
  });
  const valueKey = measureId === "unique_contract_count" ? "contract_count"
    : measureId === "sum_original_registered_amount" ? "sum_original_registered_amount"
      : "sum_current_registered_amount";
  result.sort((a, b) => (Number(b[valueKey]) || 0) - (Number(a[valueKey]) || 0) || a.label.localeCompare(b.label));
  return { groups: result, shown_groups: result.slice(0, Math.max(1, Number(topN) || 10)), value_key: valueKey };
}

function coverageBucket(row) {
  return ["exact", "none", "cannot_evaluate_missing_pin"].includes(row?.city_record_match)
    ? row.city_record_match : "cannot_evaluate_missing_pin";
}

function coverageStats(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const buckets = Object.fromEntries(["exact", "none", "cannot_evaluate_missing_pin"].map((bucket) => [bucket, { contract_count: 0, registered_value: 0 }]));
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

export function cityRecordCoverage(rows, { min_amount = -Number.MAX_VALUE, registration_fiscal_year, contract_amount_band, agency } = {}) {
  const filtered = filterAnalyticalContracts(rows, { min_amount, registration_fiscal_year, contract_amount_band, agency });
  return { ...coverageStats(filtered), rows: filtered };
}

export function analyticalDrillThroughHref({ agency, prime_vendor, registration_fiscal_year, contract_amount_band, min_amount, max_amount, retroactive, city_record_match } = {}) {
  const params = new URLSearchParams({ mode: "award" });
  if (agency) params.set("ap_agency", agency);
  if (prime_vendor) params.set("ap_vendor", prime_vendor);
  if (registration_fiscal_year != null) params.set("ap_fy", String(registration_fiscal_year));
  if (contract_amount_band) params.set("ap_amount_band", contract_amount_band);
  if (min_amount != null && min_amount !== "") params.set("ap_min", String(min_amount));
  if (max_amount != null && max_amount !== "") params.set("ap_max", String(max_amount));
  if (retroactive === true || String(retroactive).toLowerCase() === "true") params.set("retroactive", "true");
  if (city_record_match) params.set("ap_city_record_match", city_record_match);
  return `/browse/contracts/?${params.toString()}`;
}

function analyticalInputFilters(input) {
  return {
    ...(input.agency == null ? {} : { agency: input.agency }),
    ...(input.vendor == null ? {} : { prime_vendor: input.vendor }),
    ...(input.fiscalYear == null ? {} : { registration_fiscal_year: input.fiscalYear }),
    ...(input.amountBand == null ? {} : { contract_amount_band: input.amountBand }),
    ...(input.minAmount == null ? {} : { min_amount: input.minAmount }),
    ...(input.maxAmount == null ? {} : { max_amount: input.maxAmount }),
    ...(input.retroactive == null ? {} : { retroactive: input.retroactive }),
    ...(input.cityRecordMatch == null ? {} : { city_record_match: input.cityRecordMatch }),
  };
}

function publicAnalyticalFilters(input) {
  return {
    group_by: input.groupBy || "agency",
    measure: input.measure || "current",
    ...(input.agency == null ? {} : { agency: input.agency }),
    ...(input.vendor == null ? {} : { vendor: input.vendor }),
    ...(input.fiscalYear == null ? {} : { fiscal_year: input.fiscalYear }),
    ...(input.amountBand == null ? {} : { amount_band: input.amountBand }),
    ...(input.minAmount == null ? {} : { min_amount: input.minAmount }),
    ...(input.maxAmount == null ? {} : { max_amount: input.maxAmount }),
    ...(input.retroactive == null ? {} : { retroactive: input.retroactive }),
    ...(input.cityRecordMatch == null ? {} : { city_record_match: input.cityRecordMatch }),
    limit: input.limit || CONTRACTS_ANALYSIS_LIMITS.defaultGroups,
  };
}

function analyticalGroupFilters(input, groupBy, label) {
  const filters = publicAnalyticalFilters(input);
  delete filters.group_by;
  delete filters.measure;
  delete filters.limit;
  if (groupBy === "agency" && label !== UNKNOWN_DIMENSION_LABEL) filters.agency = label;
  if (groupBy === "vendor" && label !== UNKNOWN_DIMENSION_LABEL) filters.vendor = label;
  if (groupBy === "registration_fiscal_year" && label !== UNKNOWN_DIMENSION_LABEL) filters.fiscal_year = Number(label);
  if (groupBy === "amount_band" && label !== UNKNOWN_DIMENSION_LABEL) filters.amount_band = label;
  return filters;
}

function analyticalMeasure(measure) {
  const definition = MEASURE_DEFINITIONS[measure] || MEASURE_DEFINITIONS.current;
  return {
    key: measure,
    id: definition.id,
    label: definition.label,
    reader_label: definition.reader_label,
    aggregation: definition.aggregation,
    value_field: definition.source_field,
    unit: definition.unit,
    fact: "registered_contract",
    not_payment: true,
  };
}

function analyzeRegisteredContracts(projection, input) {
  if (projection?.schema !== ANALYTICAL_PROJECTION_SCHEMA || !Array.isArray(projection.rows)) {
    throw new Error("registered contract analytical projection is unavailable");
  }
  const filtered = filterAnalyticalContracts(projection.rows, analyticalInputFilters(input));
  const groupBy = input.groupBy || "agency";
  const measure = input.measure || "current";
  const grouped = groupAnalyticalContracts(filtered, { groupBy, measure, topN: input.limit || CONTRACTS_ANALYSIS_LIMITS.defaultGroups });
  const measureView = analyticalMeasure(measure);
  const groups = grouped.shown_groups.map((group) => {
    const value = Number(group[grouped.value_key]) || 0;
    return {
      label: group.label,
      value,
      measure_value: value,
      unit: measureView.unit,
      contract_count: group.contract_count,
      contract_ids: [...group.contract_ids],
      drill_through: {
        href: analyticalDrillThroughHref({
          agency: analyticalGroupFilters(input, groupBy, group.label).agency,
          prime_vendor: analyticalGroupFilters(input, groupBy, group.label).vendor,
          registration_fiscal_year: analyticalGroupFilters(input, groupBy, group.label).fiscal_year,
          contract_amount_band: analyticalGroupFilters(input, groupBy, group.label).amount_band,
          min_amount: input.minAmount,
          max_amount: input.maxAmount,
          retroactive: input.retroactive,
          city_record_match: input.cityRecordMatch,
        }),
        filters: analyticalGroupFilters(input, groupBy, group.label),
      },
    };
  });
  const denominatorValue = grouped.groups.reduce((sum, group) => sum + (Number(group[grouped.value_key]) || 0), 0);
  const denominatorContractCount = new Set(filtered.map((row) => row.prime_contract_id)).size;
  const denominatorValueCount = filtered.filter((row) => {
    const field = measure === "original" ? "original_registered_amount" : "current_registered_amount";
    return measure === "count" || Number.isFinite(Number(row[field]));
  }).length;
  const coverage = cityRecordCoverage(filtered);
  const sourcePopulation = projection.source_population || {};
  const selectedDescription = denominatorContractCount
    ? `${denominatorContractCount.toLocaleString("en-US")} exact registered-contract rows after the requested filters`
    : "No exact registered-contract rows after the requested filters";
  return {
    capability_reference: CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
    availability: groups.length ? "complete" : "empty",
    group_by: groupBy,
    measure: measureView,
    groups,
    denominator: {
      value: denominatorValue,
      unit: measureView.unit,
      contract_count: denominatorContractCount,
      value_count: denominatorValueCount,
      definition: `Selected filtered registered-contract population; ${measureView.reader_label} is not payments or agency spending.`,
    },
    population: {
      fact: "registered_contract",
      basis: projection.population_definition || "Normalized Checkbook NYC registered expense contracts",
      included: selectedDescription,
      excluded: [
        "AP-08 payment transactions and actual payment amounts",
        "contracts outside the committed analytical projection",
        ...(denominatorValueCount < denominatorContractCount ? [`${denominatorContractCount - denominatorValueCount} rows without a numeric value for this measure`] : []),
      ],
      contract_count: denominatorContractCount,
      source_population: sourcePopulation,
      snapshot_date: projection.snapshot_date || null,
    },
    coverage: {
      statement: `City Record exact-PIN match coverage for the selected registered-contract population: ${coverage.matched_contract_count.toLocaleString("en-US")} of ${coverage.eligible_contract_count.toLocaleString("en-US")} eligible contracts; rows without a published PIN cannot be evaluated.`,
      basis: "existing exact normalized Checkbook PIN ↔ City Record award PIN overlap",
      eligible_contract_count: coverage.eligible_contract_count,
      matched_contract_count: coverage.matched_contract_count,
      unmatched_contract_count: coverage.unmatched_contract_count,
      missing_pin_contract_count: coverage.missing_pin_contract_count,
      eligible_registered_value: coverage.eligible_registered_value,
      matched_registered_value: coverage.matched_registered_value,
      buckets: coverage.buckets,
    },
    filters: publicAnalyticalFilters(input),
    freshness: {
      as_of: projection.generated_at || projection.snapshot_date || "unknown",
      generated_at: projection.generated_at || null,
      snapshot_date: projection.snapshot_date || null,
      source: "committed site/data/analytics_registered_contracts.json",
    },
    error: null,
  };
}

export function createContractsAnalysisProvider(projection) {
  return Object.freeze({
    capabilityReference: CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
    providerId: CONTRACTS_ANALYSIS_PROVIDER_ID,
    async execute(input) {
      return analyzeRegisteredContracts(projection, input);
    },
  });
}
