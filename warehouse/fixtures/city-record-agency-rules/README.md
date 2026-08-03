# City Record — Agency Rules history fixture

Slim JSON extract of City Record Online (`dg92-zbpx`) rows with
`section_name = 'Agency Rules'` for the rules adoption-lag model.

- `agency_rules_history.json` — full Agency Rules slice used by
  `node tools/build_rules_adoption_predictions.mjs` when the warehouse bulk
  parquet is not present locally (bulk remains gitignored; proof receipt:
  `warehouse/receipts/proof/city-record_bulk_latest.json`).
- `sample.json` — small mixed-role sample for unit tests.

Rebuild product artifacts after updating:

```bash
node tools/build_rules_adoption_predictions.mjs
node tools/build_rules_adoption_predictions.mjs --check
```
