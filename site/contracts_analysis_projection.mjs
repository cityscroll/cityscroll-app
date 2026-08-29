// Shared registered-contract analytical projection used by the static UI and
// the Worker provider. Payments deliberately stay outside this capability.

import {
  CONTRACTS_ANALYSIS_AVAILABILITY,
  CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
  CONTRACTS_ANALYSIS_LIMITS,
  executeContractsAnalysis,
} from "../capabilities/contracts_analysis.mjs";
import {
  ANALYTICAL_MEASURES,
  analyticalDrillThroughHref,
  cityRecordCoverage,
  filterAnalyticalContracts,
  groupAnalyticalContracts,
} from "./analytical_projection.mjs";
import {
  ANALYTICAL_PROJECTION_SCHEMA,
  REGISTERED_CONTRACT_PROJECTION,
} from "./analytical_projection_contract.mjs";

function analyticalFilters(input) {
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

function publicFilters(input) {
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

function measureView(measure) {
  const id = ANALYTICAL_MEASURES[measure];
  const definition = REGISTERED_CONTRACT_PROJECTION.measures[id];
  return {
    key: measure,
    id,
    label: definition.label,
    reader_label: definition.reader_label,
    aggregation: definition.aggregation,
    value_field: definition.source_field,
    unit: measure === "count" ? "contracts" : "USD",
    fact: "registered_contract",
    not_payment: true,
  };
}

function groupFilters(input, groupBy, label) {
  const filters = publicFilters(input);
  delete filters.group_by;
  delete filters.measure;
  delete filters.limit;
  if (groupBy === "agency" && label !== "Unknown / not published") filters.agency = label;
  if (groupBy === "vendor" && label !== "Unknown / not published") filters.vendor = label;
  if (groupBy === "registration_fiscal_year" && label !== "Unknown / not published") filters.fiscal_year = Number(label);
  if (groupBy === "amount_band" && label !== "Unknown / not published") filters.amount_band = label;
  return filters;
}

function groupHref(input, groupBy, label) {
  const filters = groupFilters(input, groupBy, label);
  return analyticalDrillThroughHref({
    agency: filters.agency,
    prime_vendor: filters.vendor,
    registration_fiscal_year: filters.fiscal_year,
    contract_amount_band: filters.amount_band,
    min_amount: filters.min_amount,
    max_amount: filters.max_amount,
    retroactive: filters.retroactive,
    city_record_match: filters.city_record_match,
  });
}

/** Build and validate the exact registered-contract capability envelope. */
export function analyzeContractsProjection(projection, input = {}) {
  const rows = Array.isArray(projection?.rows) ? projection.rows : null;
  if (!rows || !["cityscroll.analytics_registered_contracts.v1", ANALYTICAL_PROJECTION_SCHEMA].includes(projection?.schema)) throw new Error("registered contract analytical projection is unavailable");
  const groupBy = input.groupBy || "agency";
  const measure = input.measure || "current";
  const filtered = filterAnalyticalContracts(rows, analyticalFilters(input));
  const grouped = groupAnalyticalContracts(filtered, { groupBy, measure, topN: input.limit || CONTRACTS_ANALYSIS_LIMITS.defaultGroups });
  const view = measureView(measure);
  const groups = grouped.shown_groups.map((group) => {
    const value = Number(group[grouped.value_key]) || 0;
    return {
      label: group.label,
      value,
      measure_value: value,
      unit: view.unit,
      contract_count: group.contract_count,
      contract_ids: [...group.contract_ids],
      drill_through: { href: groupHref(input, groupBy, group.label), filters: groupFilters(input, groupBy, group.label) },
    };
  });
  const denominatorValue = grouped.groups.reduce((sum, group) => sum + (Number(group[grouped.value_key]) || 0), 0);
  const denominatorContractCount = new Set(filtered.map((row) => row.prime_contract_id)).size;
  const denominatorValueCount = filtered.filter((row) => {
    const field = measure === "original" ? "original_registered_amount" : "current_registered_amount";
    return measure === "count" || Number.isFinite(Number(row[field]));
  }).length;
  const coverage = cityRecordCoverage(filtered, { min_amount: -Number.MAX_VALUE });
  const selectedDescription = denominatorContractCount
    ? `${denominatorContractCount.toLocaleString("en-US")} exact registered-contract rows after the requested filters`
    : "No exact registered-contract rows after the requested filters";
  return executeContractsAnalysis({
    capabilityReference: CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
    providerId: "worker-static.procurement-contracts.analysis",
    execute: async () => ({
      capability_reference: CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
      availability: groups.length ? CONTRACTS_ANALYSIS_AVAILABILITY[0] : CONTRACTS_ANALYSIS_AVAILABILITY[1],
      group_by: groupBy,
      measure: view,
      groups,
      denominator: {
        value: denominatorValue,
        unit: view.unit,
        contract_count: denominatorContractCount,
        value_count: denominatorValueCount,
        definition: `Selected filtered registered-contract population; ${view.reader_label} is not payments or agency spending.`,
      },
      population: {
        fact: "registered_contract",
        basis: projection.population_definition || "Normalized Checkbook NYC registered expense contracts",
        included: selectedDescription,
        excluded: ["AP-08 payment transactions and actual payment amounts", "contracts outside the committed analytical projection"],
        contract_count: denominatorContractCount,
        source_population: projection.source_population || {},
        snapshot_date: projection.snapshot_date || null,
      },
      coverage: {
        statement: `CityScroll found an exact City Record notice for ${coverage.matched_contract_count.toLocaleString("en-US")} of ${coverage.eligible_contract_count.toLocaleString("en-US")} eligible registered contracts; contracts without a PIN cannot be evaluated and stay a separate count.`,
        basis: "existing exact normalized Checkbook PIN ↔ City Record award PIN overlap",
        eligible_contract_count: coverage.eligible_contract_count,
        matched_contract_count: coverage.matched_contract_count,
        unmatched_contract_count: coverage.unmatched_contract_count,
        missing_pin_contract_count: coverage.missing_pin_contract_count,
        eligible_registered_value: coverage.eligible_registered_value,
        matched_registered_value: coverage.matched_registered_value,
        buckets: coverage.buckets,
      },
      filters: publicFilters(input),
      freshness: {
        as_of: projection.generated_at || projection.snapshot_date || "unknown",
        generated_at: projection.generated_at || null,
        snapshot_date: projection.snapshot_date || null,
        source: "committed site/data/analytics_registered_contracts.json",
      },
      error: null,
    }),
  }, {
    groupBy,
    measure,
    ...(input.agency == null ? {} : { agency: input.agency }),
    ...(input.vendor == null ? {} : { vendor: input.vendor }),
    ...(input.fiscalYear == null ? {} : { fiscalYear: input.fiscalYear }),
    ...(input.amountBand == null ? {} : { amountBand: input.amountBand }),
    ...(input.minAmount == null ? {} : { minAmount: input.minAmount }),
    ...(input.maxAmount == null ? {} : { maxAmount: input.maxAmount }),
    ...(input.retroactive == null ? {} : { retroactive: input.retroactive }),
    ...(input.cityRecordMatch == null ? {} : { cityRecordMatch: input.cityRecordMatch }),
    limit: input.limit || CONTRACTS_ANALYSIS_LIMITS.defaultGroups,
  });
}
