# Procurement Intent Radar corpus backtest

As of 2026-08-27. This is a measured result on the committed gold fixture pack, not an estimate of all Council material from 2022-01-01 through 2025-12-31.

The input contains 5 dated source spans: 3 manually reviewed future-procurement assertions and 2 negative controls. The retained app corpus currently has 0 Council text rows, so this backtest does not claim full-corpus coverage.

## Promotion decision

**Withheld.** Product promotion is not authorized: the fixture pack has only 3 resolved assertions and cannot establish recurrence. The measured precision and temporal checks are reported below but do not override this coverage boundary.

| Gate | Measured | Threshold | Result |
| --- | ---: | ---: | --- |
| Extraction precision | 100.0% | ≥90.0% | pass |
| Automatic realization-link precision | 100.0% | ≥95.0% | pass |
| Median positive lead | 149 days | ≥30 days | pass |
| Temporal leakage failures | 0 | 0 | pass |
| Recurrent corpus | 3 resolved assertions | sufficient recurrence | withheld |

## Aggregate metrics

- Extraction: 3 true positives, 0 false positives, 0 false negatives; precision 100.0%, recall 100.0%; abstained 2/5.
- Realization links: 4 true-positive automatic links, 0 false positives, 0 false negatives; precision 100.0%, recall 100.0%.
- Occurrence calibration: Brier 0.25; maximum calibration gap 0.5; scored 3, abstained 0.
- Lead time: mean 167.7 days; p25 142; median 149; p75 184.
- Timing window: 1/3 hits (33.3%); misses are categorized as published_after_stated_window (2).

## Cutoff and leakage discipline

Each candidate is extracted from only its dated source span and metadata. The shared prediction evaluator receives a source opening event before the per-assertion split and resolves only later exact `procurement.notice_published` events. Retrospective publisher identifiers, titles, and clocks are used to score reconciliation, not to reconstruct the historical prediction.

Leakage failures: 0. Any nonzero value is disqualifying.

## Per-assertion results

| Assertion | Date | Agency | Intent | Realization | Occurrence | Timing | Lead | Status |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- |
| compass-dycd-2025-05-19 | 2025-05-19 | agency:id:dycd | COMPASS RFP | procurement:city_record:26026P0003 | hit | hit | 135 | matched |
| hra-dv-beds-2024-10-09 | 2024-10-09 | agency:id:dss | additional emergency shelter beds for domestic-violence survivors | procurement:passport:06925P0010 | hit | miss | 149 | matched |
| acs-atd-2022-03-09 | 2022-03-09 | agency:id:acs | Alternative to Detention RFP | procurement:city_record:06823P0002 | hit | miss | 219 | matched |
| negative-reported-recollection-2025-03-20 | 2025-03-20 | — | rejected control | — | not_applicable | not_applicable | — | not_applicable |
| negative-past-tense-rfp-2023-04-24 | 2023-04-24 | — | rejected control | — | not_applicable | not_applicable | — | not_applicable |

The negative controls remain source evidence without a future-action assertion. The past-tense RFP control contains the string `RFP`, while the three-trigger extractor rejects it; this is why a substring baseline is not used for promotion.
