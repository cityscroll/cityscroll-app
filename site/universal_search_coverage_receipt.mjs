/** Resident-facing projection of the universal-search machine receipt. */

import {
  UNIVERSAL_SEARCH_COVERAGE_SCHEMA,
  UNIVERSAL_SEARCH_LENS_IDS,
} from "./universal_search_federator.mjs";

export const UNIVERSAL_SEARCH_COVERAGE_VIEW_SCHEMA =
  "cityscroll.universal_search_coverage_view.v1";

const LENS_LABELS = Object.freeze({
  notices: "Published notices",
  people: "People",
  agencies: "Agencies",
  vendors: "Vendors",
  committees: "Committees",
  community_boards: "Community boards",
  exams: "Civil-service exams",
  parcels: "Properties",
});

const STATE_LABELS = Object.freeze({
  matched: "indexed",
  empty: "indexed",
  partial: "partly indexed",
  stale: "older snapshot",
  not_indexed: "not indexed",
  provider_unavailable: "unavailable",
});

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function count(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function countLabel(value) {
  return `${value} ${value === 1 ? "match" : "matches"}`;
}

function dayLabel(value) {
  const normalized = clean(value, 80);
  if (!/^\d{4}-\d{2}-\d{2}/.test(normalized)) return null;
  return normalized.slice(0, 10);
}

function lensView(lens, raw = {}) {
  const matchedCount = count(raw.matched_count);
  const indexedCount = count(raw.indexed_count);
  const state = Object.hasOwn(STATE_LABELS, raw.state) ? raw.state : "not_indexed";
  const matchCopy = matchedCount === null ? null : countLabel(matchedCount);
  return Object.freeze({
    lens,
    label: LENS_LABELS[lens],
    state,
    state_label: STATE_LABELS[state],
    matched_count: matchedCount,
    indexed_count: indexedCount,
    as_of: dayLabel(raw.as_of),
    copy: matchCopy ? `${matchCopy} · ${STATE_LABELS[state]}` : STATE_LABELS[state],
  });
}

/** Keep all displayed totals and lens states derived from the response receipt. */
export function buildUniversalSearchCoverageView(coverage = null) {
  const receipt = coverage?.schema === UNIVERSAL_SEARCH_COVERAGE_SCHEMA ? coverage : null;
  if (!receipt) {
    return Object.freeze({
      schema: UNIVERSAL_SEARCH_COVERAGE_VIEW_SCHEMA,
      state: "unavailable",
      complete_count: null,
      observed_count: null,
      headline: "Coverage details are unavailable.",
      detail: "Results may come from only some public-record collections.",
      lenses: Object.freeze([]),
    });
  }

  const completeCount = count(receipt.complete_count);
  const observedCount = count(receipt.observed_count) ?? 0;
  const complete = receipt.snapshot?.state === "complete" && completeCount !== null;
  const lenses = UNIVERSAL_SEARCH_LENS_IDS.map((lens) => lensView(
    lens,
    receipt.by_lens?.[lens],
  ));
  const asOf = dayLabel(receipt.snapshot?.as_of);
  return Object.freeze({
    schema: UNIVERSAL_SEARCH_COVERAGE_VIEW_SCHEMA,
    state: complete ? "complete" : "incomplete",
    complete_count: completeCount,
    observed_count: observedCount,
    headline: complete
      ? `${countLabel(completeCount)} across all indexed collections.`
      : "Search coverage is incomplete.",
    detail: complete
      ? (asOf ? `Collection snapshots are current through ${asOf}.` : "Every declared collection reported its snapshot.")
      : (observedCount
        ? `${countLabel(observedCount)} found in the available collections.`
        : "No matches were found in the available collections; other collections may be missing."),
    lenses: Object.freeze(lenses),
  });
}

export function renderUniversalSearchCoverageHtml(coverage = null) {
  const view = buildUniversalSearchCoverageView(coverage);
  const lensDetails = view.lenses.length
    ? `<details><summary>Coverage by collection</summary><ul>${view.lenses.map((lens) => (
      `<li data-coverage-lens="${escapeHtml(lens.lens)}" data-coverage-state="${escapeHtml(lens.state)}"><span>${escapeHtml(lens.label)}</span><strong>${escapeHtml(lens.copy)}</strong></li>`
    )).join("")}</ul></details>`
    : "";
  return `<section class="topic-search-coverage is-${escapeHtml(view.state)}" data-search-coverage data-coverage-state="${escapeHtml(view.state)}" role="status">
    <p><strong>${escapeHtml(view.headline)}</strong><span>${escapeHtml(view.detail)}</span></p>
    ${lensDetails}
  </section>`;
}
