<!-- Generated projection: do not hand-edit the ranked table rows. Update docs/data-frontiers/2026-08/entries/<rank>-<id>.json and run node tools/build_data_frontiers.mjs -->

# Data frontiers: August 2026

This plan ranks the next data-collection and joining opportunities for Cityscroll. It covers all 28 rows in the executable [gap inventory](../site/data/gap_taxonomy.json), then adds three data gaps exposed by the August 4 product census that are not yet in that inventory: residual location coverage for Money and Meetings, plus the small remaining property-parcel key gap.

The inventory is broader than a future-work queue. Several rows describe sources that have since landed, timing states that should remain empty, or publication limits that cannot be fixed by another adapter. Those rows are retained below for completeness but are not treated as new collection work.

## Ranking method

The forward queue is ordered by expected reader value per unit of collection effort, with feasibility evidence used as the tie-breaker. Reader value is a planning score from 1 (narrow enrichment) to 5 (a missing decision, outcome, or action path). Effort uses the requested classes: **API pull**, **scrape**, **manual**, or **partnership-blocked**. A mixed method is charged at its most expensive material step. Already-landed and intentionally absent rows are parked after open opportunities regardless of their retrospective value.

Feasibility labels are load-bearing:

- **Measured** means the repository contains a dated numerator, denominator, and join strategy.
- **Unmeasured assessment** means the named source is verified but no representative join sample exists. Qualitative judgments are intentionally not converted into percentages.
- **Blocked** means no verified public, joinable source exists. A logical publication home is not presented as a dataset.

Source pages and access mechanics were rechecked on 2026-08-04. Existing measurements come from the [source registry](../site/data/source_contracts.json), the receipts linked in the table, and the [August 4 product census](evidence/overnight-quality-sweep/BREAKFAST_LEDGER.md). The DCAS fleet row also uses a bounded official Open Data collection; its non-fleet conclusion remains source reconnaissance only.

## Ranked frontier table

**RC** marks the four items ready to become cards now. “Dependent” rows share an infrastructure card with their marked parent and should not create duplicate collectors.

