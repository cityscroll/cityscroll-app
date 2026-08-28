// Source-qualified payment actuals for specific Community Board institutions.
//
// This is an additive projection over the retained Checkbook Spending
// population. It does not acquire payments and it never uses geography,
// vendor address, or descriptive text as an identity join.

export const COMMUNITY_BOARD_PAYMENT_ACTUALS_SCHEMA = "cityscroll.community_board_payment_actuals.v1";
export const COMMUNITY_BOARD_PAYMENT_ACTUALS_VERSION = 1;
export const PAYMENT_POPULATION_SOURCE_SYSTEM = "checkbook_payment_population";
export const CHECKBOOK_SPENDING_IDENTITY_SOURCE_SYSTEM = "checkbook_spending";
export const EXACT_CONTRACT_JOIN_METHOD = "exact_contract_id";

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const identityKey = (value) => clean(value).toUpperCase();

function numericAmount(value) {
  if (value == null || clean(value) === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function sourceBindings(registry) {
  return (Array.isArray(registry?.bindings) ? registry.bindings : [])
    .filter((binding) => binding?.source_system === CHECKBOOK_SPENDING_IDENTITY_SOURCE_SYSTEM
      && binding?.binding_status === "accepted")
    .map((binding) => ({
      ...binding,
      identity_key: identityKey(binding.publisher_identity),
    }))
    .filter((binding) => binding.identity_key);
}

/**
 * Resolve a payment's publisher agency only through an accepted CB-MONEY-00
 * Checkbook Spending binding. The population has the publisher label, while
 * the reviewed binding retains the exact agency_code used by Checkbook.
 */
export function resolveCommunityBoardPaymentIdentity(registry, payment) {
  const key = identityKey(payment?.agency);
  if (!key) return null;
  const matches = sourceBindings(registry).filter((binding) => binding.identity_key === key);
  if (matches.length !== 1) return null;
  const binding = matches[0];
  return {
    board_id: binding.board_id,
    source_system: CHECKBOOK_SPENDING_IDENTITY_SOURCE_SYSTEM,
    source_native_key_field: binding.source_native_key_field,
    source_native_board_key: binding.source_native_board_key,
    publisher_identity: binding.publisher_identity,
    binding_status: binding.binding_status,
    binding_method: "exact_reviewed_publisher_identity",
  };
}

/** Stable observation reference retained by every counted aggregate row. */
export function paymentObservationRef(payment) {
  const id = clean(payment?.transaction_id || payment?.source_system_id);
  return id ? `${PAYMENT_POPULATION_SOURCE_SYSTEM}:${id.replace(/^checkbook_payment_population:/, "")}` : null;
}

function paymentObservation(payment, identity, source) {
  const ref = paymentObservationRef(payment);
  return {
    source_observation_ref: ref,
    source_system: PAYMENT_POPULATION_SOURCE_SYSTEM,
    source_system_id: clean(payment?.transaction_id || payment?.source_system_id) || null,
    source_receipt: source.source_receipt,
    source_endpoint: source.endpoint,
    source_vintage: source.source_vintage,
    identity: {
      source_system: identity.source_system,
      source_native_key_field: identity.source_native_key_field,
      source_native_board_key: identity.source_native_board_key,
      publisher_identity: identity.publisher_identity,
      binding_method: identity.binding_method,
    },
    transaction_id: clean(payment?.transaction_id) || null,
    document_id: clean(payment?.document_id) || null,
    contract_id: clean(payment?.contract_id) || null,
    fiscal_year: Number.isInteger(Number(payment?.fiscal_year)) ? Number(payment.fiscal_year) : null,
    issue_date: clean(payment?.issue_date) || null,
    payee_name: clean(payment?.payee_name) || null,
    check_amount: numericAmount(payment?.check_amount),
  };
}

function aggregateRows(rows, source) {
  const payees = new Map();
  const contracts = new Map();
  let amount = 0;
  for (const row of rows) {
    if (Number.isFinite(row.check_amount)) amount += row.check_amount;
    const payee = row.payee_name || "Unknown / not published";
    const payeeValue = payees.get(payee) || { payee_name: payee, posted_payment_amount: 0, payment_count: 0 };
    payeeValue.posted_payment_amount = roundMoney(payeeValue.posted_payment_amount + (Number(row.check_amount) || 0));
    payeeValue.payment_count += 1;
    payees.set(payee, payeeValue);
    if (row.contract_id) {
      const contractValue = contracts.get(row.contract_id)
        || { contract_id: row.contract_id, posted_payment_amount: 0, payment_count: 0 };
      contractValue.posted_payment_amount = roundMoney(contractValue.posted_payment_amount + (Number(row.check_amount) || 0));
      contractValue.payment_count += 1;
      contracts.set(row.contract_id, contractValue);
    }
  }
  const sortValues = (left, right) => right.posted_payment_amount - left.posted_payment_amount
    || right.payment_count - left.payment_count
    || String(left.payee_name || left.contract_id).localeCompare(String(right.payee_name || right.contract_id));
  const topPayees = [...payees.values()].sort(sortValues).slice(0, 3);
  const topContracts = [...contracts.values()].sort((left, right) => right.posted_payment_amount - left.posted_payment_amount
    || right.payment_count - left.payment_count
    || left.contract_id.localeCompare(right.contract_id)).slice(0, 3);
  return {
    posted_payment_amount: roundMoney(amount),
    payment_count: rows.length,
    distinct_payee_count: payees.size,
    top_payees: topPayees,
    distinct_contract_count: contracts.size,
    top_contracts: topContracts,
    source_vintage: source.source_vintage,
    observed_at: source.observed_at,
  };
}

function emptyAggregate(source) {
  return {
    posted_payment_amount: 0,
    payment_count: 0,
    distinct_payee_count: 0,
    top_payees: [],
    distinct_contract_count: 0,
    top_contracts: [],
    source_vintage: source.source_vintage,
    observed_at: source.observed_at,
  };
}

/**
 * Materialize one board/FY payment projection from already-retained rows.
 * Duplicate source transaction identities are retained in the receipt counts
 * but contribute to an aggregate once.
 */
export function buildCommunityBoardPaymentActuals({
  boards = [],
  identityRegistry,
  payments = [],
  source = {},
  fiscalYears = [],
  generatedAt = null,
  throughDate = "2026-08-27",
  candidatePaymentRows = null,
} = {}) {
  const boardList = Array.isArray(boards) ? boards : [];
  const years = [...new Set((Array.isArray(fiscalYears) ? fiscalYears : [])
    .map(Number)
    .filter(Number.isInteger))].sort((left, right) => left - right);
  const sourceInfo = {
    source_receipt: source.source_receipt || null,
    endpoint: source.endpoint || null,
    source_vintage: source.source_vintage || null,
    observed_at: source.observed_at || null,
  };
  const groups = new Map();
  const seenByGroup = new Map();
  const identityCounts = new Map();
  const unmatchedAgencies = new Map();
  let invalidRows = 0;
  let duplicateRows = 0;
  let candidateRows = Number.isInteger(candidatePaymentRows) ? candidatePaymentRows : 0;

  for (const payment of Array.isArray(payments) ? payments : []) {
    if (candidatePaymentRows == null) candidateRows += 1;
    const year = Number(payment?.fiscal_year);
    if (!Number.isInteger(year)) { invalidRows += 1; continue; }
    if (years.length && !years.includes(year)) continue;
    const identity = resolveCommunityBoardPaymentIdentity(identityRegistry, payment);
    if (!identity) {
      const agency = clean(payment?.agency) || "Unknown / not published";
      unmatchedAgencies.set(agency, (unmatchedAgencies.get(agency) || 0) + 1);
      continue;
    }
    const observationRef = paymentObservationRef(payment);
    if (!observationRef) { invalidRows += 1; continue; }
    if (numericAmount(payment?.check_amount) == null) { invalidRows += 1; continue; }
    const groupKey = `${identity.board_id}:${year}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    if (!seenByGroup.has(groupKey)) seenByGroup.set(groupKey, new Set());
    const seen = seenByGroup.get(groupKey);
    if (seen.has(observationRef)) { duplicateRows += 1; continue; }
    seen.add(observationRef);
    identityCounts.set(identity.board_id, (identityCounts.get(identity.board_id) || 0) + 1);
    groups.get(groupKey).push({ ...payment, ...paymentObservation(payment, identity, sourceInfo) });
  }

  const rows = [];
  for (const board of boardList) {
    const boardId = clean(board?.board_id || board?.id);
    if (!boardId) continue;
    for (const fiscalYear of years) {
      const groupKey = `${boardId}:${fiscalYear}`;
      const observations = groups.get(groupKey) || [];
      const hasIdentity = sourceBindings(identityRegistry).some((binding) => binding.board_id === boardId);
      const aggregate = observations.length ? aggregateRows(observations, sourceInfo) : emptyAggregate(sourceInfo);
      const coverageStatus = !hasIdentity
        ? "identity_unobserved"
        : observations.length
          ? "posted_through_source_vintage"
          : "empty_source_result";
      rows.push({
        board_id: boardId,
        fiscal_year: fiscalYear,
        ...aggregate,
        coverage_status: coverageStatus,
        payment_copy: `Payments posted through ${new Date(`${throughDate}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`,
        contract_relation: {
          method: EXACT_CONTRACT_JOIN_METHOD,
          source_field: "contract_id",
          target: "checkbook_contracts.contract_id",
          exact_only: true,
        },
        observations,
      });
    }
  }

  const acceptedIdentityRows = rows.reduce((sum, row) => sum + row.payment_count, 0);
  const sourceRows = Array.isArray(payments) ? payments.length : 0;
  return {
    schema: COMMUNITY_BOARD_PAYMENT_ACTUALS_SCHEMA,
    version: COMMUNITY_BOARD_PAYMENT_ACTUALS_VERSION,
    workstream_card: "CB-MONEY-02",
    generated_at: generatedAt,
    source: {
      source_system: PAYMENT_POPULATION_SOURCE_SYSTEM,
      source_contract: "cityscroll.checkbook.payments.fiscal_year.v1",
      publisher: "Office of the New York City Comptroller",
      endpoint: sourceInfo.endpoint,
      source_receipt: sourceInfo.source_receipt,
      source_vintage: sourceInfo.source_vintage,
      observed_at: sourceInfo.observed_at,
      source_data_through: source.source_data_through || null,
      population_definition: "Retained Checkbook Spending API rows filtered by fiscal_year and spending_category=c; exact board identity from the spending observation agency binding.",
    },
    identity: {
      source_system: CHECKBOOK_SPENDING_IDENTITY_SOURCE_SYSTEM,
      location: "spending observation agency publisher identity",
      join_method: "exact_reviewed_publisher_identity_to_cb_money_00_binding",
      accepted_binding_count: sourceBindings(identityRegistry).length,
      accepted_board_count: new Set(sourceBindings(identityRegistry).map((binding) => binding.board_id)).size,
      geographic_attribution: false,
    },
    payment_population: {
      candidate_rows: candidateRows,
      retained_payment_rows: acceptedIdentityRows,
      duplicate_rows_suppressed: duplicateRows,
      invalid_rows: invalidRows,
      unmatched_agencies: [...unmatchedAgencies.entries()].map(([agency, count]) => ({ agency, candidate_rows: count })),
      distinct_board_identities: identityCounts.size,
    },
    fiscal_years: years,
    through_date: throughDate,
    through_date_copy: `Payments posted through ${new Date(`${throughDate}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`,
    coverage: {
      status: source.source_status || "partial",
      board_states: {
        observed: rows.filter((row) => row.coverage_status === "posted_through_source_vintage").length,
        empty: rows.filter((row) => row.coverage_status === "empty_source_result").length,
        identity_unobserved: rows.filter((row) => row.coverage_status === "identity_unobserved").length,
      },
      statement: "Counts are posted payment observations in the declared Checkbook fiscal-year partition; they are not geographic district spending and do not imply a completed current fiscal year.",
    },
    rows,
  };
}

export function validateCommunityBoardPaymentActuals(value) {
  const errors = [];
  if (value?.schema !== COMMUNITY_BOARD_PAYMENT_ACTUALS_SCHEMA) errors.push("invalid payment actuals schema");
  if (!value?.through_date_copy?.includes("Payments posted through August 27, 2026")) errors.push("missing through-date copy");
  if (String(value?.through_date_copy || "").includes("FY2027 spending")) errors.push("current fiscal year is presented as a completed total");
  for (const row of Array.isArray(value?.rows) ? value.rows : []) {
    if (row.payment_count !== (Array.isArray(row.observations) ? row.observations.length : -1)) errors.push(`observation count mismatch for ${row.board_id}:${row.fiscal_year}`);
    if (row.payment_count > 0 && row.coverage_status !== "posted_through_source_vintage") errors.push(`counted row lacks posted coverage state for ${row.board_id}:${row.fiscal_year}`);
    if (row.observations?.some((observation) => !observation.source_observation_ref || !observation.source_receipt)) errors.push(`uninspectable observation for ${row.board_id}:${row.fiscal_year}`);
  }
  return { ok: errors.length === 0, errors };
}
