# Two-tier precision elimination ledger

Observed 2026-08-06. The comparative floor answers whether a replacement is
better than the control it replaces. The absolute floor answers whether a
reader may see the result as an unlabeled fact.

| Control or conversion | Ground truth and deterministic sample | Baseline precision | Comparative criterion |
| --- | --- | ---: | --- |
| Exam finder interest-area categorization | 8 current DCAS open-competitive rows, compared with each row's publisher-labeled `interest_area` | 8/8 (100%) | A replacement must exceed 100%; otherwise it remains labeled or does not replace the control |
| Legacy agency string matching | 17 agency pairs from the labeled normalization fixture: 11 same, 6 distinct; case-folded alphanumeric substring control | 1/1 positive predictions (100%) | A replacement must exceed 100%; recall is measured separately and is not claimed here |
| Staffing derived fields | 40 deterministic appointment rows, 40 deterministic annual schedule rows, and 8 current exams, checking parsed title code, reason, salary presence, eligibility, status, and fee/salary presence against source records | 208/208 (100%) | A replacement must exceed 100%; exact source fields remain the fact layer |
| Title-code legacy review control | 18 explicit confirmations/rejections; pending candidates excluded | 5/18 (27.78%) | A residual title-family conversion may ship visibly inferred only when its measured precision is strictly higher |

The title-code exact-label spine is publisher-issued and may render as a fact.
The residual Fellegi–Sunter holdout is 45/55 (81.82%), which beats the
title-code control baseline and therefore may ship as `Likely title family —
inferred`. It does not clear the absolute 95% floor, so it may not create an
unlabeled title-code fact or entity pivot.

The machine-readable receipt is
[`two-tier-precision-baselines-2026-08-06.json`](two-tier-precision-baselines-2026-08-06.json).
The promotion artifact records both floors and links the candidate and control
receipts; `tools/two_tier_precision_gate.mjs` is the shared gate implementation.
