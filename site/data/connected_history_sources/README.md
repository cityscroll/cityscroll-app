# Connected-history evaluation sources

Receipts under `verification_receipts/` freeze the cross-board evaluation cohort
built from already-retained ZAP, parcel, board-position, and BSA inputs before
any extraction tuning.

Rebuild or verify:

```bash
node tools/build_connected_history_cohort.mjs
node tools/build_connected_history_cohort.mjs --check
node --test test/connected_history_cohort.test.mjs
```

The bounded corridor and component dossier URLs are recorded as unavailable
until a later retention step materializes them. Missing strata stay explicit;
they are never replaced by substituted examples.
