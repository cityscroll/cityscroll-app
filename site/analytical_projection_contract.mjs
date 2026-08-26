// Versioned, deliberately small contract for population-backed procurement analysis.
// This is a contract registry, not a query language: callers may only select the
// declared fact, dimensions, and measures below.

export const ANALYTICAL_PROJECTION_SCHEMA = "cityscroll.analytical_projection.v1";
export const UNKNOWN_DIMENSION_LABEL = "Unknown / not published";

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
  }),
  ratio_policy: Object.freeze({
    required_fields: Object.freeze(["numerator", "denominator", "excluded_row_count"]),
    note: "Vendor shares publish numerator, explicit selected-scope denominator, and excluded value rows.",
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
