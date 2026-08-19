#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { resolveKeywordQuery, searchKeywordDocuments } from "../site/keyword_matcher.mjs";
import { publicSearchResult } from "../worker/src/search.mjs";
import {
  VECTOR_SHADOW_K,
  buildVectorShadowEvaluation,
  replayFrozenMinilm,
  scoreShadowQuery,
} from "../warehouse/lib/vector_shadow_signal.mjs";

const MISS_SET = new URL("../test/fixtures/vector_shadow_signal/lexical_miss_set.json", import.meta.url);
const GOLD = new URL("../test/fixtures/universal_search_object_gold.json", import.meta.url);
const TRIAL_CORPUS = new URL("../warehouse/experiments/semantic-layer-trial/corpus.json", import.meta.url);
const RETRIEVAL_REVIEW = new URL(
  "../warehouse/experiments/semantic-layer-trial/receipts/retrieval_review.json",
  import.meta.url,
);
const OUTPUT = new URL("../docs/evidence/vector-shadow-signal-evaluation.json", import.meta.url);
const REPORT = new URL("../docs/evidence/vector-shadow-signal-evaluation.md", import.meta.url);

const EDUCATION_FIXTURE_REF = "procurement:education-synonym-fixture";
const DECOY_VENDOR_REF = "procurement:decoy-vendor-mosquito";

function json(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

function fingerprint(value) {
  const bytes = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(bytes).digest("hex");
}

function goldCase(gold, id) {
  const row = gold.cases.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`missing gold case: ${id}`);
  return row;
}

function goldenDocuments(gold) {
  const mosquito = publicSearchResult(goldCase(gold, "mosquito-procurement").source_observation);
  const education = {
    ...mosquito,
    object_ref: EDUCATION_FIXTURE_REF,
    title: "Education Department professional development",
    summary: "Education services award",
    search_text: "Education Department professional development Education services award",
    canonical_href: "/browse/contracts/?mode=award&q=education-synonym-fixture",
    source_observation_refs: ["notice:education-synonym-fixture"],
  };
  const decoy = {
    ...mosquito,
    object_ref: DECOY_VENDOR_REF,
    title: "Catch basin maintenance",
    summary: "Vendor mosquito supplies",
    search_text: "Catch basin maintenance Vendor mosquito supplies",
    canonical_href: "/browse/contracts/?mode=award&q=decoy-vendor-mosquito",
    source_observation_refs: ["notice:decoy-vendor-mosquito"],
  };
  return { mosquito, education, decoy };
}

function documentsFor(corpus, golden, trialDocs) {
  if (corpus === "golden_keyword_mosquito" || corpus === "golden_mosquito_ranking") {
    return [golden.mosquito, golden.decoy];
  }
  if (corpus === "golden_education_fixture") {
    return [golden.education, golden.mosquito];
  }
  if (corpus === "semantic_layer_trial") return trialDocs;
  throw new Error(`unknown shadow corpus: ${corpus}`);
}

function frozenBm25HitIds(query, retrievalReview) {
  const frozen = (retrievalReview?.queries || []).find((row) => row.query_id === query.trial_query_id);
  return (frozen?.methods?.bm25 || [])
    .slice(0, VECTOR_SHADOW_K)
    .filter((row) => row.relevant)
    .map((row) => String(row.document_id));
}

function lexicalHitIds(query, documents, retrievalReview) {
  if (query.trial_query_id) return frozenBm25HitIds(query, retrievalReview);
  return searchKeywordDocuments(documents, resolveKeywordQuery(query.text), { limit: 40 })
    .map((document) => document.object_ref);
}

function percent(rate) {
  if (rate == null) return "n/a";
  return `${(rate * 100).toFixed(2)}%`;
}

export function renderVectorShadowSignalReport(evaluation) {
  const d = evaluation.decision;
  const frozen = evaluation.cases.frozen_minilm;
  const goldenRows = evaluation.cases.golden_lexical_misses
    .map((row) => `- **${row.id}** (${row.category}): keyword ${row.lexical_state}; recovered at floor ${row.recovered_at_floor}; false recovery ${row.false_recovery}; relevant rank ${row.relevant_rank} score ${row.relevant_score}.`)
    .join("\n");
  const controlRows = evaluation.cases.golden_controls
    .map((row) => `- **${row.id}** (${row.role}): keyword ${row.lexical_state}; ranking inversion ${row.ranking_inversion}; relevant rank ${row.relevant_rank} score ${row.relevant_score}.`)
    .join("\n");
  const trialRows = evaluation.cases.hashed_trial_misses
    .map((row) => `- **${row.id}**: hashed relevant rank ${row.relevant_rank} score ${row.relevant_score}; recovered at k=${evaluation.k} ${row.recovered_at_k}; recovered at floor ${row.recovered_at_floor}.`)
    .join("\n");

  return `# Vector shadow signal evaluation

Evaluation: \`${evaluation.evaluation_id}\`
Method: \`${evaluation.method}\`
Named miss set: \`${evaluation.named_set}\`
k=${evaluation.k}; product score floor=${evaluation.product_min_score}.

## Decision

**Keep the vector signal shadow-only. Public ranking weight stays 0.**

This is a measurement for the captain, not a ranking change. Public search remains exact-token keyword plus the existing precomputed related-reading edges. SR4 Vectorize/Workers AI and SR8 gated hybrid ranking stay unrestored.

## Results

| Slice | Numerator / denominator | Result | Reading |
| --- | ---: | ---: | --- |
| Golden-suite miss recovery at score floor | ${d.golden_miss_recovery_at_floor.numerator} / ${d.golden_miss_recovery_at_floor.denominator} | ${percent(d.golden_miss_recovery_at_floor.rate)} | Hashed n-gram did not recover the remaining golden-suite typo miss without ranking a distractor first. |
| Frozen-trial BM25-miss recovery at score floor | ${d.hashed_trial_miss_recovery_at_floor.numerator} / ${d.hashed_trial_miss_recovery_at_floor.denominator} | ${percent(d.hashed_trial_miss_recovery_at_floor.rate)} | The production-safe hashed vector did not clear the 0.22 related-edge floor on either paraphrase miss. |
| Ranking inversions on golden controls | ${d.ranking_inversions} | harm | Query \`mosquito\` ranks the decoy above the exact title. |
| False recoveries | ${d.false_recoveries} | harm | Query \`mosqito\` ranks the decoy ahead of the pesticide award. |
| Frozen MiniLM hybrid vs BM25 | ${frozen.hybrid_additional_queries_vs_bm25} extra queries | no coverage gain | MiniLM recovered both BM25 misses and dropped ${frozen.semantic_harms.join(", ")}; hybrid added zero queries with a relevant top five. |

Usefulness gate for public ranking: ${d.usefulness_gate}. Captain call: ${d.captain_call}.

## Golden-suite lexical misses

${goldenRows}

## Golden-suite ranking controls

${controlRows}

## Hashed n-gram on the frozen-trial BM25 misses

${trialRows}

## Frozen MiniLM replay

Learned ranking recovered named misses ${frozen.recovered_named_misses.numerator}/${frozen.recovered_named_misses.denominator} and hybrid recovered ${frozen.hybrid_recovered_named_misses.numerator}/${frozen.hybrid_recovered_named_misses.denominator}. Corpus queries with a relevant top five: BM25 ${frozen.corpus_queries_with_relevant_at_k.bm25}/${frozen.corpus_queries_with_relevant_at_k.denominator}, semantic ${frozen.corpus_queries_with_relevant_at_k.semantic}/${frozen.corpus_queries_with_relevant_at_k.denominator}, hybrid ${frozen.corpus_queries_with_relevant_at_k.hybrid}/${frozen.corpus_queries_with_relevant_at_k.denominator}. Semantic harms: ${frozen.semantic_harms.join(", ")}.

## Why public ranking stays at weight 0

${d.reasons.map((reason) => `- ${reason}`).join("\n")}

A later public-ranking weight still needs a captain-recorded decision, a named miss set that clears the usefulness gate without ranking harm, and must not restore SR4 or SR8. Refresh this receipt with \`node tools/evaluate_vector_shadow_signal.mjs\`.
`;
}

export function loadVectorShadowSignalInputs() {
  const missSet = json(MISS_SET);
  const gold = json(GOLD);
  const trialCorpus = json(TRIAL_CORPUS);
  const retrievalReview = json(RETRIEVAL_REVIEW);
  const golden = goldenDocuments(gold);
  const trialDocs = (trialCorpus.documents || []).map((row) => ({
    id: row.id,
    title: row.title || null,
    text: `${row.title || ""}\n${row.text || ""}`,
  }));
  return { missSet, gold, golden, trialDocs, retrievalReview, trialCorpus };
}

export function buildCommittedVectorShadowEvaluation(inputs = loadVectorShadowSignalInputs()) {
  const { missSet, gold, golden, trialDocs, retrievalReview, trialCorpus } = inputs;
  const k = missSet.k || VECTOR_SHADOW_K;
  const minScore = missSet.product_min_score;
  const score = (query) => {
    const documents = documentsFor(query.corpus, golden, trialDocs);
    return scoreShadowQuery(
      query,
      documents,
      lexicalHitIds(query, documents, retrievalReview),
      { k, minScore },
    );
  };
  return buildVectorShadowEvaluation({
    missSet,
    goldenCases: missSet.queries.filter((query) => query.source === "golden_suite").map(score),
    controlCases: missSet.controls.map(score),
    hashedTrialCases: missSet.queries
      .filter((query) => query.source === "semantic_layer_trial_2026-08-04")
      .map(score),
    frozenMinilm: replayFrozenMinilm(retrievalReview, missSet.queries),
    inputFingerprints: {
      lexical_miss_set: fingerprint(missSet),
      golden_queries: fingerprint(
        [...missSet.queries, ...missSet.controls]
          .map((row) => row.golden_query_id)
          .filter(Boolean)
          .sort()
          .map((id) => gold.queries.find((query) => query.id === id) || { id, missing: true }),
      ),
      trial_corpus: fingerprint(JSON.stringify({
        document_count: trialCorpus.document_count,
        documents: trialCorpus.documents?.length,
      })),
      retrieval_review: fingerprint({
        schema: retrievalReview.schema,
        metrics: retrievalReview.metrics,
        query_ids: (retrievalReview.queries || []).map((row) => row.query_id),
      }),
    },
  });
}

export function writeVectorShadowSignalEvaluation({ check = false } = {}) {
  const evaluation = buildCommittedVectorShadowEvaluation();
  const files = [
    [OUTPUT, `${JSON.stringify(evaluation, null, 2)}\n`],
    [REPORT, renderVectorShadowSignalReport(evaluation)],
  ];
  const stale = files.filter(([url, content]) => !existsSync(url) || readFileSync(url, "utf8") !== content);
  if (check && stale.length) {
    for (const [url] of stale) console.error(`stale vector shadow evaluation artifact: ${fileURLToPath(url)}`);
    process.exitCode = 1;
    return evaluation;
  }
  if (!check) {
    for (const [url, content] of stale) writeFileSync(url, content);
  }
  console.log(stale.length
    ? `wrote vector shadow evaluation (${stale.length} artifact${stale.length === 1 ? "" : "s"})`
    : "vector shadow evaluation current");
  return evaluation;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeVectorShadowSignalEvaluation({ check: process.argv.includes("--check") });
}
