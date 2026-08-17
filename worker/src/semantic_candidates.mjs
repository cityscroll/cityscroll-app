import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { handleSearch } from "./search.mjs";
import corpusManifest from "../../warehouse/manifests/semantic_retrieval_corpus_manifest.json" with { type: "json" };
import sourcePassageMap from "../../warehouse/experiments/semantic-layer-trial/source_passage_map.json" with { type: "json" };
import { SEMANTIC_CIVIC_OBJECT_FAMILIES } from "../../warehouse/lib/semantic_civic_object_groups.mjs";

export const SEMANTIC_CANDIDATE_RESPONSE_SCHEMA = "cityscroll.semantic_retrieval.candidate_response.v1";
export const SEMANTIC_CANDIDATE_METHOD = "lexical_fallback_v1";

const MAX_QUERY_LENGTH = 240;
const MAX_RESULTS = 20;
const DEFAULT_RESULTS = 10;
const DEFAULT_TIMEOUT_MS = 150;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is",
  "it", "of", "on", "or", "that", "the", "this", "to", "with",
]);

function assertRuntimeArtifacts() {
  if (corpusManifest?.schema !== "cityscroll.semantic_retrieval.corpus_manifest.v1"
      || corpusManifest.manifest_version !== 1
      || corpusManifest.authorization?.runtime_semantic_retrieval !== false) {
    throw new Error("typed candidate corpus manifest is incompatible");
  }
  if (sourcePassageMap?.schema !== "cityscroll.semantic_retrieval.source_passage_map.v1"
      || sourcePassageMap.corpus_sha256 !== corpusManifest.input_receipts?.corpus?.sha256
      || !sourcePassageMap.map_sha256) {
    throw new Error("typed candidate passage index is incompatible");
  }
  if (sourcePassageMap.source_count !== corpusManifest.record_count) {
    throw new Error("typed candidate corpus and passage index counts differ");
  }
  const manifestRecords = new Map(
    corpusManifest.records.map((record) => [record.source_record_id, record]),
  );
  for (const source of sourcePassageMap.sources) {
    const record = manifestRecords.get(source.source_record_id);
    if (!record || record.civic_object_family !== source.civic_object_family) {
      throw new Error("typed candidate civic object classification differs across artifacts");
    }
  }
}

assertRuntimeArtifacts();

const MANIFEST_RECORDS = new Map(
  corpusManifest.records.map((record) => [record.source_record_id, record]),
);
const PASSAGE_SOURCES = new Map(
  sourcePassageMap.sources.map((source) => [source.source_record_id, source]),
);
const PASSAGES = new Map(
  sourcePassageMap.passages.map((passage) => [passage.passage_id, passage]),
);
export const SEMANTIC_SOURCE_FAMILIES = Object.freeze(
  corpusManifest.source_families.map((family) => family.source_family),
);
const SOURCE_FAMILIES = new Set(SEMANTIC_SOURCE_FAMILIES);

function cleanQuery(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

function lexicalTokens(value) {
  const tokens = String(value ?? "").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) || [];
  const useful = tokens.filter((token) => !STOP_WORDS.has(token));
  return [...new Set(useful.length ? useful : tokens)];
}

function normalizedFilters(filters = {}) {
  return Object.fromEntries(Object.entries({
    source_family: filters.source_family || null,
    body_id: filters.body_id || null,
    published_from: filters.published_from || null,
    published_to: filters.published_to || null,
  }).filter(([, value]) => value != null));
}

function validDate(value) {
  if (!DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function matchesScope(record, filters) {
  if (filters.source_family && record.source_family !== filters.source_family) return false;
  if (filters.body_id && record.geography?.body_id !== filters.body_id) return false;
  const publishedOn = String(record.dates?.published_at || "").slice(0, 10);
  if (filters.published_from && (!publishedOn || publishedOn < filters.published_from)) return false;
  if (filters.published_to && (!publishedOn || publishedOn > filters.published_to)) return false;
  return true;
}

function lexicalRank(passage, source, terms, phrase) {
  if (passage.text_state !== "retained" || typeof passage.text !== "string") return null;
  const text = `${source.title || ""}\n${passage.text}`.toLocaleLowerCase("en-US");
  if (!terms.every((term) => text.includes(term))) return null;
  const title = String(source.title || "").toLocaleLowerCase("en-US");
  let rank = phrase && text.includes(phrase) ? 20 : 0;
  for (const term of terms) {
    rank += title.includes(term) ? 4 : 1;
    rank += Math.min(text.split(term).length - 1, 4);
  }
  return rank;
}

function canonicalSourceHref(source) {
  if (source.source_family !== "city_record_notice" || !source.source_native_id) return null;
  return `/notices/${encodeURIComponent(source.source_native_id)}`;
}

function publicCandidate(passage, source, record, matchedTerms) {
  return {
    candidate_id: passage.candidate_id,
    civic_object_family: record.civic_object_family,
    source: {
      id: source.source_record_id,
      family: source.source_family,
      native_id: source.source_native_id,
      url: source.source_url,
      canonical_href: canonicalSourceHref(source),
      title: source.title || null,
    },
    passage: {
      id: passage.passage_id,
      text: passage.text_state === "retained" ? passage.text : null,
      text_state: passage.text_state,
      boundary: passage.boundary,
    },
    method: SEMANTIC_CANDIDATE_METHOD,
    matched_terms: [...matchedTerms],
    hard_scope_state: "matched",
    coverage_state: record.coverage_state,
    freshness: source.freshness,
  };
}

function assertPublicCandidateResponse(result, request) {
  if (result?.schema !== SEMANTIC_CANDIDATE_RESPONSE_SCHEMA
      || result.query !== request.query
      || result.method !== SEMANTIC_CANDIDATE_METHOD
      || !Array.isArray(result.candidates)
      || result.corpus?.manifest_sha256 !== corpusManifest.manifest_sha256
      || result.index?.version !== sourcePassageMap.map_sha256
      || result.coverage?.state !== corpusManifest.coverage.state
      || result.hard_scope?.state !== (Object.keys(request.filters).length ? "applied" : "unscoped")
      || JSON.stringify(result.hard_scope?.filters) !== JSON.stringify(request.filters)) {
    throw new Error("typed candidate response contract failed");
  }

  const forbidden = /(?:^|_)(?:score|cosine|confidence|legal_conclusion|graph_edge)(?:$|_)/i;
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.test(key)) throw new Error("typed candidate response contains a forbidden field");
      visit(child);
    }
  };
  visit(result);

  for (const candidate of result.candidates) {
    const passage = PASSAGES.get(candidate?.passage?.id);
    const source = passage ? PASSAGE_SOURCES.get(passage.source_record_id) : null;
    const record = passage ? MANIFEST_RECORDS.get(passage.source_record_id) : null;
    const expectedTerms = lexicalTokens(request.query);
    if (!candidate?.candidate_id
        || !candidate.source?.id
        || !SOURCE_FAMILIES.has(candidate.source.family)
        || !SEMANTIC_CIVIC_OBJECT_FAMILIES.includes(candidate.civic_object_family)
        || !/^https?:\/\//.test(candidate.source.url || "")
        || !candidate.passage?.id
        || candidate.method !== SEMANTIC_CANDIDATE_METHOD
        || candidate.hard_scope_state !== "matched"
        || !new Set(["partial", "complete", "unknown"]).has(candidate.coverage_state)
        || !passage
        || !source
        || !record
        || !matchesScope(record, request.filters)
        || candidate.candidate_id !== passage.candidate_id
        || candidate.source.id !== source.source_record_id
        || candidate.civic_object_family !== source.civic_object_family
        || candidate.civic_object_family !== record.civic_object_family
        || candidate.source.url !== source.source_url
        || candidate.source.canonical_href !== canonicalSourceHref(source)
        || JSON.stringify(candidate.matched_terms) !== JSON.stringify(expectedTerms)
        || candidate.passage.text !== passage.text) {
      throw new Error("typed candidate is incomplete");
    }
  }
  return result;
}

/**
 * Rank the committed, bounded passage corpus lexically. Structured scope is
 * applied before ranking, and the private rank is intentionally not serialized.
 */
export function retrieveTypedCandidates({ query, filters = {}, limit = DEFAULT_RESULTS } = {}) {
  const cleanedQuery = cleanQuery(query);
  const terms = lexicalTokens(cleanedQuery);
  const scope = normalizedFilters(filters);
  const boundedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_RESULTS, MAX_RESULTS));
  const phrase = cleanedQuery.toLocaleLowerCase("en-US");
  const ranked = [];

  if (terms.length) {
    for (const passage of sourcePassageMap.passages) {
      const record = MANIFEST_RECORDS.get(passage.source_record_id);
      const source = PASSAGE_SOURCES.get(passage.source_record_id);
      if (!record || !source || !matchesScope(record, scope)) continue;
      const rank = lexicalRank(passage, source, terms, phrase);
      if (rank == null) continue;
      ranked.push({ rank, passage, source, record });
    }
  }

  ranked.sort((left, right) => (
    right.rank - left.rank
    || left.passage.passage_id.localeCompare(right.passage.passage_id, "en")
  ));

  return {
    schema: SEMANTIC_CANDIDATE_RESPONSE_SCHEMA,
    query: cleanedQuery,
    method: SEMANTIC_CANDIDATE_METHOD,
    corpus: {
      schema: corpusManifest.schema,
      manifest_version: corpusManifest.manifest_version,
      manifest_sha256: corpusManifest.manifest_sha256,
      content_sha256: corpusManifest.corpus_sha256,
      observed_on: corpusManifest.observed_on,
    },
    index: {
      schema: sourcePassageMap.schema,
      version: sourcePassageMap.map_sha256,
      corpus_sha256: sourcePassageMap.corpus_sha256,
      observed_on: sourcePassageMap.observed_on,
    },
    hard_scope: {
      state: Object.keys(scope).length ? "applied" : "unscoped",
      filters: scope,
    },
    coverage: {
      state: corpusManifest.coverage.state,
      boundary: corpusManifest.coverage.boundary,
    },
    candidates: ranked.slice(0, boundedLimit).map(({ passage, source, record }) => (
      publicCandidate(passage, source, record, terms)
    )),
  };
}

function json(body, status, cors, cacheControl = "no-store") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function parseRequest(url) {
  const query = cleanQuery(url.searchParams.get("q"));
  if (!query) return { error: "missing-query" };

  const sourceFamily = String(url.searchParams.get("source_family") || "").trim() || null;
  if (sourceFamily && !SOURCE_FAMILIES.has(sourceFamily)) return { error: "invalid-source-family" };

  const rawBodyId = String(url.searchParams.get("body_id") || "").trim();
  if (rawBodyId.length > 120) return { error: "invalid-body-id" };
  const bodyId = rawBodyId || null;
  const publishedFrom = String(url.searchParams.get("published_from") || "").trim() || null;
  const publishedTo = String(url.searchParams.get("published_to") || "").trim() || null;
  if (publishedFrom && !validDate(publishedFrom)) return { error: "invalid-published-from" };
  if (publishedTo && !validDate(publishedTo)) return { error: "invalid-published-to" };
  if (publishedFrom && publishedTo && publishedFrom > publishedTo) return { error: "invalid-date-range" };

  const rawLimit = url.searchParams.get("limit");
  if (rawLimit != null && (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_RESULTS)) {
    return { error: "invalid-limit" };
  }

  return {
    query,
    filters: normalizedFilters({
      source_family: sourceFamily,
      body_id: bodyId,
      published_from: publishedFrom,
      published_to: publishedTo,
    }),
    limit: rawLimit == null ? DEFAULT_RESULTS : Number(rawLimit),
  };
}

function timeoutAfter(milliseconds) {
  let timer;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("typed candidate retrieval timed out")), milliseconds);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

async function fallback(request, env, reason) {
  console.warn("semantic-candidates fallback:", reason);
  return handleSearch(request, env);
}

export async function handleSemanticCandidates(request, env, {
  retrieve = retrieveTypedCandidates,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const origin = request.headers.get("origin") || "";
  const cors = corsHeaders(origin, env, {
    methods: "GET, OPTIONS",
    headers: "Accept, Content-Type",
  });
  if (!isAllowedRequestOrigin(origin, env)) return json({ ok: false, reason: "origin" }, 403, cors);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET") return json({ ok: false, reason: "method" }, 405, cors);

  const parsed = parseRequest(new URL(request.url));
  if (parsed.error) return json({ ok: false, reason: parsed.error }, 400, cors);
  if (env?.SEMANTIC_CANDIDATES_ENABLED === "false") return fallback(request, env, "kill_switch");
  if (request.signal?.aborted) return fallback(request, env, "cancelled");

  const timeout = timeoutAfter(Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => retrieve(parsed)),
      timeout.promise,
    ]);
    return json(
      assertPublicCandidateResponse(result, parsed),
      200,
      cors,
      "public, max-age=60, stale-while-revalidate=300",
    );
  } catch (error) {
    return fallback(request, env, String(error?.message || "retrieval_failure"));
  } finally {
    timeout.cancel();
  }
}
