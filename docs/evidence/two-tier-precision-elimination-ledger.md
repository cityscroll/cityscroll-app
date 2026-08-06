# Two-tier precision elimination ledger

Observed 2026-08-06. The comparative floor answers whether a replacement is
better than the control it replaces. Consequence tiers decide whether the
replacement may ship as a quiet navigational suggestion or must clear the
strict fact/claim floor.

| Consequence tier | Surface classes | Required floor | Presentation |
| --- | --- | --- | --- |
| Navigational / exploratory | pivots, family groupings, related records | Strictly beats the measured control baseline | One quiet confidence marker |
| High consequence | money totals, legal/actionable instructions, official-result claims | 95% precision | Strict fact/claim rendering; no inferred claim below the floor |

| Control or conversion | Ground truth and deterministic sample | Baseline precision | Comparative criterion |
| --- | --- | ---: | --- |
| Exam finder interest-area categorization | 8 current DCAS open-competitive rows, compared with each row's publisher-labeled `interest_area` | 8/8 (100%) | A replacement must exceed 100%; otherwise it remains labeled or does not replace the control |
| Legacy agency string matching | 17 agency pairs from the labeled normalization fixture: 11 same, 6 distinct; case-folded alphanumeric substring control | 1/1 positive predictions (100%) | A replacement must exceed 100%; recall is measured separately and is not claimed here |
| Staffing derived fields | 40 deterministic appointment rows, 40 deterministic annual schedule rows, and 8 current exams, checking parsed title code, reason, salary presence, eligibility, status, and fee/salary presence against source records | 208/208 (100%) | A replacement must exceed 100%; exact source fields remain the fact layer |
| Title-code legacy review control | 18 explicit confirmations/rejections; pending candidates excluded | 5/18 (27.78%) | A residual title-family conversion may ship visibly inferred only when its measured precision is strictly higher |

The title-code exact-label spine is publisher-issued and may render as a fact.
The residual Fellegi–Sunter holdout is 45/55 (81.82%), which beats the
title-code control baseline and therefore may ship in the navigational family
UI and pivot surfaces with one quiet `inferred` marker. It does not clear the
high-consequence 95% floor and therefore cannot support money, legal/actionable,
or official-result claims.

The machine-readable receipt is
[`two-tier-precision-baselines-2026-08-06.json`](two-tier-precision-baselines-2026-08-06.json).
The promotion artifact records both floors and links the candidate and control
receipts; `tools/two_tier_precision_gate.mjs` is the shared gate implementation.
