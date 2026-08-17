/**
 * Pure admission boundary for the front-door semantic topic-search shell.
 *
 * The candidate endpoint owns retrieval and scope. This adapter verifies its
 * versioned evidence envelope, then groups only by sr1 source family. It never
 * assigns a civic lens, jurisdiction, relationship, or public score.
 */

export const SEMANTIC_CANDIDATE_RESPONSE_SCHEMA = "cityscroll.semantic_retrieval.candidate_response.v1";
export const SEMANTIC_CANDIDATE_METHOD = "lexical_fallback_v1";
export const SEMANTIC_CORPUS_SCHEMA = "cityscroll.semantic_retrieval.corpus_manifest.v1";
export const SEMANTIC_PASSAGE_INDEX_SCHEMA = "cityscroll.semantic_retrieval.source_passage_map.v1";
export const SEMANTIC_CORPUS_MANIFEST_SHA256 = "0f130c2156bb0efc2b9ed6d7df65b7e264530fa3c3bcaf292f17932e5492ee88";
export const SEMANTIC_PASSAGE_INDEX_VERSION = "1d43f0ea93a306c0c164825222dfc666091cb5533e97ab469044e632e3e00226";
export const SEMANTIC_TOPIC_FAMILIES = Object.freeze([
  "city_record_notice",
  "attachment_text",
  "community_board_minutes",
]);

const MAX_QUERY_LENGTH = 240;
const MAX_CANDIDATES = 20;
const MAX_PASSAGE_LENGTH = 1_200;
const MAX_MATCHED_TERMS = 24;
const HASH = /^[a-f0-9]{64}$/;
const METHODS = new Set([SEMANTIC_CANDIDATE_METHOD]);
const COVERAGE_STATES = new Set(["partial", "complete", "unknown"]);
const PASSAGE_ID = /:p\d{4}$/;
const BANNED_PUBLIC_FIELDS = new Set([
  "confidence",
  "cosine",
  "cosine_similarity",
  "graph_edge",
  "legal_conclusion",
  "score",
]);

function clean(value, max = MAX_QUERY_LENGTH) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function hasBannedPublicField(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (BANNED_PUBLIC_FIELDS.has(key.toLocaleLowerCase("en-US"))) return true;
    if (hasBannedPublicField(child)) return true;
  }
  return false;
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function invalid(reason) {
  return freeze({ state: "invalid", reason });
}

function normalizedCandidate(candidate, responseMethod) {
  if (!candidate || typeof candidate !== "object" || hasBannedPublicField(candidate)) return null;
  const family = clean(candidate.source?.family, 80);
  const sourceId = clean(candidate.source?.id, 300);
  const sourceUrl = String(candidate.source?.url || "").trim();
  const sourceTitle = clean(candidate.source?.title, 500) || null;
  const nativeId = clean(candidate.source?.native_id, 240) || null;
  const canonicalHref = candidate.source?.canonical_href == null
    ? null
    : String(candidate.source.canonical_href).trim();
  const passageId = clean(candidate.passage?.id, 360);
  const candidateId = clean(candidate.candidate_id, 360);
  const textState = clean(candidate.passage?.text_state, 40);
  const coverageState = clean(candidate.coverage_state, 40);
  const passageText = candidate.passage?.text == null
    ? null
    : String(candidate.passage.text).trim().slice(0, MAX_PASSAGE_LENGTH);
  const matchedTerms = Array.isArray(candidate.matched_terms)
    ? [...new Set(candidate.matched_terms.map((term) => clean(term, 120)).filter(Boolean))]
    : [];
  const expectedCanonicalHref = family === "city_record_notice" && nativeId
    ? `/notices/${encodeURIComponent(nativeId)}`
    : null;
  const searchableText = `${sourceTitle || ""}\n${passageText || ""}`.toLocaleLowerCase("en-US");

  if (!SEMANTIC_TOPIC_FAMILIES.includes(family)
      || !sourceId.startsWith(`${family}:`)
      || !safeHttpUrl(sourceUrl)
      || !passageId.startsWith(`${sourceId}:`)
      || !PASSAGE_ID.test(passageId)
      || candidateId !== passageId
      || canonicalHref !== expectedCanonicalHref
      || matchedTerms.length < 1
      || matchedTerms.length > MAX_MATCHED_TERMS
      || matchedTerms.some((term) => !searchableText.includes(term.toLocaleLowerCase("en-US")))
      || clean(candidate.method, 64) !== responseMethod
      || candidate.hard_scope_state !== "matched"
      || !COVERAGE_STATES.has(coverageState)) {
    return null;
  }
  if (textState === "retained" && !passageText) return null;
  if (textState !== "retained" && passageText) return null;

  return freeze({
    candidate_id: candidateId,
    source: {
      id: sourceId,
      family,
      native_id: nativeId,
      title: sourceTitle,
      url: sourceUrl,
      canonical_href: canonicalHref,
    },
    passage: {
      id: passageId,
      text: passageText,
      text_state: textState || "unknown",
      boundary: candidate.passage?.boundary && typeof candidate.passage.boundary === "object"
        ? { ...candidate.passage.boundary }
        : null,
    },
    method: responseMethod,
    matched_terms: matchedTerms,
    hard_scope_state: "matched",
    coverage_state: coverageState,
    freshness: candidate.freshness && typeof candidate.freshness === "object"
      ? { ...candidate.freshness }
      : null,
    evidence_limit: passageText ? null : "Source passage text is unavailable for this candidate.",
  });
}

export function topicCandidateTitle(candidate) {
  const firstLine = String(candidate?.passage?.text || "").split(/\r?\n/, 1)[0];
  return clean(candidate?.source?.title, 500)
    || clean(firstLine, 300)
    || clean(candidate?.source?.native_id, 240)
    || "Public source";
}

export function normalizeSemanticCandidateResponse(payload, { expectedQuery = "" } = {}) {
  if (!payload || typeof payload !== "object" || hasBannedPublicField(payload)) {
    return invalid("unsafe_payload");
  }
  const query = clean(payload.query);
  const method = clean(payload.method, 64);
  if (payload.schema !== SEMANTIC_CANDIDATE_RESPONSE_SCHEMA) return invalid("schema");
  if (!query || query !== clean(expectedQuery)) return invalid("query");
  if (!METHODS.has(method)) return invalid("method");
  if (payload.corpus?.schema !== SEMANTIC_CORPUS_SCHEMA
      || payload.corpus?.manifest_version !== 1
      || payload.corpus?.manifest_sha256 !== SEMANTIC_CORPUS_MANIFEST_SHA256
      || !HASH.test(String(payload.corpus?.content_sha256 || ""))) {
    return invalid("corpus");
  }
  if (payload.index?.schema !== SEMANTIC_PASSAGE_INDEX_SCHEMA
      || payload.index?.version !== SEMANTIC_PASSAGE_INDEX_VERSION
      || !HASH.test(String(payload.index?.corpus_sha256 || ""))) {
    return invalid("index");
  }
  if (!(["unscoped", "applied"].includes(payload.hard_scope?.state))
      || !payload.hard_scope.filters
      || typeof payload.hard_scope.filters !== "object") {
    return invalid("hard_scope");
  }
  if (payload.coverage?.state !== "partial" || !clean(payload.coverage?.boundary, 1_000)) {
    return invalid("coverage");
  }
  if (!Array.isArray(payload.candidates) || payload.candidates.length > MAX_CANDIDATES) {
    return invalid("candidates");
  }

  const candidates = payload.candidates.map((candidate) => normalizedCandidate(candidate, method));
  if (candidates.some((candidate) => !candidate)) return invalid("candidate");
  const groups = SEMANTIC_TOPIC_FAMILIES.map((family) => {
    const familyCandidates = candidates.filter((candidate) => candidate.source.family === family);
    return freeze({
      id: family,
      state: familyCandidates.length ? "matched" : "bounded_empty",
      candidates: familyCandidates,
    });
  });

  return freeze({
    state: "typed",
    schema: payload.schema,
    query,
    method,
    corpus: {
      schema: payload.corpus.schema,
      manifest_version: payload.corpus.manifest_version,
      manifest_sha256: payload.corpus.manifest_sha256,
      content_sha256: payload.corpus.content_sha256,
      observed_on: clean(payload.corpus.observed_on, 40) || null,
    },
    index: {
      schema: payload.index.schema,
      version: payload.index.version,
      corpus_sha256: payload.index.corpus_sha256,
      observed_on: clean(payload.index.observed_on, 40) || null,
    },
    hard_scope: {
      state: payload.hard_scope.state,
      filters: { ...payload.hard_scope.filters },
    },
    coverage: {
      state: "partial",
      boundary: clean(payload.coverage.boundary, 1_000),
    },
    groups,
  });
}
