## What this is

A scout report, not a product change. It answers whether CityScroll already surfaces NYC contracts that exist in MOCS PASSPort (and Checkbook) but not as a City Record award notice — especially below the usual $100k notice threshold — and whether those rows have search / follow / detail parity with City Record awards.

Open **`data/passport-not-cityrecord-contracts-report/report.html`**.

## Verdict

A bounded slice is **live**. It is **not** at product parity, and it is **not** the full PASSPort dump.

- **Built:** observation-fed procurement objects without a City Record seed; canonical `/procurements/…` pages; Recent Awards and keyword Search include those objects.
- **In development:** titles and procurement method are stripped from the committed census, so most non-notice rows read as “Contract CT…”. PIN-only identity matches still need human review. Coverage labels are silent on live rows.
- **Not yet:** scope / pricing lines / deliverables / performance location (not in the public PASSPort dump CityScroll reads); email digests still compile City Record notices; no Watch control on the procurement document.

## Live examples (21 August 2026)

- PASSPort-only $49,690 Firematic: https://cityscroll.org/procurements/procurement%3Acontract%3ACT185720228800365
- PASSPort-only $26,113 Tameer: https://cityscroll.org/procurements/procurement%3Acontract%3ACT185020228802305
- Crosswalk-tied Moving Services $47,341: https://cityscroll.org/procurements/procurement%3Acontract%3ACT100220218800028
- Search for `TAMEER` and exact contract id `CT185720228800365` both hit the canonical objects.

## Recommended cards (in the report)

Restore PASSPort public title/method on the resident object; verify PIN-family id mismatches; Watch/digest parity for `procurement_id` without a notice; expand the bounded sample honestly; measure whether richer PASSPort detail exists anywhere public before promising it.

Public screenshots are allowlisted under `docs/public-capture-allowlist.json`.
