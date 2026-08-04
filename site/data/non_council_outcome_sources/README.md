# Non-Council minutes and vote sources

`source_registry.json` inventories the official publication homes for all 59
community boards and five borough presidents. A row marked `collect` has an
explicitly verified minutes or vote index; `inventory_only` means that only the
official body home is verified. It does not mean that records do not exist.

The registry deliberately reports board-level coverage. It must not be described
as a complete citywide network while source pages and archive practices remain
heterogeneous.

The dated receipt under `verification_receipts/` records the fixed, borough-
stratified join sample and the 30% usefulness gate. The strict bridge required
an exact body, exact meeting date, and a conservative matter token, but measured
0/10 and is disabled. Guessed URLs, date-only matches, and inferred actions are
excluded. The committed lookup contract is therefore empty by design.

Rebuild or verify committed artifacts:

```bash
node tools/build_non_council_source_registry.mjs
node tools/build_non_council_source_registry.mjs --check
warehouse/.venv/bin/python warehouse/scripts/non_council_outcomes_run.py --from-fixture --limit 10
```

The collector stores HTML/PDF/DOCX metadata and bounded extracted text, not
document binaries. A later reader card owns any Meetings or Land presentation.
