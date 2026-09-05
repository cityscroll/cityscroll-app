# Vector shadow signal evaluation

Evaluation: `sq-08-vector-shadow-2026-08-19`
Method: `hashed_ngram_tfidf_v0`
Named miss set: `sq-08-lexical-misses-v1`
k=5; product score floor=0.22.

## Decision

**Keep the vector signal shadow-only. Public ranking weight stays 0.**

This is a measurement for the captain, not a ranking change. Public search remains exact-token keyword plus the existing precomputed related-reading edges. SR4 Vectorize/Workers AI and SR8 gated hybrid ranking stay unrestored.

## Results

| Slice | Numerator / denominator | Result | Reading |
| --- | ---: | ---: | --- |
| Golden-suite miss recovery at score floor | 0 / 1 | 0.00% | Hashed n-gram did not recover the remaining golden-suite typo miss without ranking a distractor first. |
| Frozen-trial BM25-miss recovery at score floor | 0 / 2 | 0.00% | The production-safe hashed vector did not clear the 0.22 related-edge floor on either paraphrase miss. |
| Ranking inversions on golden controls | 1 | harm | Query `mosquito` ranks the decoy above the exact title. |
| False recoveries | 1 | harm | Query `mosqito` ranks the decoy ahead of the pesticide award. |
| Frozen MiniLM hybrid vs BM25 | 0 extra queries | no coverage gain | MiniLM recovered both BM25 misses and dropped q19, q23, q28; hybrid added zero queries with a relevant top five. |

Usefulness gate for public ranking: 0.3. Captain call: withheld.

## Golden-suite lexical misses

- **gq-mosquito-typo** (typo): keyword miss; recovered at floor false; false recovery true; relevant rank 2 score 0.108.

## Golden-suite ranking controls

- **gq-school-synonym** (lexical_hit_control): keyword hit; ranking inversion false; relevant rank 1 score 0.0038.
- **gq-mosquito-title** (lexical_hit_control): keyword hit; ranking inversion false; relevant rank 1 score 0.5224.
- **gq-mosquito-ranking** (ranking_control): keyword hit; ranking inversion true; relevant rank 2 score 0.1907.

## Hashed n-gram on the frozen-trial BM25 misses

- **trial-q01-scaffolding**: hashed relevant rank 3 score 0.2164; recovered at k=5 true; recovered at floor false.
- **trial-q03-auto-renew**: hashed relevant rank null score null; recovered at k=5 false; recovered at floor false.

## Frozen MiniLM replay

Learned ranking recovered named misses 2/2 and hybrid recovered 1/2. Corpus queries with a relevant top five: BM25 28/30, semantic 27/30, hybrid 28/30. Semantic harms: q19, q23, q28.

## Why public ranking stays at weight 0

- hashed n-gram recovered 0/1 golden-suite lexical misses at the product score floor
- hashed n-gram recovered 0/2 frozen-trial BM25 misses at the product score floor
- false recoveries=1; ranking inversions=1
- frozen MiniLM hybrid added 0 queries with a relevant top-five result versus BM25
- public ranking remains a captain call and is withheld

A later public-ranking weight still needs a captain-recorded decision, a named miss set that clears the usefulness gate without ranking harm, and must not restore SR4 or SR8. Refresh this receipt with `node tools/evaluate_vector_shadow_signal.mjs`.
