// Versioned, deliberately small contract for population-backed procurement analysis.
// This is a contract registry, not a query language: callers may only select the
// declared fact, dimensions, and measures below.

export const ANALYTICAL_PROJECTION_SCHEMA = "cityscroll.analytical_projection.v1";
export const UNKNOWN_DIMENSION_LABEL = "Unknown / not published";
export const CITY_RECORD_MATCH_VALUES = Object.freeze([
  "exact",
  "none",
  "cannot_evaluate_missing_pin",
]);

export const REGISTERED_CONTRACT_PROJECTION = Object.freeze({
  schema: ANALYTICAL_PROJECTION_SCHEMA,
  fact: "registered_contract",
  source: {
    system: "checkbook-contracts",
    identity_field: "prime_contract_id",
    population_basis: "normalized Checkbook registered expense contracts",
  },
  dimensions: Object.freeze({
    agency: Object.freeze({
      label: "Agency",
      field: "agency",
      source_field: "prime_contracting_agency",
      null_label: UNKNOWN_DIMENSION_LABEL,
    }),
    prime_vendor: Object.freeze({
      label: "Prime vendor",
      field: "prime_vendor",
      source_field: "prime_vendor",
      null_label: UNKNOWN_DIMENSION_LABEL,
    }),
    registration_fiscal_year: Object.freeze({
      label: "Registration fiscal year",
      field: "registration_fiscal_year",
      source_field: "prime_contract_registration_date",
      derivation: "NYC fiscal year: July 1 through June 30; derived from registration date",
      null_label: UNKNOWN_DIMENSION_LABEL,
    }),
    contract_amount_band: Object.freeze({
      label: "Contract amount band",
      field: "contract_amount_band",
      source_field: "prime_contract_current_amount",
      derivation: "versioned bands over current registered amount",
      null_label: UNKNOWN_DIMENSION_LABEL,
    }),
    award_method: Object.freeze({
      label: "Award method",
      field: "award_method",
      source_field: "prime_contract_award_method",
      observation: "source-native Checkbook observation; retained when available",
      null_label: UNKNOWN_DIMENSION_LABEL,
    }),
    registration_timing: Object.freeze({
      label: "Registration timing",
      field: "registration_timing",
      source_field: "registration_date, start_date",
      derivation: "eligible when both dates are published; retroactive when registration_lag_days > 0",
      null_label: UNKNOWN_DIMENSION_LABEL,
    }),
    city_record_match: Object.freeze({
      label: "City Record match",
      field: "city_record_match",
      source_field: "exact normalized Checkbook PIN matched to a City Record award PIN",
      derivation: "reuses the existing exact-PIN Checkbook ↔ City Record join; no fuzzy matching",
      values: CITY_RECORD_MATCH_VALUES,
    }),
  }),
  measures: Object.freeze({
    unique_contract_count: Object.freeze({
      label: "Unique registered contracts",
      reader_label: "Contracts",
      aggregation: "count_distinct",
      source_field: "prime_contract_id",
      facts: Object.freeze(["registered_contract"]),
    }),
    sum_original_registered_amount: Object.freeze({
      label: "Original registered contract value",
      reader_label: "Original registered contract value",
      aggregation: "sum",
      source_field: "prime_contract_original_amount",
      facts: Object.freeze(["registered_contract"]),
      prohibited_labels: Object.freeze(["spending", "actual spending", "payments"]),
    }),
    sum_current_registered_amount: Object.freeze({
      label: "Current registered contract value",
      reader_label: "Current registered contract value",
      aggregation: "sum",
      source_field: "prime_contract_current_amount",
      facts: Object.freeze(["registered_contract"]),
      prohibited_labels: Object.freeze(["spending", "actual spending", "payments"]),
    }),
    median_current_registered_amount: Object.freeze({
      label: "Median current registered contract value",
      reader_label: "Median current registered contract value",
      aggregation: "median",
      source_field: "prime_contract_current_amount",
      facts: Object.freeze(["registered_contract"]),
      prohibited_labels: Object.freeze(["spending", "actual spending", "payments"]),
    }),
    eligible_contract_count: Object.freeze({
      label: "Contracts with both start and registration dates",
      reader_label: "Contracts with both dates",
      aggregation: "count_where_both_dates_present",
      source_field: "start_date, registration_date",
      facts: Object.freeze(["registered_contract"]),
    }),
    missing_date_contract_count: Object.freeze({
      label: "Contracts missing a start or registration date",
      reader_label: "Missing-date contracts",
      aggregation: "count_where_either_date_missing",
      source_field: "start_date, registration_date",
      facts: Object.freeze(["registered_contract"]),
    }),
    retroactive_contract_count: Object.freeze({
      label: "Retroactive registered contracts",
      reader_label: "Retroactive contracts",
      aggregation: "count_where_registration_lag_days_positive",
      source_field: "registration_lag_days",
      facts: Object.freeze(["registered_contract"]),
    }),
    retroactive_share: Object.freeze({
      label: "Retroactive registration share",
      reader_label: "Registered after start date",
      aggregation: "retroactive_count / eligible_contract_count",
      source_field: "registration_lag_days",
      facts: Object.freeze(["registered_contract"]),
    }),
    median_registration_lag_days: Object.freeze({
      label: "Median registration lag",
      reader_label: "Median lag",
      aggregation: "nearest_rank_percentile_0.50",
      source_field: "registration_lag_days",
      facts: Object.freeze(["registered_contract"]),
    }),
    p75_registration_lag_days: Object.freeze({
      label: "75th percentile registration lag",
      reader_label: "P75 lag",
      aggregation: "nearest_rank_percentile_0.75",
      source_field: "registration_lag_days",
      facts: Object.freeze(["registered_contract"]),
    }),
    p90_registration_lag_days: Object.freeze({
      label: "90th percentile registration lag",
      reader_label: "P90 lag",
      aggregation: "nearest_rank_percentile_0.90",
      source_field: "registration_lag_days",
      facts: Object.freeze(["registered_contract"]),
    }),
    city_record_eligible_contract_count: Object.freeze({
      label: "Eligible registered contracts for City Record match coverage",
      reader_label: "Eligible registered contracts",
      aggregation: "count_distinct",
      source_field: "prime_contract_id",
      facts: Object.freeze(["registered_contract"]),
    }),
    city_record_matched_contract_count: Object.freeze({
      label: "Registered contracts with an exact City Record match",
      reader_label: "Exact City Record matches",
      aggregation: "count_distinct",
      source_field: "prime_contract_id",
      facts: Object.freeze(["registered_contract"]),
    }),
    city_record_unmatched_contract_count: Object.freeze({
      label: "Registered contracts without an exact City Record match",
      reader_label: "No exact match found",
      aggregation: "count_distinct",
      source_field: "prime_contract_id",
      facts: Object.freeze(["registered_contract"]),
    }),
    city_record_missing_pin_contract_count: Object.freeze({
      label: "Registered contracts that cannot be evaluated because PIN is missing",
      reader_label: "Missing PIN",
      aggregation: "count_distinct",
      source_field: "prime_contract_id",
      facts: Object.freeze(["registered_contract"]),
    }),
  }),
  ratio_policy: Object.freeze({
    required_fields: Object.freeze(["numerator", "denominator", "excluded_row_count"]),
    note: "Every ratio publishes numerator, denominator, and excluded rows; vendor shares publish an explicit selected-scope denominator, and missing dates are excluded from the timing-rate denominator.",
  }),
  guards: Object.freeze([
    "registration_fiscal_year is derived from registration date; source_fiscal_years is provenance only",
    "one row per exact prime_contract_id before aggregation",
    "null dimensions render as Unknown / not published and are never guessed",
    "registered contract value is not actual spending",
  ]),
});

export const ANALYTICAL_FACTS = Object.freeze({
  registered_contract: REGISTERED_CONTRACT_PROJECTION,
  payment: Object.freeze({
    fact: "payment",
    status: "deferred",
    measures: Object.freeze({}),
  }),
});

export function assertSupportedProjection({ fact = "registered_contract", measure, dimension } = {}) {
  const definition = ANALYTICAL_FACTS[fact];
  if (!definition || definition.status === "deferred") {
    throw new Error(`Unsupported analytical fact: ${fact}`);
  }
  const measureDefinition = definition.measures[measure];
  if (!measureDefinition || !measureDefinition.facts.includes(fact)) {
    throw new Error(`Unsupported measure ${measure} for fact ${fact}`);
  }
  if (dimension && !definition.dimensions[dimension]) {
    throw new Error(`Unsupported dimension ${dimension} for fact ${fact}`);
  }
  return { fact, measure, dimension: dimension || null, definition: measureDefinition };
}

export function readerDimensionValue(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || UNKNOWN_DIMENSION_LABEL;
}
