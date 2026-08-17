import {
  relevanceResultHref,
  renderUniversalSearchResultHtml,
} from "./universal_search_relevance_ux.mjs";
import {
  SEMANTIC_CANDIDATE_METHOD,
  SEMANTIC_CANDIDATE_RESPONSE_SCHEMA,
  SEMANTIC_TOPIC_FAMILIES,
  normalizeSemanticCandidateResponse,
  topicCandidateTitle,
} from "./semantic_topic_search.mjs";
import { renderUniversalSearchCoverageHtml } from "./universal_search_coverage_receipt.mjs";
import {
  buildSearchLensHandoffHref,
  searchDestinationForResult,
  searchFamilyForResult,
} from "./search_lens_handoff.mjs";

const MAX_QUERY_LENGTH = 240;
const SEARCH_TIMEOUT_MS = 12000;
const SEARCH_API_ORIGIN = "https://api.cityscroll.org";
const SEARCH_API_FALLBACK_ORIGIN = "https://crol-worker.crol-worker.workers.dev";
const LANES = Object.freeze([
  "contracts",
  "people-organizations",
  "land",
  "rules",
  "meetings",
  "exams",
]);
// Stable resident labels are also inspected by entity surfaces that hand
// results into Search; keep the product-domain vocabulary centralized here.
const DOMAIN_LANES = Object.freeze({
  contracts: "Contracts",
  rules: "Rules",
  meetings: "Meetings",
  mandates: "Mandates",
  people: "People and organizations",
  places: "Community boards",
  staffing: "Civil-service exams",
  property: "Properties",
  zoning: "Land use",
});
const PLACE_KEYS = Object.freeze([
  ["boro", "Borough"],
  ["cd", "Community district"],
  ["council", "Council district"],
  ["neighborhood", "Neighborhood"],
  ["scope", "Area"],
]);

function clean(value, max = MAX_QUERY_LENGTH) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function queryFromLocation() {
  const params = new URLSearchParams(location.search);
  return clean(params.get("q"));
}

function placeFromLocation() {
  const params = new URLSearchParams(location.search);
  return PLACE_KEYS
    .map(([key, label]) => [label, clean(params.get(key), 80)])
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`)
    .join(" · ");
}

function preservePlaceFields(form) {
  const params = new URLSearchParams(location.search);
  for (const [key] of PLACE_KEYS) {
    const value = clean(params.get(key), 80);
    if (!value) continue;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = key;
    input.value = value;
    form.append(input);
  }
}

function apiOrigins() {
  return [...new Set([
    window.CROL_API_ORIGIN || SEARCH_API_ORIGIN,
    window.CROL_API_FALLBACK_ORIGIN || SEARCH_API_FALLBACK_ORIGIN,
  ])];
}

function tr(key, vars, fallback) {
  const translated = window.t?.(key, vars);
  if (translated && translated !== key) return translated;
  if (!vars) return fallback;
  return Object.entries(vars).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    fallback,
  );
}

function laneElements(root, lane) {
  const section = root.querySelector(`[data-search-lane="${lane}"]`);
  return {
    section,
    status: section?.querySelector(".topic-search-lane-status"),
    body: section?.querySelector(".topic-search-lane-body"),
  };
}

function setLaneState(root, lane, statusText, bodyText, className = "") {
  const elements = laneElements(root, lane);
  if (elements.status) elements.status.textContent = statusText;
  if (elements.body) {
    elements.body.className = `topic-search-lane-body${className ? ` ${className}` : ""}`;
    elements.body.textContent = bodyText;
  }
}

function semanticLaneElements(root, family) {
  const section = root.querySelector(`[data-semantic-family="${family}"]`);
  return {
    section,
    status: section?.querySelector(".topic-search-lane-status"),
    body: section?.querySelector(".topic-search-lane-body"),
  };
}

function setSemanticLaneState(root, family, statusText, bodyText, className = "") {
  const elements = semanticLaneElements(root, family);
  if (elements.status) elements.status.textContent = statusText;
  if (elements.body) {
    elements.body.className = `topic-search-lane-body${className ? ` ${className}` : ""}`;
    elements.body.textContent = bodyText;
    elements.body.setAttribute("aria-busy", className === "is-loading" ? "true" : "false");
  }
}

export function searchResultHref(record) {
  return relevanceResultHref(record);
}

export function searchResultLane(record) {
  return searchFamilyForResult(record);
}

function renderResult(record, payload) {
  const html = renderUniversalSearchResultHtml(record);
  if (!html) return null;
  const template = document.createElement("template");
  template.innerHTML = html;
  const card = template.content.firstElementChild;
  const destination = searchDestinationForResult(record);
  const href = buildSearchLensHandoffHref(record, payload, location.search);
  if (destination && href) {
    const action = document.createElement("p");
    action.className = "topic-search-result-handoff";
    const link = document.createElement("a");
    link.href = href;
    link.dataset.searchHandoff = destination.surface;
    link.textContent = typeof globalThis.t === "function"
      ? globalThis.t("search_handoff_continue", { surface: destination.label })
      : `Continue in ${destination.label}`;
    action.append(link);
    card.append(action);
  }
  return card;
}

function appendFamilyReceipt(body, family) {
  if (!family) return;
  const receipt = document.createElement("p");
  receipt.className = "topic-search-lane-source";
  receipt.textContent = [
    clean(family.source, 240),
    family.as_of ? `as of ${clean(family.as_of, 160)}` : null,
    "Keyword search",
  ].filter(Boolean).join(" · ");
  body.append(receipt);
}

function renderResults(root, payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const families = new Map((payload?.lanes || []).map((family) => [family?.id, family]));
  const grouped = Object.fromEntries(LANES.map((lane) => [lane, []]));
  for (const record of results) {
    const lane = searchResultLane(record);
    if (!lane || !searchResultHref(record)) continue;
    grouped[lane].push(record);
  }
  for (const lane of LANES) {
    const items = grouped[lane];
    const elements = laneElements(root, lane);
    if (!elements.body) continue;
    const family = families.get(lane);
    elements.status.textContent = items.length === 1
      ? tr("one_result", null, "1 result")
      : items.length
        ? tr("results_count", { n: items.length }, "{n} results")
        : tr("topic_search_no_matches_status", null, "No matches");
    elements.body.className = "topic-search-lane-body";
    elements.body.replaceChildren();
    if (!items.length) {
      if (family?.status === "unknown") {
        elements.status.textContent = tr("topic_search_unavailable_status", null, "Unavailable");
        elements.body.classList.add("is-error");
        elements.body.textContent = "This source could not be checked right now.";
      } else if (family?.status === "not_covered") {
        elements.status.textContent = "Not covered";
        elements.body.textContent = "Keyword search is not available for this family yet.";
      } else {
        elements.body.textContent = "No keyword matches in this snapshot.";
      }
      appendFamilyReceipt(elements.body, family);
      continue;
    }
    const list = document.createElement("div");
    list.className = "topic-search-results";
    for (const record of items) {
      const rendered = renderResult(record, payload);
      if (rendered) list.append(rendered);
    }
    elements.body.append(list);
    appendFamilyReceipt(elements.body, family);
  }
}

function renderCoverage(root, coverage) {
  const template = document.createElement("template");
  template.innerHTML = renderUniversalSearchCoverageHtml(coverage);
  const next = template.content.firstElementChild;
  const current = root.querySelector("[data-search-coverage]");
  if (current) current.replaceWith(next);
  else root.querySelector(".topic-search-method")?.before(next);
}

function appendHighlightedText(node, text, terms = []) {
  const sourceText = String(text || "");
  const needles = [...new Set((terms || []).map((term) => clean(term, 120)).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  if (!needles.length) {
    node.textContent = sourceText;
    return node;
  }
  const escaped = needles.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  let pattern;
  try {
    pattern = new RegExp(escaped.join("|"), "giu");
  } catch {
    node.textContent = sourceText;
    return node;
  }
  let cursor = 0;
  for (const match of sourceText.matchAll(pattern)) {
    const index = match.index ?? cursor;
    if (index > cursor) node.append(document.createTextNode(sourceText.slice(cursor, index)));
    const mark = document.createElement("mark");
    mark.textContent = match[0];
    node.append(mark);
    cursor = index + match[0].length;
  }
  if (cursor < sourceText.length) node.append(document.createTextNode(sourceText.slice(cursor)));
  return node;
}

function semanticPassageExcerpt(text, terms, maxLength = 520) {
  const sourceText = clean(text, 1_200);
  if (sourceText.length <= maxLength) return sourceText;
  const lowered = sourceText.toLocaleLowerCase("en-US");
  const ranges = [...new Set((terms || []).map((term) => clean(term, 120)).filter(Boolean))]
    .map((term) => {
      const index = lowered.indexOf(term.toLocaleLowerCase("en-US"));
      return index < 0 ? null : { start: index, end: index + term.length };
    })
    .filter(Boolean)
    .sort((left, right) => left.start - right.start);
  if (!ranges.length) return `${sourceText.slice(0, maxLength - 1)}…`;

  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 80) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  const coreLength = merged.reduce((total, range) => total + range.end - range.start, 0);
  const markerLength = 2 + Math.max(0, merged.length - 1) * 3;
  const context = Math.max(
    0,
    Math.floor((maxLength - coreLength - markerLength) / (merged.length * 2)),
  );
  const expanded = merged.map((range) => ({
    start: Math.max(0, range.start - context),
    end: Math.min(sourceText.length, range.end + context),
  }));
  const chunks = expanded.map((range) => sourceText.slice(range.start, range.end));
  return `${expanded[0].start ? "…" : ""}${chunks.join(" … ")}${expanded.at(-1).end < sourceText.length ? "…" : ""}`;
}

function sourceDataNode(tag, className, text, matchedTerms = []) {
  const node = document.createElement(tag);
  node.className = className;
  node.lang = "en";
  node.dir = "ltr";
  return appendHighlightedText(node, text, matchedTerms);
}

function renderSemanticCandidate(candidate) {
  const article = document.createElement("article");
  article.className = "topic-search-result topic-search-semantic-result";
  article.dataset.semanticCandidate = candidate.candidate_id;

  const heading = document.createElement("h4");
  const title = sourceDataNode(
    "span",
    "topic-search-result-title",
    topicCandidateTitle(candidate),
    candidate.matched_terms,
  );
  if (candidate.source.canonical_href) {
    const primary = document.createElement("a");
    primary.href = candidate.source.canonical_href;
    primary.append(title);
    heading.append(primary);
  } else {
    heading.append(title);
  }
  article.append(heading);

  const rationale = document.createElement("p");
  rationale.className = "topic-search-result-reason";
  rationale.textContent = tr(
    "topic_search_related_because",
    null,
    "Related because this source passage contains the topic words.",
  );
  article.append(rationale);

  if (candidate.passage.text) {
    article.append(sourceDataNode(
      "blockquote",
      "topic-search-result-passage",
      semanticPassageExcerpt(candidate.passage.text, candidate.matched_terms),
      candidate.matched_terms,
    ));
  } else {
    const limit = document.createElement("p");
    limit.className = "topic-search-result-limit";
    limit.textContent = tr(
      "topic_search_evidence_limit",
      null,
      "Source passage text is unavailable for this candidate.",
    );
    article.append(limit);
  }

  const source = document.createElement("a");
  source.className = "topic-search-result-source";
  source.href = candidate.source.url;
  source.target = "_blank";
  source.rel = "noopener noreferrer";
  source.append(document.createTextNode(tr("topic_search_official_source", null, "Official source")));
  const arrow = document.createElement("span");
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "↗";
  source.append(arrow);
  article.append(source);
  return article;
}

function renderSemanticResults(root, response) {
  root.querySelector("[data-semantic-lanes]")?.removeAttribute("hidden");
  root.querySelector("[data-keyword-lanes]")?.setAttribute("hidden", "");
  root.querySelector("[data-search-coverage]")?.setAttribute("hidden", "");
  const method = root.querySelector("[data-search-method-value]");
  if (method) {
    method.textContent = response.method === SEMANTIC_CANDIDATE_METHOD
      ? tr("topic_search_passage_matches", null, "Source-passage matches")
      : tr("topic_search_related_matches", null, "Related topic matches");
  }
  const coverage = root.querySelector("[data-semantic-coverage]");
  if (coverage) {
    coverage.hidden = false;
    coverage.textContent = tr(
      "topic_search_bounded_coverage",
      { date: response.corpus.observed_on || response.index.observed_on || "—" },
      "Results cover a bounded source set observed {date}.",
    );
  }

  for (const group of response.groups) {
    const elements = semanticLaneElements(root, group.id);
    if (!elements.body || !elements.status) continue;
    elements.body.className = "topic-search-lane-body";
    elements.body.setAttribute("aria-busy", "false");
    elements.body.replaceChildren();
    if (!group.candidates.length) {
      elements.status.textContent = tr("topic_search_no_matches_status", null, "No matches");
      elements.body.textContent = tr(
        "topic_search_bounded_empty",
        null,
        "No matches in this bounded source set.",
      );
      continue;
    }
    elements.status.textContent = group.candidates.length === 1
      ? tr("one_result", null, "1 result")
      : tr("results_count", { n: group.candidates.length }, "{n} results");
    const list = document.createElement("div");
    list.className = "topic-search-results";
    group.candidates.forEach((candidate) => list.append(renderSemanticCandidate(candidate)));
    elements.body.append(list);
  }
}

function renderLegacyResults(root, payload) {
  root.querySelector("[data-semantic-lanes]")?.setAttribute("hidden", "");
  root.querySelector("[data-keyword-lanes]")?.removeAttribute("hidden");
  const method = root.querySelector("[data-search-method-value]");
  if (method) method.textContent = tr("topic_search_keyword_fallback", null, "Keyword fallback");
  const coverage = root.querySelector("[data-semantic-coverage]");
  if (coverage) coverage.hidden = true;
  renderResults(root, payload);
  renderCoverage(root, payload?.coverage);
}

function renderInitialState(root, query) {
  root.querySelector("[data-semantic-lanes]")?.removeAttribute("hidden");
  root.querySelector("[data-keyword-lanes]")?.setAttribute("hidden", "");
  const method = root.querySelector("[data-search-method-value]");
  if (method) method.textContent = tr("topic_search_passage_matches", null, "Source-passage matches");
  const instruction = tr("topic_search_enter", null, "Enter a topic to search public records.");
  for (const family of SEMANTIC_TOPIC_FAMILIES) {
    setSemanticLaneState(
      root,
      family,
      tr("topic_search_waiting", null, "Waiting"),
      query ? tr("loading_data", null, "Loading…") : instruction,
    );
  }
  for (const lane of LANES) {
    setLaneState(root, "" + lane, "Waiting", instruction);
  }
}

async function fetchSearchResults(query) {
  let lastError = null;
  for (const origin of apiOrigins()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${origin}/search/candidates?q=${encodeURIComponent(query)}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (response.ok) {
        const payload = await response.json();
        if (payload?.schema === SEMANTIC_CANDIDATE_RESPONSE_SCHEMA || Array.isArray(payload?.results)) {
          return payload;
        }
        throw new Error("invalid search response");
      }
      if (response.status !== 404 && response.status < 500) throw new Error(`search HTTP ${response.status}`);
      lastError = new Error(`search HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("search unavailable");
}

async function loadResults(root, query) {
  if (!query) return;
  for (const family of SEMANTIC_TOPIC_FAMILIES) {
    setSemanticLaneState(
      root,
      family,
      tr("loading_data", null, "Loading…"),
      tr("loading_data", null, "Loading…"),
      "is-loading",
    );
  }
  try {
    const payload = await fetchSearchResults(query);
    const semantic = normalizeSemanticCandidateResponse(payload, { expectedQuery: query });
    if (semantic.state === "typed") {
      renderSemanticResults(root, semantic);
      lastResponse = semantic;
      return;
    }
    if (Array.isArray(payload?.results)) {
      lastResponse = { state: "legacy", payload };
      renderLegacyResults(root, payload);
      return;
    }
    throw new Error("untyped candidate response");
  } catch {
    for (const family of SEMANTIC_TOPIC_FAMILIES) {
      setSemanticLaneState(
        root,
        family,
        tr("topic_search_unavailable_status", null, "Unavailable"),
        tr("could_not_reach", null, "The latest CityScroll snapshot is unavailable. Retry."),
        "is-error",
      );
    }
  }
}

let lastResponse = null;

function repaintResults(root) {
  if (lastResponse?.state === "typed") renderSemanticResults(root, lastResponse);
  else if (lastResponse?.state === "legacy") {
    renderLegacyResults(root, lastResponse.payload);
  }
}

function render() {
  const root = document.querySelector("[data-search-document]");
  if (!root) return;
  const query = queryFromLocation();
  const heading = root.querySelector("#search-heading");
  const input = root.querySelector("#search-query");
  const context = root.querySelector("[data-search-place]");
  if (query) heading?.removeAttribute("data-i18n");
  const paintHeading = () => {
    if (heading) heading.textContent = query
      ? tr("topic_search_results_for", { query }, "Results for “{query}”")
      : tr("topic_search_heading", null, "What are you looking for?");
  };
  paintHeading();
  if (input) input.value = query;
  const place = placeFromLocation();
  if (context && place) {
    context.textContent = `Place context · ${place}`;
    context.hidden = false;
  }
  const form = root.querySelector("[data-search-form]");
  if (form) preservePlaceFields(form);
  renderInitialState(root, query);
  void loadResults(root, query);
  window.initSubpageLangSwitcher?.(() => {
    paintHeading();
    repaintResults(root);
  });
  // The language switcher paints static data-i18n text during initialization.
  // Restore the query-bearing title afterward because it is runtime copy.
  paintHeading();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render, { once: true });
  else render();
}
