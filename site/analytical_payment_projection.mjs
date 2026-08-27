import {
  ANALYTICAL_PROJECTION_SCHEMA,
  PAYMENT_PROJECTION,
  UNKNOWN_DIMENSION_LABEL,
  readerDimensionValue,
} from "./analytical_projection_contract.mjs";
import { resolveAgencyIdentity } from "./agency_identity.mjs";

export const PAYMENT_ANALYTICAL_PROJECTION_URL = "data/analytics_payments.json";
export const PAYMENT_ANALYTICAL_GROUPS = Object.freeze({
  agency: "agency",
  vendor: "payee_name",
  fiscal_year: "fiscal_year",
});
export const PAYMENT_ANALYTICAL_MEASURES = Object.freeze({
  transactions: "payment_transaction_count",
  amount: "sum_actual_payment_amount",
});

export function normalizeAnalyticalPaymentRow(row) {
  const transactionId = String(row?.transaction_id || row?.id || "").trim();
  if (!transactionId) return null;
  const amount = Number(row?.check_amount ?? row?.actual_payment_amount);
  const fiscalYear = Number(row?.fiscal_year);
  return {
    transaction_id: transactionId,
    agency: row?.agency || null,
    payee_name: row?.payee_name || row?.vendor || row?.prime_vendor || null,
    fiscal_year: Number.isInteger(fiscalYear) ? fiscalYear : null,
    contract_id: row?.contract_id || null,
    check_amount: Number.isFinite(amount) ? amount : null,
  };
}

function canonicalAgency(value) {
  return resolveAgencyIdentity(value).canonical_id;
}

function sameAgency(left, right) {
  const leftLabel = readerDimensionValue(left);
  const rightLabel = readerDimensionValue(right);
  return leftLabel === rightLabel || canonicalAgency(leftLabel) === canonicalAgency(rightLabel);
}

export function filterAnalyticalPayments(rows, filters = {}) {
  const agency = filters.agency == null || filters.agency === "" ? null : String(filters.agency);
  const vendor = filters.prime_vendor == null || filters.prime_vendor === "" ? null : String(filters.prime_vendor);
  const fiscalYear = filters.fiscal_year ?? filters.payment_fiscal_year ?? filters.registration_fiscal_year;
  const fy = fiscalYear == null || fiscalYear === "" ? null : Number(fiscalYear);
  const contractId = filters.contract_id == null || filters.contract_id === "" ? null : String(filters.contract_id);
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (agency != null && !sameAgency(row?.agency, agency)) return false;
    if (vendor != null && readerDimensionValue(row?.payee_name) !== vendor) return false;
    if (fy != null && Number(row?.fiscal_year) !== fy) return false;
    if (contractId != null) {
      if (readerDimensionValue(row?.contract_id) !== contractId) return false;
    }
    return true;
  });
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

export function paymentPopulationSummary(rows, population = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const transactionCount = list.reduce((sum, row) => sum + Number(row?.transaction_count || 0), 0);
  const uniqueTransactionCount = list.reduce((sum, row) => sum + Number(row?.unique_transaction_count || row?.transaction_count || 0), 0);
  const amount = list.reduce((sum, row) => sum + (Number(row?.actual_payment_amount) || 0), 0);
  const years = list.map((row) => Number(row?.fiscal_year)).filter(Number.isInteger);
  return {
    payment_transaction_count: transactionCount,
    unique_payment_transaction_count: uniqueTransactionCount,
    actual_payment_amount: roundMoney(amount),
    year_label: years.length ? `payment FY${Math.min(...years)}–FY${Math.max(...years)}` : "payment fiscal year unavailable",
    snapshot_date: population.snapshot_date || null,
    population_definition: population.population_definition || PAYMENT_PROJECTION.source.population_basis,
  };
}

export function groupAnalyticalPayments(rows, { groupBy = "agency", measure = "amount", topN = 10 } = {}) {
  const dimension = PAYMENT_ANALYTICAL_GROUPS[groupBy] || groupBy;
  const measureId = PAYMENT_ANALYTICAL_MEASURES[measure] || measure;
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const label = dimension === "agency"
      ? (row?.agency ? resolveAgencyIdentity(row.agency).canonical_name : UNKNOWN_DIMENSION_LABEL)
      : dimension === "fiscal_year"
      ? (Number.isInteger(Number(row?.[dimension])) ? `FY${row[dimension]}` : UNKNOWN_DIMENSION_LABEL)
      : readerDimensionValue(row?.[dimension]);
    if (!groups.has(label)) groups.set(label, { label, rows: [] });
    groups.get(label).rows.push(row);
  }
  const result = [...groups.values()].map((group) => {
    const transactionCount = group.rows.reduce((sum, row) => sum + Number(row?.transaction_count ?? 1), 0);
    const uniqueTransactionCount = group.rows.reduce((sum, row) => sum + Number(row?.unique_transaction_count ?? row?.transaction_count ?? 1), 0);
    const amount = roundMoney(group.rows.reduce((sum, row) => sum + Number(row?.actual_payment_amount ?? row?.check_amount ?? 0), 0));
    const contracts = new Set(group.rows.flatMap((row) => Array.isArray(row?.contract_ids)
      ? row.contract_ids : row?.contract_id ? [row.contract_id] : []));
    return {
      label: group.label,
      transaction_count: transactionCount,
      unique_transaction_count: uniqueTransactionCount,
      actual_payment_amount: amount,
      contract_count: rowValue(group.rows, "contract_count") || contracts.size,
      contract_ids: [...contracts],
    };
  });
  const valueKey = measureId === "payment_transaction_count" ? "transaction_count" : "actual_payment_amount";
  result.sort((left, right) => (Number(right[valueKey]) || 0) - (Number(left[valueKey]) || 0) || left.label.localeCompare(right.label));
  return {
    groups: result,
    shown_groups: result.slice(0, Math.max(1, Number(topN) || 10)),
    value_key: valueKey,
    measure: measureId,
  };
}

function rowValue(rows, key) {
  return rows.reduce((sum, row) => sum + Number(row?.[key] || 0), 0);
}

export function paymentTransactionDrillThroughHref({ agency, prime_vendor, fiscal_year, contract_id } = {}) {
  const params = new URLSearchParams({ mode: "award", ap_fact: "payment", ap_payment_view: "transactions" });
  if (agency && agency !== UNKNOWN_DIMENSION_LABEL) params.set("ap_agency", agency);
  if (prime_vendor && prime_vendor !== UNKNOWN_DIMENSION_LABEL) params.set("ap_vendor", prime_vendor);
  if (fiscal_year != null && fiscal_year !== "" && fiscal_year !== UNKNOWN_DIMENSION_LABEL) {
    params.set("ap_fy", String(fiscal_year).replace(/^FY/, ""));
  }
  if (contract_id && contract_id !== UNKNOWN_DIMENSION_LABEL) params.set("ap_contract_id", contract_id);
  return `/browse/contracts/?${params.toString()}`;
}

export function paymentRelatedContractDrillThroughHref({ agency, prime_vendor, fiscal_year, contract_id } = {}) {
  const params = new URLSearchParams({ mode: "award" });
  if (agency && agency !== UNKNOWN_DIMENSION_LABEL) params.set("ap_agency", agency);
  if (prime_vendor && prime_vendor !== UNKNOWN_DIMENSION_LABEL) params.set("ap_vendor", prime_vendor);
  if (fiscal_year != null && fiscal_year !== "" && fiscal_year !== UNKNOWN_DIMENSION_LABEL) params.set("ap_fy", String(fiscal_year).replace(/^FY/, ""));
  if (contract_id && contract_id !== UNKNOWN_DIMENSION_LABEL) params.set("ap_contract_id", contract_id);
  return `/browse/contracts/?${params.toString()}`;
}

export function paymentFactProjection(rows, metadata = {}) {
  return {
    schema: ANALYTICAL_PROJECTION_SCHEMA,
    fact: "payment",
    projection_contract: ANALYTICAL_PROJECTION_SCHEMA,
    population_definition: PAYMENT_PROJECTION.source.population_basis,
    ...metadata,
    rows: Array.isArray(rows) ? rows : [],
  };
}
