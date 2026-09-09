# Research response bounds

Research tools return at most **65,536 bytes (64 KiB)** of UTF-8 JSON per tool
result, including `content` and `structuredContent`. The named constants in
[`capabilities/research_response_limits.mjs`](../capabilities/research_response_limits.mjs)
reserve 8 KiB for a text summary and the tool envelope. This keeps opaque
identifiers from consuming the context an answer needs for evidence and reasoning.
The [generated MCP catalog](https://cityscroll.org/data/mcp_tool_catalog.json)
declares the budget for every research read. JSON-RPC framing is outside that budget.

## Contract analysis and browse

`contracts.analysis` version 1.2.0 retains the v1 envelope and civic measures.
Each group returns `contract_count`, a `contract_sample` of 10 references by
default (`sample_limit`: 1–50), and `browse`. Each reference has the publisher
registration `id`, resolved canonical `procurement_id`, and canonical `href`.
The latter two are null when the detail read model cannot resolve the registration;
this does not remove the registration from the count or browse population.

Follow `browse.arguments` with `browse_contracts`, or open `browse.href`.
`contracts.browse` version 1.1.0 adds `population=registered`. In this mode it reads
the same materialized analytical population as analysis, uses exact agency/vendor
labels, and returns registration references rather than procurement detail objects.
It supports fiscal year, amount band, amount range, registration timing, and City
Record match filters. `group_by` plus `group_label` restricts the exact group,
including `Unknown / not published`. Detail-only filters are rejected in this mode.
Each page reports `total_matches` and `pagination.next_cursor`; repeat all filters
with that cursor until it is null. Every registration stays reachable, even when
it has no individual detail record.

Analysis group limits and browse row limits are ceilings. A page may contain fewer
items to fit the byte budget. For analysis, repeat the same arguments with
`filters.pagination.next_cursor` until it is null. The denominator remains the
complete filtered population on every group page. Samples and pagination do not
change registered values, identity resolution, or coverage calculations. Continue
against the same published data vintage; restart when the vintage changes.

For existing HTTP clients that require the former complete parallel arrays,
`GET /contracts/analysis?identifiers=full` additionally returns `contract_ids` and
`contract_procurement_ids`. This explicit compatibility export is outside the
research byte budget. The research tool does not accept or forward `identifiers`.
The browser analysis uses counts and filter-based browse links; it needs no full
identifier arrays.

## Other catalog reads

The catalog audit found identifier arrays without a per-array bound in:

- `get_contract` and `browse_contracts`: identity-key contract IDs, provenance
  prime contract IDs and EPINs, and source observation references.
- `search_federated`: source observation references.
- `get_entity_dossier`: derivation evidence assertion IDs (the enclosing assertion
  result already has a record limit).
- `get_person_or_organization` and `browse_organizations`: vendor agency IDs.

The shared research adapter pages string identifier arrays ending in `_ids` or
`_refs`, plus `epins`, at 10 entries by default and 50 maximum. Existing array field
names remain usable. When sampled, a text content block supplies each array's JSON
Pointer, total count, offset, returned count, and exact replay arguments. Follow
its continuation on the named tool; `identifier_path`, `identifier_offset`, and
`identifier_limit` paginate only the selected array. Other arrays retain their
initial samples. Keep the result filters and result-page cursor unchanged.

Search results, cited passages, graph nodes/edges, browse rows, and meeting matter
IDs already have owner-defined result or list bounds. Other record-valued arrays
(documents, events, assertions, observations, and relationship evidence) retain
those owners' civic meaning. A final byte check returns an explicit tool error if
a record still exceeds the response budget; it never silently removes civic facts.
Contract and organization browse pages also shrink by bytes and retain a cursor.
The HTTP record APIs retain their source-honest detail representation.

## Verification

[`worker/test/research_response_budget.test.mjs`](../worker/test/research_response_budget.test.mjs)
checks the actual MCP result for every research catalog read, uses maximum result
limits where declared, and covers an unfiltered, all-years agency fixture with 69
groups and a 3,599-registration group. Both default and maximum samples must fit,
all groups must remain reachable, and exact browse continuations must enumerate
without duplicates. Additional checks cover every analytical dimension, unknown
labels, combined filters, HTTP compatibility, multibyte byte accounting, and
lossless identifier replay. Required checks use fixtures and never fetch publishers.
