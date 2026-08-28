// Source-scoped Community Board financial identity.
//
// This is deliberately separate from site/agency_identity.mjs. That module's
// generic "Community Boards" grouping remains useful for citywide agency
// reconciliation; this contract resolves an exact publisher key before that
// generic projection is applied.

export const COMMUNITY_BOARD_FINANCIAL_IDENTITY_SCHEMA = "cityscroll.community_board_financial_identity.v1";
export const COMMUNITY_BOARD_FINANCIAL_IDENTITY_VERSION = 1;
const FINANCIAL_SOURCES = ["expense_budget", "checkbook_contracts", "checkbook_spending"];

const BOARD_ID = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export function financialIdentityLookupKey(sourceSystem, sourceNativeBoardKey) {
  const source = clean(sourceSystem);
  const key = clean(sourceNativeBoardKey);
  return source && key ? `${source}:${key}` : null;
}

/**
 * Resolve only an accepted exact source key. Names, geography, and similarity
 * are not fallback identity mechanisms.
 */
export function resolveCommunityBoardFinancialIdentity(registry, sourceSystem, sourceNativeBoardKey) {
  const key = financialIdentityLookupKey(sourceSystem, sourceNativeBoardKey);
  if (!key) return null;
  const matches = (Array.isArray(registry?.bindings) ? registry.bindings : [])
    .filter((binding) => financialIdentityLookupKey(binding.source_system, binding.source_native_board_key) === key);
  if (matches.length !== 1 || matches[0].binding_status !== "accepted") return null;
  return matches[0].board_id || null;
}

export function validateCommunityBoardFinancialIdentity(registry, receipt = null) {
  const errors = [];
  if (registry?.schema !== COMMUNITY_BOARD_FINANCIAL_IDENTITY_SCHEMA) errors.push("invalid registry schema");
  const boards = Array.isArray(registry?.boards) ? registry.boards : [];
  const boardIds = new Set(boards.map((board) => board?.board_id).filter(Boolean));
  if (boards.length !== 59 || boardIds.size !== 59) errors.push("registry must enumerate 59 unique boards");
  const bindings = Array.isArray(registry?.bindings) ? registry.bindings : [];
  const bindingKeys = new Set();
  for (const binding of bindings) {
    if (!FINANCIAL_SOURCES.includes(binding?.source_system)) errors.push(`unsupported binding source: ${binding?.source_system || "missing"}`);
    const key = financialIdentityLookupKey(binding?.source_system, binding?.source_native_board_key);
    if (!key || bindingKeys.has(key)) errors.push(`duplicate or invalid binding key: ${key || "missing"}`);
    bindingKeys.add(key);
    if (binding?.binding_status !== "accepted") errors.push(`non-accepted binding in accepted registry: ${key}`);
    if (!String(binding?.source_native_key_field || "").trim()) errors.push(`binding is missing its native key field: ${key}`);
    if (!String(binding?.publisher_identity || "").trim()) errors.push(`binding is missing its publisher identity: ${key}`);
    if (!Number.isInteger(binding?.candidate_rows) || binding.candidate_rows < 0) errors.push(`binding has invalid candidate rows: ${key}`);
    if (binding?.binding_method !== "exact_publisher_code_with_reviewed_exact_name") errors.push(`binding is not exact-reviewed: ${key}`);
    if (binding?.ambiguous !== false) errors.push(`binding ambiguity is not explicitly false: ${key}`);
    if (!BOARD_ID.test(String(binding?.board_id || "")) || !boardIds.has(binding.board_id)) {
      errors.push(`binding points outside the 59-board registry: ${key}`);
    }
  }
  if (bindings.some((binding) => binding?.ambiguous === true)) errors.push("accepted bindings include an ambiguous identity");
  if (receipt) {
    if (receipt.schema !== "cityscroll.community_board_financial_identity_receipt.v1") errors.push("invalid receipt schema");
    if (!Array.isArray(receipt.unmatched_identities)) errors.push("receipt is missing unmatched identities");
    if (!Array.isArray(receipt.ambiguous_identities)) errors.push("receipt is missing ambiguous identities");
    for (const source of FINANCIAL_SOURCES) {
      const measurement = receipt.sources?.[source];
      if (!measurement || measurement.source_system !== source) errors.push(`receipt is missing source measurement: ${source}`);
      if (!String(measurement?.native_key_field || "").trim()) errors.push(`source measurement is missing its native key field: ${source}`);
      if (!String(measurement?.source_vintage || "").trim()) errors.push(`source measurement is missing its source vintage: ${source}`);
      if (!Number.isInteger(measurement?.candidate_rows) || measurement.candidate_rows < 0) errors.push(`source measurement has invalid candidate rows: ${source}`);
      if (!Array.isArray(measurement?.identities)) errors.push(`source measurement is missing its identity inventory: ${source}`);
      for (const identity of measurement?.identities || []) {
        if (!String(identity?.source_native_board_key || "").trim()) errors.push(`identity is missing its publisher-native key: ${source}`);
        if (!String(identity?.publisher_identity || "").trim()) errors.push(`identity is missing its publisher label: ${source}`);
        if (!BOARD_ID.test(String(identity?.board_id || "")) || !boardIds.has(identity.board_id)) errors.push(`identity points outside the 59-board registry: ${source}`);
        if (!Number.isInteger(identity?.candidate_rows) || identity.candidate_rows < 0) errors.push(`identity has invalid candidate rows: ${source}`);
      }
      const sourceBindings = bindings.filter((binding) => binding.source_system === source);
      if (receipt.accepted_bindings?.[source] !== sourceBindings.length) errors.push(`accepted binding count mismatch: ${source}`);
      const covered = receipt.rows_covered_by_accepted_bindings?.[source];
      if (!Number.isInteger(covered) || covered < 0 || covered > measurement.candidate_rows) errors.push(`invalid covered-row count: ${source}`);
      const noObserved = receipt.boards_with_no_observed_identity?.[source];
      if (!Array.isArray(noObserved)) errors.push(`receipt is missing no-observation boards: ${source}`);
      else if (noObserved.some((boardId) => !boardIds.has(boardId))) errors.push(`no-observation list contains an unknown board: ${source}`);
    }
    if (!receipt.candidate_rows || !receipt.distinct_publisher_identities || !receipt.accepted_bindings
      || !receipt.boards_with_no_observed_identity || !receipt.rows_covered_by_accepted_bindings) {
      errors.push("receipt is missing required measurement summaries");
    }
    if (receipt.measurement?.accepted_binding_count !== bindings.length) errors.push("receipt accepted binding total does not match registry");
    if (receipt.measurement?.reviewed_accepted_bindings !== bindings.length) errors.push("receipt reviewed binding total does not match registry");
    if (receipt.measurement?.false_positive_accepted_bindings !== 0) errors.push("receipt reports false-positive accepted bindings");
    if (receipt.measurement?.reviewed_precision !== 1) errors.push("reviewed precision is not 1");
    if (receipt.measurement?.no_ambiguous_accepted_bindings !== true) errors.push("receipt does not clear the ambiguity gate");
    if (receipt.measurement?.acceptance_gate !== true) errors.push("receipt acceptance gate is not clear");
    if (receipt.ambiguous_identities.length > 0) errors.push("receipt contains ambiguous identities");
    if (receipt.hard_rules && Object.values(receipt.hard_rules).some((value) => value !== true)) errors.push("receipt hard rules are not all enabled");
  }
  return { ok: errors.length === 0, errors };
}
