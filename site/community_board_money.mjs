import { officialSourceLink } from "./affordance_grammar.mjs";
import { ABSENCE_REASONS } from "./edge_summary.mjs";

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

const CARD_STATES = new Set([
  "both_sources",
  "separate_fiscal_years",
  "budget_only",
  "spending_only",
  "unmatched_identity",
  "empty_source_result",
  "stale_source",
  "unavailable",
]);

const htmlEsc = (value) => String(value ?? "").replace(/[<>&"']/g, (char) => ({
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&#39;",
}[char]));

function cardCurrency(value) {
  return value == null
    ? null
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function cardCount(value) {
  return value == null ? null : new Intl.NumberFormat("en-US").format(value);
}

function cardFiscalYear(value) {
  return integer(value) == null ? null : `FY${integer(value)}`;
}

function cardDate(value) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? raw
    : new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(parsed);
}

function paymentThroughDate(spending, model) {
  const vintage = spending?.source_vintage;
  const sourceVintage = model?.sources?.spending?.source_vintage;
  return cardDate(
    (vintage && typeof vintage === "object" ? vintage.payment_issue_date_through : null)
      || (sourceVintage && typeof sourceVintage === "object" ? sourceVintage.payment_issue_date_through : null),
  );
}

function cardRows(model, boardId) {
  return moneyReadModelRows(model)
    .filter((row) => row?.board_id === boardId)
    .sort((left, right) => Number(right.fiscal_year || 0) - Number(left.fiscal_year || 0));
}

function usableBudget(row) {
  return Boolean(row?.budget?.source_ref && row.budget.adopted_amount != null && row.budget.fiscal_year != null);
}

function usableSpending(row, model) {
  return Boolean(
    row?.spending?.source_ref
      && row.spending.posted_amount != null
      && row.spending.fiscal_year != null
      && row.spending.coverage !== "identity_unobserved"
      && row.spending.coverage !== "empty_source_result"
      && paymentThroughDate(row.spending, model),
  );
}

function staleRow(row, model) {
  return row?.coverage?.state === "stale_source"
    || row?.coverage?.budget === "stale"
    || row?.coverage?.spending === "stale"
    || model?.sources?.budget?.status === "stale"
    || model?.sources?.spending?.status === "stale";
}

/**
 * Select the exact board facts needed by the resident card. A same-FY row is
 * preferred; otherwise budget and payments remain visibly separate facts.
 */
export function buildCommunityBoardMoneyCardView(model, boardId) {
  if (!model || !boardId) return null;
  const rows = cardRows(model, boardId);
  if (!rows.length) return {
    board_id: boardId,
    state: "unavailable",
    absence_reason: ABSENCE_REASONS.RETRIEVAL_FAILURE,
    fiscal_years: [],
    budget: null,
    spending: null,
    source_refs: [],
  };

  const both = rows.find((row) => usableBudget(row) && usableSpending(row, model));
  const budgetRow = both || rows.find(usableBudget) || null;
  const spendingRow = both || rows.find((row) => usableSpending(row, model)) || null;
  const emptyRow = rows.find((row) => row?.spending?.coverage === "empty_source_result") || null;
  const unmatchedRow = rows.find((row) => row?.spending?.coverage === "identity_unobserved") || null;
  const budget = budgetRow?.budget || null;
  const spending = spendingRow?.spending || null;
  const budgetFiscalYear = budget?.fiscal_year ?? null;
  const spendingFiscalYear = spending?.fiscal_year ?? null;
  const stale = staleRow(budgetRow || spendingRow, model);
  let state = "unavailable";
  if (stale) state = "stale_source";
  else if (both) state = "both_sources";
  else if (emptyRow && !spending) state = "empty_source_result";
  else if (unmatchedRow && !spending) state = "unmatched_identity";
  else if (budget && spending) state = "separate_fiscal_years";
  else if (budget) state = unmatchedRow ? "unmatched_identity" : "budget_only";
  else if (spending) state = "spending_only";
  else if (unmatchedRow) state = "unmatched_identity";

  const sourceRefs = [budget?.source_ref, spending?.source_ref].filter(Boolean);
  const fiscalYears = [...new Set([budgetFiscalYear, spendingFiscalYear].filter((year) => year != null))];
  // "empty_source_result" is a materialized, sourced zero (RU-02 A2/A3); an
  // unresolved identity is its own distinct concept and is never relabeled
  // as a zero. States outside this set describe partial coverage, not
  // absence, and are left untagged.
  const absenceReason = state === "unavailable"
    ? ABSENCE_REASONS.RETRIEVAL_FAILURE
    : state === "empty_source_result"
      ? ABSENCE_REASONS.VALID_ZERO
      : null;
  return {
    board_id: boardId,
    state,
    absence_reason: absenceReason,
    fiscal_year: both?.fiscal_year ?? null,
    fiscal_years: fiscalYears,
    separate_fiscal_years: budgetFiscalYear != null && spendingFiscalYear != null && budgetFiscalYear !== spendingFiscalYear,
    budget,
    spending,
    source_refs: [...new Map([
      ...sourceRefs,
      ...(emptyRow?.spending?.source_ref ? [emptyRow.spending.source_ref] : []),
      ...(unmatchedRow?.spending?.source_ref ? [unmatchedRow.spending.source_ref] : []),
    ].map((ref) => [`${ref.role}:${ref.source_system}`, ref])).values()],
    payment_through: paymentThroughDate(spending, model),
    stale,
    identity_unobserved: Boolean(unmatchedRow),
    empty_source_result: Boolean(emptyRow),
    model_checked_at: model.checked_at || null,
  };
}

function sourceLink(ref, label) {
  if (!ref?.source_url) return htmlEsc(label);
  return officialSourceLink({
    href: ref.source_url,
    label,
    className: "community-board-money-source-link",
    escape: htmlEsc,
  });
}

function sourceLabel(ref) {
  return ref?.role === "budget" ? "NYC Expense Budget" : "Checkbook NYC";
}

function stateCopy(card) {
  if (card.state === "stale_source") return "These figures were observed, but one or more sources need a fresh check.";
  if (card.state === "separate_fiscal_years") return "The available budget and payment facts are from different fiscal years and are shown separately.";
  if (card.state === "budget_only") return `${card.payment_through ? `Payments posted through ${card.payment_through} are` : "Payments are"} unavailable from the current source for this fiscal year.`;
  if (card.state === "spending_only") return "The adopted budget is unavailable from the current source for this fiscal year.";
  if (card.state === "unmatched_identity") return `The current source does not establish an accepted exact financial identity for this board's payments${card.payment_through ? ` through ${card.payment_through}` : ""}.`;
  if (card.state === "empty_source_result") return `No posted payments were returned for this board in the checked source${card.payment_through ? ` through ${card.payment_through}` : ""}.`;
  if (card.state === "unavailable") return "Budget and spending facts are unavailable from the current sources.";
  return "Budget and posted payment facts are available for this board.";
}

function metric(label, value, detail = "") {
  if (value == null && !detail) return "";
  return `<div class="community-board-money-metric"><dt>${htmlEsc(label)}</dt><dd>${value == null ? "Unavailable" : htmlEsc(value)}</dd>${detail ? `<small>${htmlEsc(detail)}</small>` : ""}</div>`;
}

function spendingDetail(card) {
  if (!card.spending) return "";
  const facts = [
    card.spending.payment_count != null ? `${cardCount(card.spending.payment_count)} payments` : "",
    card.spending.distinct_payee_count != null ? `${cardCount(card.spending.distinct_payee_count)} payees` : "",
  ].filter(Boolean);
  return facts.join(" · ");
}

function topPayees(card) {
  const payees = Array.isArray(card.spending?.top_payees) ? card.spending.top_payees.slice(0, 3) : [];
  if (!payees.length) return "";
  return `<div class="community-board-money-top-payees"><h3>Top payees</h3><ul>${payees.map((payee) => `<li><span>${htmlEsc(payee.payee_name || "Unnamed payee")}</span><strong>${htmlEsc(cardCurrency(payee.posted_payment_amount))}</strong></li>`).join("")}</ul></div>`;
}

/** Render the small financial module embedded in a Community Board dossier. */
export function renderCommunityBoardMoneyCard(card) {
  if (!card || !CARD_STATES.has(card.state)) return "";
  const sourceRefs = Array.isArray(card.source_refs) ? card.source_refs : [];
  const budgetYear = cardFiscalYear(card.budget?.fiscal_year);
  const spendingYear = cardFiscalYear(card.spending?.fiscal_year);
  const headingDetail = card.state === "both_sources" && budgetYear ? budgetYear : "Available fiscal facts";
  const budgetDetail = budgetYear || "Fiscal year not provided";
  const through = card.payment_through;
  const spendingLabel = through
    ? `Payments posted through ${through}`
    : card.spending
      ? "Payments posted through a date not provided by the current source"
      : "Payments posted";
  const spendingDetailCopy = [spendingYear, spendingDetail(card)].filter(Boolean).join(" · ");
  const provenance = sourceRefs.length
    ? `<details class="community-board-money-provenance"><summary>Sources and coverage</summary><div><ul>${sourceRefs.map((ref) => `<li>${sourceLink(ref, sourceLabel(ref))}${ref.fiscal_year ? ` · ${htmlEsc(cardFiscalYear(ref.fiscal_year))}` : ""}${ref.source_vintage?.payment_issue_date_through ? ` · through ${htmlEsc(cardDate(ref.source_vintage.payment_issue_date_through))}` : ""}</li>`).join("")}</ul><p>This card reports funds budgeted to and payments posted by this Community Board. Community District spending is a separate measure.</p></div></details>`
    : "";
  const identityNote = card.identity_unobserved && card.state !== "unmatched_identity"
    ? `<p class="community-board-money-note">The source has no accepted payment identity for this board, so no payment total is shown.</p>`
    : "";
  return `<section id="community-board-money" class="node-section node-card civic-object-section community-board-money-card" data-community-board-money="1" data-money-state="${htmlEsc(card.state)}" aria-labelledby="community-board-money-heading"><div class="community-board-money-heading"><div><p class="community-board-money-kicker">Board finances</p><h2 id="community-board-money-heading">Budget &amp; spending <span>${htmlEsc(headingDetail)}</span></h2></div></div><p class="community-board-money-boundary">Money budgeted to and paid by this Community Board. Community District spending is a separate measure.</p><p class="community-board-money-state">${htmlEsc(stateCopy(card))}</p><dl class="community-board-money-metrics">${card.budget?.adopted_amount != null ? metric("Adopted budget", cardCurrency(card.budget.adopted_amount), budgetDetail) : ""}${card.spending?.posted_amount != null && card.payment_through ? metric(spendingLabel, cardCurrency(card.spending.posted_amount), spendingDetailCopy) : ""}</dl>${card.spending?.posted_amount != null && !card.payment_through ? `<p class="community-board-money-unavailable">${htmlEsc(spendingLabel)}: unavailable</p>` : ""}${topPayees(card)}${identityNote}${provenance}</section>`;
}
