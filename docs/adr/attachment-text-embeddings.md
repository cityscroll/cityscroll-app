# ADR: Attachment-text embeddings (T3)

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-03 |
| Scope | Semantic relatedness over T1-extracted attachment text |
| Supersedes | — |
| Builds on | T0 attachment metadata, T1 inline text extract |

## Context

T0 stores attachment metadata; T1 extracts clean text from high-value office
attachments (docx/pdf). Keyword haystack merge already helps exact-term search.
What keyword search still misses is **conceptual** nearness: a Cannonsville
watershed timber packet should surface other DEP water-supply forest / reservoir
land notices even when they never share a distinctive token such as
“Cannonsville”.

The product is a **static site + Worker**. Precompute-first is hard doctrine: no
live model API on the request path, and CI must stay inside a tight wall-clock
budget.

Corpus scale (honest): thousands of notices with attachment text as T1 grows —
not millions. Pairwise nearest-neighbor at build time is O(n²) on a few thousand
short documents and is acceptable when capped and cached.

## Options evaluated

### (a) Static quantized embedding index + query-time nearest neighbor

Ship document vectors in a small index. At query time, embed the user query and
run cosine k-NN in the Worker or browser.

**Requires an embedding of the query.** That forces either:

1. a **runtime model call** (paid API or host model) — violates no-live-dependency
   doctrine for the public path, or
2. **client-side model weights** (ONNX / transformers.js) — multi-MB download,
   cold-start cost, device variance, and a second embed stack to keep in lockstep
   with the build-time model.

Index size itself is fine at this corpus scale (thousands × 256-d float16 is on
the order of a few MB). The blocker is **query embedding**, not storage.

### (b) Precomputed similar-document edges only (chosen)

At build time, embed every T1-bearing notice’s attachment text (plus a small
notice-body corpus for neighbors without extracts), run nearest-neighbor, and
materialize `related notices` edges as a static JSON artifact. Detail pages
render the edges; no query-time embedding.

Semantic re-ranking of arbitrary keyword search is **out of scope** until a
query embed path exists without a live dependency. Edges still catch the owner’s
“going deep” thesis on the attachment-bearing detail surface.

## Decision

**Ship (b).** Materialize attachment-content similarity as
`site/data/attachment_related_notices.json` (+ Worker twin). Serve related links
on notice detail next to the T1 extract.

### Embedding source

- **Default / CI path:** deterministic local **hashed n-gram + token TF-IDF**
  embedder in pure JS (`warehouse/lib/attachment_embeddings.mjs`). No network,
  no paid API, no torch. Fits CI time limits; fixture rebuild is sub-second.
- **Optional richer path:** build-time sentence-transformer (e.g. MiniLM) via
  Python when explicitly enabled and cached. Same materialization shape; method
  field records which embedder produced the vectors. Not required for the
  fixture golden case.

### Surface

1. **Related notices** on detail pages from attachment-content similarity
   (primary).
2. Keyword vs embedding comparison for the Cannonsville golden case (tests +
   evidence), not a second search product.

### Threshold for revisiting (a)

Re-open option (a) only when **all** of the following hold:

| Gate | Threshold |
| --- | --- |
| Corpus with T1 text | ≥ ~50k documents **or** measured edge recall plateaus while users still ask free-form semantic search |
| Query embed path | Offline weights ≤ ~5 MB gzipped **and** p95 client embed + k-NN ≤ 150 ms on mid-tier mobile, **or** a self-hosted edge model with no third-party paid dependency and a kill switch |
| Product need | Related-edge coverage measured insufficient for a named user journey that free-form semantic search would fix |

Until then, (b) is the honest fit for precompute-first.

## Non-goals

- Live OpenAI / cloud embedding APIs on build or request paths
- Client download of multi-hundred-MB model weights
- Inventing relatedness without shared corpus text (no LLM summarizer)
- Replacing keyword search; edges are additive

## Consequences

- Relatedness is **asymmetric to attachment text richness**: notices without T1
  text appear only as *targets* (via title/body embedding in the neighbor pool),
  not as *sources*, until they gain extracts.
- Rebuild after T1 inventory growth:
  `node tools/build_attachment_related.mjs` (fixture or inventory mode).
- Metric: `attachment_related_edge_rate` = notices with ≥1 related edge /
  notices with T1 text (fixture golden: Cannonsville ≥1 environmental neighbor
  that keyword “Cannonsville” does not hit).

## Artifacts

| Path | Role |
| --- | --- |
| `warehouse/lib/attachment_embeddings.mjs` | Pure embed + NN |
| `warehouse/fixtures/attachment_embeddings_corpus.json` | Golden + distractor corpus |
| `tools/build_attachment_related.mjs` | Materialize + `--check` |
| `site/data/attachment_related_notices.json` | Static product edges |
| `worker/src/data/attachment_related_notices.json` | Worker twin |
| `warehouse/receipts/proof/att_t3_attachment_embeddings_latest.json` | Proof receipt |
