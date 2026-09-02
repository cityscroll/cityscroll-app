# Contracts Browse as a scoped form factor

`/browse/contracts/` is a form factor of `search.federated@1`, not a second
search engine. It asks the capability the registered **Contracts scope**,
projects the bounded SearchDocuments it gets back through one adapter, and keeps
its own procurement presentation: modes, typed facets, exact object lookup, row
actions, static-first paint, and the retained local snapshot as a disclosed
fallback.

## The one question Browse asks

| | |
| --- | --- |
| Registered scope | `FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts` in `capabilities/federated_search.mjs` — lenses `notices`, `vendors`; domain `contracts` |
| Keyword retrieval | `GET /search?q=<query>&scope=notices&scope=vendors` |
| Exact object lookup | `GET /search?object_ref=<procurement:…>&source_ref=<notice:…>` — one canonical object, so no lens scope is requested and no lens coverage is reported |
| Request builder | `contractScopedRetrievalRequest()` in `site/contract_search_bridge.mjs` |

The worker's Contracts lane is built from the same registered entry, so the
search front door and the source Browse cannot drift into asking different
questions. The request takes only a query and an optional object reference: a
Browse mode, facet, or sort has no way to reach into it.

## The one adapter

`site/contract_search_bridge.mjs` owns both halves of the seam and nothing else
owns either half.

| Function | Responsibility |
| --- | --- |
| `contractScopedRetrievalRequest()` | The request above, with the query clamped to the capability's bound |
| `contractScopedRetrievalOutcome()` | Bounded response → candidates plus one explicit outcome, with the capability's own coverage, freshness and rank order retained |
| `contractScopedRetrievalUnavailable()` | Transport or provider failure as a disclosable state, never an empty array |
| `contractSearchDocumentToMoneyRow()` | One SearchDocument → one Browse row, admitting only `outcome: "indexed"`, `object_type: "procurement"`, `domain: "contracts"` and cross-checking any carried `browse_record` against canonical identity |
| `mergeContractSearchRows()` / `mergeCanonicalProcurementBrowseRows()` | Union by canonical id, retaining richer resident rows |

Browse consumes the scoped **result set** rather than the front door's
eight-card lane truncation, so the two surfaces share candidate identity,
ranking and provenance while each keeps its own display bound. Document order is
the capability's rank order and is never re-sorted by the adapter.

## Outcomes a surface must tell apart

| Outcome | Meaning | What Browse renders |
| --- | --- | --- |
| `idle` | No retrieval was issued (a queryless route) | Local snapshot only; no coverage claim |
| `matched` | Requested lenses answered and returned candidates | Rows, plus the capability's freshness |
| `empty` | Requested lenses answered and matched nothing | The ordinary empty state |
| `partial` | A requested lens is `partial`, `stale`, or `not_indexed` | Rows, plus the degraded-source note in the same vocabulary the search front door uses |
| `unavailable` | A requested lens reported `provider_unavailable`, or the request failed | The sources that could not be reached, and that what follows is the retained snapshot |

`unavailable` is deliberately not `empty`. A provider failure rendered as "no
contracts matched" is a false statement about the city, so a failure with
nothing else to show replaces the empty state instead of hiding behind it.

A response that carried no coverage receipt (the exact-object route, or a legacy
unscoped adapter) reports `coverage_reported: false` and claims no per-lens
state, rather than inventing a "not indexed" claim the capability never made.

## What stays local

Local filtering still owns everything that is not keyword relevance: mode
(`open`, `allrfp`, `award`, `archive`), agency, method, closing week, amount
bands, category, months, process state, location basis, sort, and the 40-row
render bound. Those narrow the shared result set; they do not re-decide it.

One rule makes that boundary real: a row projected from a scoped SearchDocument
is exempt from the local keyword text predicate in `filterMoneySnapshot()`,
because the capability already matched it for this query. Snapshot rows are
still matched locally. Without this, local text matching would silently overrule
the capability and the two surfaces would disagree about the same query — the
divergence this surface exists to remove.

## Proof

- `test/contract_search_bridge.test.mjs` — request shape, scope registration,
  outcome states, rank order, domain filtering, absent-receipt honesty.
- `test/functional/31_contract_search_regression.py` — eight browser scenarios:
  beyond-snapshot award PINs, a queryless route, keyword parity against the
  scoped capability (canonical references, rank order, bounds, freshness,
  provenance), typed facets, exact object lookup, provider failure, empty
  result, and partial (stale) coverage.
- `tools/capture_contracts_browse_scoped_adapter.py` — headless before/after
  evidence at 390px and 1440px, receipts under
  `docs/screenshots/contracts-browse-scoped-adapter/`.
