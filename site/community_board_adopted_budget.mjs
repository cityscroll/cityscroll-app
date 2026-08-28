import {
  resolveCommunityBoardFinancialIdentity,
  validateCommunityBoardFinancialIdentity,
} from "./community_board_financial_identity.mjs";

export const COMMUNITY_BOARD_ADOPTED_BUDGET_SCHEMA = "cityscroll.community_board_adopted_budget.v1";
export const COMMUNITY_BOARD_ADOPTED_BUDGET_VERSION = 1;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const upper = (value) => clean(value).toUpperCase();
const OTPS_APPROPRIATION_NAMES = new Set(["OTHER THAN PERSONAL SERVICES", "RENT", "RENT AND ENERGY"]);
const money = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
};

function stableRowValue(row) {
  return Object.fromEntries(
    Object.entries(row || {})
      .filter(([key]) => !key.startsWith(":"))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * The Expense Budget publication repeats line items across publication dates.
 * The builder pins one date; this fingerprint also makes identical rows in
 * that slice idempotent without trusting a volatile Socrata row id.
 */
export function sourceRowFingerprint(row) {
  return JSON.stringify(stableRowValue(row));
}

export function componentSemanticCheck(rows) {
  const failures = [];
  const components = { P: 0, O: 0 };
  let personalRows = 0;
  let otpsRows = 0;

  for (const [index, row] of (rows || []).entries()) {
    const indicator = upper(row?.personal_service_other_than_personal_service_indicator);
    const appropriation = upper(row?.unit_appropriation_name);
    const amount = money(row?.adopted_budget_amount);
    const semanticMatch = indicator === "P"
      ? appropriation === "PERSONAL SERVICES"
      : indicator === "O" && OTPS_APPROPRIATION_NAMES.has(appropriation);
    if (!semanticMatch || amount === null) {
      failures.push({
        row_index: index,
        indicator: indicator || null,
        unit_appropriation_name: appropriation || null,
        reason: !indicator || !["P", "O"].includes(indicator)
          ? "unsupported_indicator"
          : amount === null
            ? "invalid_adopted_amount"
            : "indicator_appropriation_mismatch",
      });
      continue;
    }
    components[indicator] = money(components[indicator] + amount);
    if (indicator === "P") personalRows += 1;
    if (indicator === "O") otpsRows += 1;
  }

  const total = money((rows || []).reduce((sum, row) => sum + (money(row?.adopted_budget_amount) ?? 0), 0));
  const componentTotal = money(components.P + components.O);
  const reconciles = failures.length === 0 && total !== null && total === componentTotal;
  return {
    status: reconciles ? "verified" : "unsupported",
    indicator_field: "personal_service_other_than_personal_service_indicator",
    appropriation_field: "unit_appropriation_name",
    personal_indicator: "P",
    otps_indicator: "O",
    personal_rows: personalRows,
    otps_rows: otpsRows,
    adopted_total: total,
    component_total: componentTotal,
    components,
    reconciles,
    failures,
  };
}

function exactBinding(registry, sourceNativeKey) {
  const binding = (registry?.bindings || []).find((candidate) =>
    candidate.source_system === "expense_budget"
      && clean(candidate.source_native_board_key) === clean(sourceNativeKey),
  );
  return binding?.binding_status === "accepted" ? binding : null;
}

function rowReport(row, reason, extra = {}) {
  const parsedFiscalYear = Number(row?.fiscal_year);
  return {
    source_native_key: clean(row?.agency_number) || null,
    publisher_identity: clean(row?.agency_name) || null,
    fiscal_year: Number.isInteger(parsedFiscalYear) && parsedFiscalYear > 0 ? parsedFiscalYear : null,
    publication_date: clean(row?.publication_date) || null,
    reason,
    ...extra,
  };
}

/**
 * Materialize adopted facts from raw Expense Budget rows. Identity resolution
 * is intentionally source-scoped and happens before aggregation.
 */
export function materializeCommunityBoardAdoptedBudget({
  rows = [],
  registry,
  identityReceipt = null,
  fiscalYear,
  publicationDate,
  sourceVintage,
  observedAt,
  sourceUrl = "https://data.cityofnewyork.us/d/mwzb-yiwb",
}) {
  const identityValidation = validateCommunityBoardFinancialIdentity(registry, identityReceipt);
  if (!identityValidation.ok) throw new Error(`invalid CB-MONEY-00 identity artifact: ${identityValidation.errors.join("; ")}`);
  if (!Number.isInteger(Number(fiscalYear))) throw new Error("adopted budget fiscal year must be explicit");
  if (!clean(publicationDate)) throw new Error("adopted budget publication date must be explicit");

  const byFact = new Map();
  const seenRows = new Set();
  const unmatchedRows = [];
  let duplicateRowsSuppressed = 0;
  let sliceRows = 0;

  for (const row of rows) {
    const rowYear = Number(row?.fiscal_year);
    const rowPublicationDate = clean(row?.publication_date);
    if (rowYear !== Number(fiscalYear) || rowPublicationDate !== clean(publicationDate)) {
      unmatchedRows.push(rowReport(row, "outside_pinned_source_slice"));
      continue;
    }
    sliceRows += 1;
    const fingerprint = sourceRowFingerprint(row);
    if (seenRows.has(fingerprint)) {
      duplicateRowsSuppressed += 1;
      continue;
    }
    seenRows.add(fingerprint);

    const sourceNativeKey = clean(row?.agency_number);
    const binding = exactBinding(registry, sourceNativeKey);
    const boardId = resolveCommunityBoardFinancialIdentity(registry, "expense_budget", sourceNativeKey);
    if (!binding || !boardId) {
      unmatchedRows.push(rowReport(row, "no_accepted_cb_money_00_binding"));
      continue;
    }
    const adoptedAmount = money(row?.adopted_budget_amount);
    if (adoptedAmount === null) {
      unmatchedRows.push(rowReport(row, "invalid_adopted_amount", { board_id: boardId }));
      continue;
    }

    const factKey = `${boardId}:${rowYear}`;
    const fact = byFact.get(factKey) || {
      board_id: boardId,
      fiscal_year: rowYear,
      adopted_amount: 0,
      personnel_amount: 0,
      otps_amount: 0,
      source_system: "expense_budget",
      source_native_key: sourceNativeKey,
      source_native_key_field: "agency_number",
      source_vintage: sourceVintage || null,
      observed_at: observedAt || null,
      binding_status: binding.binding_status,
      publisher_identity: binding.publisher_identity,
      publication_date: rowPublicationDate,
      aggregation: {
        input_rows: 0,
        unique_source_rows: 0,
        duplicate_rows_suppressed: 0,
        amount_field: "adopted_budget_amount",
        row_fingerprint: "all non-metadata source fields",
      },
      provenance: {
        dataset_id: "mwzb-yiwb",
        source_url: sourceUrl,
        source_native_key: sourceNativeKey,
        source_native_key_field: "agency_number",
        source_vintage: sourceVintage || null,
        observed_at: observedAt || null,
        fiscal_year: rowYear,
        publication_date: rowPublicationDate,
        identity_binding: "cityscroll.community_board_financial_identity.v1",
      },
      _rows: [],
    };
    fact.adopted_amount = money(fact.adopted_amount + adoptedAmount);
    fact.aggregation.input_rows += 1;
    fact.aggregation.unique_source_rows += 1;
    fact._rows.push(row);
    const indicator = upper(row?.personal_service_other_than_personal_service_indicator);
    if (indicator === "P") fact.personnel_amount = money(fact.personnel_amount + adoptedAmount);
    if (indicator === "O") fact.otps_amount = money(fact.otps_amount + adoptedAmount);
    byFact.set(factKey, fact);
  }

  const outputRows = [...byFact.values()].sort((a, b) => a.board_id.localeCompare(b.board_id) || a.fiscal_year - b.fiscal_year);
  const componentChecks = [];
  for (const fact of outputRows) {
    const check = componentSemanticCheck(fact._rows);
    fact.component_status = check.status;
    fact.personnel_amount = check.status === "verified" ? check.components.P : null;
    fact.otps_amount = check.status === "verified" ? check.components.O : null;
    // The source amounts are still useful when the semantic gate fails, but
    // unsupported components must never look like verified read-model facts.
    fact.component_check = {
      status: check.status,
      adopted_total: check.adopted_total,
      component_total: check.component_total,
      reconciles: check.reconciles,
      failures: check.failures,
    };
    fact.aggregation.duplicate_rows_suppressed = duplicateRowsSuppressed;
    componentChecks.push({ board_id: fact.board_id, fiscal_year: fact.fiscal_year, ...check });
  }

  const acceptedRows = outputRows.reduce((sum, row) => sum + row.aggregation.unique_source_rows, 0);
  for (const row of outputRows) delete row._rows;
  return {
    schema: COMMUNITY_BOARD_ADOPTED_BUDGET_SCHEMA,
    version: COMMUNITY_BOARD_ADOPTED_BUDGET_VERSION,
    title: "Community Board adopted budget facts",
    terminology: "adopted budget",
    source: {
      source_system: "expense_budget",
      dataset_id: "mwzb-yiwb",
      source_url: sourceUrl,
      source_native_key_field: "agency_number",
      amount_field: "adopted_budget_amount",
      source_vintage: sourceVintage || null,
      observed_at: observedAt || null,
      pinned_slice: { fiscal_year: Number(fiscalYear), publication_date: clean(publicationDate) },
      identity_artifact: "site/data/community_board_financial_identity_crosswalk.json",
    },
    coverage: {
      fiscal_year: Number(fiscalYear),
      publication_date: clean(publicationDate),
      candidate_rows: rows.length,
      slice_rows: sliceRows,
      accepted_rows: acceptedRows,
      accepted_board_facts: outputRows.length,
      unmatched_rows: unmatchedRows.length,
      duplicate_rows_suppressed: duplicateRowsSuppressed,
      unmatched_rows_reported: true,
    },
    rows: outputRows,
    unmatched_rows: unmatchedRows,
    component_checks: componentChecks,
    aggregation: {
      grouping: ["board_id", "fiscal_year"],
      source_amount: "adopted_budget_amount",
      duplicate_key: "stable JSON of all non-metadata source fields",
      duplicate_publication_policy: "one explicit fiscal_year/publication_date slice",
    },
  };
}

export function validateCommunityBoardAdoptedBudget(readModel) {
  const errors = [];
  if (readModel?.schema !== COMMUNITY_BOARD_ADOPTED_BUDGET_SCHEMA) errors.push("invalid adopted budget schema");
  if (readModel?.terminology !== "adopted budget") errors.push("adopted budget terminology is missing");
  if (!Number.isInteger(Number(readModel?.source?.pinned_slice?.fiscal_year))) errors.push("source fiscal year is not explicit");
  if (!clean(readModel?.source?.pinned_slice?.publication_date)) errors.push("source publication date is not explicit");
  if (!Array.isArray(readModel?.rows)) errors.push("read model rows are missing");
  for (const row of readModel?.rows || []) {
    if (row.binding_status !== "accepted") errors.push(`row ${row.board_id} is not accepted`);
    if (row.source_system !== "expense_budget") errors.push(`row ${row.board_id} has an invalid source system`);
    if (!row.source_native_key || !row.source_vintage || !row.provenance?.dataset_id) errors.push(`row ${row.board_id} is missing provenance`);
    if (row.fiscal_year !== readModel.source.pinned_slice.fiscal_year) errors.push(`row ${row.board_id} is outside the pinned fiscal year`);
  }
  if (readModel?.coverage?.unmatched_rows_reported !== true) errors.push("unmatched rows are not reported");
  return { ok: errors.length === 0, errors };
}
