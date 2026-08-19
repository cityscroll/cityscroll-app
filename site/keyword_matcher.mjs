/**
 * Literal keyword resolution shared by the bounded cross-family search route.
 *
 * Matching semantics (`cityscroll.keyword_match.v1`):
 * - Exact whole-token match against Unicode word tokens. Infix/substring hits
 *   (rat inside integrated, strategy, ratio) are not matches.
 * - No prefix match. A query token must align to a whole document token, so
 *   "rat" does not match "rate" or "rates".
 * - Longer tokens keep query-side reviewed plural/singular normalization
 *   (mosquitos → mosquito). Match-time also accepts a simple regular +s
 *   plural in either direction so "rat" ↔ "rats" without stemming "rate".
 * - Reviewed aliases (ida → Industrial Development Agency) stay agency
 *   filters, not token expansions.
 * - Reviewed synonym expansions (school → education) store expansion_tokens[]
 *   plus a receipt. Retrieval may OR those tokens; canonical identity stays
 *   the literal query. Unreviewed synonyms and typos do not expand.
 * - A surfaced keyword hit must produce offset-backed evidence. If the
 *   matched token cannot be marked in a publisher field, the hit is
 *   unjustified and must not be published. The marked term is the document
 *   token that matched, including an expansion hit.
 *
 * Retrieval and explanation consume the same resolved term. Character offsets
 * are retained only so clients can render the exact publisher passage safely.
 */

export const KEYWORD_MATCH_SEMANTICS = Object.freeze({
  schema: "cityscroll.keyword_match.v1",
  mode: "exact_token",
  infix: false,
  prefix: false,
  simple_regular_plural: true,
  reviewed_aliases: true,
  reviewed_synonym_expansion: true,
  evidence_required: true,
});

const MAX_QUERY_LENGTH = 240;
const SNIPPET_RADIUS = 90;
const SEGMENTER = typeof Intl?.Segmenter === "function"
  ? new Intl.Segmenter("en-US", { granularity: "word" })
  : null;

const REVIEWED_ALIASES = Object.freeze({
  ida: Object.freeze({
    canonical: "Industrial Development Agency",
    agency_id: "industrial-development-agency",
  }),
  nycida: Object.freeze({
    canonical: "Industrial Development Agency",
    agency_id: "industrial-development-agency",
  }),
});

/** Closed reviewed synonym table. A pair lands only with a fixture that turns
 *  a documented miss into a hit without flipping other gold identities. */
export const REVIEWED_SYNONYM_EXPANSIONS = Object.freeze({
  school: Object.freeze({
    expansion_tokens: Object.freeze(["education"]),
    receipt: "reviewed_synonym_v1",
  }),
});

const MAX_EXPANSION_SEQUENCES = 8;

function clean(value, max = MAX_QUERY_LENGTH) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function singularToken(value) {
  const token = value.toLocaleLowerCase("en-US");
  if (token.length <= 4 || /(ss|us|is)$/.test(token)) return token;
  if (token.endsWith("ies") && token.length > 5) return `${token.slice(0, -3)}y`;
  if (token.endsWith("oes") && token.length > 5) return token.slice(0, -2);
  if (/(ches|shes|xes|zes|ses)$/.test(token) && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("s")) return token.slice(0, -1);
  return token;
}

export function keywordTokens(value) {
  const text = clean(value, 8_000);
  if (!text) return Object.freeze([]);
  const tokens = [];
  if (SEGMENTER) {
    for (const segment of SEGMENTER.segment(text)) {
      if (!segment.isWordLike) continue;
      const normalized = clean(segment.segment, 120).toLocaleLowerCase("en-US");
      if (!normalized) continue;
      tokens.push(Object.freeze({
        value: segment.segment,
        normalized,
        canonical: singularToken(normalized),
        start: segment.index,
        end: segment.index + segment.segment.length,
      }));
    }
  } else {
    const pattern = /[\p{L}\p{N}]+/gu;
    for (const match of text.matchAll(pattern)) {
      const normalized = match[0].toLocaleLowerCase("en-US");
      tokens.push(Object.freeze({
        value: match[0],
        normalized,
        canonical: singularToken(normalized),
        start: match.index,
        end: match.index + match[0].length,
      }));
    }
  }
  return Object.freeze(tokens);
}

function retrievalVariants(token) {
  const variants = [token.normalized, token.canonical];
  const expansion = REVIEWED_SYNONYM_EXPANSIONS[token.canonical];
  if (expansion) variants.push(...expansion.expansion_tokens);
  return Object.freeze([...new Set(variants)]);
}

function reviewedExpansion(literalTokens, alias) {
  if (alias) {
    return Object.freeze({
      tokens: Object.freeze([]),
      receipt: null,
      pairs: Object.freeze([]),
    });
  }
  const tokens = [];
  const pairs = [];
  for (const token of literalTokens) {
    const expansion = REVIEWED_SYNONYM_EXPANSIONS[token.canonical];
    if (!expansion) continue;
    for (const extra of expansion.expansion_tokens) {
      if (extra === token.canonical || extra === token.normalized) continue;
      if (!tokens.includes(extra)) tokens.push(extra);
      pairs.push(Object.freeze({
        from: token.canonical,
        to: extra,
        receipt: expansion.receipt,
      }));
    }
  }
  const receipts = [...new Set(pairs.map((pair) => pair.receipt))];
  return Object.freeze({
    tokens: Object.freeze(tokens),
    receipt: receipts.length === 1 ? receipts[0] : null,
    pairs: Object.freeze(pairs),
  });
}

function matchSequences(canonicalTokens) {
  if (!canonicalTokens.length) return Object.freeze([]);
  const sequences = [Object.freeze([...canonicalTokens])];
  for (let index = 0; index < canonicalTokens.length; index += 1) {
    const expansion = REVIEWED_SYNONYM_EXPANSIONS[canonicalTokens[index]];
    if (!expansion) continue;
    for (const extra of expansion.expansion_tokens) {
      if (sequences.length >= MAX_EXPANSION_SEQUENCES) break;
      if (extra === canonicalTokens[index]) continue;
      const next = canonicalTokens.slice();
      next[index] = extra;
      sequences.push(Object.freeze(next));
    }
    if (sequences.length >= MAX_EXPANSION_SEQUENCES) break;
  }
  return Object.freeze(sequences);
}

export function resolveKeywordQuery(value) {
  const rawQuery = clean(value);
  const literalTokens = keywordTokens(rawQuery);
  const aliasKey = literalTokens.length === 1 ? literalTokens[0].normalized : null;
  const alias = REVIEWED_ALIASES[aliasKey] || null;
  const resolvedTokens = alias ? keywordTokens(alias.canonical) : literalTokens;
  const expansion = reviewedExpansion(literalTokens, alias);
  return Object.freeze({
    raw_query: rawQuery,
    match_mode: "keyword",
    canonical_tokens: Object.freeze(resolvedTokens.map((token) => token.canonical)),
    retrieval_groups: alias
      ? Object.freeze([])
      : Object.freeze(literalTokens.map(retrievalVariants)),
    structured_filters: Object.freeze(alias ? {
      agency: alias.canonical,
      agency_id: alias.agency_id,
    } : {}),
    alias: alias ? Object.freeze({
      input: aliasKey,
      canonical: alias.canonical,
      receipt: "reviewed_agency_alias_v1",
    }) : null,
    expansion_tokens: expansion.tokens,
    expansion: expansion.receipt ? Object.freeze({
      receipt: expansion.receipt,
      pairs: expansion.pairs,
    }) : null,
  });
}

function simplePlural(token) {
  return `${token}s`;
}

function tokenEqualsQuery(documentToken, queryCanonical) {
  const documentForms = [documentToken.canonical, documentToken.normalized];
  if (documentForms.includes(queryCanonical) || documentForms.includes(simplePlural(queryCanonical))) {
    return true;
  }
  if (
    queryCanonical.length > 3
    && queryCanonical.endsWith("s")
    && !/(ss|us|is)$/.test(queryCanonical)
  ) {
    const stem = queryCanonical.slice(0, -1);
    return documentForms.includes(stem);
  }
  return false;
}

function sequenceStart(tokens, canonicalTokens) {
  if (!canonicalTokens.length || tokens.length < canonicalTokens.length) return -1;
  for (let start = 0; start <= tokens.length - canonicalTokens.length; start += 1) {
    if (canonicalTokens.every((token, offset) => tokenEqualsQuery(tokens[start + offset], token))) {
      return start;
    }
  }
  return -1;
}

/** True when `value` contains the resolved query as an adjacent whole-token sequence. */
export function keywordTextMatches(value, resolved = resolveKeywordQuery("")) {
  if (!resolved.canonical_tokens?.length) return false;
  const tokens = keywordTokens(value);
  return matchSequences(resolved.canonical_tokens).some((sequence) => (
    sequenceStart(tokens, sequence) >= 0
  ));
}

function evidenceForSequence(field, text, tokens, sequence, sourceIdentifier) {
  const startToken = sequenceStart(tokens, sequence);
  if (startToken < 0) return null;
  const endToken = startToken + sequence.length;
  const charStart = tokens[startToken].start;
  const charEnd = tokens[endToken - 1].end;
  const snippetStart = Math.max(0, charStart - SNIPPET_RADIUS);
  const snippetEnd = Math.min(text.length, charEnd + SNIPPET_RADIUS);
  const prefix = snippetStart > 0 ? "…" : "";
  const suffix = snippetEnd < text.length ? "…" : "";
  const passage = `${prefix}${text.slice(snippetStart, snippetEnd)}${suffix}`;
  const prefixLength = prefix.length;
  return Object.freeze({
    field,
    token_offsets: Object.freeze([startToken, endToken]),
    character_offsets: Object.freeze([charStart, charEnd]),
    matched_normalized_term: sequence.join(" "),
    source_identifier: sourceIdentifier,
    snippet: Object.freeze({
      text: passage,
      mark_start: prefixLength + charStart - snippetStart,
      mark_end: prefixLength + charEnd - snippetStart,
    }),
  });
}

function evidenceForField(field, value, resolved, sourceIdentifier) {
  const text = clean(value, 8_000);
  const tokens = keywordTokens(text);
  for (const sequence of matchSequences(resolved.canonical_tokens)) {
    const evidence = evidenceForSequence(field, text, tokens, sequence, sourceIdentifier);
    if (evidence) return evidence;
  }
  return null;
}

export function matchKeywordDocument(document = {}, resolved = resolveKeywordQuery("")) {
  if (!resolved.canonical_tokens?.length) return null;
  const sourceIdentifier = Array.isArray(document.source_observation_refs)
    ? document.source_observation_refs[0] || null
    : null;
  for (const [field, value] of [
    ["title", document.title],
    ["summary", document.summary],
    ["search_text", document.search_text],
  ]) {
    const evidence = evidenceForField(field, value, resolved, sourceIdentifier);
    if (evidence) return evidence;
  }
  return null;
}

export function searchKeywordDocuments(documents = [], resolved, { limit = 8 } = {}) {
  const matches = [];
  for (const document of Array.isArray(documents) ? documents : []) {
    const matchEvidence = matchKeywordDocument(document, resolved);
    if (!matchEvidence) continue;
    matches.push(Object.freeze({ ...document, match_evidence: matchEvidence }));
    if (matches.length >= Math.max(0, Number(limit) || 0)) break;
  }
  return Object.freeze(matches);
}
