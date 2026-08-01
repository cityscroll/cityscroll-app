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
