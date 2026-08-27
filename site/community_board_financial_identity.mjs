// Source-scoped Community Board financial identity.
//
// This is deliberately separate from site/agency_identity.mjs. That module's
// generic "Community Boards" grouping remains useful for citywide agency
// reconciliation; this contract resolves an exact publisher key before that
// generic projection is applied.

export const COMMUNITY_BOARD_FINANCIAL_IDENTITY_SCHEMA = "cityscroll.community_board_financial_identity.v1";
export const COMMUNITY_BOARD_FINANCIAL_IDENTITY_VERSION = 1;

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
    const key = financialIdentityLookupKey(binding?.source_system, binding?.source_native_board_key);
    if (!key || bindingKeys.has(key)) errors.push(`duplicate or invalid binding key: ${key || "missing"}`);
    bindingKeys.add(key);
    if (binding?.binding_status !== "accepted") errors.push(`non-accepted binding in accepted registry: ${key}`);
    if (!BOARD_ID.test(String(binding?.board_id || "")) || !boardIds.has(binding.board_id)) {
      errors.push(`binding points outside the 59-board registry: ${key}`);
    }
  }
  if (bindings.some((binding) => binding?.ambiguous === true)) errors.push("accepted bindings include an ambiguous identity");
  if (receipt) {
    if (receipt.schema !== "cityscroll.community_board_financial_identity_receipt.v1") errors.push("invalid receipt schema");
    if (receipt.measurement?.reviewed_precision !== 1) errors.push("reviewed precision is not 1");
    if ((receipt.ambiguous_identities || []).length > 0) errors.push("receipt contains ambiguous identities");
  }
  return { ok: errors.length === 0, errors };
}
