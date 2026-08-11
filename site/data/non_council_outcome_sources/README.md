# Non-Council minutes and vote sources

`source_registry.json` inventories the official publication homes for all 59
community boards and five borough presidents. A row marked `collect` has an
explicitly verified minutes or vote index; `inventory_only` means that only the
official body home is verified. It does not mean that records do not exist.

The registry deliberately reports board-level coverage. It must not be described
as a complete citywide network while source pages and archive practices remain
heterogeneous.

Dated receipts under `verification_receipts/` record the fixed, borough-
stratified real-notice sample. The authoritative re-measure is
`non_council_minutes_votes_2026-08-11.json` (**0/10** joins after expanding
collectable minutes indexes from 8 to 17). The prior
`non_council_minutes_votes_2026-08-04.json` sample (also 0/10 at 8 collectable
pages) is retained as historical evidence. The join method is
`exact_body_date_publisher_ulurp`: exact body, exact meeting date, and a
publisher-supplied ULURP matter identifier present in both the notice and the
minutes text. Slug or street-name tokens are not join keys. Guessed URLs,
date-only matches, and inferred actions are excluded.

Promotion requires **both** (1) usefulness ≥30% join rate on the sample and
(2) reviewed precision 100% on proposed joins. Until both clear,
`policy.join_bridge_enabled` stays false and the committed lookup stays empty.
Fixture precision review:
`warehouse/receipts/proof/rc3_non_council_outcome_precision_2026-08-05.json`.

Rebuild or verify committed artifacts:

```bash
node tools/build_non_council_source_registry.mjs
node tools/build_non_council_source_registry.mjs --check
warehouse/.venv/bin/python warehouse/scripts/non_council_outcomes_run.py --from-fixture --limit 8 --max-docs 10
node --test test/non_council_outcomes_infrastructure.test.mjs
```

The collector stores HTML/PDF/DOCX metadata and bounded extracted text, not
document binaries. A later reader card owns any Meetings or Land presentation.
