// Shared registered-contract analytical projection used by the static UI and
// the Worker provider. Payments deliberately stay outside this capability.

import {
  CONTRACTS_ANALYSIS_AVAILABILITY,
  CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
  CONTRACTS_ANALYSIS_LIMITS,
  PROCUREMENT_DETAIL_NOT_RETRIEVABLE_REASON,
  PROCUREMENT_DETAIL_RESOLUTIONS,
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
  readerDimensionValue,
} from "./analytical_projection_contract.mjs";
import { resolveProcurementDetailIds } from "./procurement_detail_index.mjs";

const CONTRACT_IDENTIFIER_NOTE =
  "contract_ids are publisher registration identifiers for the registered-contract aggregate; contract.get@1 accepts only the canonical procurement id at the same index of contract_procurement_ids, and a null there means that contract is not individually retrievable.";

/**
 * Resolve a group's contributing registration identifiers into the canonical
 * ids the contract detail capability accepts. Without a detail index nothing
 * is claimed: the ids stay null and the group says so, which is the honest
 * answer when the aggregate cannot see the detail read model it would be
 * pointing at.
 */
function groupContractDetail(contractIds, detailIndex) {
  const resolved = resolveProcurementDetailIds(detailIndex, contractIds);
  if (!resolved) {
    return {
      contract_procurement_ids: null,
      contract_retrieval: {
        resolution: PROCUREMENT_DETAIL_RESOLUTIONS[2],
        retrievable_contract_count: 0,
        not_retrievable_contract_count: contractIds.length,
      },
    };
  }
  const retrievable = resolved.filter((procurementId) => procurementId !== null).length;
  return {
    contract_procurement_ids: resolved,
    contract_retrieval: {
      resolution: detailIndex.resolution,
      retrievable_contract_count: retrievable,
      not_retrievable_contract_count: resolved.length - retrievable,
    },
  };
}

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
export function analyticalFilterDiscovery(rows, input = {}) {
  const acceptedLabels = [...new Set(rows.map((row) => readerDimensionValue(row.agency)))].sort();
  const requested = input.agency ?? null;
  const recognized = requested === null || acceptedLabels.includes(requested);
  const terms = String(requested || "").toLowerCase().split(/\s+/).filter(Boolean);
  const caseMatches = acceptedLabels.filter((label) => label.toLowerCase() === String(requested).toLowerCase());
  const suggestions = recognized ? [] : caseMatches.length ? caseMatches : acceptedLabels.filter((label) =>
    terms.length && terms.every((term) => label.toLowerCase().split(/\W+/).includes(term))).slice(0, 5);
  return {
    agency: {
      match: "exact_label",
      accepted_labels: acceptedLabels,
      requested_label: requested,
      status: requested === null ? "not_requested" : recognized ? "recognized" : "unrecognized",
      suggestions,
      message: recognized ? null : `Unrecognized agency label; ${suggestions.length ? `did you mean ${suggestions.join(" or ")}?` : "choose a label from accepted_labels."} This result does not establish zero awards.`,
    },
    fiscal_year: {
      field: "registration_fiscal_year",
      definition: REGISTERED_CONTRACT_PROJECTION.dimensions.registration_fiscal_year.derivation,
      accepted_values: [...new Set(rows.map((row) => row.registration_fiscal_year).filter(Number.isInteger))].sort((a, b) => a - b),
      requested_value: input.fiscalYear ?? null,
      period_start: input.fiscalYear == null ? null : `${input.fiscalYear - 1}-07-01`,
      period_end: input.fiscalYear == null ? null : `${input.fiscalYear}-06-30`,
    },
  };
}

export function analyzeContractsProjection(projection, input = {}, detailIndex = null) {
  const rows = Array.isArray(projection?.rows) ? projection.rows : null;
  if (!rows || !["cityscroll.analytics_registered_contracts.v1", ANALYTICAL_PROJECTION_SCHEMA].includes(projection?.schema)) throw new Error("registered contract analytical projection is unavailable");
  const groupBy = input.groupBy || "agency";
  const measure = input.measure || "current";
  const filterDiscovery = analyticalFilterDiscovery(rows, input);
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
      ...groupContractDetail([...group.contract_ids], detailIndex),
      drill_through: { href: groupHref(input, groupBy, group.label), filters: groupFilters(input, groupBy, group.label) },
    };
  });
  const retrievableContractCount = groups.reduce((sum, group) => sum + group.contract_retrieval.retrievable_contract_count, 0);
  const notRetrievableContractCount = groups.reduce((sum, group) => sum + group.contract_retrieval.not_retrievable_contract_count, 0);
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
        definition: `${filterDiscovery.agency.message ? `${filterDiscovery.agency.message} ` : ""}Selected filtered registered-contract population; ${view.reader_label} is not payments or agency spending.`,
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
      contract_detail: {
        capability: "contract.get@1",
        identifier_field: "contract_procurement_ids",
        identifier_note: CONTRACT_IDENTIFIER_NOTE,
        resolution: detailIndex?.resolution || PROCUREMENT_DETAIL_RESOLUTIONS[2],
        not_retrievable_reason: PROCUREMENT_DETAIL_NOT_RETRIEVABLE_REASON,
        retrievable_contract_count: retrievableContractCount,
        not_retrievable_contract_count: notRetrievableContractCount,
        // Both vintages travel together so a reader can see when the aggregate
        // and the detail records it points at were built from the same day.
        read_model_generated_at: detailIndex?.generated_at || null,
        read_model_procurement_id_count: detailIndex?.procurement_id_count ?? null,
      },
      filters: { ...publicFilters(input), discovery: filterDiscovery },
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
