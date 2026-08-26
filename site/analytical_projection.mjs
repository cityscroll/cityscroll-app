import {
  ANALYTICAL_PROJECTION_SCHEMA,
  REGISTERED_CONTRACT_PROJECTION,
  UNKNOWN_DIMENSION_LABEL,
  assertSupportedProjection,
  readerDimensionValue,
} from "./analytical_projection_contract.mjs";

export const ANALYTICAL_PROJECTION_URL = "data/analytics_registered_contracts.json";
export const ANALYTICAL_GROUPS = Object.freeze({ agency: "agency", vendor: "prime_vendor" });
export const ANALYTICAL_PROJECTION_QUERY_KEYS = Object.freeze([
  "ap_agency", "ap_vendor", "ap_fy", "ap_amount_band", "ap_min", "ap_max",
]);
export const ANALYTICAL_MEASURES = Object.freeze({
  count: "unique_contract_count",
  current: "sum_current_registered_amount",
  original: "sum_original_registered_amount",
});

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
  const current = Number(row?.current ?? row?.current_amount);
  const original = Number(row?.original ?? row?.original_amount);
  const registrationFiscalYearValue = row?.registration_fiscal_year
    ?? registrationFiscalYear(registeredDate);
  return {
    prime_contract_id: contractId,
    agency: row?.agency || null,
    prime_vendor: row?.prime_vendor || row?.vendor || null,
    registration_date: registeredDate || null,
    registration_fiscal_year: Number.isInteger(Number(registrationFiscalYearValue))
      ? Number(registrationFiscalYearValue) : null,
    contract_amount_band: row?.contract_amount_band || contractAmountBand(current),
    award_method: row?.award_method || row?.awardMethod || null,
    current_registered_amount: Number.isFinite(current) ? current : null,
    original_registered_amount: Number.isFinite(original) ? original : null,
    source_fiscal_years: Array.isArray(row?.source_fiscal_years) ? [...row.source_fiscal_years] : [],
    source: "checkbook-contracts",
  };
}

export function filterAnalyticalContracts(rows, filters = {}) {
  const min = filters.min_amount == null || filters.min_amount === "" ? null : Number(filters.min_amount);
  const max = filters.max_amount == null || filters.max_amount === "" ? null : Number(filters.max_amount);
  const fy = filters.registration_fiscal_year == null || filters.registration_fiscal_year === ""
    ? null : Number(filters.registration_fiscal_year);
  const agency = filters.agency == null || filters.agency === "" ? null : String(filters.agency);
  const vendor = filters.prime_vendor == null || filters.prime_vendor === "" ? null : String(filters.prime_vendor);
  const amountBand = filters.contract_amount_band || null;
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const current = Number(row?.current_registered_amount);
    if (fy != null && row.registration_fiscal_year !== fy) return false;
    if (agency != null && readerDimensionValue(row.agency) !== agency) return false;
    if (vendor != null && readerDimensionValue(row.prime_vendor) !== vendor) return false;
    if (amountBand && readerDimensionValue(row.contract_amount_band) !== amountBand) return false;
    if (min != null && (!Number.isFinite(current) || current < min)) return false;
    if (max != null && (!Number.isFinite(current) || current > max)) return false;
    return true;
  });
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function groupAnalyticalContracts(rows, { groupBy = "agency", measure = "current", topN = 10 } = {}) {
  const dimension = ANALYTICAL_GROUPS[groupBy] || groupBy;
  const measureId = ANALYTICAL_MEASURES[measure] || measure;
  assertSupportedProjection({ fact: "registered_contract", measure: measureId, dimension });
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
    };
  });
  const valueKey = measureId === "unique_contract_count" ? "contract_count"
    : measureId === "sum_original_registered_amount" ? "sum_original_registered_amount"
      : measureId === "median_current_registered_amount" ? "median_current_registered_amount"
        : "sum_current_registered_amount";
  result.sort((a, b) => (Number(b[valueKey]) || 0) - (Number(a[valueKey]) || 0) || a.label.localeCompare(b.label));
  return { groups: result, shown_groups: result.slice(0, Math.max(1, Number(topN) || 10)), value_key: valueKey };
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

export function analyticalDrillThroughHref({ agency, prime_vendor, registration_fiscal_year, contract_amount_band, min_amount, max_amount } = {}) {
  const params = new URLSearchParams({ mode: "award" });
  if (agency) params.set("ap_agency", agency);
  if (prime_vendor) params.set("ap_vendor", prime_vendor);
  if (registration_fiscal_year != null) params.set("ap_fy", String(registration_fiscal_year));
  if (contract_amount_band) params.set("ap_amount_band", contract_amount_band);
  if (min_amount != null && min_amount !== "") params.set("ap_min", String(min_amount));
  if (max_amount != null && max_amount !== "") params.set("ap_max", String(max_amount));
  return `/browse/contracts/?${params.toString()}`;
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
