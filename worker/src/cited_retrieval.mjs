import corpusManifest from "../../warehouse/manifests/semantic_retrieval_corpus_manifest.json" with { type: "json" };
import sourcePassageMap from "../../warehouse/experiments/semantic-layer-trial/source_passage_map.json" with { type: "json" };
import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";

import {
  SEMANTIC_CANDIDATE_RESPONSE_SCHEMA,
  SEMANTIC_SOURCE_FAMILIES,
  retrieveTypedCandidates,
} from "./semantic_candidates.mjs";
import {
  CITED_PASSAGES_CONTRACT_VERSION,
  CITED_PASSAGES_EXACT_JOIN_METHOD,
  CITED_PASSAGES_CAPABILITY_REFERENCE,
  CITED_PASSAGES_PROVIDER_ID,
  CITED_PASSAGES_REPRESENTATIONS,
  CITED_PASSAGES_RESPONSE_SCHEMA,
  executeCitedPassages,
} from "../../capabilities/cited_passages.mjs";

export const CITED_RETRIEVAL_RESPONSE_SCHEMA = CITED_PASSAGES_RESPONSE_SCHEMA;
export const CITED_RETRIEVAL_CONTRACT_VERSION = CITED_PASSAGES_CONTRACT_VERSION;
export const CITED_RETRIEVAL_EXACT_JOIN_METHOD = CITED_PASSAGES_EXACT_JOIN_METHOD;

export const HTTP_CITED_PASSAGES_ADAPTER = Object.freeze({
  id: "worker-http.retrieve-cited-passages@1",
  capabilityReference: CITED_PASSAGES_CAPABILITY_REFERENCE,
  providerId: CITED_PASSAGES_PROVIDER_ID,
  route: "GET /cited-passages",
  surface: "Cited passage retrieval",
  representations: CITED_PASSAGES_REPRESENTATIONS,
});

const COVERAGE_STATES = new Set(["partial", "complete", "unknown"]);
const JOIN_STATES = new Set(["matched", "unknown"]);

export const CITED_RETRIEVAL_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schema", "contract_version", "query", "retrieval", "hard_scope", "coverage", "citations"],
  properties: {
    schema: { type: "string", const: CITED_RETRIEVAL_RESPONSE_SCHEMA },
    contract_version: { type: "integer", const: CITED_RETRIEVAL_CONTRACT_VERSION },
    query: { type: "string", minLength: 1, maxLength: 240 },
    retrieval: {
      type: "object",
      additionalProperties: false,
      required: ["method", "corpus", "index"],
      properties: {
        method: { type: "string" },
        corpus: {
          type: "object",
          additionalProperties: false,
          required: ["schema", "manifest_version", "manifest_sha256", "content_sha256", "observed_on"],
          properties: {
            schema: { type: "string", const: "cityscroll.semantic_retrieval.corpus_manifest.v1" },
            manifest_version: { type: "integer", const: 1 },
            manifest_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            content_sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            observed_on: { type: ["string", "null"] },
          },
        },
        index: {
          type: "object",
          additionalProperties: false,
          required: ["schema", "version", "corpus_sha256", "observed_on"],
          properties: {
            schema: { type: "string", const: "cityscroll.semantic_retrieval.source_passage_map.v1" },
            version: { type: "string", pattern: "^[a-f0-9]{64}$" },
            corpus_sha256: { type: ["string", "null"] },
            observed_on: { type: ["string", "null"] },
          },
        },
      },
    },
    hard_scope: { type: "object" },
    coverage: {
      type: "object",
      additionalProperties: false,
      required: ["state", "boundary"],
      properties: {
        state: { type: "string", enum: [...COVERAGE_STATES] },
        boundary: { type: ["string", "null"] },
      },
    },
    citations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "citation_id", "source", "passage", "coverage_state", "freshness", "exact_join_evidence",
        ],
        properties: {
          citation_id: { type: "string" },
          source: {
            type: "object",
            additionalProperties: false,
            required: ["id", "family", "native_id", "url", "canonical_href", "title"],
            properties: {
              id: { type: "string" },
              family: { type: "string", enum: SEMANTIC_SOURCE_FAMILIES },
              native_id: { type: "string" },
              url: { type: "string", format: "uri" },
              canonical_href: { type: ["string", "null"] },
              title: { type: ["string", "null"] },
            },
          },
          passage: {
            type: "object",
            additionalProperties: false,
            required: ["id", "text", "text_state", "boundary"],
            properties: {
              id: { type: "string" },
              text: { type: ["string", "null"] },
              text_state: { type: "string", enum: ["retained", "unknown"] },
              boundary: {
                type: "object",
                additionalProperties: false,
                required: ["unit", "start", "end"],
                properties: {
                  unit: { type: "string", const: "utf16_code_unit" },
                  start: { type: ["integer", "null"] },
                  end: { type: ["integer", "null"] },
                },
              },
            },
          },
          coverage_state: { type: "string", enum: [...COVERAGE_STATES] },
          freshness: {
            type: "object",
            additionalProperties: false,
            required: ["state", "observed_on", "source_published_at"],
            properties: {
              state: { type: "string", enum: ["observed", "stale", "unknown"] },
              observed_on: { type: ["string", "null"] },
              source_published_at: { type: ["string", "null"] },
            },
          },
          exact_join_evidence: {
            type: "object",
            additionalProperties: false,
            required: ["state", "method", "candidate_id", "source_record_id", "passage_id"],
            properties: {
              state: { type: "string", enum: [...JOIN_STATES] },
              method: { type: ["string", "null"] },
              candidate_id: { type: "string" },
              source_record_id: { type: ["string", "null"] },
              passage_id: { type: ["string", "null"] },
            },
          },
        },
      },
    },
  },
});

function sameBoundary(left, right) {
  return left?.unit === right?.unit
    && left?.start === right?.start
    && left?.end === right?.end;
}

function exactJoinEvidence(candidate, candidateResponse, manifest, passageMap) {
  const reference = passageMap?.by_candidate_id?.[candidate.candidate_id];
  const source = passageMap?.sources?.find(({ source_record_id: id }) => id === reference?.source_record_id);
  const passage = passageMap?.passages?.find(({ passage_id: id }) => id === reference?.passage_id);
  const record = manifest?.records?.find(({ source_record_id: id }) => id === reference?.source_record_id);
  const artifactsMatch = candidateResponse.corpus?.schema === manifest?.schema
    && candidateResponse.corpus?.manifest_version === manifest?.manifest_version
    && candidateResponse.corpus?.manifest_sha256 === manifest?.manifest_sha256
    && candidateResponse.corpus?.content_sha256 === manifest?.corpus_sha256
    && candidateResponse.index?.schema === passageMap?.schema
    && candidateResponse.index?.version === passageMap?.map_sha256
    && candidateResponse.index?.corpus_sha256 === passageMap?.corpus_sha256;
  const matched = artifactsMatch
    && !!reference
    && reference.source_record_id === candidate.source.id
    && reference.passage_id === candidate.passage.id
    && source?.source_record_id === candidate.source.id
    && source?.source_family === candidate.source.family
    && source?.source_native_id === candidate.source.native_id
    && source?.source_url === candidate.source.url
    && passage?.candidate_id === candidate.candidate_id
    && passage?.source_record_id === candidate.source.id
    && passage?.text === candidate.passage.text
    && sameBoundary(passage?.boundary, candidate.passage.boundary)
    && record?.source_record_id === candidate.source.id
    && record?.source_family === candidate.source.family
    && record?.source_native_id === candidate.source.native_id
    && record?.source_url === candidate.source.url;

  if (!matched) {
    return {
      state: "unknown",
      method: null,
      candidate_id: candidate.candidate_id,
      source_record_id: null,
      passage_id: null,
    };
  }
  return {
    state: "matched",
    method: CITED_RETRIEVAL_EXACT_JOIN_METHOD,
    candidate_id: candidate.candidate_id,
    source_record_id: reference.source_record_id,
    passage_id: reference.passage_id,
  };
}

function assertCitedRetrievalResponse(response) {
  if (response?.schema !== CITED_RETRIEVAL_RESPONSE_SCHEMA
      || response.contract_version !== CITED_RETRIEVAL_CONTRACT_VERSION
      || typeof response.query !== "string"
      || !response.retrieval?.method
      || !response.retrieval?.corpus?.manifest_sha256
      || !response.retrieval?.index?.version
      || !COVERAGE_STATES.has(response.coverage?.state)
      || !Array.isArray(response.citations)) {
    throw new Error("cited retrieval response contract failed");
  }

  const forbidden = /(?:^|_)(?:answer|synthesis|action|legal_conclusion|graph_edge|relationship)(?:$|_)/i;
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (forbidden.test(key)) throw new Error("cited retrieval response contains a forbidden field");
      visit(child);
    }
  };
  visit(response);

  for (const citation of response.citations) {
    const evidence = citation?.exact_join_evidence;
    if (!citation?.citation_id
        || citation.citation_id !== citation.passage?.id
        || !citation.source?.id
        || !citation.source?.family
        || !/^https?:\/\//.test(citation.source?.url || "")
        || !COVERAGE_STATES.has(citation.coverage_state)
        || !JOIN_STATES.has(evidence?.state)
        || evidence.candidate_id !== citation.citation_id) {
      throw new Error("cited retrieval citation is incomplete");
    }
    if (evidence.state === "matched"
        && (evidence.method !== CITED_RETRIEVAL_EXACT_JOIN_METHOD
          || evidence.source_record_id !== citation.source.id
          || evidence.passage_id !== citation.passage.id)) {
      throw new Error("cited retrieval exact join is inconsistent");
    }
    if (evidence.state === "unknown"
        && (evidence.method !== null || evidence.source_record_id !== null || evidence.passage_id !== null)) {
      throw new Error("unknown cited retrieval evidence must not infer identifiers");
    }
  }
  return response;
}

export function projectCitedRetrievalResponse(candidateResponse, {
  manifest = corpusManifest,
  passageMap = sourcePassageMap,
} = {}) {
  if (candidateResponse?.schema !== SEMANTIC_CANDIDATE_RESPONSE_SCHEMA) {
    throw new Error("cited retrieval requires typed candidate response v1");
  }
  const response = {
    schema: CITED_RETRIEVAL_RESPONSE_SCHEMA,
    contract_version: CITED_RETRIEVAL_CONTRACT_VERSION,
    query: candidateResponse.query,
    retrieval: {
      method: candidateResponse.method,
      corpus: candidateResponse.corpus,
      index: candidateResponse.index,
    },
    hard_scope: candidateResponse.hard_scope,
    coverage: candidateResponse.coverage,
    citations: candidateResponse.candidates.map((candidate) => ({
      citation_id: candidate.passage.id,
      source: candidate.source,
      passage: candidate.passage,
      coverage_state: candidate.coverage_state,
      freshness: candidate.freshness,
      exact_join_evidence: exactJoinEvidence(candidate, candidateResponse, manifest, passageMap),
    })),
  };
  return assertCitedRetrievalResponse(response);
}

export function retrieveCitedPassages(input = {}, options = {}) {
  const retrieve = options.retrieve || retrieveTypedCandidates;
  return projectCitedRetrievalResponse(retrieve(input), options);
}

/** Explicit provider over the existing cited-retrieval projector. */
export function workerCitedPassages(options = {}) {
  return Object.freeze({
    capabilityReference: CITED_PASSAGES_CAPABILITY_REFERENCE,
    providerId: CITED_PASSAGES_PROVIDER_ID,
    execute(input) {
      return retrieveCitedPassages(input, options);
    },
  });
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

function parseHttpInput(url) {
  const query = String(url.searchParams.get("q") || url.searchParams.get("query") || "").trim();
  const sourceFamily = String(url.searchParams.get("source_family") || "").trim() || null;
  const bodyId = String(url.searchParams.get("body_id") || "").trim() || null;
  const publishedFrom = String(url.searchParams.get("published_from") || "").trim() || null;
  const publishedTo = String(url.searchParams.get("published_to") || "").trim() || null;
  const rawLimit = url.searchParams.get("limit");
  return {
    query,
    filters: {
      source_family: sourceFamily,
      body_id: bodyId,
      published_from: publishedFrom,
      published_to: publishedTo,
    },
    ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
  };
}

export function formatCitedPassagesText(result) {
  const count = result.citations.length;
  return `Returned ${count} source passage${count === 1 ? "" : "s"}. Use the structured citations for source text and links.`;
}

/** HTTP adapter for cited.passages.retrieve@1; all civic meaning comes from the capability. */
export async function handleCitedPassages(request, env) {
  const origin = request.headers.get("origin") || "";
  const cors = corsHeaders(origin, env, {
    methods: "GET, OPTIONS",
    headers: "Accept, Content-Type",
  });
  if (!isAllowedRequestOrigin(origin, env)) return json({ ok: false, reason: "origin" }, 403, cors);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET") return json({ ok: false, reason: "method" }, 405, cors);
  if (env?.SEMANTIC_CANDIDATES_ENABLED === "false") {
    return json({ ok: false, reason: "unavailable" }, 503, cors);
  }

  const input = parseHttpInput(new URL(request.url));
  try {
    const result = await executeCitedPassages(workerCitedPassages(), input);
    const format = new URL(request.url).searchParams.get("format");
    if (format === "text" || (request.headers.get("accept") || "").includes("text/plain")) {
      return new Response(formatCitedPassagesText(result), {
        status: 200,
        headers: { ...cors, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60" },
      });
    }
    return json(result, 200, cors, "public, max-age=60, stale-while-revalidate=300");
  } catch (error) {
    const message = String(error?.message || error);
    const invalid = /^(?:query|body_id|published_|source_family|filters|limit)/.test(message);
    return json({ ok: false, reason: invalid ? "invalid-request" : "unavailable" }, invalid ? 400 : 503, cors);
  }
}
