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
  legal_code: "Administrative Code",
});

const LENS_I18N_KEYS = Object.freeze(Object.fromEntries(
  UNIVERSAL_SEARCH_LENS_IDS.map((lens) => [lens, `topic_search_coverage_lens_${lens}`]),
));

const STATE_LABELS = Object.freeze({
  matched: "indexed",
  empty: "indexed",
  partial: "partly indexed",
  stale: "older snapshot",
  not_indexed: "not indexed",
  provider_unavailable: "unavailable",
  out_of_scope: "out of scope",
});

const VARYING_NOTE_COPY = Object.freeze({
  provider_unavailable: Object.freeze({
    key: "topic_search_coverage_provider_unavailable",
    fallback: "{source} results temporarily unavailable.",
  }),
  stale: Object.freeze({
    key: "topic_search_coverage_stale",
    fallback: "{source} results may be out of date.",
  }),
  not_indexed: Object.freeze({
    key: "topic_search_coverage_not_indexed",
    fallback: "{source} results are not available for this search.",
  }),
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

function interpolate(template, variables = {}) {
  return Object.entries(variables || {}).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

function translateFallback(_key, variables, fallback) {
  return interpolate(fallback, variables);
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
      match_count: null,
      notes: Object.freeze([]),
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
  const matchCount = complete ? completeCount : observedCount;
  const notes = lenses
    .filter((lens) => Object.hasOwn(VARYING_NOTE_COPY, lens.state))
    .map((lens) => Object.freeze({
      lens: lens.lens,
      state: lens.state,
      label: lens.label,
      message_key: VARYING_NOTE_COPY[lens.state].key,
      fallback: VARYING_NOTE_COPY[lens.state].fallback,
    }));
  return Object.freeze({
    schema: UNIVERSAL_SEARCH_COVERAGE_VIEW_SCHEMA,
    state: complete ? "complete" : "incomplete",
    complete_count: completeCount,
    observed_count: observedCount,
    match_count: matchCount,
    notes: Object.freeze(notes),
    lenses: Object.freeze(lenses),
  });
}

/** Render only the useful count plus query-specific degraded-source signals. */
export function renderUniversalSearchCoverageHtml(coverage = null, options = {}) {
  const view = buildUniversalSearchCoverageView(coverage);
  const translate = typeof options.translate === "function"
    ? options.translate
    : translateFallback;
  const optionCount = count(options.matchCount);
  const matchCount = optionCount ?? view.match_count;
  const countCopy = matchCount === null
    ? ""
    : translate(
      matchCount === 1 ? "topic_search_match_count_one" : "topic_search_match_count_other",
      { n: matchCount },
      countLabel(matchCount),
    );
  const noteItems = view.notes.map((note) => {
    const source = translate(LENS_I18N_KEYS[note.lens], null, note.label);
    const copy = translate(note.message_key, { source }, note.fallback);
    return `<li data-coverage-lens="${escapeHtml(note.lens)}" data-coverage-state="${escapeHtml(note.state)}">${escapeHtml(copy)}</li>`;
  }).join("");
  const hidden = !countCopy && !noteItems ? " hidden" : "";
  const notes = noteItems ? `<ul>${noteItems}</ul>` : "";
  return `<section class="topic-search-coverage is-${escapeHtml(view.state)}" data-search-coverage data-coverage-state="${escapeHtml(view.state)}" role="status"${hidden}>
    ${countCopy ? `<p><strong>${escapeHtml(countCopy)}</strong></p>` : ""}
    ${notes}
  </section>`;
}
