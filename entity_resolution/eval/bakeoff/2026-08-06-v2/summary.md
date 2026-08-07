# Entity-resolution scorer bake-off er_scorer_bakeoff_v1

Gold **v2** contains **158** labeled pairs. Candidate blocker: **token_v0**. The production policy and link-not-merge behavior were not changed.

## Comparison

| Scorer | Status | Precision | Recall | Unresolved | False merges | False splits |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| conventional_v2 | measured | 1 | 0.9659090909090909 | 0.4430379746835443 | 0 | 3 |
| splink_duckdb | measured | 1 | 0.09090909090909091 | 0.9493670886075949 | 0 | 80 |
| dedupe_gazetteer | measured | 1 | 0.06818181818181818 | 0.9620253164556962 | 0 | 82 |

## Calibration by score band

The conventional scorer's fixed confidences are shown as scores, not treated as calibrated probabilities. `empirical_match_rate` is the observed share of gold-same pairs in each band.

### conventional_v2

| Band | N | Mean score | Empirical match rate | Calibration error |
| --- | ---: | ---: | ---: | ---: |
| 0.00-0.50 | 0 | — | — | — |
| 0.50-0.75 | 73 | 0.6577671232876713 | 0.0821917808219178 | -0.5755753424657535 |
| 0.75-0.90 | 1 | 0.777 | 1 | 0.22299999999999998 |
| 0.90-0.95 | 9 | 0.9211111111111112 | 1 | 0.07888888888888879 |
| 0.95-0.99 | 68 | 0.9827205882352937 | 0.9705882352941176 | -0.012132352941176094 |
| 0.99-1.00 | 7 | 0.995 | 0.8571428571428571 | -0.1378571428571429 |

### splink_duckdb

| Band | N | Mean score | Empirical match rate | Calibration error |
| --- | ---: | ---: | ---: | ---: |
| 0.00-0.50 | 111 | 0.00828611356884312 | 0.3783783783783784 | 0.3700922648095353 |
| 0.50-0.75 | 43 | 0.5195019579947783 | 0.9767441860465116 | 0.4572422280517333 |
| 0.75-0.90 | 0 | — | — | — |
| 0.90-0.95 | 4 | 0.9105672028192586 | 1 | 0.08943279718074137 |
| 0.95-0.99 | 0 | — | — | — |
| 0.99-1.00 | 0 | — | — | — |

### dedupe_gazetteer

| Band | N | Mean score | Empirical match rate | Calibration error |
| --- | ---: | ---: | ---: | ---: |
| 0.00-0.50 | 79 | 0.29610706960098654 | 0.3291139240506329 | 0.03300685444964635 |
| 0.50-0.75 | 78 | 0.6344305979899871 | 0.782051282051282 | 0.14762068406129492 |
| 0.75-0.90 | 1 | 0.7501153349876404 | 1 | 0.24988466501235962 |
| 0.90-0.95 | 0 | — | — | — |
| 0.95-0.99 | 0 | — | — | — |
| 0.99-1.00 | 0 | — | — | — |

## Recommendation

**review_measured_results** — Review measured contenders against calibration, false merges, false splits, and incremental consistency before changing production scoring.

The next discriminating sample should come from the unresolved band through the existing clerical-review path. Record the gold version, feature version, blocker version, scorer artifact hash, and config hash with every rerun.
