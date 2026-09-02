# Contracts Browse becomes a scoped form factor of federated search

Measured at revision `77bb5ca6d697aee7dd32b8f1975a1fccc87e8eea` against the
prepared public site, with a stubbed capability so every state is reproducible.
Both receipts are in this directory's sibling
[`docs/screenshots/contracts-browse-scoped-adapter/`](../../screenshots/contracts-browse-scoped-adapter):
[`before-receipt.json`](../../screenshots/contracts-browse-scoped-adapter/before-receipt.json)
and [`after-receipt.json`](../../screenshots/contracts-browse-scoped-adapter/after-receipt.json).

## Orientation — what a resident was getting

Someone browsing public contracts and someone searching for the same words were
being answered by two different systems. `/browse/contracts/` filtered a local
snapshot and called `/search` only to enrich award and archive queries; the
search front door called the federated capability. Nothing made the two agree,
and nothing told the reader when the shared source had failed.

## Summary — what changed

`/browse/contracts/` now asks `search.federated@1` for the registered Contracts
scope (`notices`, `vendors` → domain `contracts`), projects the bounded
SearchDocuments through the one existing adapter, and keeps every procurement
affordance it had. The capability's coverage, freshness and rank order are
rendered rather than replaced by a generic empty state, and a provider failure
is disclosed alongside the retained snapshot instead of arriving as a city that
awarded nothing.

The registered scope is now a single declared entry that the worker's Contracts
lane and Browse both read, so the front door and the source Browse cannot drift
into asking different questions.

## Exploration — the same query, two surfaces

Query `aircraft`, capability answering with two indexed procurement documents.

| | Before | After |
| --- | --- | --- |
| Request Browse issued | `q=aircraft` — no scope | `q=aircraft&scope=notices&scope=vendors` |
| References Browse rendered | `05626S0012` | `05626S0012`, `05626W0023001` |
| References the search front door rendered | `05626S0012`, `05626W0023001` | `05626S0012`, `05626W0023001` |
| Coverage / freshness shown | none | `As of 2026-09-01`, requested lenses named |

Before, Browse dropped a document the front door showed for the same query: the
local keyword predicate re-decided a match the capability had already made.
After, the two surfaces answer with the same canonical references in the
capability's rank order.

Provider failure, same query:

| | Before | After |
| --- | --- | --- |
| Nothing else to show | **"Nothing found"** | "Some sources could not be reached: Published notices, Vendors. Counts below cover the available sources." |
| Local snapshot has matches (`maintenance`) | 40 rows, no disclosure | 40 rows **and** the disclosure, marked `fallback: local_snapshot` |
| Genuinely empty capability result | "Nothing found" — indistinguishable from failure | "Nothing found" with `outcome: empty`, distinguishable |

## Evidence

Headless captures at exactly 390px and 1440px, both phases, four states each
(`contracts-query`, `contracts-provider-failure`,
`contracts-provider-failure-snapshot-fallback`, `contracts-empty`) plus the
search front-door handoff for the same query. Route, viewport, capability mode,
the `/search` requests issued, the requested scope, the rendered canonical
references, and the disclosed coverage receipt are all recorded per capture.
Captures and receipts are tracked together beside this note; every one is a
public product surface served from the tracked site tree.

Automated proof:

| Check | What it holds |
| --- | --- |
| `node --test test/contract_search_bridge.test.mjs` | Request shape and registered scope, exact lookup requests no lens scope, five distinguishable outcomes, capability rank order and contracts-domain filtering, no invented coverage claim, worker lane and Browse read one registered entry |
| `python3 test/functional/31_contract_search_regression.py` | Nine browser scenarios: beyond-snapshot award PINs, queryless route, keyword parity (references, rank order, bounds, freshness, provenance), typed facets, exact object lookup, provider failure, empty result, partial (stale) coverage, and a non-award mode that paints the snapshot first and folds the scoped candidates in after |
| `node --test test/*.test.mjs`, `node --test` in `worker/` | Green on the full checkout: 4265 site tests, 1830 worker tests, 0 failures |
| `./tools/preflight-required-checks.sh --with-reading-level` | The repository pre-push gate, green |
| `11_accessibility`, `12_language`, `23_mobile_viewport`, `29_snapshot_only_resident_reads`, `30_browse_interaction_grammar`, `30_procurement_city_record_coverage`, `29_procurement_analytical_projection_drillthrough` | Reader-facing browser gates, green |

## Methodology and limits

- Award and archive wait for the scoped answer, because their canonical read-model
  query merges the scoped candidates before it runs. Every other mode paints the
  retained snapshot first and folds the scoped candidates and their coverage in
  when the capability replies, so a slow or failing provider cannot delay the
  first paint.
- The capability is stubbed in both phases so the comparison isolates the
  surface, not a live index. The stub returns the same envelope shape the worker
  serves: `results`, `federated.coverage.by_lens`, `federated.requested_scope`,
  and the lane projection.
- `contracts-provider-failure` shows zero rows because the retained snapshot has
  no local match for `aircraft`; the fallback case uses `maintenance`, which it
  does match, so the disclosed-fallback state is captured with rows present.
- Browse consumes the scoped result set rather than the front door's eight-card
  lane truncation. Identity, ranking and provenance are shared; the display
  bound stays each surface's own (40 rows on Browse).
- The reader-journey RJ-06 gate has not landed in this repository; no such gate
  exists to run. The available reader-facing gates — accessibility, language,
  browse interaction grammar, and the functional family — were run instead.
- This card migrates one surface. The remaining domain adapters keep their
  current paths and now have a concrete seam to follow.
- Provisioning observation, pre-existing and unchanged by this card: the declared
  functional corpus (`functional_corpus` in `tools/card-profile/closure.v1.json`,
  30 paths) does not include `site/data/procurement_browse_rows.json` or
  `site/data/money_procurement_agencies.json`, which
  `test/functional/31_contract_search_regression.py` reads. `verify_functional_corpus`
  reports ready without them, so this test needs those paths hydrated on a
  reduced card-work checkout. CI runs the full checkout and is unaffected.
