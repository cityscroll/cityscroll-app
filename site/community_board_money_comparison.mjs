import { communityBoardPageHref } from "./community_board_links.mjs";

export const COMMUNITY_BOARD_MONEY_COMPARISON_SCHEMA = "cityscroll.community_board_money_comparison.v1";
export const COMMUNITY_BOARD_MONEY_COMPARISON_VERSION = 1;

export const MONEY_COMPARISON_METRICS = Object.freeze({
  adopted_budget: Object.freeze({
    label: "Adopted budget",
    shortLabel: "Budget",
    source: "budget",
    field: "adopted_amount",
    format: "currency",
  }),
  posted_amount: Object.freeze({
    label: "Payments posted",
    shortLabel: "Payments",
    source: "spending",
    field: "posted_amount",
    format: "currency",
  }),
  payment_count: Object.freeze({
    label: "Payment count",
    shortLabel: "Payments",
    source: "spending",
    field: "payment_count",
    format: "count",
  }),
  payee_count: Object.freeze({
    label: "Payee count",
    shortLabel: "Payees",
    source: "spending",
    field: "distinct_payee_count",
    format: "count",
  }),
});

const METRIC_KEYS = Object.freeze(Object.keys(MONEY_COMPARISON_METRICS));
const integer = (value) => value == null || String(value).trim() === ""
  ? null
  : Number.isInteger(Number(value)) ? Number(value) : null;
const finite = (value) => value == null || String(value).trim() === ""
  ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;
const text = (value) => String(value ?? "").trim() || null;

function rowsOf(model) {
  return Array.isArray(model?.rows) ? model.rows.filter(Boolean) : [];
}

function boardIdOf(board) {
  return text(board?.body_id || board?.board_id || board?.id);
}

function rowKey(row) {
  return row ? `${row.board_id}:${row.fiscal_year}` : null;
}

function sourceVintage(row, model, source) {
  return row?.[source]?.source_vintage ?? model?.sources?.[source]?.source_vintage ?? null;
}

function sourceRef(row, model, source) {
  return row?.[source]?.source_ref || null;
}

function factState(row, model, source) {
  const sourceStatus = model?.sources?.[source]?.status;
  if (sourceStatus === "stale" || row?.[source]?.coverage === "stale") return "stale";
  if (!row) return "unavailable";
  if (source === "budget") {
    return row.budget?.adopted_amount == null || !row.budget?.source_ref ? "unavailable" : "available";
  }
  if (row.spending?.coverage === "identity_unobserved") return "identity_unobserved";
  if (row.spending?.coverage === "empty_source_result") return "empty_source_result";
  if (row.spending?.posted_amount == null || !row.spending?.source_ref) return "unavailable";
  return "available";
}

function sourceRowsForBoard(rows, boardId, source, fiscalYear) {
  const candidates = rows.filter((row) => row.board_id === boardId);
  if (fiscalYear != null) return candidates.find((row) => integer(row.fiscal_year) === fiscalYear) || null;
  return candidates
    .filter((row) => row?.[source]?.source_ref || row?.[source]?.coverage === "identity_unobserved" || row?.[source]?.coverage === "empty_source_result")
    .sort((left, right) => integer(right.fiscal_year) - integer(left.fiscal_year))[0] || null;
}

function sourceBoundary(model, rows, source) {
  const refs = rows
    .map((row) => sourceRef(row, model, source))
    .filter(Boolean);
  const vintage = model?.sources?.[source]?.source_vintage
    ?? refs.find((ref) => ref.source_vintage)?.source_vintage
    ?? null;
  const vintages = [...new Map(refs
    .map((ref) => ref.source_vintage)
    .filter((value) => value != null)
    .map((value) => [JSON.stringify(value), value])).values()];
  if (vintage != null && !vintages.some((value) => JSON.stringify(value) === JSON.stringify(vintage))) vintages.unshift(vintage);
  return {
    source_system: model?.sources?.[source]?.source_system || null,
    dataset_id: model?.sources?.[source]?.dataset_id || null,
    source_url: model?.sources?.[source]?.source_url || refs.find((ref) => ref.source_url)?.source_url || null,
    source_vintage: vintage,
    source_vintages: vintages,
    observed_at: model?.sources?.[source]?.generated_at || refs.find((ref) => ref.observed_at)?.observed_at || null,
    fiscal_years: [...new Set(rows.map((row) => integer(row?.[source]?.fiscal_year)).filter((year) => year != null))].sort((a, b) => a - b),
    publication_dates: [...new Set(refs.map((ref) => ref.publication_date).filter(Boolean))].sort(),
  };
}

function sourceValue(row, source, field) {
  const value = row?.[source]?.[field];
  return value == null ? null : finite(value);
}

function stateLabel(state) {
  return {
    available: "Available",
    stale: "Source needs a fresh check",
    empty_source_result: "No rows returned",
    identity_unobserved: "Identity not established",
    unavailable: "Unavailable",
  }[state] || "Unavailable";
}

function selectedRows(model, boardId, fiscalYear) {
  const rows = rowsOf(model);
  return {
    budget: sourceRowsForBoard(rows, boardId, "budget", fiscalYear),
    spending: sourceRowsForBoard(rows, boardId, "spending", fiscalYear),
  };
}

function factProjection(row, model, source, fields) {
  const state = factState(row, model, source);
  const reference = sourceRef(row, model, source);
  const values = Object.fromEntries(fields.map((field) => [field, state === "available" ? sourceValue(row, source, field) : null]));
  return {
    ...values,
    state,
    state_label: stateLabel(state),
    fiscal_year: integer(row?.[source]?.fiscal_year),
    source_vintage: sourceVintage(row, model, source),
    source_ref: reference,
    read_model_row_key: rowKey(row),
    coverage: row?.[source]?.coverage || "unavailable",
  };
}

function sourceYearLabel(facts) {
  const years = [...new Set(facts.map((fact) => fact.fiscal_year).filter((year) => year != null))];
  return years.length === 1 ? `FY${years[0]}` : years.length ? years.map((year) => `FY${year}`).join(" / ") : "year unavailable";
}

function alignedYears(rows) {
  const years = rows.flatMap((row) => [row.budget.fiscal_year, row.spending.fiscal_year]).filter((year) => year != null);
  return years.length > 0 && new Set(years).size === 1;
}

/**
 * Project the canonical CB-MONEY-03 rows into a comparison-friendly shape.
 * This function selects facts; it never re-aggregates source observations.
 */
export function buildCommunityBoardMoneyComparison(model, boards = [], { fiscalYear = null } = {}) {
  const normalizedFiscalYear = fiscalYear == null ? null : integer(fiscalYear);
  const rows = (Array.isArray(boards) ? boards : [])
    .map((board) => ({ board, boardId: boardIdOf(board) }))
    .filter(({ boardId }) => boardId)
    .map(({ board, boardId }) => {
      const selected = selectedRows(model, boardId, normalizedFiscalYear);
      const budget = factProjection(selected.budget, model, "budget", ["adopted_amount"]);
      const spending = factProjection(selected.spending, model, "spending", ["posted_amount", "payment_count", "distinct_payee_count"]);
      const values = {
        adopted_budget: budget.adopted_amount,
        posted_amount: spending.posted_amount,
        payment_count: spending.payment_count,
        payee_count: spending.distinct_payee_count,
      };
      return {
        board_id: boardId,
        name: text(board.name || board.display_name),
        borough: text(board.borough),
        district: integer(board.district),
        dossier_href: communityBoardPageHref(boardId),
        fiscal_year: normalizedFiscalYear,
        budget,
        spending,
        values,
        states: { budget: budget.state, spending: spending.state },
        source_year_label: sourceYearLabel([budget, spending]),
        read_model_row_keys: {
          budget: budget.read_model_row_key,
          spending: spending.read_model_row_key,
        },
        exclusions: [
          ...(budget.state === "unavailable" ? ["adopted_budget_unavailable"] : []),
          ...(spending.state === "identity_unobserved" ? ["payment_identity_unobserved"] : []),
          ...(spending.state === "empty_source_result" ? ["payment_source_returned_no_rows"] : []),
          ...(spending.state === "unavailable" ? ["payments_unavailable"] : []),
          ...(budget.state === "stale" || spending.state === "stale" ? ["source_stale"] : []),
        ],
      };
    });
  const boundaryRows = rows.map((row) => ({
    board_id: row.board_id,
    budget: row.budget,
    spending: row.spending,
  }));
  const boundaries = {
    budget: sourceBoundary(model, boundaryRows, "budget"),
    spending: sourceBoundary(model, boundaryRows, "spending"),
  };
  const sourceYears = {
    budget: [...new Set(rows.map((row) => row.budget.fiscal_year).filter((year) => year != null))].sort((a, b) => a - b),
    spending: [...new Set(rows.map((row) => row.spending.fiscal_year).filter((year) => year != null))].sort((a, b) => a - b),
  };
  const aligned = alignedYears(rows);
  return {
    schema: COMMUNITY_BOARD_MONEY_COMPARISON_SCHEMA,
    version: COMMUNITY_BOARD_MONEY_COMPARISON_VERSION,
    read_model: {
      schema: model?.schema || null,
      version: model?.version || null,
      generated_at: model?.generated_at || null,
      checked_at: model?.checked_at || null,
      artifact: "site/data/community_board_money.json",
      receipt: "warehouse/receipts/proof/community_board_money_latest.json",
    },
    fiscal_year: normalizedFiscalYear,
    fiscal_year_mode: normalizedFiscalYear == null ? "latest_retained_fact_by_source" : "exact_fiscal_year",
    source_years: sourceYears,
    year_alignment: aligned ? "aligned" : "separate_source_years",
    ranking: {
      allowed: true,
      scope: "each_metric_only",
      reason: aligned
        ? "Each metric is sortable within the selected fiscal year; no combined ratio is calculated."
        : "Each source metric is sortable only within its explicitly labeled source fiscal year; sources are not combined.",
    },
    boundaries,
    coverage: {
      board_count: rows.length,
      rows_with_budget: rows.filter((row) => row.budget.state === "available").length,
      rows_with_payments: rows.filter((row) => row.spending.state === "available").length,
      excluded_or_partial: rows.filter((row) => row.exclusions.length > 0).length,
      source_as_of_exposed: true,
      no_combined_ratio: true,
      no_per_capita_metric: true,
    },
    rows,
  };
}

export function buildCommunityBoardMoneyComparisons(model, boards = []) {
  const years = Array.isArray(model?.fiscal_years) ? model.fiscal_years.map(integer).filter((year) => year != null).sort((a, b) => a - b) : [];
  const comparisons = { latest: buildCommunityBoardMoneyComparison(model, boards) };
  for (const fiscalYear of years) comparisons[`fy${fiscalYear}`] = buildCommunityBoardMoneyComparison(model, boards, { fiscalYear });
  return { default_key: "latest", available_keys: ["latest", ...years.map((year) => `fy${year}`)], comparisons };
}

export function validateCommunityBoardMoneyComparison(value) {
  const errors = [];
  if (value?.schema !== COMMUNITY_BOARD_MONEY_COMPARISON_SCHEMA) errors.push("invalid Community Board money comparison schema");
  if (value?.version !== COMMUNITY_BOARD_MONEY_COMPARISON_VERSION) errors.push("invalid Community Board money comparison version");
  if (!Array.isArray(value?.rows)) errors.push("money comparison rows are missing");
  if (value?.coverage?.no_combined_ratio !== true) errors.push("money comparison must not calculate a combined ratio");
  if (value?.coverage?.no_per_capita_metric !== true) errors.push("money comparison must not include per-capita metrics");
  const keys = new Set();
  for (const row of value?.rows || []) {
    if (!row.board_id || !row.dossier_href) errors.push("comparison row is missing board identity or dossier link");
    for (const [source, key] of Object.entries(row.read_model_row_keys || {}).filter(([, value]) => Boolean(value))) {
      if (keys.has(`${row.board_id}:${source}:${key}`)) errors.push(`duplicate comparison source key ${row.board_id}:${source}:${key}`);
      keys.add(`${row.board_id}:${source}:${key}`);
    }
    if (row.values?.posted_share_of_adopted != null || row.values?.per_capita != null) errors.push(`unsupported comparison metric for ${row.board_id}`);
  }
  if (value?.boundaries?.budget == null || value?.boundaries?.spending == null) errors.push("source-as-of boundaries are missing");
  return { ok: errors.length === 0, errors };
}

export function moneyComparisonMetricValue(row, metric) {
  return row?.values?.[metric] == null ? null : finite(row.values[metric]);
}

export function moneyComparisonMetricSourceYear(row, metric) {
  const definition = MONEY_COMPARISON_METRICS[metric];
  const fact = row?.[definition?.source];
  return integer(fact?.fiscal_year);
}

export function moneyComparisonMapProjection(comparison, metric = "adopted_budget") {
  const values = (comparison?.rows || []).map((row) => moneyComparisonMetricValue(row, metric)).filter((value) => value != null).sort((a, b) => a - b);
  const unique = [...new Set(values)];
  return Object.fromEntries((comparison?.rows || []).map((row) => {
    const value = moneyComparisonMetricValue(row, metric);
    const index = value == null ? -1 : unique.indexOf(value);
    const level = index < 0 ? null : unique.length <= 1 ? 3 : Math.min(5, Math.floor((index / (unique.length - 1)) * 4) + 1);
    return [row.board_id, { value, level, state: row[MONEY_COMPARISON_METRICS[metric].source]?.state || "unavailable" }];
  }));
}

export { METRIC_KEYS };
