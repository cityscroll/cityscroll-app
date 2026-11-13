# ADR: Organization search reads a static, generation-stamped index

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-11-11 |
| Scope | `GET /organization-search`, `GET /vendor-profile?ref=org:...`, `site/data/organization_index*` |
| Supersedes | — |
| Related | `docs/adr/kv-vs-d1-search.md`, `docs/adr/entity-resolution-taxonomy.md`, `worker/src/people_organizations.mjs`, `worker/d1-release-policy.json`, `tools/worker_deploy_guard.mjs`, `tools/check_pages_bundle_sizes.mjs` |

## Context

Organization search is an open-ended query, which `kv-vs-d1-search.md` assigns to D1. The existing vendor
lane does exactly that: `tools/build_keyword_search_index.mjs` writes the `vendors` family (128 reviewed
vendor roots) to `worker/src/data/keyword_search_index_shards`, `tools/build_worker_d1_read_models.mjs`
publishes it into `keyword_search_documents` and the FTS5 table `keyword_search_fts`, and
`searchKeywordFamilyFromD1` queries it.

The organization population is 160,860 name stems (engine award sources, Doing Business, the SBS
certified business list, and the IRS, DOL and SCA registers; measured 2026-11-11).

## Decision

Build the organization index at build time from committed artifacts and publish it as static files
under `site/data/organization_index.json` and `site/data/organization_index/` (a stems file, entries
range-sharded at 256 KiB, identifier shards in 64 FNV-1a buckets). The Worker reads them from
`https://cityscroll.org/data/` with an edge cache and a per-isolate cache, as `people_organizations.mjs`
reads its read model. Every file carries the index generation; a reader that sees two generations
answers `not_indexed`.

## Why not the D1 vendor lane

- Publication budget: one D1 family of 160,860 documents writes 321,721 rows (document plus FTS
  companion) on first load; `worker/d1-release-policy.json` stops incremental publication at 100,000
  rows written in a rolling 30 days.
- Close spelling: FTS5 with `unicode61` matches whole tokens and prefixes; one-letter misspellings need a
  second structure. Measured on the static index: recall at 5 = 1.0 and wrong-first = 0.005 over 600
  misspellings of 200 real names.
- The Worker bundle: the index is 7,962,654 bytes gzip, 76 percent of the 10 MB compressed Worker limit.

## Consequences

- Pages per-file limit 24 MiB (headroom mark 18 MiB): the largest file is the stems file, 5,847,888 bytes.
- Cold isolate: one manifest and one stems file (1.42 MB gzip), 134 ms to open on the measurement
  machine, 31.5 MB heap; warm query p50 2.7 ms, p95 8.2 ms over 1,000 queries.
- The universal `/search` vendors lane is unchanged: its documents assert reviewed vendor-stem identity
  with strong-link provenance, which organization entries do not.
- The routes are snapshot-only. The live New York State register answer is
  `GET /org-register/dos`, called on an explicit reader action.
