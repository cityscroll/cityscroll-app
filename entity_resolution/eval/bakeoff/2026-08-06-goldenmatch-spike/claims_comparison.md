# GoldenMatch spike vs endorsed scorer (gold_v1)

**Status:** eval-only spike. No production scorer change. No Worker / site wiring.

**Harness:** entity-resolution scorer bake-off `er_scorer_bakeoff_v1` (pluggable scorer contract from the scorer bake-off work).

**Gold:** `entity_resolution/eval/gold_v1.jsonl` — 56 labeled pairs (vendor / agency hard cases, VI-03 residual strata). Blocker: `token_v0`. Decision threshold: **0.9** (production policy router unchanged).

**Packages:** GoldenMatch `3.12.0` via optional eval venv; adapter `goldenmatch_adapter_v1`.

**Artifacts:** `report.json`, `summary.md`, `goldenmatch.json`, `goldenmatch/goldenmatch_claims_receipt.json`.

---

## Claim → measurement

| Vendor claim (paraphrased) | How this spike tests it | Result on gold_v1 |
| --- | --- | --- |
| **Accuracy** — strong / Splink-beating match quality out of the box | Pair precision / recall / false merge / false split after the same policy threshold as the endorsed scorer | **Not reproduced.** GoldenMatch precision 1.0 but recall **0.465** vs endorsed **1.0 / 1.0**. **23 false splits**, 0 false merges. |
| **Zero-config** | `dedupe_df` with auto-configure on the gold-shaped vendor corpus (112 side records) | **Failed cleanly.** Auto-configure fell through to a bibliographic `__title_key__` path and raised `KeyError`. Explicit matchkey used for scoring instead. |
| **Incremental** scoring consistent with full pair score | `score_pair(left, right)` vs `match_one(left, two-row frame)` with match threshold 0 | **Consistent.** 0 / 56 probability mismatches. |
| **Merge / split** control plane | IdentityStore `manual_merge` + `manual_split` smoke (synthetic records) | **API works.** Merge absorbed records; split detached the named record into a new entity id. This is control-plane plumbing, not gold accuracy. |

---

## Numbers vs endorsed scorer (`conventional_v2`)

Policy-routed metrics from `report.json` (same gold, same blocker, same 0.9 threshold):

| Scorer | Status | Precision | Recall | Unresolved rate | False merges | False splits | Cluster fragmentation |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **conventional_v2** (endorsed) | measured | **1.0** | **1.0** | 0.179 | **0** | **0** | **0** |
| goldenmatch (explicit matchkey) | measured | 1.0 | **0.465** | 0.643 | 0 | **23** | **0.50** |
| splink_duckdb | not_run | — | — | — | — | — | — |
| dedupe_gazetteer | not_run | — | — | — | — | — | — |

Reading the table:

- The endorsed scorer saturates pair metrics on this 56-case set (known bake-off honesty limit).
- GoldenMatch never false-merges at 0.9 on this sample, but leaves **most gold-same pairs unresolved**, so it is a **high-precision, low-recall** contender here — opposite of a production replacement that must retain hard same-cases (truncation, agency rename, bare department names).
- Half of reference multi-record clusters fragment under GoldenMatch pair decisions.

### What the explicit GoldenMatch matchkey was

Because zero-config failed, scoring used a **field-fair** explicit weighted matchkey (same conceptual fields as the Splink/Dedupe adapters):

| Field | Scorer | Weight |
| --- | --- | ---: |
| `display_name` | jaro_winkler | 0.5 |
| `stem` | exact | 0.2 |
| `authority_key` (PIN/EPIN) | exact | 0.3 |

Transforms: lowercase + strip. Training labels were **not** passed to GoldenMatch (`training_overlap: false`).

### Calibration (mean score vs empirical gold-same rate)

| Band | conventional_v2 N | empirical match | goldenmatch N | empirical match |
| --- | ---: | ---: | ---: | ---: |
| 0.50–0.75 | 14 | 0.286 | 17 | 0.412 |
| 0.75–0.90 | 0 | — | 23 | 0.870 |
| 0.90–0.95 | 8 | 1.0 | 1 | 1.0 |
| 0.95–0.99 | 27 | 0.926 | 9 | 1.0 |
| 0.99–1.00 | 7 | 0.857 | 6 | 1.0 |

GoldenMatch puts many gold-same pairs in the **0.75–0.90** band (below the 0.9 auto-link threshold). The endorsed scorer’s discrete confidences land most retained sames above 0.90.

### Example gold-same pairs GoldenMatch leaves unresolved (score &lt; 0.9)

| Case | Score | Left | Right |
| --- | ---: | --- | --- |
| gv0-001 | 0.751 | HNTB New York Engineering and Architecture, P.C. | HNTB NEW YORK ENGINEERING ARCHITECTURE AND LANDSCA… |
| gv0-002 | 0.647 | HNTB New York Engineering and Architecture, P.C. | HNTB |
| gv0-015 | 0.710 | O'Brien & Sons Co | OBRIEN AND SONS COMPANY |
| gv0-024 | 0.867 | Health and Mental Hygiene | DEPARTMENT OF HEALTH AND MENTAL HYGIENE |
| gv0-025 | 0.718 | Buildings | DEPARTMENT OF BUILDINGS |
| gv0-026 | 0.791 | Dept of Info Tech & Telecomm | Office of Technology and Innovation |

These are exactly the strata the product matcher was tuned for (truncation, legal suffix, agency short name, successor rename).

---

## Incremental claim

| Path | Pairs | Probability mismatches |
| --- | ---: | ---: |
| `score_pair` (full) vs `match_one` (incremental, threshold 0) | 56 | **0** |

Notes:

- With matchkey threshold left at 0.9, `match_one` **drops** sub-threshold candidates (40 missing hits in an earlier probe). The spike therefore measures incremental score consistency at threshold 0, then lets the bake-off policy apply 0.9 for decisions — same pattern as “full rebuild vs single-record score.”
- This does **not** prove durable identity-index incremental resolution on a multi-million-row store; it proves the pair-scoring surfaces agree on this corpus.

---

## Merge / split claim

Identity control-plane smoke (`goldenmatch_claims_receipt.json`):

| Step | Result |
| --- | --- |
| Create two entities with three source records | ok |
| `manual_merge(keep, absorb)` | absorb status `merged_into`; keep holds all three records |
| `manual_split(keep, [r3])` | new entity id; r3 reassigned; keep retains the other two |

This validates **API presence**, not that merge/split improves gold metrics. CityScroll link-not-merge policy remains the production authority; this spike did not call it.

---

## Honesty limits (do not over-read)

1. **Gold is small and baseline-saturated.** The bake-off already refuses to declare a production winner when `conventional_v2` hits precision=recall=1. GoldenMatch looking worse on pair metrics is informative; looking equal would still be insufficient evidence to switch.
2. **Zero-config did not run.** Marketing “zero-config F1” numbers on customer/bibliographic benchmarks are not measured here. On this vendor gold shape, auto-configure failed.
3. **No Splink head-to-head in this spike.** Splink/Dedupe adapters were left `not_run` to keep the time-box on GoldenMatch vs the endorsed scorer.
4. **Explicit matchkey is a reasonable best effort**, not an exhaustive GoldenMatch tuning study. A specialist config or LLM scorer might recover recall; that would be a follow-on experiment, still eval-only.

---

## Recommendation

| Decision | Rationale |
| --- | --- |
| **Do not adopt GoldenMatch as a production scorer** from this spike | Recall collapse and cluster fragmentation on the hard gold stratum; zero-config path unavailable on the corpus shape. |
| **Keep the bake-off adapter** | Optional contender path is useful for future re-runs when gold grows (unresolved clerical-review labels). |
| **Production path unchanged** | `conventional_v2` + policy + link-not-merge remain the endorsed scoring stack. |

Reproduce:

```bash
python3 -m venv entity_resolution/eval/.venv
entity_resolution/eval/.venv/bin/pip install -r entity_resolution/eval/optional-requirements.txt
node entity_resolution/eval/run_bakeoff.mjs \
  --gold entity_resolution/eval/gold_v1.jsonl \
  --out-dir entity_resolution/eval/bakeoff/2026-08-06-goldenmatch-spike
entity_resolution/eval/.venv/bin/python entity_resolution/eval/contenders/goldenmatch_adapter.py \
  --input entity_resolution/eval/bakeoff/2026-08-06-goldenmatch-spike/candidate_pairs.jsonl \
  --out-dir entity_resolution/eval/bakeoff/2026-08-06-goldenmatch-spike/goldenmatch \
  --output entity_resolution/eval/bakeoff/2026-08-06-goldenmatch-spike/goldenmatch.json
node entity_resolution/eval/run_bakeoff.mjs \
  --gold entity_resolution/eval/gold_v1.jsonl \
  --out-dir entity_resolution/eval/bakeoff/2026-08-06-goldenmatch-spike \
  --goldenmatch-output entity_resolution/eval/bakeoff/2026-08-06-goldenmatch-spike/goldenmatch.json
```
