# Land-use prediction stance backtest

As of 2026-08-31. Frozen control pack `lup2-c7-gold.v1`, not a recurrent population estimate.

Train window 2022-01-01–2023-12-31 (16 applications). Test window 2024-01-01–2024-12-31 (16 applications). Outcomes are observed strictly after each cutoff. Feature evidence is reconstructed at that cutoff.

## Kill criterion and promotion

**Not met.** Stance is not promoted as a major feature. Product promotion remains withheld. The incumbent `land_prediction_baseline_v1` path stays authoritative.

Held-out stance lift after formal signals is above the recorded threshold and is not dominated by late evidence. That measurement still does not authorize a causal deference claim or production promotion.

| Check | Value |
| --- | ---: |
| Meaningful Brier lift threshold | 0.01 |
| Stance lift vs process baseline (Brier) | 0.04118008 |
| Stance lift after formal signals (Brier) | 0.03661574 |
| Late stance share | 0.25 |
| Median stance lead days | 121.5 |
| Reasons | none |

## Held-out probabilistic error

| Model | N | Brier | Log loss |
| --- | ---: | ---: | ---: |
| Existing process baseline | 16 | 0.2069521 | 0.60358444 |
| Baseline + formal-process signals | 16 | 0.14149759 | 0.46222264 |
| Baseline + local-member stance | 16 | 0.16577202 | 0.51075134 |
| Full V2 feature set | 16 | 0.10488185 | 0.37206287 |

Ablation deltas (positive = lower error): formal vs baseline Brier 0.06545451; stance vs baseline Brier 0.04118008; full vs formal Brier 0.03661574.

The existing CityScroll production baseline does not emit a project-level approval probability. The process baseline here is a cutoff-safe logistic over application type and procedural stage so the four models share one scoring contract.

## Stage, coverage, and timing

Full V2 by procedural stage:

| Stage | N | Brier | Log loss |
| --- | ---: | ---: | ---: |
| borough_president | 1 | 0.08960123 | 0.35572488 |
| city_council | 3 | 0.1163845 | 0.39402612 |
| community_board | 4 | 0.10270213 | 0.37466124 |
| cpc | 7 | 0.10776662 | 0.37122982 |
| pre_certification | 1 | 0.07418003 | 0.31794902 |

Full V2 by fixture cohort:

| Cohort | N | Brier | Log loss |
| --- | ---: | ---: | ---: |
| late_stance | 2 | 0.1535903 | 0.47641253 |
| lift | 4 | 0.0864736 | 0.33869276 |
| missing_features | 2 | 0.11422064 | 0.40839097 |
| null_lift | 4 | 0.13318508 | 0.41600843 |
| sparse_stance | 2 | 0.08883094 | 0.34963123 |
| stage_difference | 2 | 0.04309556 | 0.23266587 |

Stance known in 12 of 16 held-out applications (4 unknown). Late stance cases: 3. Median lead from first stance clock to outcome: 121.5 days.

Unknown and missing stance remain explicit. Institutional power is not imputed.

## Rival hypotheses

H1 (institutional mechanism): The local member's position independently predicts Council disposition because other members routinely defer to that member on local land-use matters.

H2 (information/sensor mechanism): The member's position predicts outcomes mainly because the member already observes negotiations, constituency response, applicant concessions, and project viability that CityScroll otherwise lacks.

Either mechanism may justify using stance as a predictive feature. This backtest does not distinguish H1 from H2 and does not assign a strong weight because institutional literature or domain theory predicts one. Causal claim: false. Literature-driven weight assigned: false.

## Leakage and exclusions

Eligible exclusions: 0. Negative controls rejected: 3/3. Future Council outcomes, post-cutoff member statements, and materialized labels are not training features.

Predictor cityscroll.land_prediction_predictor.v2 2.0.0; feature schema cityscroll.land_prediction_feature_vector.v1.
