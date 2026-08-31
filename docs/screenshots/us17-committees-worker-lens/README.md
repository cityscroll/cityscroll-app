# US-17 Committees worker lens evidence

Query: `Committee on Finance`.

## Before (production)

Live `api.cityscroll.org/search` reports Committees as not indexed and returns no typed Committee objects.

- Coverage state: `not_indexed`
- `indexed_count`: null
- Typed Committee results: 0

!Before coverage panel (owner-only evidence retained under the registered RCP-03 disposition)

## After (this branch)

The worker indexes all 96 published Committee documents through the production collection provider seam.

- Coverage state: `matched` (`indexed` in the panel)
- `indexed_count`: 96
- Query returns `committee:11` → `/committees/11/`

!After coverage panel (owner-only evidence retained under the registered RCP-03 disposition)
