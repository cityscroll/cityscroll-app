# Served-product coverage

The public Stats page used to stand in for the product with two numbers: an upstream notice
aggregate fetched from the publisher while the page was loading, and a fixed list of six source
system names. Neither measured what CityScroll serves. This directory holds the census that
replaced them, and the evidence behind each published figure.

## What is published, and where it comes from

| Artifact | Owner | Tracked | Role |
| --- | --- | --- | --- |
| `site/data/served_coverage_snapshot.json` | `tools/build_served_coverage_snapshot.mjs` | yes | The closed public contract. The Stats page fetches it from its own origin; `GET /stats` projects the same file. |
| `docs/evidence/served-coverage/census.json` | the same builder | yes | The full disposition census. Not a served artifact. |
| `docs/evidence/served-coverage/capture-manifest.json` | this directory | yes | Before and after render manifests. No image is committed. |

Rebuild and verify:

```sh
node tools/build_served_coverage_snapshot.mjs
node tools/build_served_coverage_snapshot.mjs --check
node --test test/served_coverage_snapshot.test.mjs
```

The builder reads committed artifacts only. It uses no clock, no network and no randomness, so
rebuilding unchanged evidence produces byte-identical output and cannot move a published date.

## How a coverage figure is defined

Each published row is one served consumer, and counts the records that consumer publishes using
that consumer's own record identity:

- **Population** — the records in the artifact the linked page serves. Not the publisher's
  population, and not the rows collected before selection.
- **Counting rule** — one of: one row per record in the set; one record per canonical identity
  across sources; only records with matched served evidence; records carrying one named source.
- **Evidence vintage** — the artifact's own declared vintage field, tried in the order the
  first-class artifact registry declares. When that field holds several instants it is a
  composite of several inputs, and the **oldest** of them bounds the claim: coverage is never
  presented as fresher than the least current evidence behind it.
- **State** — counted, none served, last verified, or not established. A population that cannot
  be measured is never published as zero.

Rows are never added together. Different consumers count different things, and the contract
carries `units_are_not_summed` so a consumer of the JSON is told so too.

## Registry census

The source-contract registry held **63** contracts at the inspected revision. Registry size is a
count of contracts on file, not of coverage, and the census keeps the two apart:

| Disposition | Contracts | Meaning |
| --- | --- | --- |
| `publicly_represented` | 18 | At least one record from this source is counted in a served population. |
| `context_only` | 28 | Enriches a population counted elsewhere; counting it separately would restate the same records. |
| `not_served` | 8 | No served records: disabled, backstage-only, or observed with no rows. |
| `unresolved` | 9 | Reaches readers, but no first-class served-population artifact declares it, so no count is established. |

`served_sources_represented` is the 18, not the 63. A registry change is reported rather than
absorbed: the builder records the reviewed size against the observed size, and a contract with
neither a derived nor a reviewed disposition fails the build instead of defaulting to a
flattering answer.

## Named-source receipts

### Checkbook NYC registered contracts (`checkbook-contracts`)

| | |
| --- | --- |
| Consumer A | `site/data/analytics_registered_contracts.json` + `analytics_registered_contracts/shard-000.json`, served at `/browse/contracts/` |
| Serving revision | `snapshot_date` 2026-08-18, `generated_at` 2026-08-18T04:05:51.552Z |
| Record identity | `prime_contract_id` |
| Counting grain | one row per exact `prime_contract_id` across the declared collection fiscal years |
| Reproduced count | **26,270** distinct `prime_contract_id` over 26,270 shard rows (no duplicates) |
| Consumer B | `site/data/procurement_browse_rows.json` + population shards, served at `/browse/contracts/` and `/procurements/<id>` |
| Serving revision | `generated_at` 2026-08-18T04:05:51.552Z; source model fingerprint `2cf20d591d478d13512a99f537389baff5255a10412a96a08b78fbdf03fb87bd` |
| Record identity | `procurement_id` |
| Counting grain | procurement records carrying at least one `checkbook_contracts:` observation |
| Reproduced count | **1,704** |
| Record reference | `checkbook_contracts:contract:registered:CT100220268808241:EMPIRE ELECTRONICS INC:prime-vendor:2026-06-04` |
| Canonical route | `/procurements/procurement%3Acontract%3ACT100220268808241` |

Reachability is established from committed artifacts, not asserted: `procurement:contract:CT100220268808241`
resolves in `shared_procurement_read_model.json#procurement_shard_by_id` to
`shared_procurement_read_model/shard-000.json`, and `/procurements/<id>` is matched by the Pages
edge handler at `site/pages_edge.mjs`.

The two consumers are reported separately and are not added. They count different things: a
registered contract in one, a canonical procurement record in the other.

### PASSPort Public solicitations, RFx (`passport-public-rfx`)

| | |
| --- | --- |
| Consumer | the same shared procurement population, served at `/browse/contracts/` |
| Serving revision | `generated_at` 2026-08-18T04:05:51.552Z |
| Record identity | EPIN, per the contract's declared join keys |
| Counting grain | procurement records carrying at least one `passport_public_rfx:` observation |
| Declared input rows | 0, with the source itself reported available |
| Reproduced count | **0** — `LC_ALL=C grep -c "passport_public_rfx:" site/data/procurement_browse_rows_population/shard-00{0,1}.json` returns 0 and 0 |
| Record reference | none exists at this revision |
| Published state | `observed_zero` on the page; `not_served` in the census, with the reason recorded |

This is a verified zero, not a gap in the measurement: the source was reachable and contributed
no rows. **No record reference or detail URL is preserved for this source, because none exists at
this revision.** The contract's other consumer is an edge-materialised table the Worker rebuilds
on its scheduled run; a build reading committed artifacts cannot count it, and it is not counted.
The zero sits beside its neighbours without suppressing them — PASSPort Public contracts, from
the same publisher, is counted at 12,770.

### NYC Council Legistar (`nyc-council-legistar`)

| | |
| --- | --- |
| Consumer A | `site/data/committee_graph_lookup.json`, served at `/browse/people/`, `/officials/<id>/`, `/committees/<id>/` |
| Serving revision | `generated_at` 2026-08-12T14:37:51Z; publication `published`; gate observed 2026-08-12 |
| Record identity | membership edge id, which carries the source row hash |
| Counting grain | published membership records |
| Reproduced count | **1,142** — equal to retained observations, and deliberately **not** the 2,284 edges in the display graph, which are the same 1,142 records plus their reverse direction |
| Record reference | `edge:member_of:official:5259:committee:12:541d245eab250d4a1608124e05d512711342e9bc457fcb40d0564db33968a5bd` |
| Canonical routes | `/officials/5259/` and `/committees/12/` |
| Consumer B | `site/data/meeting_outcomes_snapshot.json`, served at `/browse/meetings/` and `/notices/<request_id>` |
| Serving revision | `generated_at` 2026-08-10T13:08:13.019Z |
| Record identity | notice `request_id` |
| Counting grain | notices with matched served outcome evidence only |
| Reproduced count | **16** present of 319 notices considered; the other 303 are explicit absence records and are excluded |
| Record reference | notice `20260707022`, Legistar event `22509` |
| Canonical route | `/notices/20260707022` |

Matters, events and votes are not summed under one unlabelled record unit. Legistar reaches the
page as two rows with two different record types — committee membership and meeting outcome —
each with its own counting rule and its own evidence date.

## Duplicate and grain specimens

- **Repeated observations.** The served procurement population carries 13,162 `city_record:`
  observations across 12,899 records: some records carry more than one. The published figure is
  **12,899**, the record count under the consumer's own identity, not the observation count.
- **Declared inputs are not served records.** The same artifact's coverage block declares 13,178
  City Record input rows. The served figure is 12,899. Selection drops rows, and only the served
  side is retrievable by a reader, so only the served side is published.
- **Doubled display edges.** The committee graph publishes 1,142 membership records and renders
  2,284 directed edges. The published figure is 1,142.
- **Explicit absence.** The meeting-outcomes snapshot holds 319 notice records, of which 303
  record that no outcome was matched. The published figure is 16.
- **A source family is not two sources.** `ibo-fiscal-history` is registered with two component
  workbooks. It is one context-only source, contributes no searchable record unit, and is not
  counted twice — or once — toward represented sources.

## Arithmetic tying the page to the artifacts

| Page row | Value | Artifact field | Check |
| --- | --- | --- | --- |
| Procurement record | 13,791 | `procurement_browse_rows.json#row_count` | equals `shared_procurement_read_model.json#counts.total`; 689 accepted cross-source identity joins at precision 1.0 are what make one canonical count legitimate |
| Registered contract | 26,270 | `analytics_registered_contracts.json#row_count` | equals distinct `prime_contract_id` in the shard |
| Contract payment | 28,448 | `analytics_payments.json#rows` length | |
| Contract award | 53,600 | `ocp_awards_warehouse_lookup.json#row_count` | |
| Committee membership | 1,142 | `committee_graph_lookup.json#public_edges` length | equals `history.observations_retained` |
| Meeting outcome | 16 | `meeting_outcomes_snapshot.json#present_count` | `present + absent = 319 = record_count` |
| Sources in the served product | 18 | derived | equals the census `publicly_represented` count |
| Record sets counted | 19 | derived | equals the published unit count |

## Render evidence

`capture-manifest.json` holds the before and after manifests: route, viewport, repository
revision, data vintage, assertion and the SHA-256 of the rendered main region. No screenshot or
other image binary is committed.

The captures share one condition: every off-origin request is denied. Before the change the page
rendered four dashes and an unreachable message, because every number it showed came from a
request made while the page was loading. After the change the same page renders 9 domains and 28
counted rows from an artifact served beside it.

## Checks this change is held to

- `node tools/build_served_coverage_snapshot.mjs --check` runs in the required static-standards
  family and is registered in `ops/first-class-refresh/committed-read-models.json`, so a data
  refresh that publishes new inputs without restating coverage fails its own gate.
- `site/stats.html` is now a declared browser entrypoint in
  `architecture/resident-read-policy.json`, so the resident-read zero-egress gate covers it: the
  page may read `data/…` from its own origin and nothing else.
- `node --test test/served_coverage_snapshot.test.mjs` covers the census, the named-source
  reproductions, the duplicate and grain specimens, vintage stability, and the retained
  last-verified behaviour.
- `node --test worker/test/stats.test.mjs` covers the response projection, the parity between the
  page and `GET /stats`, and the absence of any request-time publisher fetch.

## Production read-back — pending

These are measurement-gated and are **not** claimed as done. They can only be recorded after the
change is deployed and the deployed page is read back:

- `served_sources_represented` — read back from the deployed `GET /stats` and from the deployed
  Stats page, and confirm the two agree.
- `served_record_sets` — same, read back from both surfaces.
- `coverage.evidence_vintage.oldest` and `coverage.evidence_vintage.newest` — confirm the
  deployed range equals the committed snapshot's range and has not been replaced by a build clock.
- Per-unit `served_records` for `registered-contracts`, `procurement-records` and
  `meeting-outcomes` — confirm the deployed values equal the committed artifact counts recorded
  above.
- The `coverage-vintage` and `coverage-sanity` post-flip checks against the deployed API base.
