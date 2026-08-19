import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveKeywordQuery, searchKeywordDocuments } from "../site/keyword_matcher.mjs";
import { SEMANTIC_CANDIDATE_METHOD } from "../site/semantic_topic_search.mjs";
import { publicSearchResult } from "../worker/src/search.mjs";
import {
  VECTOR_SHADOW_AUTHORIZATION,
  VECTOR_SHADOW_HONEST_LABEL,
  VECTOR_SHADOW_METHOD,
  VECTOR_SHADOW_SIGNAL_SCHEMA,
  VECTOR_SHADOW_USEFULNESS_GATE,
  rankShadowVector,
  replayFrozenMinilm,
  scoreShadowQuery,
} from "../warehouse/lib/vector_shadow_signal.mjs";
import {
  buildCommittedVectorShadowEvaluation,
  renderVectorShadowSignalReport,
} from "../tools/evaluate_vector_shadow_signal.mjs";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const GOLD = readJson("./fixtures/universal_search_object_gold.json");
const MISS_SET = readJson("./fixtures/vector_shadow_signal/lexical_miss_set.json");
const RETRIEVAL_REVIEW = readJson("../warehouse/experiments/semantic-layer-trial/receipts/retrieval_review.json");

function goldCase(id) {
  const row = GOLD.cases.find((candidate) => candidate.id === id);
  assert.ok(row, `missing gold case: ${id}`);
  return row;
}

function mosquitoDocument() {
  return publicSearchResult(goldCase("mosquito-procurement").source_observation);
}

function educationDocument() {
  const gold = mosquitoDocument();
  return {
    ...gold,
    object_ref: "procurement:education-synonym-fixture",
    title: "Education Department professional development",
    summary: "Education services award",
    search_text: "Education Department professional development Education services award",
  };
}

function decoyDocument() {
  const gold = mosquitoDocument();
  return {
    ...gold,
    object_ref: "procurement:decoy-vendor-mosquito",
    title: "Catch basin maintenance",
    summary: "Vendor mosquito supplies",
    search_text: "Catch basin maintenance Vendor mosquito supplies",
  };
}

function evaluation() {
  return buildCommittedVectorShadowEvaluation();
}

test("the named lexical-miss set is labeled and points at golden-suite expected misses", () => {
  assert.equal(MISS_SET.schema, "cityscroll.search_quality.lexical_miss_set.v1");
  assert.equal(MISS_SET.named_set, "sq-08-lexical-misses-v1");
  assert.equal(MISS_SET.usefulness_gate, VECTOR_SHADOW_USEFULNESS_GATE);
  const goldenIds = MISS_SET.queries
    .filter((row) => row.golden_query_id)
    .map((row) => row.golden_query_id)
    .sort();
  assert.deepEqual(goldenIds, ["gq-mosquito-typo", "gq-school-synonym"]);
  const byId = new Map(GOLD.queries.map((query) => [query.id, query]));
  for (const row of MISS_SET.queries.filter((query) => query.golden_query_id)) {
    const query = byId.get(row.golden_query_id);
    assert.ok(query, row.golden_query_id);
    assert.equal(query.input.text, row.text, row.id);
    assert.equal(query.expect.recall.expected, "miss", `${row.id} must stay an encoded miss`);
  }
  for (const row of MISS_SET.controls) {
    assert.ok(byId.has(row.golden_query_id), row.golden_query_id);
    assert.notEqual(byId.get(row.golden_query_id).expect.recall?.expected, "miss");
  }
});

test("public keyword retrieval still misses the named golden-suite cases", () => {
  const mosquito = mosquitoDocument();
  const education = educationDocument();
  assert.deepEqual(
    searchKeywordDocuments([mosquito], resolveKeywordQuery("mosqito")).map((row) => row.object_ref),
    [],
  );
  assert.deepEqual(
    searchKeywordDocuments([education], resolveKeywordQuery("school")).map((row) => row.object_ref),
    [],
  );
  assert.deepEqual(
    searchKeywordDocuments([mosquito], resolveKeywordQuery("Pesticides and Mosquito Control Products"))
      .map((row) => row.object_ref),
    ["procurement:81626S0021001"],
  );
});

test("hashed n-gram is a shadow candidate signal and does not recover golden misses at the product floor", () => {
  const mosquito = mosquitoDocument();
  const decoy = decoyDocument();
  const education = educationDocument();
  const typo = scoreShadowQuery(
    MISS_SET.queries.find((row) => row.id === "gq-mosquito-typo"),
    [mosquito, decoy],
    [],
  );
  const synonym = scoreShadowQuery(
    MISS_SET.queries.find((row) => row.id === "gq-school-synonym"),
    [education, mosquito],
    [],
  );
  const ranking = scoreShadowQuery(
    MISS_SET.controls.find((row) => row.id === "gq-mosquito-ranking"),
    [mosquito, decoy],
    [mosquito.object_ref, decoy.object_ref],
  );

  assert.equal(typo.method, VECTOR_SHADOW_METHOD);
  assert.equal(typo.public_ranking, false);
  assert.equal(typo.recovered_at_floor, false);
  assert.equal(typo.false_recovery, true);
  assert.equal(typo.vector_top[0].id, decoy.object_ref);
  assert.ok(typo.vector_top.every((row) => row.honest_label === VECTOR_SHADOW_HONEST_LABEL));

  assert.equal(synonym.recovered_at_floor, false);
  assert.equal(synonym.false_recovery, false);
  assert.ok((synonym.relevant_score ?? 0) < MISS_SET.product_min_score);

  assert.equal(ranking.ranking_inversion, true);
  assert.equal(ranking.vector_top[0].id, decoy.object_ref);
  assert.equal(ranking.lexical_state, "hit");
});

test("frozen MiniLM replay keeps the 2026-08-04 not-worth-it coverage numbers", () => {
  const frozen = replayFrozenMinilm(RETRIEVAL_REVIEW, MISS_SET.queries);
  assert.equal(frozen.public_ranking, false);
  assert.deepEqual(frozen.semantic_recoveries, ["q01", "q03"]);
  assert.deepEqual(frozen.semantic_harms, ["q19", "q23", "q28"]);
  assert.equal(frozen.hybrid_additional_queries_vs_bm25, 0);
  assert.equal(frozen.recovered_named_misses.numerator, 2);
  assert.equal(frozen.hybrid_recovered_named_misses.numerator, 1);
  assert.equal(frozen.corpus_queries_with_relevant_at_k.bm25, 28);
  assert.equal(frozen.corpus_queries_with_relevant_at_k.semantic, 27);
  assert.equal(frozen.corpus_queries_with_relevant_at_k.hybrid, 28);
});

test("the evaluation withholds public ranking and does not restore SR4 or SR8", () => {
  const result = evaluation();
  assert.equal(result.schema, VECTOR_SHADOW_SIGNAL_SCHEMA);
  assert.equal(result.decision.status, "shadow_only");
  assert.equal(result.decision.public_ranking_weight, 0);
  assert.equal(result.decision.public_ranking_eligible, false);
  assert.equal(result.decision.captain_call, "withheld");
  assert.equal(result.decision.golden_miss_recovery_at_floor.numerator, 0);
  assert.equal(result.decision.hashed_trial_miss_recovery_at_floor.numerator, 0);
  assert.equal(result.decision.false_recoveries, 1);
  assert.equal(result.decision.ranking_inversions, 1);
  assert.equal(result.decision.restore_sr4_vectorize, false);
  assert.equal(result.decision.restore_sr8_hybrid, false);
  assert.deepEqual(result.authorization, VECTOR_SHADOW_AUTHORIZATION);
  assert.equal(SEMANTIC_CANDIDATE_METHOD, "lexical_fallback_v1");
});

test("public ranking and candidate paths do not consume the shadow vector", () => {
  const federator = readFileSync(new URL("../site/universal_search_federator.mjs", import.meta.url), "utf8");
  const keyword = readFileSync(new URL("../site/keyword_matcher.mjs", import.meta.url), "utf8");
  const search = readFileSync(new URL("../worker/src/search.mjs", import.meta.url), "utf8");
  const wrangler = readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
  const candidates = readFileSync(new URL("../worker/src/semantic_candidates.mjs", import.meta.url), "utf8");
  for (const [name, source] of [
    ["federator", federator],
    ["keyword", keyword],
    ["search", search],
    ["candidates", candidates],
  ]) {
    assert.doesNotMatch(source, /vector_shadow_signal/, `${name} imported the shadow scorer`);
    assert.doesNotMatch(source, /VECTORIZE|Workers AI|hybrid_rrf/, `${name} restored SR4/SR8`);
  }
  assert.doesNotMatch(wrangler, /VECTORIZE|Workers AI/i);
  assert.match(candidates, /lexical_fallback_v1/);
});

test("the committed machine artifact and written evaluation reproduce exactly", () => {
  const result = evaluation();
  const committed = readJson("../docs/evidence/vector-shadow-signal-evaluation.json");
  const report = readFileSync(
    new URL("../docs/evidence/vector-shadow-signal-evaluation.md", import.meta.url),
    "utf8",
  );
  assert.deepEqual(result, committed);
  assert.equal(renderVectorShadowSignalReport(result), report);
  assert.match(report, /Keep the vector signal shadow-only/);
  assert.match(report, /Public ranking weight stays 0/);
  assert.match(report, /captain call/);
  assert.doesNotMatch(report, /may not be complete|disclaimer|we cannot guarantee/i);
});

test("evaluation is deterministic and contains no model or live-source path", () => {
  const first = evaluation();
  const second = evaluation();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const source = readFileSync(new URL("../tools/evaluate_vector_shadow_signal.mjs", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../warehouse/lib/vector_shadow_signal.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\s*\(|openai|anthropic\.com|from ["']sqlite-vec|env\.VECTORIZE|workers-ai/i);
  assert.doesNotMatch(lib, /fetch\s*\(|openai|anthropic\.com|from ["']sqlite-vec|env\.VECTORIZE|workers-ai/i);
  assert.equal(rankShadowVector("mosquito", [mosquitoDocument(), decoyDocument()])[0].public_ranking, false);
});
