# Rules sources

Join-measurement and verification receipts for the Agency Rules multi-notice
rulemaking stitch (City Record Online `dg92-zbpx` → `/rules` materialization).

| Receipt | Metric |
| --- | --- |
| `verification_receipts/rulemaking_sibling_stitch_2026-08-02.json` | `multi_notice_rulemakings` after 540-day lookback widen; false-merge proxy rate |

Rebuild the live view by bumping `RULES_VIEW_VERSION` in `worker/src/rules.mjs`
(or waiting for the age gate / admin refresh). Do not lower
`RULEMAKING_TITLE_OVERLAP_MIN` to force multi-notice groups.
