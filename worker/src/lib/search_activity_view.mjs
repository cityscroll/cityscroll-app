/**
 * Desk projection over stored search-execution receipts.
 *
 * This module reads receipts; it never runs a search. Every value an operator
 * sees on Product Activity comes from the receipt that was stored when the
 * reader's Search finished, so a page opened today still shows what that reader
 * actually saw — not what the same query would return now.
 *
 * The filter vocabulary is deliberately closed and each entry names the stored
 * field that backs it. A filter with no retained field behind it would be a
 * query engine wearing a receipt's clothes, so it is rejected rather than
 * approximated.
 */

import {
  SEARCH_ACTIVITY_FAMILIES,
  SEARCH_ACTIVITY_OUTCOME_STATES,
  cleanReceiptText,
  isSafeSearchActivityLink,
} from "../../../capabilities/search_activity.mjs";

/** The reader-facing origin a stored canonical result path resolves against. */
export const SEARCH_ACTIVITY_PUBLIC_ORIGIN = "https://cityscroll.org";

export const SEARCH_ACTIVITY_VIEW_SCHEMA = "cityscroll.search_activity.desk_view.v1";

/** Read parameters that select a page rather than filter its contents. */
export const SEARCH_ACTIVITY_READ_PARAMS = Object.freeze(["key", "limit", "traffic_class"]);

/**
 * The complete offered filter vocabulary. `backing_field` is the retained field
 * the filter reads; there is no entry without one.
 */
export const SEARCH_ACTIVITY_FILTERS = Object.freeze([
  Object.freeze({
    key: "since",
    label: "From",
    backing_field: "received_at",
    input: "date",
    description: "Receipts recorded at or after this UTC instant (accepts YYYY-MM-DD).",
  }),
  Object.freeze({
    key: "until",
    label: "To",
    backing_field: "received_at",
    input: "date",
    description: "Receipts recorded at or before this UTC instant (YYYY-MM-DD covers the whole day).",
  }),
  Object.freeze({
    key: "query",
    label: "Query contains",
    backing_field: "query.raw",
    input: "text",
    description: "Case-insensitive substring of the raw or normalized query the reader submitted.",
  }),
  Object.freeze({
    key: "visitor",
    label: "Visitor ID",
    backing_field: "visitor_id",
    input: "text",
    description: "Exact opaque browser visitor id; returns every retained execution for that browser.",
  }),
  Object.freeze({
    key: "subscriber",
    label: "Subscriber ID",
    backing_field: "subscriber_id",
    input: "text",
    description: "Exact recognized subscriber id; anonymous receipts are never back-filled with it.",
  }),
  Object.freeze({
    key: "outcome",
    label: "Terminal state",
    backing_field: "outcome",
    input: "enum",
    options: SEARCH_ACTIVITY_OUTCOME_STATES,
    description: "Stored terminal state: matched, partial, empty, or unavailable.",
  }),
  Object.freeze({
    key: "family",
    label: "Result family",
    backing_field: "family_counts",
    input: "enum",
    options: SEARCH_ACTIVITY_FAMILIES,
    description: "Executions that rendered rows in this family or recorded it incomplete.",
  }),
]);

export const SEARCH_ACTIVITY_FILTER_KEYS = Object.freeze(SEARCH_ACTIVITY_FILTERS.map((f) => f.key));

/**
 * Ceiling on receipts read while resolving a filtered page. A visitor filter must
 * reach every retained execution for that browser, so a filtered read scans past
 * non-matching receipts — but only this far, and it reports when it stopped short.
 */
export const SEARCH_ACTIVITY_MAX_FILTER_SCAN = 500;

const FILTER_BY_KEY = new Map(SEARCH_ACTIVITY_FILTERS.map((filter) => [filter.key, filter]));
const OUTCOME_SET = new Set(SEARCH_ACTIVITY_OUTCOME_STATES);
const FAMILY_SET = new Set(SEARCH_ACTIVITY_FAMILIES);
const MAX_FILTER_VALUE_LENGTH = 240;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 3600 * 1000;

/**
 * A calendar day means the whole day: `since` opens it, `until` closes it. A full
 * instant is taken as given, so a narrow incident window stays narrow.
 */
function boundaryMs(text, edge) {
  if (DAY_PATTERN.test(text)) {
    const ms = Date.parse(`${text}T00:00:00.000Z`);
    if (!Number.isFinite(ms)) return null;
    return edge === "until" ? ms + DAY_MS - 1 : ms;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse the offered filters out of a read request.
 *
 * Returns `{ filters, active, unsupported, invalid }`. `unsupported` names query
 * parameters outside the closed vocabulary and `invalid` names offered filters
 * whose value is not a stored value — both are surfaced rather than ignored, so a
 * mistyped filter can never read as "no executions match".
 */
export function parseSearchActivityFilters(searchParams) {
  const filters = {};
  const unsupported = [];
  const invalid = [];

  for (const name of new Set(searchParams.keys())) {
    if (SEARCH_ACTIVITY_READ_PARAMS.includes(name)) continue;
    if (!FILTER_BY_KEY.has(name)) unsupported.push(name);
  }

  for (const filter of SEARCH_ACTIVITY_FILTERS) {
    if (!searchParams.has(filter.key)) continue;
    const raw = cleanReceiptText(searchParams.get(filter.key), MAX_FILTER_VALUE_LENGTH);
    if (!raw) continue;
    if (filter.key === "since" || filter.key === "until") {
      const ms = boundaryMs(raw, filter.key);
      if (ms === null) {
        invalid.push(filter.key);
        continue;
      }
      filters[filter.key] = raw;
      filters[`${filter.key}_ms`] = ms;
      continue;
    }
    if (filter.key === "outcome" && !OUTCOME_SET.has(raw)) {
      invalid.push(filter.key);
      continue;
    }
    if (filter.key === "family" && !FAMILY_SET.has(raw)) {
      invalid.push(filter.key);
      continue;
    }
    filters[filter.key] = raw;
  }

  const active = SEARCH_ACTIVITY_FILTER_KEYS.some((key) => Object.hasOwn(filters, key));
  return { filters, active, unsupported, invalid };
}

/** Echo of the applied filters, free of the parsed millisecond boundaries. */
export function appliedSearchActivityFilters(filters = {}) {
  const applied = {};
  for (const key of SEARCH_ACTIVITY_FILTER_KEYS) {
    if (Object.hasOwn(filters, key)) applied[key] = filters[key];
  }
  return applied;
}

function receiptTimeMs(receipt) {
  const ms = Date.parse(receipt?.received_at || "");
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Does one stored receipt satisfy the filters? Every branch reads a retained
 * field directly; nothing is inferred, joined, or reconstructed.
 */
export function matchesSearchActivityFilters(receipt, filters = {}) {
  if (!receipt || typeof receipt !== "object") return false;

  if (Object.hasOwn(filters, "since_ms") || Object.hasOwn(filters, "until_ms")) {
    const ms = receiptTimeMs(receipt);
    if (ms === null) return false;
    if (Object.hasOwn(filters, "since_ms") && ms < filters.since_ms) return false;
    if (Object.hasOwn(filters, "until_ms") && ms > filters.until_ms) return false;
  }

  if (filters.query) {
    const needle = filters.query.toLowerCase();
    const raw = String(receipt.query?.raw || "").toLowerCase();
    const normalized = String(receipt.query?.normalized || "").toLowerCase();
    if (!raw.includes(needle) && !normalized.includes(needle)) return false;
  }

  // Exact match: a visitor id is an opaque identity, not a search term. A prefix
  // match would silently pool two browsers into one operator conclusion.
  if (filters.visitor && receipt.visitor_id !== filters.visitor) return false;
  if (filters.subscriber && receipt.subscriber_id !== filters.subscriber) return false;
  if (filters.outcome && receipt.outcome !== filters.outcome) return false;

  if (filters.family) {
    const rendered = Number(receipt.family_counts?.[filters.family]) || 0;
    const incomplete = Array.isArray(receipt.incomplete_families)
      && receipt.incomplete_families.includes(filters.family);
    if (!rendered && !incomplete) return false;
  }

  return true;
}

/**
 * Absolute reader URL for a stored result row, or null when the stored path is
 * not a link this surface will follow. The intake already validated the path;
 * re-checking here means a receipt written by an older, looser contract still
 * cannot put an arbitrary URL in front of an operator.
 */
export function canonicalResultUrl(row = {}) {
  const href = row.canonical_href;
  if (!href || !isSafeSearchActivityLink(href)) return null;
  return `${SEARCH_ACTIVITY_PUBLIC_ORIGIN}${href}`;
}

/** Coarse, low-cardinality device line. Absent observations stay absent. */
export function browserSummary(receipt = {}) {
  const parts = [];
  if (receipt.browser_family) {
    parts.push(receipt.browser_major_version
      ? `${receipt.browser_family} ${receipt.browser_major_version}`
      : String(receipt.browser_family));
  }
  if (receipt.os_family) parts.push(String(receipt.os_family));
  if (receipt.device_class) parts.push(String(receipt.device_class));
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Project one stored receipt into the row Product Activity renders. Field names
 * are the receipt's own, so the Desk row and the authenticated JSON item can be
 * compared identity by identity without a translation table.
 */
export function projectSearchActivityExecution(receipt = {}) {
  const results = Array.isArray(receipt.results) ? receipt.results : [];
  const incomplete = Array.isArray(receipt.incomplete_families) ? receipt.incomplete_families : [];
  return {
    execution_id: receipt.execution_id || null,
    receipt_id: receipt.receipt_id || null,
    occurred_at: receipt.occurred_at || null,
    received_at: receipt.received_at || null,
    query_raw: receipt.query?.raw || null,
    query_normalized: receipt.query?.normalized || null,
    scope: receipt.scope && typeof receipt.scope === "object" ? receipt.scope : {},
    visitor_id: receipt.visitor_id || null,
    subscriber_id: receipt.subscriber_id || null,
    account_label: receipt.account_label || null,
    recognition: receipt.recognition === "recognized" ? "recognized" : "anonymous",
    browser_summary: browserSummary(receipt),
    outcome: receipt.outcome || null,
    rendered_count: Number.isSafeInteger(receipt.rendered_count) ? receipt.rendered_count : results.length,
    family_counts: receipt.family_counts && typeof receipt.family_counts === "object" ? receipt.family_counts : {},
    incomplete_families: incomplete,
    coverage_complete: incomplete.length === 0,
    results: results.map((row) => ({
      rank: row?.rank ?? null,
      family: row?.family || null,
      kind: row?.kind || null,
      title: row?.title || null,
      reference: row?.reference || null,
      entity_type: row?.entity_type || null,
      canonical_href: row?.canonical_href || null,
      canonical_url: canonicalResultUrl(row || {}),
    })),
  };
}

/**
 * Build the Desk model for one filtered page of receipts.
 *
 * `scanned`/`scan_complete` come from the read, not from the rows: an operator
 * who filters by visitor needs to know whether the scan reached the end of
 * retention or stopped at its bound.
 */
export function buildSearchActivityDeskModel({
  items = [],
  filters = {},
  unsupported = [],
  invalid = [],
  limit = 0,
  trafficClass = "production",
  scanned = 0,
  scanComplete = true,
  available = true,
  unavailableReason = null,
} = {}) {
  return {
    schema: SEARCH_ACTIVITY_VIEW_SCHEMA,
    available,
    unavailable_reason: available ? null : unavailableReason,
    traffic_class: trafficClass,
    limit,
    count: items.length,
    filters: appliedSearchActivityFilters(filters),
    offered_filters: SEARCH_ACTIVITY_FILTERS,
    unsupported_filters: [...unsupported],
    invalid_filters: [...invalid],
    scanned,
    scan_complete: scanComplete,
    // The stored receipts exactly as retained, and the Desk projection of those same
    // objects. Both halves of this model come from one read, so the authenticated JSON
    // representation and the rendered section cannot describe different executions.
    receipts: [...items],
    executions: items.map(projectSearchActivityExecution),
  };
}
