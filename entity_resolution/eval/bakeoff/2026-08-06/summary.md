# Entity-resolution scorer bake-off er_scorer_bakeoff_v1

Gold **v1** contains **56** labeled pairs. Candidate blocker: **token_v0**. The production policy and link-not-merge behavior were not changed.

## Comparison

| Scorer | Status | Precision | Recall | Unresolved | False merges | False splits |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| conventional_v2 | measured | 1 | 1 | 0.17857142857142858 | 0 | 0 |
| splink_duckdb | not_run | — | — | — | — | No adapter output supplied |
| dedupe_gazetteer | not_run | — | — | — | — | No adapter output supplied |

## Calibration by score band

The conventional scorer's fixed confidences are shown as scores, not treated as calibrated probabilities. `empirical_match_rate` is the observed share of gold-same pairs in each band.

### conventional_v2

| Band | N | Mean score | Empirical match rate | Calibration error |
| --- | ---: | ---: | ---: | ---: |
| 0.00-0.50 | 0 | — | — | — |
| 0.50-0.75 | 14 | 0.6336428571428572 | 0.2857142857142857 | -0.3479285714285715 |
| 0.75-0.90 | 0 | — | — | — |
| 0.90-0.95 | 8 | 0.92 | 1 | 0.07999999999999996 |
| 0.95-0.99 | 27 | 0.9805555555555552 | 0.9259259259259259 | -0.05462962962962925 |
| 0.99-1.00 | 7 | 0.995 | 0.8571428571428571 | -0.1378571428571429 |

## Recommendation

**insufficient_evidence** — Do not switch the production scorer from this bake-off. The 56-case gold set saturates the baseline pair metrics; extend gold with labeled candidates from the unresolved clerical-review stratum, then compare calibration and incremental behavior.

The next discriminating sample should come from the unresolved band through the existing clerical-review path. Record the gold version, feature version, blocker version, scorer artifact hash, and config hash with every rerun.
