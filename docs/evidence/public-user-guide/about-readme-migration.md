# About and README after the guide became reachable

Observed 2026-09-06 against this change. Screenshots of the click-through live
under `.artifacts/guide-product-access/` and are recorded by hash in
`guide-product-access/capture-manifest.json`.

## About (`site/about.html`)

Retained:

- Identity and independence ("CityScroll is independent. It is not part of city government.")
- Short product orientation, now including Guide next to Now, Near you, Following, and Browse
- Team and contact (`#maintainers`, the About page's public team address, GitHub)
- Accessibility (`#accessibility`) and content-policy summary
- Feedback form
- Cited anchors: `#context`, `#past-patterns`, `#staffing-list-establishment-formula`, `#property-disposition-timing-formula`, `#tax-lien-sale-predictions`, `#zoning-base-rates`, `#applicant-conditioned-ulurp`

Migrated destinations:

- How to read a flag or past pattern → `/guide/understand/flags-and-historical-patterns/`
- Learning to use the product → `/guide/`
- Exact formula numbers stay on the About anchors (and `docs/formulas/`), which is the ownership E4 already documented

An HTTP redirect was not used. Each old fragment still has an in-page summary.

## README

Retained:

- Product overview
- Public entry points (site, Guide, About, Stats)
- A few representative examples, each with a live route and its canonical guide page
- Maintainer links (GitHub, `AGENTS.md`, `ARCHITECTURE.md`, `docs/public-guide.md`, `docs/data-sources.md`)

Migrated destinations:

- Search walkthrough → `/guide/start/explore-housing-across-city-records/`
- Following walkthrough → `/guide/how-to/follow-a-search/`
- Calendar walkthrough → `/guide/how-to/put-dates-in-your-calendar/`
- Graph, officials, payments, and as-of internals no longer live in the README; those remain with their owners and the matching guide articles
