# API parity B2: additional representative migrations

This portfolio extends the shared-capability dogfood surface across four
distinct resident experiences. The changes are additive: existing URLs,
static-first snapshots, source labels, coverage wording, and degraded states
remain the public behavior.

## Portfolio

| Surface | Route | Shared capability | Public adapters | UI adapter |
| --- | --- | --- | --- | --- |
| Search/filter | `/search/?q=<term>` | `search.federated@1` | HTTP `GET /search`, MCP `search_federated` | `site/search_capability_projection.mjs` |
| Analytical projection | `/browse/contracts/?mode=award` | `contracts.analysis@1` | HTTP `GET /contracts/analysis`, MCP `analyze_contracts` | `site/contracts_analysis_projection.mjs` |
| Meeting explorer / geography | `/browse/meetings/` | `meeting.get@1` over the shared meeting read model | HTTP `GET /hearings?id=…`, MCP `get_meeting` | `site/meeting_capability_projection.mjs` |
| Meeting detail | `/meetings/<meeting_id>/` | `meeting.get@1` | HTTP `GET /hearings?id=…`, MCP `get_meeting` | `site/meeting_capability_projection.mjs` |

Search was the first B2 slice and remains covered by the dedicated [Search
parity record](api-parity-b2.md). This change adds the meeting capability and
makes the Contracts analytical projection a true shared provider: the static
Contracts panel and the public Worker/MCP adapters now construct and validate
the same grouped registered-contract envelope. The meeting explorer and detail
renderer project source-qualified rows through the same exact-id capability.

## Before / after architecture

Before, the Contracts panel and its public analysis adapter each invoked the
same low-level filter/group helpers but assembled their own output envelopes.
Before, meeting detail rendered a materialized row directly while the Worker
route exposed the broader read model. After, `analyzeContractsProjection`
owns the capability envelope for both delivery paths, and
`canonicalMeetingResult` applies exact identity, source receipt, coverage, and
freshness checks to both the static meeting collection and detail document.

No browser request was added. The meeting collection and detail page continue
to read the committed shared meeting snapshot first; the Worker route remains a
cache-only compatibility representation. The public cache policy is unchanged
(`max-age=1800` for the meeting JSON response), and an unavailable or malformed
snapshot produces the existing empty/unavailable behavior rather than a live
publisher lookup.

## Evidence

The visual surface is intentionally unchanged. Existing headless before/after
pairs cover the migrated routes:

- Search, 390px before/after (owner-only evidence retained under the registered RCP-03 disposition) · after (owner-only evidence retained under the registered RCP-03 disposition)
- Search, 1440px before/after (owner-only evidence retained under the registered RCP-03 disposition) · after (owner-only evidence retained under the registered RCP-03 disposition)
- Meeting detail, community-board before/after (owner-only evidence retained under the registered RCP-03 disposition) · after (owner-only evidence retained under the registered RCP-03 disposition)
- Meeting card, community-board before/after (owner-only evidence retained under the registered RCP-03 disposition) · after (owner-only evidence retained under the registered RCP-03 disposition)

The focused adapter tests prove positive identity/provenance, negative
not-found and malformed-snapshot states, shared analytical denominators and
groups, legacy meeting-id lookup compatibility, and no live-source fallback.
The meeting document and analytical provider tests also preserve the existing
reader-facing output and drill-through links.

## Performance

Search retains the three-run headless measurements in its [capture
receipt](screenshots/api-parity-b2-search/capture-receipt.json): FCP median
2084ms before versus 2076ms after, and settled median 2103.6ms before versus
2092.0ms after.

For the new in-memory projections, 200 calls were measured after a 20-call
warm-up against the committed analytical snapshot. These are bounded
projection measurements, not browser paint measurements:

| Projection | Before median / p95 | After median / p95 | Gate |
| --- | ---: | ---: | --- |
| Contracts grouping | 3.85ms / 17.83ms | 5.61ms / 23.03ms | pass; remains below the 100ms interaction budget |
| Meeting row validation | 0.00004ms / 0.00004ms | 0.00104ms / 0.00117ms | pass; no request or paint-path network cost |

The small validation cost is bounded and keeps static delivery intact. The
existing browser route regressions and accessibility checks remain the final
delivery gate; no performance ceiling was loosened.

## Validation

- `node --test test/meeting_capability.test.mjs test/analytical_capability_projection.test.mjs test/meeting_document_links.test.mjs test/capability_registry.test.mjs worker/test/hearings.test.mjs`
- `node tools/build_capability_topology.mjs`
- `node tools/reconcile_architecture.mjs --write-watermark`
- `node tools/reconcile_architecture.mjs --check`
- `node tools/backtest_architecture_canaries.mjs --check`
- `tools/run_a11y_ci_shard.sh browser-a11y primary`
- `tools/run_a11y_ci_shard.sh routes-focus primary`
