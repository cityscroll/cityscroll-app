/**
 * Quote-only Ask card over cited-passage retrieval.
 *
 * An Ask answer may quote matched citations to real sources. It may not emit
 * generated answers, civic relationships, or legal conclusions. Unknown-join
 * citations stay unquoted.
 */

export const ASK_CITED_QUOTES_SCHEMA = "cityscroll.ask_cited_quotes.v1";
export const ASK_CITED_QUOTES_KEYS = Object.freeze([
  "schema",
  "query",
  "coverage",
  "quotes",
]);

const FORBIDDEN_FIELD = /(?:^|_)(?:answer|synthesis|action|legal_conclusion|graph_edge|relationship|score|cosine|confidence)(?:$|_)/i;
const JOIN_METHOD = "candidate_source_passage_manifest_exact_id_v1";
const COVERAGE_STATES = new Set(["partial", "complete", "unknown"]);
const MAX_QUOTES = 10;
const MAX_EXCERPT = 520;

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function cleanText(value, max = 240) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function assertNoForbiddenFields(value, path = "cited_quotes") {
  if (!value || typeof value !== "object") return;
  for (const [field, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELD.test(field)) {
      throw new TypeError(`Ask cited quotes expose forbidden semantics: ${path}.${field}`);
    }
    assertNoForbiddenFields(child, `${path}.${field}`);
  }
}

function isMatchedCitation(citation) {
  const evidence = citation?.exact_join_evidence;
  const passage = citation?.passage;
  const source = citation?.source;
  return evidence?.state === "matched"
    && evidence.method === JOIN_METHOD
    && evidence.candidate_id === citation.citation_id
    && evidence.source_record_id === source?.id
    && evidence.passage_id === passage?.id
    && citation.citation_id === passage?.id
    && passage.text_state === "retained"
    && typeof passage.text === "string"
    && passage.text.trim().length > 0
    && /^https?:\/\//.test(source?.url || "")
    && Boolean(source.id && source.family && source.native_id);
}

function projectQuote(citation) {
  return freezeDeep({
    citation_id: citation.citation_id,
    source: {
      id: citation.source.id,
      family: citation.source.family,
      native_id: citation.source.native_id,
      url: citation.source.url,
      canonical_href: citation.source.canonical_href || null,
      title: citation.source.title || null,
    },
    passage: {
      id: citation.passage.id,
      text: citation.passage.text,
      boundary: {
        unit: citation.passage.boundary?.unit || "utf16_code_unit",
        start: citation.passage.boundary?.start ?? null,
        end: citation.passage.boundary?.end ?? null,
      },
    },
    exact_join_evidence: {
      state: "matched",
      method: JOIN_METHOD,
      candidate_id: citation.exact_join_evidence.candidate_id,
      source_record_id: citation.exact_join_evidence.source_record_id,
      passage_id: citation.exact_join_evidence.passage_id,
    },
  });
}

export function projectAskCitedQuotes(citedResponse) {
  if (!citedResponse || citedResponse.schema !== "cityscroll.semantic_retrieval.cited_passage_response.v1") {
    throw new TypeError("Ask cited quotes require a cited-passage response v1");
  }
  const citations = Array.isArray(citedResponse.citations) ? citedResponse.citations : [];
  const quotes = citations.filter(isMatchedCitation).slice(0, MAX_QUOTES).map(projectQuote);
  const omittedUnknown = citations.filter((citation) => (
    citation?.exact_join_evidence?.state === "unknown"
  )).length;
  const coverageState = COVERAGE_STATES.has(citedResponse.coverage?.state)
    ? citedResponse.coverage.state
    : "unknown";
  const projection = freezeDeep({
    schema: ASK_CITED_QUOTES_SCHEMA,
    query: cleanText(citedResponse.query),
    coverage: {
      state: coverageState,
      quoted_count: quotes.length,
      omitted_unknown_count: omittedUnknown,
    },
    quotes,
  });
  assertNoForbiddenFields(projection);
  return projection;
}

function excerptPassage(text) {
  const sourceText = String(text || "").trim();
  if (sourceText.length <= MAX_EXCERPT) return sourceText;
  return `${sourceText.slice(0, MAX_EXCERPT - 1)}…`;
}

export function renderAskCitedQuotesHtml(view, { t, escape } = {}) {
  if (!view || view.schema !== ASK_CITED_QUOTES_SCHEMA || !Array.isArray(view.quotes) || !view.quotes.length) {
    return "";
  }
  const esc = typeof escape === "function" ? escape : (value) => String(value ?? "");
  const tr = typeof t === "function" ? t : (key) => key;
  const cards = view.quotes.map((quote) => {
    const title = quote.source.title || quote.source.native_id;
    const titleHtml = quote.source.canonical_href
      ? `<a class="ask-cited-quote-title" href="${esc(quote.source.canonical_href)}">${esc(title)}</a>`
      : `<span class="ask-cited-quote-title">${esc(title)}</span>`;
    const official = `<a class="ask-cited-quote-source" href="${esc(quote.source.url)}" target="_blank" rel="noopener noreferrer">${esc(tr("topic_search_official_source"))}<span aria-hidden="true">↗</span></a>`;
    return `<figure class="ask-cited-quote" data-citation-id="${esc(quote.citation_id)}"><blockquote lang="en" dir="ltr">${esc(excerptPassage(quote.passage.text))}</blockquote><figcaption>${titleHtml} ${official}</figcaption></figure>`;
  }).join("");
  return `<section class="ask-cited-quotes" data-ask-cited="1"><h3 class="ask-cited-quotes-heading">${esc(tr("ask_cited_quotes_heading"))}</h3>${cards}</section>`;
}
