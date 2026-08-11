# Engineering lessons (multi-flywheel)

Recurring improvement classes extracted by the multi-dimension flywheel.
Append-only: runners add a section when a `lesson_class` repeats in one run.
Do not hand-delete lessons; mark superseded in a new note if needed.

## Lessons

### Declared Not Ingested (`declared-not-ingested`)

- **First noted:** 2026-08-01
- **Count this run:** 17
- **Dimensions:** coverage

Recurring flywheel class `declared-not-ingested` appeared 17 times in one run. Sample cards: crol-list/mf-coverage-not-ingested-active-civil-service-list, crol-list/mf-coverage-not-ingested-annual-examination-schedule, crol-list/mf-coverage-not-ingested-citywide-payroll. Related context: site/data/source_contracts.json; entity_resolution/source_coverage.json; https://data.cityofnewyork.us/d/vx8i-nprf; https://data.cityofnewyork.us/d/4ptz-hmtc; https://data.cityofnewyork.us/d/k397-673e; https://data.cityofnewyork.us/d/a9md-ynri. When fixing one instance, scan siblings of the same class before closing the queue item.

### Ontology Gap_a (`ontology-gap_a`)

- **First noted:** 2026-08-01
- **Count this run:** 13
- **Dimensions:** ontology-enrichment

Recurring flywheel class `ontology-gap_a` appeared 13 times in one run. Sample cards: crol-list/mf-ontology-enrichment-gap-a-exam-outcome-aggregate, crol-list/mf-ontology-enrichment-gap-a-external-awards-abo-none, crol-list/mf-ontology-enrichment-gap-a-land-outcome-detail. Related context: site/data/gap_taxonomy.json; external_award_none_note_html; land_outcomes_unmatched_html; meeting_outcomes_no_matters_html; meeting_outcomes_unmatched_html; meeting_outcomes_no_votes_html. When fixing one instance, scan siblings of the same class before closing the queue item.

### Dual Write Coverage Gap (`dual-write-coverage-gap`)

- **First noted:** 2026-08-01
- **Count this run:** 4
- **Dimensions:** coverage

Recurring flywheel class `dual-write-coverage-gap` appeared 4 times in one run. Sample cards: crol-list/mf-coverage-dual-write-abo-external-awards, crol-list/mf-coverage-dual-write-checkbook-nycha-contracts, crol-list/mf-coverage-dual-write-doing-business-entities. Related context: entity_resolution/source_coverage.json; worker/src/external_award.mjs#refreshAboAwards; worker/src/external_award.mjs#checkbookNychaByPin; worker/src/vendor_profile.mjs#attachDoingBusiness; worker/src/subsidy_lifecycle.mjs#computeLifecycle. When fixing one instance, scan siblings of the same class before closing the queue item.

### Ontology Coverage (`ontology-coverage`)

- **First noted:** 2026-08-01
- **Count this run:** 4
- **Dimensions:** ontology-enrichment

Recurring flywheel class `ontology-coverage` appeared 4 times in one run. Sample cards: crol-list/mf-ontology-enrichment-coverage-doing-business-entities, crol-list/mf-ontology-enrichment-coverage-abo-external-awards, crol-list/mf-ontology-enrichment-coverage-checkbook-nycha-contracts. Related context: entity_resolution/source_coverage.json; worker/src/vendor_profile.mjs#attachDoingBusiness; worker/src/external_award.mjs#refreshAboAwards; worker/src/external_award.mjs#checkbookNychaByPin; worker/src/subsidy_lifecycle.mjs#computeLifecycle. When fixing one instance, scan siblings of the same class before closing the queue item.

### Cross Source Disagreement (`cross-source-disagreement`)

- **First noted:** 2026-08-01
- **Count this run:** 2
- **Dimensions:** cross-source-consistency

Recurring flywheel class `cross-source-disagreement` appeared 2 times in one run. Sample cards: crol-list/mf-cross-source-consistency-disagree-notice-20231222103-contract-amount, crol-list/mf-cross-source-consistency-disagree-contract-ct107120248803393-vendor-name. Related context: ontology/fixtures/dimensions/cross_source_disagreements.json. When fixing one instance, scan siblings of the same class before closing the queue item.

### Cross Spine Contradiction (`cross-spine-contradiction`)

- **First noted:** 2026-08-01
- **Count this run:** 2
- **Dimensions:** cross-source-consistency

Recurring flywheel class `cross-spine-contradiction` appeared 2 times in one run. Sample cards: crol-list/mf-cross-source-consistency-spine-notice-demo-confirmed-separate, crol-list/mf-cross-source-consistency-spine-notice-demo-pin-mismatch. Related context: ontology/cross_spine.mjs; ontology/fixtures/cross_spine. When fixing one instance, scan siblings of the same class before closing the queue item.

### Unusable Joined View (`unusable-joined-view`)

- **First noted:** 2026-08-01
- **Count this run:** 2
- **Dimensions:** readability

Recurring flywheel class `unusable-joined-view` appeared 2 times in one run. Sample cards: crol-list/mf-readability-view-raw-source-records-dump, crol-list/mf-readability-view-gap-taxonomy-dense-table. Related context: admin.possibly_same; worker/src/lib/possibly_same.mjs; ontology/fixtures/dimensions/readability_views.json; docs.gap_taxonomy; docs/gap-taxonomy.md. When fixing one instance, scan siblings of the same class before closing the queue item.

### Join False Negative (`join-false-negative`)

- **First noted:** 2026-08-11
- **Count this run:** 2
- **Dimensions:** coverage, data-integrity

Two high-value joins were falsely gated by measurement shape, not by a real absence of links:

1. **Stricter join than the product already ships.** RC-1 plan→PASSPort used exact `identifier_key` equality only. The product passport join already documents `pin_prefix_of_epin` / `epin_prefix_of_pin` (and strip-suffix). On identifier-bearing plans the prefix strategy joined ~76% with precision 1.0, while exact-only looked dead.
2. **Wrong usefulness denominator.** ULURP Borough President recommendations were killed on ZAP-universe catalog coverage (0.54%) even though **recommendation-row** hit rate was ~88%. Catalog coverage is contrast; the gate denominator is the joinable candidate rows for that edge.

**Standing rule (encoded in `ontology/join_gate_policy.mjs`):**

- When gating a join, prefer the product's already-documented strategies; at minimum measure exact **and** product strategies and report the better.
- Compute usefulness against the joinable-candidate denominator for that card, not an unrelated whole universe.
- Keep wrong-universe guards (Property Disposition ≠ ZAP; capital FMS ≠ City Record PIN).

Verify: `node --test test/join_gate_policy.test.mjs`. RC-1 receipt: `site/data/procurement_plan_sources/verification_receipts/procurement_plans_2026-08-11.json`. ULURP receipt: `site/data/ulurp_recommendation_sources/verification_receipts/ulurp_recommendations_2026-08-11.json`.
