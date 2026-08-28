/**
 * Resident-ready financial projection for specific Community Boards.
 *
 * This module joins the already-materialized adopted-budget and posted-payment
 * facts by the reviewed board id and fiscal year. It does not fetch either
 * source, use geography as a payer join, or derive a balance from unlike
 * accounting measures.
 */

export const COMMUNITY_BOARD_MONEY_READ_MODEL_SCHEMA = "cityscroll.community_board_money_read_model.v1";
export const COMMUNITY_BOARD_MONEY_READ_MODEL_VERSION = 1;
export const MONEY_SOURCE_MAX_AGE_MS = 36 * 60 * 60 * 1000;

const SOURCE_STATUSES = new Set(["available", "partial", "stale", "unavailable"]);
const text = (value) => String(value ?? "").trim() || null;
const number = (value) => {
  if (value == null || text(value) === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const integer = (value) => Number.isInteger(Number(value)) ? Number(value) : null;
const rowsOf = (model) => Array.isArray(model?.rows) ? model.rows.filter(Boolean) : [];
const time = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

function rounded(value) {
  return value == null ? null : Math.round(Number(value) * 100) / 100;
}

function sourceGeneratedAt(model) {
  return model?.generated_at || model?.source?.observed_at || null;
}

function ageStatus(generatedAt, now, maxAgeMs) {
  const generated = time(generatedAt);
  const checked = time(now) ?? Date.now();
  if (generated == null) return "unavailable";
  return checked - generated > maxAgeMs ? "stale" : "available";
}

function declaredCoverageStatus(model, role) {
  if (!model) return "unavailable";
  if (role === "spending" && model.coverage?.status === "partial_board_identity_coverage") return "partial";
  if (role === "budget" && model.coverage?.accepted_board_facts === 0) return "partial";
  return "available";
}

function sourceStatus(model, role, now, maxAgeMs) {
  if (!model) {
    return {
      status: "unavailable",
      freshness: "unavailable",
      coverage: "unavailable",
      available: false,
      generated_at: null,
    };
  }
  const freshness = ageStatus(sourceGeneratedAt(model), now, maxAgeMs);
  const coverage = declaredCoverageStatus(model, role);
  const status = freshness === "stale" ? "stale" : coverage;
  return {
    status,
    freshness,
    coverage,
    available: status !== "unavailable",
    generated_at: sourceGeneratedAt(model),
  };
}

function uniqueSorted(values) {
  return [...new Set(values.map(Number).filter(Number.isInteger))].sort((left, right) => left - right);
}

function boardIdFrom(board) {
  return text(board?.board_id || board?.body_id || board?.id);
}

function sourceReference(role, model, row, artifact, receipt) {
  const provenance = row?.provenance || {};
  const source = model?.source || {};
  const spendingSource = role === "spending";
  return {
    role,
    source_system: row?.source_system || source.source_system || (spendingSource ? "checkbook_payment_population" : "expense_budget"),
    dataset_id: row?.provenance?.dataset_id || source.dataset_id || null,
    source_contract: source.source_contract || null,
    source_url: provenance.source_url || source.source_url || source.endpoint || null,
    artifact,
    receipt,
    source_native_key: row?.source_native_key || null,
    source_native_key_field: row?.source_native_key_field || source.source_native_key_field || null,
    source_vintage: row?.source_vintage ?? provenance.source_vintage ?? source.source_vintage ?? null,
    observed_at: row?.observed_at || provenance.observed_at || source.observed_at || model?.generated_at || null,
    fiscal_year: integer(row?.fiscal_year),
    publication_date: row?.publication_date || source.pinned_slice?.publication_date || null,
    input_rows: row?.aggregation?.input_rows ?? row?.payment_count ?? null,
  };
}

function indexRows(model, label) {
  const index = new Map();
  for (const row of rowsOf(model)) {
    const boardId = boardIdFrom(row);
    const fiscalYear = integer(row?.fiscal_year);
    if (!boardId || fiscalYear == null) continue;
    const key = `${boardId}:${fiscalYear}`;
    if (index.has(key)) throw new Error(`${label} contains duplicate board/FY fact ${key}`);
    index.set(key, row);
  }
  return index;
}

function budgetProjection(row, model, sourceState, artifact, receipt) {
  const reference = row ? sourceReference("budget", model, row, artifact, receipt) : null;
  const coverage = row
    ? sourceState.status === "stale" ? "stale" : "complete"
    : sourceState.status === "stale" ? "stale" : "unavailable";
  return {
    adopted_amount: row ? rounded(number(row.adopted_amount)) : null,
    personnel_amount: row ? rounded(number(row.personnel_amount)) : null,
    otps_amount: row ? rounded(number(row.otps_amount)) : null,
    current_amount: null,
    modified_amount: null,
    commitments_amount: null,
    fiscal_year: row ? integer(row.fiscal_year) : null,
    source_vintage: row?.source_vintage ?? model?.source?.source_vintage ?? null,
    observed_at: row?.observed_at || model?.source?.observed_at || model?.generated_at || null,
    coverage,
    source_ref: reference,
  };
}

function spendingProjection(row, model, sourceState, artifact, receipt) {
  const rowCoverage = text(row?.coverage_status);
  const identityUnobserved = rowCoverage === "identity_unobserved";
  const usable = Boolean(row) && !identityUnobserved;
  const reference = row ? sourceReference("spending", model, row, artifact, receipt) : null;
  const coverage = row
    ? sourceState.status === "stale" ? "stale" : rowCoverage || "unknown"
    : sourceState.status === "stale" ? "stale" : "unavailable";
  return {
    posted_amount: usable ? rounded(number(row.posted_payment_amount)) : null,
    payment_count: usable ? integer(row.payment_count) : null,
    distinct_payee_count: usable ? integer(row.distinct_payee_count) : null,
    top_payees: usable && Array.isArray(row.top_payees) ? row.top_payees : [],
    fiscal_year: usable ? integer(row.fiscal_year) : null,
    source_vintage: row?.source_vintage ?? model?.source?.source_vintage ?? null,
    observed_at: row?.observed_at || model?.source?.observed_at || model?.generated_at || null,
    coverage,
    source_ref: reference,
  };
}

function rowState(budget, spending) {
  if (budget.coverage === "stale" || spending.coverage === "stale") return "stale_source";
  if (budget.source_ref && spending.source_ref && budget.coverage !== "stale" && spending.coverage !== "stale") return "both_sources";
  if (budget.source_ref) return "budget_only";
  if (spending.coverage === "identity_unobserved") return "unmatched_identity";
  if (spending.coverage === "empty_source_result") return "empty_source_result";
  if (spending.source_ref) return "spending_only";
  return "unavailable";
}

function rowCoverage(budget, spending, state) {
  return {
    budget: budget.coverage,
    spending: spending.coverage,
    binding: state === "unavailable" || state === "unmatched_identity" ? "unknown" : "exact",
    state,
  };
}

function projectionInputs(row) {
  return {
    budget: {
      present: Boolean(row.budget.source_ref),
      fiscal_year: row.budget.fiscal_year,
      adopted_amount: row.budget.adopted_amount,
      personnel_amount: row.budget.personnel_amount,
      otps_amount: row.budget.otps_amount,
      current_amount: row.budget.current_amount,
      modified_amount: row.budget.modified_amount,
      commitments_amount: row.budget.commitments_amount,
    },
    spending: {
      present: Boolean(row.spending.source_ref),
      fiscal_year: row.spending.fiscal_year,
      posted_amount: row.spending.posted_amount,
      payment_count: row.spending.payment_count,
      distinct_payee_count: row.spending.distinct_payee_count,
    },
  };
}

/** Build one source-qualified object for every known board/FY key. */
export function buildCommunityBoardMoneyReadModel({
  boards = [],
  adoptedBudget = null,
  paymentActuals = null,
  generatedAt = null,
  now = generatedAt || new Date().toISOString(),
  maxAgeMs = MONEY_SOURCE_MAX_AGE_MS,
  budgetArtifact = "site/data/community_board_adopted_budget.json",
  budgetReceipt = "warehouse/receipts/proof/community_board_adopted_budget_latest.json",
  spendingArtifact = "site/data/community_board_payment_actuals.json",
  spendingReceipt = "warehouse/receipts/proof/community_board_payment_actuals_latest.json",
} = {}) {
  const boardIds = [...new Set((Array.isArray(boards) ? boards : []).map(boardIdFrom).filter(Boolean))].sort();
  const budgetRows = rowsOf(adoptedBudget);
  const spendingRows = rowsOf(paymentActuals);
  const budgetYears = [
    ...budgetRows.map((row) => row.fiscal_year),
    adoptedBudget?.source?.pinned_slice?.fiscal_year,
  ];
  const spendingYears = [
    ...spendingRows.map((row) => row.fiscal_year),
    ...(Array.isArray(paymentActuals?.fiscal_years) ? paymentActuals.fiscal_years : []),
  ];
  const fiscalYears = uniqueSorted([...budgetYears, ...spendingYears]);
  const budgetIndex = indexRows(adoptedBudget, "adopted budget");
  const spendingIndex = indexRows(paymentActuals, "payment actuals");
  const budgetState = sourceStatus(adoptedBudget, "budget", now, maxAgeMs);
  const spendingState = sourceStatus(paymentActuals, "spending", now, maxAgeMs);
  const rows = [];

  for (const boardId of boardIds) {
    for (const fiscalYear of fiscalYears) {
      const key = `${boardId}:${fiscalYear}`;
      const budget = budgetProjection(
        budgetIndex.get(key),
        adoptedBudget,
        budgetState,
        budgetArtifact,
        budgetReceipt,
      );
      const spending = spendingProjection(
        spendingIndex.get(key),
        paymentActuals,
        spendingState,
        spendingArtifact,
        spendingReceipt,
      );
      const row = {
        board_id: boardId,
        fiscal_year: fiscalYear,
        budget,
        spending,
        derived: {
          posted_share_of_adopted: null,
          ratio_status: "not_certified",
        },
        coverage: rowCoverage(budget, spending, rowState(budget, spending)),
        sources: [budget.source_ref, spending.source_ref].filter(Boolean),
      };
      row.projection_inputs = projectionInputs(row);
      rows.push(row);
    }
  }

  const generated = generatedAt || sourceGeneratedAt(adoptedBudget) || sourceGeneratedAt(paymentActuals) || null;
  const currentFiscalYear = integer(adoptedBudget?.source?.pinned_slice?.fiscal_year)
    || Math.max(...fiscalYears, 0) || null;
  const states = Object.fromEntries([...new Set(rows.map((row) => row.coverage.state))].sort().map((state) => [
    state,
    rows.filter((row) => row.coverage.state === state).length,
  ]));

  return {
    schema: COMMUNITY_BOARD_MONEY_READ_MODEL_SCHEMA,
    version: COMMUNITY_BOARD_MONEY_READ_MODEL_VERSION,
    generated_at: generated,
    checked_at: now,
    current_fiscal_year: currentFiscalYear,
    fiscal_years: fiscalYears,
    sources: {
      budget: {
        source_system: adoptedBudget?.source?.source_system || "expense_budget",
        dataset_id: adoptedBudget?.source?.dataset_id || null,
        artifact: budgetArtifact,
        receipt: budgetReceipt,
        source_url: adoptedBudget?.source?.source_url || null,
        source_vintage: adoptedBudget?.source?.source_vintage || null,
        generated_at: budgetState.generated_at,
        status: budgetState.status,
        freshness: budgetState.freshness,
        coverage: budgetState.coverage,
        available: budgetState.available,
        fiscal_years: uniqueSorted(budgetYears),
        accepted_board_facts: adoptedBudget?.coverage?.accepted_board_facts ?? 0,
        unmatched_rows: adoptedBudget?.coverage?.unmatched_rows ?? null,
      },
      spending: {
        source_system: paymentActuals?.source?.source_system || "checkbook_payment_population",
        source_contract: paymentActuals?.source?.source_contract || null,
        artifact: spendingArtifact,
        receipt: spendingReceipt,
        source_url: paymentActuals?.source?.endpoint || null,
        source_vintage: paymentActuals?.source?.source_vintage || null,
        generated_at: spendingState.generated_at,
        status: spendingState.status,
        freshness: spendingState.freshness,
        coverage: spendingState.coverage,
        available: spendingState.available,
        fiscal_years: uniqueSorted(spendingYears),
        board_states: paymentActuals?.coverage?.board_states || null,
        unmatched_agencies: paymentActuals?.payment_population?.unmatched_agencies || [],
      },
    },
    coverage: {
      board_count: boardIds.length,
      board_fy_rows: rows.length,
      fiscal_years: fiscalYears,
      states,
      statement: "Adopted budget and posted payments are separate source facts. Missing, unmatched, stale, or cross-fiscal-year facts remain unknown; this model does not estimate a balance.",
    },
    rows,
  };
}

export function validateCommunityBoardMoneyReadModel(value) {
  const errors = [];
  if (value?.schema !== COMMUNITY_BOARD_MONEY_READ_MODEL_SCHEMA) errors.push("invalid Community Board money read model schema");
  if (value?.version !== COMMUNITY_BOARD_MONEY_READ_MODEL_VERSION) errors.push("invalid Community Board money read model version");
  if (!Array.isArray(value?.rows)) errors.push("money read model rows are missing");
  if (JSON.stringify(value || {}).toLowerCase().includes("remaining budget")) errors.push("money read model must not derive remaining budget");
  const seen = new Set();
  for (const row of value?.rows || []) {
    const key = `${row.board_id}:${row.fiscal_year}`;
    if (seen.has(key)) errors.push(`duplicate money row ${key}`);
    seen.add(key);
    if (!row.budget || !row.spending || !row.derived || !row.coverage) errors.push(`incomplete money row ${key}`);
    if (row.derived?.posted_share_of_adopted !== null) errors.push(`uncertified ratio populated for ${key}`);
    if (row.derived?.ratio_status !== "not_certified") errors.push(`ratio certification missing for ${key}`);
    if (!Array.isArray(row.sources)) errors.push(`source references missing for ${key}`);
    if (["unavailable", "identity_unobserved"].includes(row.spending?.coverage)
      && (row.spending?.posted_amount !== null || row.spending?.payment_count !== null)) {
      errors.push(`unknown spending was filled for ${key}`);
    }
    if (row.budget?.coverage === "unavailable"
      && ["adopted_amount", "personnel_amount", "otps_amount", "current_amount", "modified_amount", "commitments_amount"]
        .some((field) => row.budget[field] !== null)) {
      errors.push(`unknown budget was filled for ${key}`);
    }
    for (const source of row.sources || []) {
      if (!source.artifact || !source.receipt || !source.source_system) errors.push(`incomplete source reference for ${key}`);
    }
  }
  for (const source of [value?.sources?.budget, value?.sources?.spending]) {
    if (!source || !SOURCE_STATUSES.has(source.status)) errors.push("invalid money source status");
  }
  return { ok: errors.length === 0, errors };
}

export function moneyReadModelRows(value) {
  return Array.isArray(value?.rows) ? value.rows : [];
}

export function moneyReadModelSourceStatus(value, source) {
  return value?.sources?.[source]?.status || "unavailable";
}
