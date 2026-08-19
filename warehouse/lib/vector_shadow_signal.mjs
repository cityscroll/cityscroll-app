/**
 * Shadow vector signal for search-quality evaluation.
 *
 * Hashed n-gram TF-IDF cosine is scored against a named lexical-miss set.
 * Results are retrieval candidates only. They do not authorize public ranking,
 * restore Vectorize/Workers AI (SR4), or restore gated hybrid ranking (SR8).
 */

import {
  DEFAULT_MIN_SCORE,
  EMBED_METHOD_HASHED,
  buildIdf,
  cosineSimilarity,
  embedDocument,
} from "./attachment_embeddings.mjs";

export const VECTOR_SHADOW_SIGNAL_SCHEMA = "cityscroll.search_quality.vector_shadow_signal.v1";
export const VECTOR_SHADOW_METHOD = EMBED_METHOD_HASHED;
export const VECTOR_SHADOW_EVALUATION_ID = "sq-08-vector-shadow-2026-08-19";
export const VECTOR_SHADOW_K = 5;
export const VECTOR_SHADOW_USEFULNESS_GATE = 0.3;
export const VECTOR_SHADOW_HONEST_LABEL = "shadow_retrieval_candidate";

export const VECTOR_SHADOW_AUTHORIZATION = Object.freeze({
  public_ranking: false,
  public_ranking_weight: 0,
  runtime_semantic_retrieval: false,
  restore_sr4_vectorize: false,
  restore_sr8_hybrid: false,
  captain_call: "withheld",
});

export function shadowDocument(row = {}) {
  const id = String(row.id || row.object_ref || row.request_id || "").trim();
  const title = row.title || row.short_title || null;
  const text = row.text != null
    ? String(row.text)
    : [row.title, row.summary, row.search_text].filter(Boolean).join("\n");
  return { id, title, text: String(text || "") };
}

export function rankShadowVector(queryText, documents = [], {
  k = VECTOR_SHADOW_K,
  minScore = 0,
  idf = null,
} = {}) {
  const rows = (Array.isArray(documents) ? documents : [])
    .map(shadowDocument)
    .filter((row) => row.id);
  const idfMap = idf || buildIdf(rows);
  const queryVec = embedDocument(String(queryText || ""), { idf: idfMap });
  const ranked = rows
    .map((row) => {
      const score = Number(cosineSimilarity(queryVec, embedDocument(row.text, { idf: idfMap })).toFixed(4));
      return {
        id: row.id,
        title: row.title,
        score,
        honest_label: VECTOR_SHADOW_HONEST_LABEL,
        method: VECTOR_SHADOW_METHOD,
        public_ranking: false,
      };
    })
    .filter((row) => row.score >= minScore)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map((row, index) => ({ ...row, rank: index + 1 }));
  return ranked.slice(0, Math.max(0, Number(k) || 0));
}

function rate(numerator, denominator) {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? Math.round((numerator / denominator) * 1_000_000) / 1_000_000 : null,
  };
}

function relevantAtK(results = [], k = VECTOR_SHADOW_K) {
  return (Array.isArray(results) ? results : [])
    .slice(0, k)
    .filter((row) => row.relevant)
    .map((row) => String(row.document_id));
}

export function scoreShadowQuery(query, documents, lexicalHitIds = [], {
  k = VECTOR_SHADOW_K,
  minScore = DEFAULT_MIN_SCORE,
} = {}) {
  const relevant = new Set(query.relevant || []);
  const harm = new Set(query.harm_controls || []);
  const lexical = new Set(lexicalHitIds);
  const allRanked = rankShadowVector(query.text, documents, { k: documents.length, minScore: 0 });
  const topK = allRanked.slice(0, k);
  const atFloor = allRanked.filter((row) => row.score >= minScore).slice(0, k);
  const preferred = query.preferred_first || [...relevant][0] || null;
  const preferredRow = allRanked.find((row) => row.id === preferred) || null;
  const preferredRank = preferredRow?.rank ?? null;
  const harmAhead = preferred
    ? allRanked.filter((row) => harm.has(row.id) && row.rank < (preferredRank ?? Infinity))
    : [];
  const lexicalRelevant = [...relevant].some((id) => lexical.has(id));
  const lexicalMiss = query.role === "lexical_miss" || !lexicalRelevant;
  const relevantInTopK = topK.filter((row) => relevant.has(row.id));
  const relevantAtFloor = atFloor.filter((row) => relevant.has(row.id));
  const top1 = allRanked[0] || null;
  const recoveredAtFloor = lexicalMiss
    && relevantAtFloor.length > 0
    && relevantAtFloor[0].id === top1?.id
    && !harmAhead.some((row) => row.score >= minScore);
  const falseRecovery = lexicalMiss && Boolean(top1 && harm.has(top1.id));
  const rankingInversion = Boolean(query.preferred_first) && harmAhead.length > 0;

  return Object.freeze({
    id: query.id,
    role: query.role,
    source: query.source,
    golden_query_id: query.golden_query_id || null,
    trial_query_id: query.trial_query_id || null,
    category: query.category,
    text: query.text,
    lexical_hit_ids: [...lexical],
    lexical_relevant: lexicalRelevant,
    lexical_state: lexicalRelevant ? "hit" : "miss",
    vector_top: topK.map((row) => Object.freeze({
      id: row.id,
      rank: row.rank,
      score: row.score,
      relevant: relevant.has(row.id),
      harm_control: harm.has(row.id),
      honest_label: VECTOR_SHADOW_HONEST_LABEL,
    })),
    relevant_rank: preferredRank,
    relevant_score: preferredRow?.score ?? null,
    relevant_in_top_k: relevantInTopK.length > 0,
    recovered_at_k: lexicalMiss && relevantInTopK.length > 0,
    recovered_at_floor: recoveredAtFloor,
    false_recovery: falseRecovery,
    ranking_inversion: rankingInversion,
    method: VECTOR_SHADOW_METHOD,
    public_ranking: false,
  });
}

export function replayFrozenMinilm(retrievalReview, missSetQueries = []) {
  const k = retrievalReview?.k || VECTOR_SHADOW_K;
  const byId = new Map((retrievalReview?.queries || []).map((row) => [row.query_id, row]));
  const named = missSetQueries
    .filter((query) => query.trial_query_id)
    .map((query) => {
      const frozen = byId.get(query.trial_query_id);
      const bm25Hits = relevantAtK(frozen?.methods?.bm25, k);
      const semanticHits = relevantAtK(frozen?.methods?.semantic, k);
      const hybridHits = relevantAtK(frozen?.methods?.hybrid_rrf, k);
      return {
        id: query.id,
        trial_query_id: query.trial_query_id,
        text: query.text,
        relevant: query.relevant,
        bm25_relevant_at_k: bm25Hits,
        semantic_relevant_at_k: semanticHits,
        hybrid_relevant_at_k: hybridHits,
        lexical_miss: bm25Hits.length === 0,
        semantic_recovered: bm25Hits.length === 0 && semanticHits.length > 0,
        hybrid_recovered: bm25Hits.length === 0 && hybridHits.length > 0,
      };
    });

  const all = (retrievalReview?.queries || []).map((row) => {
    const bm25 = relevantAtK(row.methods?.bm25, k).length > 0;
    const semantic = relevantAtK(row.methods?.semantic, k).length > 0;
    const hybrid = relevantAtK(row.methods?.hybrid_rrf, k).length > 0;
    return {
      query_id: row.query_id,
      text: row.query,
      relevant: row.relevant,
      bm25,
      semantic,
      hybrid,
    };
  });
  const bm25Hits = all.filter((row) => row.bm25).length;
  const hybridHits = all.filter((row) => row.hybrid).length;

  return Object.freeze({
    method: "minilm_sqlite_vec_2026-08-04",
    public_ranking: false,
    named_misses: named,
    recovered_named_misses: rate(named.filter((row) => row.semantic_recovered).length, named.length),
    hybrid_recovered_named_misses: rate(named.filter((row) => row.hybrid_recovered).length, named.length),
    corpus_queries_with_relevant_at_k: {
      bm25: bm25Hits,
      semantic: all.filter((row) => row.semantic).length,
      hybrid: hybridHits,
      denominator: all.length,
    },
    hybrid_additional_queries_vs_bm25: hybridHits - bm25Hits,
    semantic_harms: all.filter((row) => row.bm25 && !row.semantic).map((row) => row.query_id),
    semantic_recoveries: all.filter((row) => !row.bm25 && row.semantic).map((row) => row.query_id),
  });
}

export function decideVectorShadowWeight({
  goldenMisses = [],
  hashedTrialMisses = [],
  controls = [],
  frozenMinilm = null,
  captainAuthorized = false,
} = {}) {
  const goldenRecovered = rate(
    goldenMisses.filter((row) => row.recovered_at_floor).length,
    goldenMisses.length,
  );
  const trialRecovered = rate(
    hashedTrialMisses.filter((row) => row.recovered_at_floor).length,
    hashedTrialMisses.length,
  );
  const falseRecoveries = goldenMisses.filter((row) => row.false_recovery).length
    + hashedTrialMisses.filter((row) => row.false_recovery).length;
  const rankingInversions = controls.filter((row) => row.ranking_inversion).length;
  const usefulnessCleared = (goldenRecovered.rate ?? 0) >= VECTOR_SHADOW_USEFULNESS_GATE;
  const harmFree = falseRecoveries === 0 && rankingInversions === 0;
  const frozenHybridUplift = frozenMinilm?.hybrid_additional_queries_vs_bm25 === 0;
  const publicRankingEligible = usefulnessCleared
    && harmFree
    && captainAuthorized
    && VECTOR_SHADOW_AUTHORIZATION.restore_sr4_vectorize === false
    && VECTOR_SHADOW_AUTHORIZATION.restore_sr8_hybrid === false;

  return Object.freeze({
    status: "shadow_only",
    public_ranking_weight: 0,
    public_ranking_eligible: publicRankingEligible,
    captain_call: captainAuthorized ? "authorized" : "withheld",
    usefulness_gate: VECTOR_SHADOW_USEFULNESS_GATE,
    golden_miss_recovery_at_floor: goldenRecovered,
    hashed_trial_miss_recovery_at_floor: trialRecovered,
    false_recoveries: falseRecoveries,
    ranking_inversions: rankingInversions,
    frozen_hybrid_additional_queries_vs_bm25: frozenMinilm?.hybrid_additional_queries_vs_bm25 ?? null,
    restore_sr4_vectorize: false,
    restore_sr8_hybrid: false,
    reasons: Object.freeze([
      `hashed n-gram recovered ${goldenRecovered.numerator}/${goldenRecovered.denominator} golden-suite lexical misses at the product score floor`,
      `hashed n-gram recovered ${trialRecovered.numerator}/${trialRecovered.denominator} frozen-trial BM25 misses at the product score floor`,
      `false recoveries=${falseRecoveries}; ranking inversions=${rankingInversions}`,
      frozenHybridUplift
        ? "frozen MiniLM hybrid added 0 queries with a relevant top-five result versus BM25"
        : "frozen MiniLM hybrid query coverage is not a public-ranking authorization",
      "public ranking remains a captain call and is withheld",
    ]),
  });
}

export function buildVectorShadowEvaluation({
  missSet,
  goldenCases = [],
  controlCases = [],
  hashedTrialCases = [],
  frozenMinilm,
  inputFingerprints = {},
} = {}) {
  const decision = decideVectorShadowWeight({
    goldenMisses: goldenCases,
    hashedTrialMisses: hashedTrialCases,
    controls: controlCases,
    frozenMinilm,
    captainAuthorized: false,
  });
  return Object.freeze({
    schema: VECTOR_SHADOW_SIGNAL_SCHEMA,
    evaluation_id: VECTOR_SHADOW_EVALUATION_ID,
    evaluated_on: missSet?.observed_on || "2026-08-19",
    method: VECTOR_SHADOW_METHOD,
    named_set: missSet?.named_set,
    k: missSet?.k || VECTOR_SHADOW_K,
    product_min_score: missSet?.product_min_score || DEFAULT_MIN_SCORE,
    authorization: VECTOR_SHADOW_AUTHORIZATION,
    input_fingerprints: inputFingerprints,
    cases: Object.freeze({
      golden_lexical_misses: goldenCases,
      golden_controls: controlCases,
      hashed_trial_misses: hashedTrialCases,
      frozen_minilm: frozenMinilm,
    }),
    decision,
  });
}
