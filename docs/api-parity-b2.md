# Milestone B2: Search capability parity

This slice migrates the universal Search document to consume the civic coverage
meaning from the same `search.federated@1` capability exposed by the public
HTTP and MCP adapters. The site owner’s existing URLs, labels, source receipts,
coverage wording, static-first delivery, and degraded states remain unchanged.

## Before / after

| Concern | Before | After |
| --- | --- | --- |
| UI route | `/search/?q=<term>` | `/search/?q=<term>` |
| Provider/read-model path | The Search document fetched the public `/search` projection and rendered its presentation `coverage` field directly. The endpoint already ran the federated provider, but the browser did not validate or consume that canonical envelope. | The public `/search` response is still fetched directly. A Search-only entry module loads the document, which validates `federated` with the shared capability contract and derives its coverage receipt from `federated.coverage`; the existing projection remains a fallback for older or degraded responses. |
| Duplicate civic semantics eliminated | Browser presentation code could treat the projection coverage as authoritative independently of the federator’s coverage contract. | Coverage state, participating lenses, source, and freshness are owned by `search.federated@1`; Search keeps only card/lane presentation. |
| Public API / MCP gap closed | External adapters and the UI did not have an executable browser-side assertion that the same bounded coverage contract was being consumed. | HTTP `GET /search`, MCP `search_federated`, and this UI slice share the versioned federated envelope and its typed-evidence validation. |
| Direct HTTP decision | Appropriate for this slice: `/search` is the public representation of the exact operation, already cacheable and already static-first from the page’s point of view. No private endpoint or extra request was introduced. | Same decision; capability validation happens on the returned envelope, below presentation and above transport. |

## Observable result and evidence

- Baseline and after screenshots are byte-identical at 390px (owner-only evidence retained under the registered RCP-03 disposition) / after (owner-only evidence retained under the registered RCP-03 disposition) and 1440px (owner-only evidence retained under the registered RCP-03 disposition) / after (owner-only evidence retained under the registered RCP-03 disposition).
- URLs, headings, lane labels, result cards, provenance links, match counts, and incomplete-source wording are covered by `test/functional/29_search_results.py`.
- A response without a federated envelope, or with an invalid envelope, retains the prior projection coverage and existing unavailable/empty rendering. This is graceful degradation, not a relaxed assertion of a valid capability response.
- Focused contract coverage is in `test/search_capability_projection.test.mjs`; the shared provider equivalence remains covered by `test/federated_search_capability.test.mjs`.

## Performance, caching, and delivery

Three cold headless runs at 390px used the same fixture payload and static site for both variants:

| Metric | Baseline median | After median | Delta |
| --- | ---: | ---: | ---: |
| FCP | 2084ms | 2076ms | -8ms |
| LCP | 2084ms | 2076ms | -8ms |
| Search settled | 2103.6ms | 2092.0ms | -11.6ms |

The measured difference is within run variance and is not a regression. The
roughly 2.1s absolute local value is the existing full static shell/font
startup; it is not attributed to this capability projection. The capability
validation itself adds no request and does not displace static-first HTML.

The route boundary is observable in the built module graph: `/search/` loads
`search_entry.mjs`, which then loads `search_document.mjs` and the capability
projection; the root shell continues to load only `app/main.mjs`. A vendor
footprint trace requested no `search_entry.mjs`, `search_document.mjs`, or
`capabilities/federated_search.mjs` module. This keeps the Search capability
off unrelated routes without changing the vendor-footprint gate.

The decisive clean-main control reproduced the vendor timing failure: the
unmodified main build measured 2.39s on the same fixture, versus 2.33–2.37s
on this branch. The clean-main property notice-actions check passed; the
intermittent timeout in the full route shard is therefore recorded separately
from this Search migration. The vendor-footprint failure is pre-existing or
runner-sensitive evidence for follow-up, not a Search regression.

The live public response was sampled with `cache-control: public, max-age=60,
stale-while-revalidate=300`. Static HTML paints first; the two bounded Search
requests settle asynchronously. The receipt preserves per-lens `state`, source,
and freshness, so unavailable, stale, not-indexed, and partial coverage remain
visible rather than being collapsed into an empty result.

## Heavy-surface stop-condition evidence

An earlier heavy vendor-footprint migration attempt was reverted before this
slice was selected. Its precomputed footprint paint measured approximately
2.34–2.35s against the 2.0s gate, while DOM equivalence passed. The gate was
not weakened and the surface was not contorted further. This is Milestone B
evidence that heavy surfaces incur a real cost under this migration; light
Search/detail surfaces should be chosen first.

## Regression gates

- `node --test test/search_capability_projection.test.mjs test/federated_search_capability.test.mjs`
- `python3 test/functional/29_search_results.py`
- `tools/run_a11y_ci_shard.sh browser-a11y primary`
- `tools/run_a11y_ci_shard.sh routes-focus primary`
