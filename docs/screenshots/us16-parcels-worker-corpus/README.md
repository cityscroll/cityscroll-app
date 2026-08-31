# US-16 Properties/Parcels worker corpus evidence

Query: `PIER-16 SOUTH STREET` (exact-BBL sibling proof uses `1000730008`).

## Before (production)

Live `api.cityscroll.org/search` reports Properties/Parcels as not indexed and returns no typed Parcel objects.

- Coverage state: `not_indexed`
- `indexed_count`: null
- Typed Parcel results: 0

!Before coverage panel (owner-only evidence retained under the registered RCP-03 disposition)

## After (this branch)

The worker indexes all 320 exact-BBL Parcel documents through the production collection provider seam.

- Coverage state: `matched` (`indexed` in the panel)
- `indexed_count`: 320
- Address query returns `bbl:1000730008` → `/parcels/1000730008/`

!After coverage panel (owner-only evidence retained under the registered RCP-03 disposition)
