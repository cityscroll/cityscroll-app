# Semantic-layer trial: learned retrieval and evidence-gated link candidates

Observed on 2026-08-04. This is a bounded offline experiment, not product wiring.
Every semantic result is labeled as a candidate. No score in this experiment
authorizes a rendered fact or link.

## Decision

**Decision hook: `not-worth-it`.** Do not add a learned embedding service or a
vector database to the product from this trial.

Learned retrieval found two useful paraphrase matches that BM25 missed, but it
also missed three strong lexical matches. Hybrid retrieval put 37 relevant
documents in 150 result slots, compared with BM25's 36, and did not increase the
number of queries with at least one relevant result. The one reviewed join
candidate survived review, but represented 1 of 10 residual records, below the
existing 30% usefulness gate. Exact body and date filters already isolated that
pair, so this trial did not demonstrate that embeddings caused join uplift.

The near-term opportunity is ranked lexical retrieval. BM25 improved the fixed
query set from 3 to 28 queries with a relevant result in the top five without a
model or vector index. The existing precomputed related-reading path should stay
in place. A learned-layer trial becomes worth repeating only when a larger
labeled set identifies a reader journey that ranked lexical retrieval misses.

## What exists today

CityScroll has no learned vector database or query-time embedding layer.

- D1 notice search applies deterministic token constraints over the notice
  `haystack` in `worker/src/lib/notices.mjs`.
- Attachment T3 in `warehouse/lib/attachment_embeddings.mjs` computes a local,
  256-dimension hashed n-gram TF-IDF representation and publishes static related
  notice edges. It is vector-shaped, but it is not a learned embedding model or
  a vector database. The boundary is recorded in
  `docs/adr/attachment-text-embeddings.md`.
- Entity links remain deterministic and provenance-bearing. This trial did not
  alter them.

That distinction matters: a static similarity build can support labeled
"related reading" without putting a model, remote index, or semantic score on a
request path.

## Design-space findings

### Search behavior: where semantics can help

Hearst distinguishes lookup from **exploratory search**: the reader learns,
reformulates, and follows new cues rather than retrieving one known item. Her
discussion of berrypicking and information scent explains the useful civic case:
a resident may know the concept but not the agency's vocabulary, while clear
titles and snippets let the resident decide whether to continue. This favors
semantic candidates for paraphrases and related reading, not invisible factual
inference. [Hearst, *User Interfaces for Search*, chapter 2, pp. 4–7](https://people.ischool.berkeley.edu/~hearst/papers/mir2e_chapter2_hearst_uis_references.pdf)

GRAFS similarly frames exploratory search as mental-model building with facets,
clusters, and visual summaries. It also notes that automatically generated
clusters can confuse users. That supports progressive disclosure and source
snippets around any related-reading surface. [Guo et al., *GRAFS*](https://arxiv.org/abs/2302.09448)

### Retrieval practice: why lexical remains a serious baseline

BEIR found BM25 to be a robust zero-shot baseline and found that dense methods
can lose effectiveness outside the distributions on which they were trained.
More capable reranking and late-interaction approaches performed well on average
but carried higher computation costs. [Thakur et al., *BEIR*](https://arxiv.org/abs/2104.08663)

The common production pattern is therefore a **retrieve-and-rerank cascade**:
retrieve a broad candidate set cheaply, then apply a more expensive model to a
small set. Sentence Transformers documents this as bi-encoder retrieval followed
by CrossEncoder reranking. The trial measured candidate retrieval only; it did
not measure a reranker. [Sentence Transformers retrieve-and-rerank guide](https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html)

### Storage choices

| Option | Appropriate use | Added mechanics | Trial finding |
|---|---|---|---|
| BM25 or another ranked lexical index | Reader search over the existing corpus | Tokenization, ranking, refresh | Best next step; 28/30 queries had a relevant top-five result |
| `sqlite-vec` in an offline build | Bounded experiments and review queues | Local extension, model cache, rebuild receipts | Sufficient for the trial; it keeps candidate generation off the request path |
| Cloudflare Vectorize with Workers AI | Arbitrary semantic queries at runtime, after measured adoption evidence | Remote index, embedding call, bindings, versioned refresh and failure behavior | Platform-native fit for the current Worker stack, but unneeded for the observed uplift |
| No vector database | Static related-reading edges | Rebuild the committed artifact | Already fits the T3 path and remains the lowest-complexity choice |

`sqlite-vec` exposes vector KNN through SQLite and explicitly describes itself as
pre-v1, which makes pinning and receipt checks important for experiments.
[sqlite-vec KNN documentation](https://alexgarcia.xyz/sqlite-vec/features/knn.html)
[sqlite-vec versioning](https://alexgarcia.xyz/sqlite-vec/versioning.html)

If runtime semantic retrieval later clears an adoption gate, Cloudflare
Vectorize is the narrowest operational fit: Workers access the index through a
binding, and Workers AI can create query embeddings. That conclusion is about
architecture fit, not measured performance; this trial did not call either
service. [Cloudflare Vectorize overview](https://developers.cloudflare.com/vectorize/)
[Workers AI embeddings guide](https://developers.cloudflare.com/vectorize/get-started/embeddings/)

## Trial method

### Corpus and model

- Fixed corpus: 122 public documents—120 City Record notice bodies, one already
  extracted City Record attachment, and one community-board minutes document.
- Chunking: 1,200 characters with 200-character overlap; 238 chunks.
- Model: `sentence-transformers/all-MiniLM-L6-v2`, pinned to the immutable
  revision recorded in the cost receipt and run locally on CPU. The measured
  output is 384 dimensions and the measured maximum sequence length is 256.
  The model card describes it as a sentence and short-paragraph encoder for
  semantic search. [Model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2)
- Vector index: `sqlite-vec` 0.1.9 in ignored local storage. No index or model
  binary is committed.
- Fixed judgments: 30 realistic reader queries, each with explicit relevant
  document IDs and a short judgment basis.

Before hashing and embedding, the fixture builder redacts contact details, old
meeting credentials, and one irrelevant place name. Per-document redaction
counts remain in the corpus.

The strict `token_and` comparator is an emulation of the current all-token
constraint over the same fixed text, not an end-to-end measurement of the
production natural-language parser. BM25, semantic, and reciprocal-rank-fused
hybrid methods all use the same corpus and judgments. Precision uses a denominator
of five even when a method returns fewer candidates.

### Retrieval results

| Method | Precision@5 | Recall@5 | MRR@5 | Queries with a relevant top-five result |
|---|---:|---:|---:|---:|
| Current token-constraint emulation | 0.0200 | 0.1000 | 0.1000 | 3/30 |
| BM25 | 0.2400 | 0.8861 | **0.8333** | **28/30** |
| Learned semantic | 0.2400 | 0.8889 | 0.8056 | 27/30 |
| Hybrid reciprocal-rank fusion | **0.2467** | **0.9111** | 0.7956 | **28/30** |

The hybrid precision delta over BM25 is 0.0067—one relevant slot across the 150
reviewed top-five slots. It added zero queries with any relevant result and had
lower reciprocal rank. The evidence does not support paying a model-and-index
complexity tax for that increment.

The learned ranking did expose real semantic value:

- It found the sidewalk-shed rule for “keeping pedestrians safe around
  construction scaffolding,” which BM25 missed.
- It found the subscription-renewal rule for “how to end an automatically
  renewing service,” which BM25 missed; hybrid preserved this result.

But the learned ranking also dropped relevant lexical results BM25 found:

- property-assessment financing identified only by the PACE terminology;
- the Brooklyn Borough President's rezoning hearing, while returning the Queens
  analogue;
- the commercial-waste-zone hearing, while preferring a generic sanitation
  environmental-review notice.

### Join-candidate result

The known dated non-Council residual started at 0 joined records out of 10. The
trial required exact `body_id` and meeting date before applying semantic
similarity. Only one pair was structurally eligible:

| Measure | Result |
|---|---:|
| Structurally eligible pairs | 1 |
| Semantic candidates proposed | 1 |
| Candidates surviving evidence review | 1 |
| Residual yield | 1/10 (10%) |
| Existing usefulness gate | 30% |
| Review time | 47 seconds |
| Review cost per surviving candidate | 47 seconds |

The candidate connected City Record notice `20260527036` to Queens Community
Board 8 minutes for 2026-06-10. The body, date, named street co-naming, and
recorded vote aligned. It remains an `accepted_candidate`, not an authorized
product edge.

This is encouraging as a document-discovery example but weak join evidence:
deterministic structural filters already reduced the residual to the same pair.
The semantic score did not discover a candidate across a missing identifier or
date, and the measured yield did not clear the established gate.

## Inaccuracy accounting

Dense retrieval does not invent source text, but it can assert misleading
**semantic relatedness** through ranking. The observed failure pattern is
semantic drift: shared civic vocabulary displaces the intended entity, action,
or jurisdiction.

| Failure mode | Observed example | Consequence | Required control |
|---|---|---|---|
| Polysemy | “hidden fees added to a purchase” ranked a real-property acquisition above the junk-fee rule | Same word, wrong legal concept | Keep lexical/entity features and show source snippets |
| Generic-topic attraction | “building energy efficiency” ranked a hearing about battery and solar projects above the building-code rule | Broad sustainability language overwhelms the requested action | Rerank or require action/entity agreement |
| Geographic substitution | A Brooklyn borough query returned the Queens counterpart | Correct document type, wrong jurisdiction | Apply exact geography filters before similarity |
| Acronym and title mismatch | The semantic method missed PACE documents and commercial-waste-zone language | Learned paraphrase is not reliable for opaque program names | Preserve BM25 and exact identifiers in a hybrid candidate pool |
| Boilerplate attraction | Long agendas and minutes entered results through repeated hearing and meeting language | Generic civic documents become false neighbors | Chunk by section, downweight template text, and review |
| Join overclaim | A score can express topic overlap without proving that two records describe the same event | False factual edge | Structural blockers first; human/evidence review; never render a score as truth |

Every receipt preserves the candidate label, underlying method, fixed relevance
judgment, or source span needed to inspect these failures.

## Measured costs

Measurements are from one local CPU run on the 122-document fixture. They do
not characterize a production deployment.

| Measure | Result |
|---|---:|
| Model cache | 91,578,415 bytes |
| Corpus | 257,376 bytes |
| Raw float32 vector payload | 365,568 bytes |
| SQLite vector index | 1,613,824 bytes |
| Embed 238 chunks | 1,470.88 ms |
| Build SQLite index | 10.85 ms |
| Total process CPU | 3.969 s |
| Warm query embedding p50 / p95 | 2.827 / 3.018 ms |
| Vector KNN p50 / p95 | 0.395 / 0.423 ms |
| BM25 p50 / p95 | 0.058 / 0.089 ms |
| Hybrid total p50 / p95 | 3.298 / 3.506 ms |
| Re-embed one changed chunk | 3.546 ms |
| Replace one indexed chunk | 0.528 ms |
| Metered API calls and cost | 0 / $0 |

Refresh is mechanically simple offline: re-embed changed chunks and replace
their rows, leaving unchanged vectors intact. Runtime Vectorize and Workers AI
latency, billing, production corpus growth, and cross-encoder reranking were not
measured and are not inferred here.

## Receipts and reproduction

- [Retrieval review](../../warehouse/experiments/semantic-layer-trial/receipts/retrieval_review.json)
- [Join-candidate review](../../warehouse/experiments/semantic-layer-trial/receipts/join_candidate_review.json)
- [Measured costs](../../warehouse/experiments/semantic-layer-trial/receipts/costs.json)
- [Decision hook](../../warehouse/experiments/semantic-layer-trial/receipts/decision.json)
- [Fixed source manifest](../../warehouse/experiments/semantic-layer-trial/source_manifest.json)
- [Fixed query judgments](../../warehouse/experiments/semantic-layer-trial/queries.json)

The committed checks do not need model dependencies or network access:

```bash
node warehouse/experiments/semantic-layer-trial/build_corpus.mjs --check
python3 warehouse/experiments/semantic-layer-trial/trial.py --check
node --test test/semantic_layer_trial.test.mjs
```

To reproduce the measurement run, install the pinned experiment-only
requirements into an isolated environment, ensure the exact model revision is
already available locally, and run:

```bash
python3 warehouse/experiments/semantic-layer-trial/trial.py
```

The run writes its SQLite index under ignored `warehouse/raw/` storage. It does
not import product modules, bind a Worker service, or write production data.

## Limitations

- The corpus is fixed and small, with only one extracted attachment. It measures
  this civic slice, not all City Record language.
- Relevance judgments and the join review were performed once. Inter-rater
  agreement was not measured.
- The query set is realistic but authored for the experiment rather than sampled
  from production query logs.
- No cross-encoder reranker was tested. A reranker might improve ordering, but
  would add another model and should be evaluated only against a named retrieval
  gap.
- The join residual had one structurally eligible pair, so it cannot demonstrate
  semantic recall across missing structural keys.

Within those limits, the conclusion is narrow: learned embeddings showed some
paraphrase value, but this fixture does not justify a production semantic layer.
Ranked lexical search captures nearly all of the measured gain with substantially
less machinery.
