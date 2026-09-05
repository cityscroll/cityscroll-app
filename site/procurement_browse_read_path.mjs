/**
 * The Browse Contracts read-path decision for Award and Archive.
 *
 * Award and Archive are the only modes backed by the bounded, sharded query
 * projection in procurement_browse_query.mjs: that projection draws from the
 * same registered/award corpus, not the City Record solicitation feed Open
 * and All RFPs read from. Within those two modes, any facet or sort the
 * compact rows carry is fair game — free text, a scoped vendor/contract
 * reference, and the analytics drill-through are the only queries the shards
 * cannot answer, because those need the search capability's documents or a
 * different projection entirely.
 */

export function moneyBoundedAwardArchiveEligible({
  mode, needsSearch, analyticalScopeActive, entityRefs, contractIdentity,
} = {}) {
  return (mode === "award" || mode === "archive")
    && !needsSearch
    && !analyticalScopeActive
    && !(entityRefs || []).length
    && !contractIdentity;
}

/** The reason a non-default Contracts view fell back to the full read, kept
 * for the read-path receipt so the fallback is inspectable rather than
 * silent. */
export function moneyBoundedAwardArchiveFallbackReason({
  mode, needsSearch, analyticalScopeActive, entityRefs, contractIdentity,
} = {}) {
  if (mode !== "award" && mode !== "archive") return "mode_not_indexed";
  if (needsSearch) return "keyword_or_reference_search";
  if (analyticalScopeActive) return "analytics_scope";
  if ((entityRefs || []).length || contractIdentity) return "entity_scope";
  return null;
}

/** search()'s whole read-path call: eligibility plus, only when it matters
 * (a non-default search that missed the bounded path), the fallback reason. */
export function moneyBrowseReadPath(input = {}) {
  const eligible = moneyBoundedAwardArchiveEligible(input);
  const fallbackReason = input.defaultSearch || eligible ? null : moneyBoundedAwardArchiveFallbackReason(input);
  return { eligible, fallbackReason };
}

/** The read-path receipt: inspectable for performance triage, never rendered. */
export function moneyBrowseReceipt(mode, source, fallbackReason = null) {
  return { mode, source, fallback_reason: fallbackReason };
}
