/** Independent fiscal-year Checkbook Spending population acquisition. */

import { createHash } from "node:crypto";

export const PAYMENT_POPULATION_CONTRACT = "cityscroll.checkbook.payments.fiscal_year.v1";
export const PAYMENT_POPULATION_SOURCE_SYSTEM = "checkbook_payment_population";
export const CHECKBOOK_CONTRACT_SPENDING_CATEGORY = "c";

export const SOURCE_FIELDS = Object.freeze([
  "agency",
  "associated_prime_vendor",
  "budget_code",
  "capital_project",
  "contract_id",
  "mocs_registered",
  "contract_purpose",
  "check_amount",
  "department",
  "document_id",
  "expense_category",
  "fiscal_year",
  "industry",
  "issue_date",
  "mwbe_category",
  "payee_name",
  "spending_category",
  "sub_contract_reference_id",
  "sub_vendor",
  "woman_owned_business",
  "emerging_business",
]);

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const FIELD_PATTERNS = Object.fromEntries(SOURCE_FIELDS.map((field) => [
  field,
  new RegExp(`<${field}>([\\s\\S]*?)<\/${field}>`, "i"),
]));

function decodeXmlText(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return String(value ?? "").replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower in named) return named[lower];
    const point = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    try { return String.fromCodePoint(point); } catch { return match; }
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseAmount(value) {
  if (value == null || clean(value) === "") return null;
  const amount = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(amount) ? amount : null;
}

function normalizeSourceValue(value) {
  // Empty XML elements remain present in source_fields, but normalized columns
  // use null so missing publisher values cannot become dimensions.
  const text = clean(value);
  return text || null;
}

/** Parse every source field from Checkbook's citywide Spending transaction. */
export function parseCheckbookPaymentTransactions(xml) {
  const rows = [];
  for (const match of String(xml ?? "").matchAll(/<transaction>([\s\S]*?)<\/transaction>/g)) {
    const body = match[1];
    const sourceFields = {};
    for (const field of SOURCE_FIELDS) {
      const tag = FIELD_PATTERNS[field].exec(body);
      sourceFields[field] = tag ? decodeXmlText(tag[1]) : "";
    }
    rows.push(sourceFields);
  }
  return rows;
}

/** Stable identity for a source transaction, including line dimensions. */
export function paymentTransactionId(sourceFields) {
  const identityFields = {};
  for (const field of SOURCE_FIELDS) identityFields[field] = sourceFields?.[field] ?? "";
  return `${PAYMENT_POPULATION_SOURCE_SYSTEM}:${sha256(canonicalJson(identityFields))}`;
}

/** Normalize one source transaction without dropping source evidence. */
export function normalizeCheckbookPaymentRow(sourceFields, opts = {}) {
  if (!sourceFields || typeof sourceFields !== "object") return null;
  const source = Object.fromEntries(SOURCE_FIELDS.map((field) => [field, String(sourceFields[field] ?? "")]));
  const amount = parseAmount(source.check_amount);
  const fiscalYear = normalizeSourceValue(source.fiscal_year) || opts.fiscalYear || null;
  const row = {
    transaction_id: paymentTransactionId(source),
    source_system: PAYMENT_POPULATION_SOURCE_SYSTEM,
    fiscal_year: fiscalYear,
    issue_date: normalizeSourceValue(source.issue_date),
    agency: normalizeSourceValue(source.agency),
    payee_name: normalizeSourceValue(source.payee_name),
    contract_id: normalizeSourceValue(source.contract_id),
    spending_category: normalizeSourceValue(source.spending_category),
    check_amount: amount,
    document_id: normalizeSourceValue(source.document_id),
    expense_category: normalizeSourceValue(source.expense_category),
    department: normalizeSourceValue(source.department),
    budget_code: normalizeSourceValue(source.budget_code),
    capital_project: normalizeSourceValue(source.capital_project),
    industry: normalizeSourceValue(source.industry),
    mwbe_category: normalizeSourceValue(source.mwbe_category),
    sub_vendor: normalizeSourceValue(source.sub_vendor),
    associated_prime_vendor: normalizeSourceValue(source.associated_prime_vendor),
    sub_contract_reference_id: normalizeSourceValue(source.sub_contract_reference_id),
    mocs_registered: normalizeSourceValue(source.mocs_registered),
    woman_owned_business: normalizeSourceValue(source.woman_owned_business),
    emerging_business: normalizeSourceValue(source.emerging_business),
    is_reversal: amount != null && amount < 0,
    source_fields_json: JSON.stringify(source),
  };
  return row;
}

/** Keep duplicate rows for auditability while measuring duplicate identities. */
export function normalizeCheckbookPaymentRows(sourceRows, opts = {}) {
  const rows = [];
  const identityCounts = new Map();
  let invalidRows = 0;
  for (const source of Array.isArray(sourceRows) ? sourceRows : []) {
    const row = normalizeCheckbookPaymentRow(source, opts);
    if (!row) {
      invalidRows += 1;
      continue;
    }
    identityCounts.set(row.transaction_id, (identityCounts.get(row.transaction_id) || 0) + 1);
    rows.push(row);
  }
  const duplicateRows = rows.reduce(
    (total, row) => total + (identityCounts.get(row.transaction_id) > 1 ? 1 : 0),
    0,
  );
  rows.sort((a, b) => String(a.transaction_id).localeCompare(String(b.transaction_id)));
  return {
    rows,
    counts: {
      source_rows: Array.isArray(sourceRows) ? sourceRows.length : 0,
      normalized_rows: rows.length,
      unique_transaction_ids: identityCounts.size,
      duplicate_transaction_rows: duplicateRows,
      invalid_rows: invalidRows,
      reversal_rows: rows.filter((row) => row.is_reversal).length,
      null_amount_rows: rows.filter((row) => row.check_amount == null).length,
    },
  };
}

export function sumCheckAmounts(rows) {
  return Math.round((Array.isArray(rows) ? rows : [])
    .reduce((sum, row) => sum + (Number.isFinite(row?.check_amount) ? row.check_amount : 0), 0) * 100) / 100;
}

export function groupPaymentsByAgency(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const agency = row?.agency || "Unknown / not published";
    const current = groups.get(agency) || { agency, transaction_count: 0, net_check_amount: 0 };
    current.transaction_count += 1;
    if (Number.isFinite(row?.check_amount)) current.net_check_amount += row.check_amount;
    groups.set(agency, current);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, net_check_amount: Math.round(group.net_check_amount * 100) / 100 }))
    .sort((a, b) => b.net_check_amount - a.net_check_amount || a.agency.localeCompare(b.agency));
}

/** Reconcile the publisher denominator and amount across source and normalized rows. */
export function reconcilePaymentPartition({ sourceRecordCount, sourceRows, normalizedRows }) {
  const source = Array.isArray(sourceRows) ? sourceRows : [];
  const normalized = Array.isArray(normalizedRows) ? normalizedRows : [];
  const sourceAmount = sumCheckAmounts(source.map((row) => ({ check_amount: parseAmount(row?.check_amount) })));
  const normalizedAmount = sumCheckAmounts(normalized);
  const countMatchesApi = sourceRecordCount == null || Number(sourceRecordCount) === source.length;
  const countMatchesConversion = source.length === normalized.length;
  const amountMatchesConversion = sourceAmount === normalizedAmount;
  return {
    source_record_count: sourceRecordCount == null ? null : Number(sourceRecordCount),
    source_xml_rows: source.length,
    normalized_rows: normalized.length,
    source_net_check_amount: sourceAmount,
    normalized_net_check_amount: normalizedAmount,
    count_matches_publisher_api: countMatchesApi,
    count_matches_conversion: countMatchesConversion,
    amount_matches_conversion: amountMatchesConversion,
    reconciled: countMatchesApi && countMatchesConversion && amountMatchesConversion,
  };
}

export function sha256Json(value) {
  return sha256(canonicalJson(value));
}
