# RUM refresh 05 · bounded first-page and bootstrap follow-ons

This note records the measured follow-ons after the grouped field RUM split.
The production ranking that selected the work is the seven-day grouped read-back
in the field readiness report: Notice `notice-context` first (p75/p95
12,601.6/21,722.2 ms), Following second (5,724.7/10,457.1 ms), Browse Contracts
third (3,264.2/9,622.0 ms). Agency and Near You remain below the 30-row floor
and are unranked.

Estimates below are **not additive**. They are lab traces and payload bounds,
not field SLO results. A later grouped production query is required before
claiming a readiness improvement.

## What changed

| Surface | Change | Lab/payload evidence | Field status |
| --- | --- | --- | --- |
| Browse Contracts | Default Recent Awards / Archive first 40 rows load the compact query manifest only. They do not parse `procurement_browse_rows.json` (21,278,918 bytes) or the 11,808,198-byte query-row file. Filtered queries still use the query-row file, never the full snapshot, unless that artifact is missing. | Cold parse: full snapshot 40.11 ms; first-page manifest 57,120 bytes / 0.09 ms. First-page fetch list is the manifest only. | Field p75 3,264.2 ms remains the baseline. This payload bound is a hypothesis until the next grouped query. |
| Notice | No additional instrumentation. First-use still reports before optional flags/award/related/mandate/tables, and optional money/rules modules stay off the first-use gate. | Unit ordering: `test/notice_context_progressive.test.mjs`, `test/rum_static_record_instrumentation.test.mjs`. | Field `notice-context` p75 12,601.6 ms is unchanged in this rung; do not treat lab first-use as a production reduction. |
| Bootstrap | Independent namespace modules (`scope_v0`, `entity_pivot`, `report_issue`, `agency_connections`, `route_migration`) load together after `core.mjs`. Ordered `site/app/` modules stay sequential, including the `data-app-ready` barrier. | Source contract in `test/site_module_architecture.test.mjs`. No field import-chain metric exists, so this is not an SLO result. | Unmeasured in production. |
| Agency | No further payload rewrite. Relationship HTML remains deferred. | Prior lab deferral is in `docs/performance/content-parity/rank-5/`. | `no_data` (0 retained readiness rows). |
| Near You | No further payload rewrite. | Same prior lab deferral. | `no_data` (0 retained readiness rows). |

## Non-additive estimates

Do not sum these ranges. Each row is a separate hypothesis.

- Browse Contracts first-page payload: 21,278,918 → 57,120 bytes on the default Award/Archive path (−99.7% bytes). The earlier −2,000 to −6,000 ms field guess remains a guess.
- Notice optional-enrichment split: already landed; this rung adds no second estimate.
- Bootstrap overlap: earlier −800 to −2,000 ms guess is **not** claimed here.
- Agency / Near You: earlier −400 to −1,500 ms / −300 to −1,200 ms guesses stay with the prior deferral PR and are not recounted.

## Grouped RUM floor

A percentile is published only when `sampled_count >= 30`. Agency and Near You
stay `no_data` in the current field window. This report does not invent a
numeric pass for those surfaces.

## Proof

- `node --test test/procurement_browse_query.test.mjs`
- `node --test test/notice_context_progressive.test.mjs test/rum_static_record_instrumentation.test.mjs`
- `node --test test/site_module_architecture.test.mjs`
- `node tools/check_card_reconciliation.mjs --check`
- `node tools/reconcile_architecture.mjs --check`
