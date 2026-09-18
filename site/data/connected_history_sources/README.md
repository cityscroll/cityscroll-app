# Connected-history evaluation sources

Receipts under `verification_receipts/` freeze the cross-board evaluation cohort
built from already-retained ZAP, parcel, board-position, and BSA inputs before
any extraction tuning, and record the bounded CEQR / DOT / EDC document
retention pass over the fixed six-case dossier.

Rebuild or verify:

```bash
node tools/build_connected_history_cohort.mjs
node tools/build_connected_history_cohort.mjs --check
node --test test/connected_history_cohort.test.mjs

node tools/build_connected_history_documents.mjs
node tools/build_connected_history_documents.mjs --check
node --test test/connected_history_documents.test.mjs
```

Document retention resolves DOT parent-page attachment selectors once into an
auditable manifest, keeps publication time distinct from internal section dates
and observation time, and records acquisition failures without counting them as
retained evidence. Historical DOT presentations stay out of the open-consultation
set. Missing strata stay explicit; they are never replaced by substituted
examples.
