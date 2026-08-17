// Pure route-faithful certification for Contracts "Try asking" suggestions.
// The browser and worker both use the resident snapshot/filter adapters below; this module
// deliberately does not consult the broader publisher corpus.

import { mergeContractSearchRows } from "./contract_search_bridge.mjs";
import { filterMoneySnapshot, moneySnapshotRows } from "./resident_snapshot_queries.mjs";
import { routeHashFromScope, scopeFromLensState } from "./scope_v0.mjs";

export const MONEY_SUGGESTION_DESTINATION_SCHEMA = "cityscroll.money_suggestion_destination.v1";

function addDaysISO(today, days) {
  const date = new Date(`${String(today).slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMonthsISO(today, months) {
  const date = new Date(`${String(today).slice(0, 10)}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + Number(months));
  return date.toISOString().slice(0, 10);
}

export function moneySuggestionRoute(filter = {}) {
  if (filter.route) return null;
  const keywords = Array.isArray(filter.keywords) ? filter.keywords.filter(Boolean) : [];
  const wantsAward = !filter.closingWeek && (
    filter.noticeType === "award"
    || (!filter.noticeType && (filter.minAmount || filter.maxAmount))
  );
  const state = {
    q: keywords.join(" "),
    mode: wantsAward ? "award" : "open",
    agency: filter.agency || null,
    minAmount: filter.minAmount ?? null,
    maxAmount: filter.maxAmount ?? null,
    category: filter.category || null,
    months: filter.months ?? null,
    excludeSpecial: Boolean(filter.excludeSpecial),
    when: filter.closingWeek && !wantsAward ? "closing:week" : null,
  };
  const hash = routeHashFromScope(scopeFromLensState("money", state), { surface: "money" });
  const query = hash.split("?", 2)[1] || "";
  return `/browse/contracts/${query ? `?${query}` : ""}`;
}

function contractSearchAsOf(searchPayload) {
  const contractLane = (searchPayload?.lanes || []).find((lane) => lane?.id === "contracts");
  return contractLane?.as_of
    || searchPayload?.coverage?.snapshot?.as_of_by_lens?.contracts
    || null;
}

/** Certify the final rows produced by the same merge-then-filter sequence as money-list.mjs. */
export function certifyMoneySuggestionDestination({
  filter = {},
  snapshot,
  searchPayload = null,
  today,
} = {}) {
  const route = moneySuggestionRoute(filter);
  if (!route || !snapshot || !Array.isArray(snapshot.rows)) return null;
  const keywords = Array.isArray(filter.keywords) ? filter.keywords.filter(Boolean) : [];
  const keyword = keywords.join(" ");
  const wantsAward = !filter.closingWeek && (
    filter.noticeType === "award"
    || (!filter.noticeType && (filter.minAmount || filter.maxAmount))
  );
  const mode = wantsAward ? "award" : "open";
  const retainedRows = moneySnapshotRows(snapshot);
  const usesKeywordSearch = Boolean(keyword && (mode === "award" || mode === "archive"));
  const searchDocuments = usesKeywordSearch
    ? (Array.isArray(searchPayload?.results) ? searchPayload.results : [])
    : [];
  const mergedRows = mergeContractSearchRows(retainedRows, searchDocuments);
  const rows = filterMoneySnapshot(mergedRows, {
    mode,
    agency: filter.agency || "",
    keyword,
    closingWeek: Boolean(filter.closingWeek),
    minAmount: filter.minAmount ?? null,
    maxAmount: filter.maxAmount ?? null,
    category: filter.category || "",
    months: filter.months ?? null,
    excludeSpecial: Boolean(filter.excludeSpecial),
    sort: "deadline",
    today,
    weekEnd: filter.closingWeek ? addDaysISO(today, 7) : null,
    monthEnd: filter.months ? addMonthsISO(today, filter.months) : null,
    limit: mergedRows.length,
  });
  return Object.freeze({
    schema: MONEY_SUGGESTION_DESTINATION_SCHEMA,
    route,
    readModel: usesKeywordSearch
      ? "money_resident_snapshot+keyword_search_response"
      : "money_resident_snapshot",
    corpus: Object.freeze({
      residentSnapshot: Object.freeze({
        schemaVersion: snapshot.schema_version ?? null,
        generatedAt: snapshot.generated_at || null,
        rowCount: snapshot.count ?? retainedRows.length,
      }),
      keywordSearch: Object.freeze({
        schema: usesKeywordSearch ? searchPayload?.schema || null : null,
        asOf: usesKeywordSearch ? contractSearchAsOf(searchPayload) : null,
      }),
    }),
    finalCount: rows.length,
  });
}
