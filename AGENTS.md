# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## PR and CI preflight

- Run `./tools/preflight-required-checks.sh` before creating or handing back a PR URL and
  before opening a pull request. CI still runs the full accessibility and runtime
  stray-English work after Unit checks.

## CI path fast paths and merge queue

- Required checks always report a conclusion (never stay missing). Fast paths:
  `changelog_only` (bot-owned changelog files) and `docs_only` (`tools/docs-only-path-guard.sh`)
  skip the full unit suite; non-frontend PRs skip browser a11y / reading-level
  heavy work while still posting SUCCESS. Performance budgets (20-sample p95) use a
  narrower `perf` path filter (site HTML/CSS/JS/media + budget harness) — not all of
  `site/**` — so data-only / worker-only diffs report SUCCESS without the long measure.
  Performance is not a merge-queue required check (`tools/merge_queue_policy.json`).
- Stray-English: **Unit static lint only** (`test/standards/stray_english.py`). The runtime
  multi-locale walk (`test/functional/13_stray_english.py`) is **not** a CI job or required
  check — optional locally via that script or `run_stray_english_shards.sh`. Required merge
  checks are Unit, Accessibility + language, and Reading-level (three total).
- Playwright installs go through `.github/actions/setup-playwright` (browser cache for a11y/perf).
- Merge-queue parameters: `tools/merge_queue_policy.json` + `node tools/apply_merge_queue_policy.mjs`
  (short train wait). Concurrent merge-when-ready seating for this repo is capped outside this tree.

## Cross-domain entity intelligence

Object-link layer across money / land / **property** / rules / meetings / people /
**franchise** for one agency or vendor (`entity_resolution/cross_domain/`). Reuses
subject registry kinds + ER normalizers + warehouse OCP/ZAP/ZAP-BBL fixtures — does
not reinvent matchers. Land projects gain `sited_on_parcel` edges when BBL join keys
exist. Money awards also emit join-key edges when present: PIN →
`shares_authority_key`, contract_id → `references_contract` (+
`contract_published_by_agency`), Checkbook spending → `paid_to_vendor` /
`payment_on_contract`. Franchise/concession notices with a firm counterparty emit
`named_franchisee` (franchise → vendor stem). Every link carries provenance.

Instant materialization + warehouse edge index (CPU-light, fixture path).
Rules/meetings densify from live City Record domain snapshots
(`site/data/rules_domain_observations.json`,
`site/data/meetings_domain_observations.json`) — agency → `issued_rule` /
`hosts_meeting`; meetings also emit `decides_land_project` when a hearing body
cites a ULURP token or ZAP project URL that resolves to a known land project in
the corpus (strict `extractUlurpKeys` / portal URL only — no title-only invent).
People densify from Legistar `by_person` on **all** meeting-outcomes records that already carry roll-call names (`site/data/people_domain_observations.json` — list densify via `tools/build_rules_meetings_domain_observations.mjs --people-only`; never invents from `tally_only`).
Refresh snapshots: `node tools/build_rules_meetings_domain_observations.mjs`
(extracts ULURP/ZAP keys from body at build time — raw body is not committed)
then rebuild entity intelligence.

```bash
node tools/build_rules_meetings_domain_observations.mjs --check
node tools/build_entity_intelligence.mjs
node tools/build_entity_intelligence.mjs --check
node warehouse/lib/entity_intelligence_index.mjs --from-fixture --limit 600
node warehouse/lib/entity_intelligence_index.mjs --check
node tools/build_property_cross_domain.mjs
node tools/build_property_cross_domain.mjs --check
node --test test/cross_domain_object_links.test.mjs \
  test/warehouse_entity_intelligence_index.test.mjs \
  test/property_cross_domain.test.mjs test/property_phase_spine.test.mjs \
  worker/test/entity_intelligence.test.mjs
```

Serve: `GET /entity-intelligence?demo=1` (prefers multi-domain with people when
live — City Council field case) or `?kind=agency&name=…`. Agency profile UI mounts
`#entity-intelligence`. People is matched when person-level Legistar votes are
retained (`by_person`); Parks remains multi-domain without inventing officials.
ADR: `docs/adr/cross-domain-object-links.md`. Warehouse SQL shape:
`warehouse/sql/examples/entity_intelligence_index.sql`; proof receipt:
`warehouse/receipts/proof/wh_entity_intelligence_index_latest.json`.

**Property / BBL joins (parity catchup):** pure
`entity_resolution/cross_domain/property_links.mjs` +
`site/data/property_cross_domain_lookup.json`. BBL → ZAP is **exact** tax-lot only
(`zap-bbl`); owner → contracts is labeled winning-bidder / sold-to → `vendorStem`
only; no fuzzy invent. Notice detail phase-groups disposition spine
(`site/property_phase_spine.mjs`) and action rail surfaces ZoLa parcel lookup.
Demo BBLs: `1006440001`, `3025180036`.

## DuckDB + parquet warehouse (WH-01…WH-06)

Local lake under `warehouse/` (bulk raw/parquet/duckdb gitignored). CPU-capped
ingest: single-job lock, headroom gate, `taskpolicy`/nice wrap, tiny row
defaults; full Socrata export only via `--bulk --ack-large` (one dataset at a
time). Setup + fixture proof:

```bash
python3 -m venv warehouse/.venv && warehouse/.venv/bin/pip install -r warehouse/requirements.txt
warehouse/.venv/bin/python warehouse/scripts/ingest.py --dataset ocp-recent-contract-awards --from-fixture --limit 5
warehouse/.venv/bin/python warehouse/scripts/ingest.py --dataset zap-projects --from-fixture --limit 5
warehouse/.venv/bin/python warehouse/scripts/ingest.py --dataset zap-bbl --from-fixture --limit 20
node --test test/warehouse_scaffold.test.mjs test/warehouse_bulk.test.mjs \
  test/warehouse_ocp_lookup.test.mjs test/warehouse_zap_lookup.test.mjs \
  test/warehouse_zap_bbl_lookup.test.mjs \
  worker/test/ocp_warehouse_lookup.test.mjs worker/test/zap_warehouse_lookup.test.mjs \
  worker/test/zap_bbl_warehouse_lookup.test.mjs \
  test/warehouse_er_batch.test.mjs
```

**Bulk packs (loaded):** OCP awards `qyyg-4tf5` + ZAP projects `hgx4-8ukb` +
ZAP BBL `2iga-a6mk` full `rows.csv` through the capped runner. Manifest +
checksums (no multi-MB bulk in git): `warehouse/manifests/wh02_load_manifest.json`.
Reproduce bulk:

```bash
python3 "$HEADROOM_BIN"   # estate headroom.py; CONSTRAINED → defer
warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset ocp-recent-contract-awards --bulk --ack-large --write-sample 25
warehouse/.venv/bin/python warehouse/scripts/query.py \
  --sql-file warehouse/sql/examples/ocp_bulk_verify.sql
warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset zap-projects --bulk --ack-large --write-sample 25
warehouse/.venv/bin/python warehouse/scripts/query.py \
  --sql-file warehouse/sql/examples/zap_bulk_verify.sql
warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset zap-bbl --bulk --ack-large --write-sample 25
warehouse/.venv/bin/python warehouse/scripts/query.py \
  --sql-file warehouse/sql/examples/zap_bbl_bulk_verify.sql
```

**WH-03 OCP serve:** materialize warehouse OCP into
`site/data/ocp_awards_warehouse_lookup.json` (+ Worker twin). Replaces live SODA
in `fetchOcpAwardRows` for materialization hits; live SODA remains the miss
fallback. Rebuild + speed receipt:

```bash
node tools/build_ocp_warehouse_lookup.mjs --fixture --bench
# receipt: warehouse/receipts/proof/wh03_ocp_lookup_speed.json
```

**WH-05 ZAP serve:** materialize sell-facing ZAP projects (+ demo `2022M0258`)
into `site/data/zap_projects_warehouse_lookup.json` (+ Worker twin). Replaces
live SODA in `fetchOpenDataRow` (`/zap-outcomes`) for materialization hits; live
SODA remains the miss fallback:

```bash
node tools/build_zap_warehouse_lookup.mjs --fixture --bench
# receipt: warehouse/receipts/proof/wh05_zap_lookup_speed.json
```

**WH-05 Doing Business serve:** materialize Doing Business Search Entities into
`site/data/doing_business_warehouse_lookup.json` (+ Worker twin). Replaces live
multi-page SODA in `attachDoingBusiness` for materialization hits; live SODA
remains the miss / partial-snapshot gap-fill:

```bash
node tools/build_doing_business_warehouse_lookup.mjs --fixture --bench
# receipt: warehouse/receipts/proof/wh05_doing_business_lookup_speed.json
node --test test/warehouse_wh05_lookups.test.mjs worker/test/wh05_warehouse_lookups.test.mjs
```

**WH-06 ZAP BBL serve:** materialize project→BBL groups (+ demo `2022M0258`)
into `site/data/zap_bbl_warehouse_lookup.json` (+ Worker twin). Replaces live
SODA in `fetchBbls` (`/zap-outcomes` DOB tax-lot side-car) for materialization
hits; live SODA remains the miss fallback. Cross-domain land objects gain
`sited_on_parcel` edges when BBL join keys exist:

```bash
node tools/build_zap_bbl_warehouse_lookup.mjs --fixture --bench
# receipt: warehouse/receipts/proof/wh06_zap_bbl_lookup_speed.json
node tools/build_entity_intelligence.mjs
```

**Remaining bulk (sequential, only if headroom green):** `city-record`
(`dg92-zbpx`). Optional later: full `doing-business-entities` bulk (~11k; enables
zero-SODA vendor attach). Query seam: `warehouse/lib/query.mjs` /
`warehouse/scripts/query.py`. Details: `warehouse/README.md`.

## Warehouse batch ER (WH-04)

Reuse `entity_resolution/` (vendorStem, token_v0, scorePair, canonicalAgency) —
do **not** reimplement matchers in SQL. Capped runner (same lock + headroom +
taskpolicy wrap as ingest):

```bash
python3 "$HEADROOM_BIN"   # CONSTRAINED → defer
warehouse/.venv/bin/python warehouse/scripts/er_batch_run.py --from-fixture --limit 25 --force-headroom
warehouse/.venv/bin/python warehouse/scripts/er_batch_run.py --limit 200   # warehouse OCP slice
warehouse/.venv/bin/python warehouse/scripts/query.py \
  --sql-file warehouse/sql/examples/er_entity_links_verify.sql
```

Materialized views: `er_entity_link`, `er_canonical_entity`, `er_resolution_run`,
`er_pair_receipt`, `er_ocp_vendor_resolved`. Pure lib:
`warehouse/lib/er_batch.mjs`. Proof:
`warehouse/receipts/proof/wh04_er_batch_latest.json`. Verify:
`node --test test/warehouse_er_batch.test.mjs`.

## Global item-route navigation

Detail-route Back controls use the session-history sidecar in `site/index.html`
(`rememberItemRouteContext` / `routeBackHTML`) so returning to a lens restores its
serialized filters and scroll position. New item-route chrome must use
`routeBackHTML` with an explicit cold-entry fallback; keep fallback routing in
`itemRouteFallbackHash`. Verify:
`node --test test/navigation_history.test.mjs` and
`python3 test/functional/20_navigation_history.py` with `site/` served locally.


## README live screenshots

`tools/capture_readme_screens.py` → `docs/readme/*.png` (linked from root `README.md`).
Captures the live site. Each frame waits on data-bearing selectors (not network-idle /
fixed sleep) and **fails if a skeleton is still visible** (`.today-skeleton`, `.empty.skel`,
`.skl`). Homepage must clear the email CTA (`#homeCta`) and the default Contracts list
(`#list .row`). Data page must clear
section counts and chart bars (sections paint last; "Counting 1M…" / "Loading…" are not ready).
Re-run: `python3 tools/capture_readme_screens.py`. Eyeball PNGs before commit.

## Batch-precompute first paint (perceived speed wave 2)

BATCHABLE / hybrid-default surfaces paint from prebuilt payloads; parameterized search stays live.

| Surface | Replaces | Payload / path | Hybrid |
|---|---|---|---|
| Data page charts | 5 live SODA aggregates on `data.html` | `site/data/data_page_charts.json` | Snapshot first, then live SODA refresh |
| Land default list | SODA `hgx4-8ukb` Active ULURP 40 on `#land` open | `site/data/land_default_ulurp.json` | Snapshot first; filter/keyword/geo still SODA; live refresh without re-autoSelect |
| Property first paint | Full 1.2MB `/property-locations` body dumps | Slim list default; `?full=1` keeps complete KV view | Already daily edge materialization |

Rebuild snapshots: `node tools/build_batch_precompute_snapshots.mjs` (pure lib:
`tools/lib/batch_precompute_snapshots.mjs`). Property slim: `worker/src/lib/property_list.mjs`.
Verify: `node --test test/batch_precompute_snapshots.test.mjs worker/test/property.test.mjs`.
Do **not** batch GENUINELY-LIVE paths (session/pins, NL, arbitrary money filters, geocode).

## PASSPort Public machine path

PASSPort Public has **no Socrata dataset** for contracts/RFx. Stable machine dumps:

- `https://a0333-passportpublic.nyc.gov/dataJs/contractData.js` (`public_ctr_data`)
- `https://a0333-passportpublic.nyc.gov/dataJs/rfxData.js` (`public_rfx_data`)

Edge materialization: `worker/src/passport.mjs` → D1 `passport_contracts` / `passport_rfx`
(+ dual-write `source_records` when `PASSPORT_SOURCE_RECORD_DUAL_WRITE=true`).
Strict EPIN↔PIN join: `worker/src/lib/passport_join.mjs`. Measured rates live in
`site/data/source_contracts.json` (`join_measurement`) and
`site/data/passport_sources/verification_receipts/`.
Deploy applies D1 migrations before worker code (`deploy-worker.yml`); `ensurePassportSchema`
is the runtime safety net. `lookup_status` is three-state: `ok` / `error` / `skipped` —
error must never render as a confident empty miss. Characterization:
`node --test worker/test/passport_lookup.test.mjs worker/test/er_source_coverage.test.mjs`.

**Freshness / dual-write (load-bearing):** daily cron runs `ingestPassportPublic` with a
browser-like User-Agent (empty UA → portal HTTP 403). Failed attempts stamp
`passport_ingest_meta` (`last_attempt_at`, `last_error`, `last_ok`) without wiping the last
good `ingested_at`. On fetch failure, dual-write **backfills** from existing product
payloads so observation coverage is not stuck at zero. Staleness helper:
`passportIngestIsStale` (default 48h). Operator force: `POST /admin/passport-ingest`
(`ADMIN_KEY`). Host-side full reseed when edge cannot reach dataJs:
`node tools/passport_remote_reseed.mjs` (optional `--dual-write-only`).

Solicitation response handoffs are evidence records, not generic bid links:
`site/action_registry.js` → `solicitationHandoff`. Notice-named agency systems take
precedence; PASSPort matches with numeric `rfp_id` deep-link to
`passport.cityofnewyork.us/.../process_manage_extranet/{rfp_id}` (same path public rfx.js
uses); without `rfp_id`, unmatched EPIN-shaped notices get a public browse search recipe. Keep the
field cases in `test/action-rail.test.mjs` and visual evidence in
`tools/capture_passport_bid_guide.py`.

**Package documents (measured stop, 2026-07-30):** `public_rfx_data` has **no document
URL columns**. Kill sample on 50 Solicitation+PIN notices: EPIN join **38%**, document
URL join **0%** (modern universe 0/1470). OCP `3khw-qi8f` and City Record solicitation
`document_links` also **0%** for `start_date` ≥ 2025-01-01. Gap
`procurement-solicitation-documents` is class (b) **not_published** → City Record
GetFile (`a856-cityrecord.nyc.gov/Search/GetFile`). Do not edge-materialize package
docs from RFx; RFx **metadata** materialization is unchanged. Helpers/receipt:
`worker/src/lib/rfx_documents_join.mjs`,
`site/data/passport_sources/verification_receipts/passport_rfx_documents_2026-07-30.json`.

## Bid Tabulations Historical (`9k82-ys7w`)

Ranked class-(a) bid-count source. **Measured below usefulness** (2026-07-30): strict
PIN↔`bid_number` join is **0%** on Procurement notices since 2025-01-01 and **9.07%** on
2016–2021 overlap (no PIN column; openings end 2021-03-24). Source contract
`bid-tabulations-historical` is **disabled** — no edge materialization. Strategies and
receipts: `worker/src/lib/bid_tabulations_join.mjs`,
`site/data/bid_tabulation_sources/`.

## Checkbook NYCHA awards (`Contracts_NYCHA`)

Ranked exact-PIN solicitation→award join. **Measured below usefulness** (2026-08-01):
temporal exact-PIN rate **0%** on the modern product notice window (23 PIN-bearing Housing
Authority solicitations; 0 non-empty `external_award_matches`). City Record RFQ-style pins
and Checkbook pin values largely do not share a joinable key; PIN reuse is correctly
rejected by the temporal filter. Source contract `checkbook-nycha-contracts` is
**disabled** for dense materialization. On-demand lookup may still run; empty cache TTL is
3 days (do not permanently sticky-cache empties). Strategies and receipts:
`worker/src/lib/nycha_awards_join.mjs`, `site/data/nycha_award_sources/`.

## Doing Business Search Entities (`72mk-a8z7`)

Vendor identity enrichment (listing, ownership structure, phone, start date). **Measured
above usefulness** (2026-07-30): `vendorStem` join is **70.42%** notice-level and
**61.62%** of distinct vendors on modern awards (`start_date` ≥ 2025-01-01). Four
columns only (no EIN/BIN/PIN). Source contract `doing-business-entities` is **live**
edge-materialized onto daily vendor-profile rebuilds (`doingBusiness` field).
Strategies and receipts: `worker/src/lib/doing_business_join.mjs`,
`site/data/doing_business_sources/`. Publisher dates often use truncated `00YY` years —
normalize to `20YY` before display.

## ULURP Recommendations (`4j6i-9rmr` + PDF `gt5i-dmde`)

Land-outcome depth candidate (Borough President positions + letter PDFs). **Measured
below usefulness** (2026-07-30): strict ULURP-token join on ZAP projects with non-null
`ulurp_numbers` is **0.54%** either-source (152/27,971), **0.29%** recommendations,
**0.25%** PDFs. Borough-scoped historical catalogs (91 + 88 rows). Source contracts
`ulurp-recommendations` and `ulurp-recommendation-pdfs` are **disabled** — no edge
materialization; keep the class-(a) land-outcome pointer. **Wrong universe:** Property
Disposition notices are not ZAP projects — do not use that slice as a success metric.
Strategies and receipts: `worker/src/lib/ulurp_recommendations_join.mjs`,
`site/data/ulurp_recommendation_sources/`.

## Land/ZAP event spine

`GET /zap-outcomes?id=` returns `record.spine`: a date-normalized rail joining ZAP API
milestones/dispositions with City Record notices by strict ULURP token. Each event carries
`time` (value/precision/basis/certainty) and a named source URL; `gaps` preserves class-(a),
class-(b), and operational-unavailable states, while `lag.open_data_vs_portal` compares the
two published milestone dates without treating Open Data as live.

**Write-ahead prewarm (load-bearing for Land detail speed):** cold multi-source
materialization is ~12s; warm KV is sub-second. Daily cron runs
`refreshZapOutcomes` (sell-facing statuses In Public Review → Noticed → Active →
Filed, capped, plus demo `2022M0258`). Operator force:
`POST /admin/zap-outcomes-refresh` (`ADMIN_KEY`). Client session-prefetches the
first screenful of list project ids after land list paint. Unlisted ids still
compute-on-miss. Verify:
`node --test test/zap_outcomes.test.mjs worker/test/zap_outcomes_prewarm.test.mjs
test/land_event_spine.test.mjs`. UI capture:
`python3 tools/capture_land_event_spine.py`.

**ULURP statutory clocks (cs-pred-03):** after certification, Charter §197-c
windows (CB 60 → BP +30 → CPC +60 → Council +50 → Mayor +5, ≤205 days) are
batch-stamped on `/zap-outcomes` as `statutory_clock` + `cityscroll.prediction.v0`
assertions (`method: statutory_clock`). Pure table:
`site/ulurp_statutory_clock.mjs`; emission:
`worker/src/lib/ulurp_statutory_predictions.mjs` via
`attachUlurpStatutoryPredictions` in `buildZapOutcomeRecord`. UI uses the
precomputed view only (shared labeled-forecast chip class). Withdrawn projects close open predictions
as `withdrawn`. Verify:
`node --test test/ulurp_statutory_clock.test.mjs`. Capture:
`python3 tools/capture_ulurp_statutory_clock.py`.

**Contract renewal forecasts (cs-pred-09):** Checkbook `fc:*` rows keep product
fields for `/forecast`, vendor profiles, and digests, and also carry
`cityscroll.prediction.v0` provenance (`method: term_arithmetic`) via
`worker/src/lib/contract_forecast_predictions.mjs`. Digest de-dup stays
`sent:fc:<contract_id>:<sub_key>` (warning_date single-fire). Accuracy:
`forecast_score.mjs` fuzzy Solicitation hit_rate + `resolveForecastPredictions`
for exact-join status. Next-award cadence tags `method: cadence` on the derived
object only (render copy unchanged). Verify:
`node --test worker/test/contract_forecast_predictions.test.mjs
worker/test/forecast_scoring.test.mjs worker/test/checkbook_expiration.test.mjs
test/cadence_estimate.test.mjs`.

## Legistar agenda/vote depth

Ranked class-(a) meeting-outcomes depth. **Edge materialization is live** (daily
cron) with Worker secret `LEGISTAR_API_TOKEN` (full multi-segment key as `token=`
query; first segment alone → 403). GitHub Actions secret syncs on worker deploy.

- Modern City Council notice → Legistar event join: **100%** (59/59)
- Joined events with EventItems: **100%**; matter-linked items: **98.3%**; roll-call
  votes sampled on ~**10%** of subcommittee hearings (voice/committee outcomes use
  inline `EventItemActionName`)
- Nested routes: `Events/{id}/EventItems`, `EventItems/{id}/Votes`,
  `EventItems/{id}/Attachments` (top-level EventItems/Votes are 404)

Client: `worker/src/lib/legistar_client.mjs`. Strict join: `worker/src/lib/legistar_join.mjs`.
Read model: `worker/src/lib/meeting_outcomes.mjs` → KV `meeting-outcomes:materialized:v2`.
Open Data `m48u-yjt8` remains a **disabled** freeze through 2024-12-19 (0% modern).
Receipts: `site/data/legistar_sources/`. Demo: notice `20260706036` → event `22526`.

**Meeting outcomes UI:** matter-centric scan list (summary chips + short title +
outcome badge + progressive disclosure), not one four-stage lifecycle chain per
Legistar action row. Render: `meetingOutcomesHTML` in `site/index.html`.
Characterization: `node --test test/meeting_view_readability.test.mjs`.

**Matter deep links:** numeric Legistar `MatterId` →
`https://nyc.legistar.com/Gateway.aspx?M=L&ID={id}` (resolves to
LegislationDetail with GUID). `LegislationDetail.aspx?ID=` alone returns
"Invalid parameters!". Non-numeric ids (fixtures) get no link. Helper:
`matterDetailUrl` in `worker/src/lib/legistar_join.mjs` (stamped as `matter_url`
on assembled matters / spine). Non-Council unmatched outcomes link real BP/CB
HTTPS landings via `nonCouncilWhereHTML` — never text-only "where". Package-doc
class-(b) gaps deep-link `RequestDetail/{request_id}` when known, not bare GetFile.

**Meeting vote spine (matter path as one object):** each matched notice record
carries `spines[]` — one object per matter for the connected path
**agenda → matter → action → vote → attachment** (`buildMeetingVoteSpine` /
`buildMeetingVoteSpines` in `meeting_outcomes.mjs`). Named metric:
`meeting_vote_spine_completeness_rate` (mean stage fill over matter spines;
also `full_spine_rate` + per-stage rates on the view `metrics` block).
Verify: `node --test test/meeting_vote_spine.test.mjs
test/contract/meeting_outcomes.test.mjs test/procurement_lifecycle_stitch.test.mjs`.
Capture: `python3 tools/capture_meeting_event_spine.py`.

**Official entity family (person-level votes):** Live Legistar Votes rows carry
`VotePersonId`/`VotePersonName` (+ `VoteValueName` Affirmative/Negative) — not
`PersonId`/`PersonName`. Mapper retains both shapes as `official:{person_id}`
with typed `votes_on` edges (official → matter|agenda_item). Pure helpers:
`entity_resolution/officials/`. Named metrics: `person_vote_retention_rate` and
`official_votes_on_edge_rate`. **Live audit 2026-08-02 (event 22526):** 49/49
vote rows retained after VotePerson* mapping (`person_vote_retention_rate=1`);
receipt `official_person_vote_retention_2026-08-02.json`. Public meeting-outcomes
`vote_identity` is `roll_call` when persons retained, `tally_only` when rows
exist without identity (no fabrication). Meeting UI surfaces a one-line roll-call
chip on the matter card when `by_person` is non-empty (not only inside collapsed
Decision) and deep-links names to `#official/{id}?notice=&event=` (event-scoped
skim). Entity intelligence loads people from
`site/data/people_domain_observations.json` (built via
`tools/build_rules_meetings_domain_observations.mjs` from meeting-outcomes
`by_person`). Never invent roll call for `tally_only`.
Immutable `source_records` dual-write for Legistar Events/EventItems/Votes/
Attachments is live under `LEGISTAR_SOURCE_RECORD_DUAL_WRITE`
(`worker/src/lib/legistar_source_records.mjs`).
Writes are chunked and stream-isolated; `refreshMeetingOutcomes` returns
`dual_write` stats (not cached on the public KV view). On-demand operator
trigger: `POST /admin/meeting-outcomes-refresh` (`ADMIN_KEY`). Nested
Attachments can honestly be empty when product documents are only event
Agenda/Minutes on Events (those fields ride on `nyc_legistar_events` snapshots).
Verify: `node --test test/official_entity_family.test.mjs
test/legistar_client.test.mjs test/contract/meeting_outcomes.test.mjs
worker/test/legistar_source_records.test.mjs`.

## Content and testing — lifecycle gap taxonomy

**Standing contract:** every absent-data state on a lifecycle surface must tell the reader *which kind of gap* it is. Never ship an undifferentiated “no record” / “unknown” / blank slot when the product has decided a field is missing.

| Class | Reader-facing register | Meaning |
|---|---|---|
| **Not yet ingested** | “Not yet shown here — … live in *source*.” | A public source publishes this field; the empty slot is incomplete join or a missing adapter. Name the source. |
| **Not published** | “The city does not publish this — it would appear in *where* if released.” | No public, joinable release is known. Name the logical home when one exists. |

Keep **per-item** specificity (pending vs registered vs payments; subsidy outcome vs company field; Council vote vs matter). No page-level disclaimer in place of a slot-level line.

**Out of taxonomy (keep operational wording):** source unreachable (`lifecycle_unknown_html`, `subsidy_source_unavailable_html`) and multi-match ambiguity (`lifecycle_ambiguous_html`).

**Where it lives**

- Depot (join graph + gap inventory + ranked class-(a) ingest list): [`site/data/gap_taxonomy.json`](site/data/gap_taxonomy.json) — `sources` / `crosswalks` are the graph; `gaps` are the slots
- Direction page (generated): [`docs/gap-taxonomy.md`](docs/gap-taxonomy.md)
- Re-derive after source-contract or taxonomy changes: `node tools/depot_rederive.mjs` (CI drift gate: `--check`)
- Characterization: `node --test test/gap_taxonomy.test.mjs test/depot_rederive.test.mjs`
- Screenshot capture: `python3 tools/capture_gap_taxonomy.py`

### Live source-contract monitor

Daily workflow `.github/workflows/source-contracts-live.yml` →
`node tools/verify_source_contracts.mjs --live`. Fixture check stays in PR CI; live
alerts open/update the drift issue.

**Probe classes (keep teeth, cut CI noise):**

- **Ingest** (default Socrata/Checkbook/RSS): schema + sample + freshness gate
- **Pointer** (`contract_class: "pointer"`, `stale_policy: "skip"`): existence +
  schema only — Capital Projects is the exemplar
- **Bot-blocked egress** (`egress_class: "bot_blocked"`, often with
  `landing_probe: "bot_blocked"`): CI runners get HTTP 403 from the publisher (PASSPort
  HTML **and** dataJs). That is not upstream drift — product freshness is the Worker’s
  materialization. Still fail on non-403 failures (404, DNS, empty body when reachable)
- **Auth API** (`auth_token_env`, e.g. Legistar): with token → 200 JSON; without →
  HTTP 403/401 is the expected gate, not a failure. Wire `LEGISTAR_API_TOKEN` into the
  live workflow when present
- **Templated endpoints**: require `probe_sample_id` or `probe_endpoint` (never probe
  the literal `{project_id}` path)
- **Checkbook Spending**: product shape is Contracts-then-Spending-by-`contract_id`
  (PIN is rejected); required XML fields are `contract_id`, `payee_name`,
  `check_amount`, `issue_date`

Every live failure line must name `source_id` and URL class. Never emit bare
`fetch failed`. After registry edits that touch landing URLs, run
`node tools/depot_rederive.mjs` so gap taxonomy does not retain a stale copy.

When adding a new lifecycle empty state: pick class a or b with evidence, add or update the inventory row, use the matching register in English and all shipping locales, and extend the characterization test. Prefer pointing new work at the inventory over inventing a third gap register. After landing a source or stamping `join_measurement`, run `depot_rederive.mjs` so realized coverage, candidate crosswalks, and the ranked queue stay current.

### Lifecycle rendering coherence (notice detail)

Precompute-first on the notice page: never live Checkbook proxy; never render `lifecycle_unknown_html` (“Could not reach…”) as a public data gap. Coerce `unknown` → taxonomy unmatched, or **passed** when a later stage is matched. No-PIN collapses Checkbook stages into the single class-(b) note. Format zero amounts with `lifecycleMoney` (`$0` / `—`), never literal `null`.

**Phase-group timeline (procurement):** presentation groups stages under Solicitation → Selection (City Record intermediates) → Award and registration → Payments via `site/procurement_phase_spine.mjs` (same shape as land `land_phase_spine` — do not fork a second generic component). Action-first lead for the current phase; earlier phases under disclosure; one outbound source family per phase. Verify: `node --test test/procurement_phase_spine.test.mjs test/lifecycle_render.test.mjs`.

**Compact template (cognitive load):** contract lifecycle is a stepper (`.lc-stepper`) plus detail cards only for populated / attention stages. Future unmatched steps stay grey chips — do **not** emit a per-stage “Not yet shown here — lives in {source}” paragraph or a repeated Checkbook URL. Unmatched OCP / RFx side-cars also collapse until matched. Methodology lives in a “How this timeline works” disclosure (source *names*, no extra outbound links). One actionable source link on the current stage only. Solicitations lead with the action rail + how-to-respond (`buildApply`) before lifecycle. Class-(a)/(b) strings remain in i18n and the gap inventory for other surfaces and when precompute later fills a stage. Characterization: `node --test test/lifecycle_render.test.mjs test/lifecycle_coherence_field_cases.test.mjs`. Evidence: `docs/screenshots/notice-template-rethink/`.

**Notice action rail (no punt):** “What can I do now?” must extract concrete response steps from the notice itself — package/submit URL from the body when present, plus contact, deadline, method, and submit-to address from City Record fields. Never ship “Use the response instructions in the official notice” as the primary CTA. Logic: `site/action_registry.js` (`solicitationHandoff` / `notice_extracted`); render: `actionRailGuideHTML` in `site/index.html`. Verify: `node --test test/action-rail.test.mjs test/notice_action_rail.test.mjs`.

**Award action rail (no watch-only punt):** Award notices already carry vendor, amount, PIN, and `/contract-lifecycle` registration/spending. Primary CTA is dollars/vendor/registration-aware (`awardHandoff` → `system: award_lifecycle`) — e.g. awarded-to, registered date, pending registration, Checkbook handoff — never “Watch this notice” as the only next step. **Intent to Award / Intent to Negotiate / Vendor List** are selection-phase guides (not a solicitation bid CTA). Closed awards never say “bid.” Fields only when present; empty lifecycle degrades to notice + watch. Verify: `node --test test/action-rail.test.mjs test/notice_action_rail.test.mjs`.

**Hearing action rail (no online-link punt):** for `kind === "hearing"`, extract attend / testify / contact steps from ingested City Record body + `hearing_location.js` participation (URLs/emails/phones) and venue fields. `hearingHandoff` in `site/action_registry.js`; `noticeActionMatter` passes full body + `venue` / `participation`. Present as a “How to participate” step list — never “No online participation link…” when venue or testimony is published. Field cases: `20260716022` (FCRC/Parks), `20260709028` (FCRC/NYPD).

**Land / rezone action rail:** `#ldetail` mounts `#land-actions` via `paintLandActionRail` / `landActionMatter` — phase-tied ULURP next steps from ZAP status + `city_record_notices` on `/zap-outcomes` (testimony, venue, join, hearing dates). Logic: `zoningHandoff` in `site/action_registry.js` (`system: zoning_extracted`). Never invent hearings or comment-open CTAs pre-review. Verify: `node --test test/land_action_rail.test.mjs test/land_event_spine.test.mjs`.

**One owner per fact (lifecycle vs detail):** when the Checkbook registration join exists, the payments card **summarizes** (`$X paid of $Y committed`, zero-lag note when $0-fresh) and anchor-links to `#follow-the-dollars`; it never emits class-(a) gap copy in parallel. Follow-the-Dollars owns paid-to-date detail and must not re-emit the payments gap. Gap register for payments only when the join is genuinely absent (no PIN / no registered record). Same ownership rule for subsidy: project-level unmatched is one note, not stacked per-stage gaps. Characterization: `node --test test/lifecycle_coherence_field_cases.test.mjs` (symptom: *joined payments rendered as not-shown, duplicated*). Captures: `python3 tools/capture_lifecycle_coherence.py`.

### Procurement lifecycle coherence counters

Detect orphaned/contradictory Money stages on assembled lifecycles and measure them:

- **Issue kinds:** `orphaned_award` (matched award, no solicitation from any honest
  source — class-(a) with named sources: City Record, PASSPort RFx, OCP Current
  Solicitations; never a silent gap),
  `payment_exceeds_commitment` (paid-to-date > award/registered commitment),
  `out_of_order_dates` (matched stage dates violate order on a **comparable
  event-time basis** — CR publication vs Checkbook registration is exempt)
- **Solicitation recovery:** CR sibling → OCP Current Solicitations → PASSPort RFx
  (injects matched solicitation when unique). EPIN prefix min length 8.
- **Side-car:** `assembleLifecycle` / passport enrich / payment recovery stamp
  `lifecycle.coherence` + `lifecycle.solicitation_recovery`
- **Named metrics:** `procurement_lifecycle_coherence_rate` =
  coherent / eligible; `award_solicitation_recovery_rate` = PIN-bearing awards
  with matched solicitation / PIN-bearing awards
- Pure lib: `worker/src/lib/lifecycle_coherence.mjs`
- Fixtures: `worker/test/fixtures/lifecycle-coherence/`
- Verify:
  `node --test worker/test/lifecycle_coherence.test.mjs &&
  node worker/scripts/lifecycle-coherence-scorecard.mjs --fixtures
  worker/test/fixtures/lifecycle-coherence --check`


## Changelog harvest

Public surface: `site/changelog-data.json` + `site/changelog.html` (not repo-root). Workflow:
`.github/workflows/update-changelog.yml` → `tools/prepare-changelog-base.sh` →
`tools/gen_changelog.mjs`. Editorial bar: `changelog:major` **and** an accepted user-impact
heading (canonical `## What this means for you`; aliases in `tools/changelog_extract.mjs`).
**Vacuity tripwire:** major label with nothing extractable, or major with an empty `site/`
delta that is not already-recorded, fails the job — never a green no-op. Convention:
`CONTRIBUTING.md` “Changelog entries”. Characterization: `test/changelog_*.test.mjs`,
`test/changelog_entry_gate.test.mjs`.

**Self-merge / merge queue:** main’s ruleset requires three named checks (see
`update-changelog.yml` `REQUIRED_CHECKS` and `tools/merge_queue_policy.json`). Changelog-only
bot PRs take `ci.yml`’s `changelog_only` fast path so those check names report SUCCESS within
about a minute (workflow_dispatch + merge_group); without that, the queue waits forever.
Auto-merge arms with `gh pr merge --auto` (no strategy flag — the queue’s method is SQUASH).
Path guard: `tools/changelog-path-guard.sh`. Characterization: `test/changelog_queue_checks.test.mjs`.

## Live-URL smoke target sets

Post-deploy gate: `node tools/live_url_smoke.mjs` (default set includes apex, www, crol-list redirect host, about). Named opt-in sets do not change production routing:

- `--set pages-dev` — parallel host only (or `--base-url https://cityscroll.pages.dev`)
- `--set post-flip` — post-cutover URL matrix **plus** named incident checks (EMAIL HEALTH, STATS SANITY, WORKER ACCESS, HUMAN-PATH JOURNEY in `tools/post_flip_checks.mjs` + `tools/human_path_journey.py`); select only after an owner-authorized flip

Migration value baseline (merge-to-live wall-clock, detection exemplars, rollback estimate, dual-host live metrics): `docs/evidence/hosting-migration-baseline.json` + full receipt `docs/evidence/hosting-dual-host-metrics.json`. After cutover, measure against it — do not assert improvements. Re-measure dual-host only (read-only, no DNS/route changes): `node tools/measure_hosting_baseline.mjs --phase after-cutover --samples 5 --out-receipt docs/evidence/hosting-dual-host-metrics-after.json --write-baseline docs/evidence/hosting-migration-baseline.json`. Characterization: `node --test test/measure_hosting_baseline.test.mjs test/live_url_smoke.test.mjs test/post_flip_checks.test.mjs`. Operator flip procedure lives outside this public tree.


## Hearing participation (one owner, list + detail)

Meetings list cards and notice permalinks share one derivation:
`normalizeHearing` / `normalizeHearingRow` → `participation.links` →
`participationLinksHTML` in `site/index.html`. Strip trailing punctuation
**before** dedupe (body often has `https://…hearings,` and `https://…hearings`);
one outbound affordance per notice. NYCIDA board URL labels as **IDA meetings page**
(the deepest public target those notices publish). Characterization:
`node --test test/ida_notice_defects.test.mjs`. Captures:
`python3 tools/capture_ida_notice_defects.py`.

**Meetings domain explorer (list):** pure `site/meetings_explorer.mjs` elevates
the Meetings lens on process stage (scheduled → agenda → held → outcomes),
next-action keys (attend / join / testimony when the notice publishes them),
and agency entity links — while **keeping place-based navigation** (local /
citywide / unlocated groups + affected-area filters). Same-agency same-day
notices collapse to one event card; same-agency same-matter decides text can
collapse a multi-notice journey. Detail vote spine stays
`site/meeting_phase_spine.mjs`; non-Council process spine stays
`site/non_council_hearing_spine.mjs`. Verify:
`node --test test/meetings_explorer.test.mjs test/meeting_phase_spine.test.mjs
test/non_council_hearing_spine.test.mjs`. Captures:
`python3 tools/capture_meetings_ops_ontology.py`.

## Contract lifecycle category gate

`isContractLifecycleEligible` — Procurement section or Solicitation/Award/Intent
types only. Hearings, Agency Rules, Property Disposition, and Changes in Personnel
never mount contract lifecycle / OCP / PIN gap modules (wrong-universe). Subsidy and
meeting-outcomes keep their own eligibility helpers. Characterization:
`test/ida_notice_defects.test.mjs`, `test/lifecycle_coherence_field_cases.test.mjs`.

## Subsidy lifecycle (NYCIDA / Build NYC)

Endpoint `GET /subsidy-lifecycle?id=` (`worker/src/subsidy_lifecycle.mjs`). The
EDC documents page is often Cloudflare-blocked to edge fetch (HTTP 403 / challenge
HTML) — treat as feed failure, do **not** permanently D1-cache `source_status:
unavailable`. When the feed fails, `projectFromIdaNotice` derives a hearing-stage
join from the City Record IDA hearing notice (company names, event date, and
labeled **Total Project Cost** / **Total Development Cost** dollars via
`parseHearingMoneyFromBody`). Keep honest unavailable copy only when the feed is
down **and** no notice-derived hearing applies. Schema safety net:
`ensureSubsidySchema` (migration `0005_subsidy_lifecycle.sql`).

**Money honesty on hearing-only joins:** when `join.method=city-record-hearing`
(and/or `feed_status=unavailable`), never label blank structured money as class
(b) “city does not publish on the Build NYC record.” Use class (a)
`not_yet_ingested` / feed-unreachable copy for structured Build NYC fields, and
**show** parsed City Record costs when present (`total_project_cost` / `total_development_cost` on the money object). Durable EDC structured-feed
ingestion remains a follow-up (bot-blocked host). Fixture:
`worker/test/fixtures/subsidy-hearing-money/20220525018.json`. Verify:
`node --test test/subsidy_hearing_money.test.mjs`.

**Age-aware gap kinds** (temporal sibling of paid / verified_zero / unavailable):
`subsidyGapKind` → `too_soon` | `not_published` | (worker stamp)
`not_yet_ingested` | `unavailable`. Lag table `SUBSIDY_STAGE_EXPECT_LAG_DAYS`
(board ~60d, closing ~180d, project_record ~90d).


**Phase-group presentation (Money-collapse):** empty future stages collapse into a compact “not yet reached” indicator + stepper. Lead with current stage + action; detail cards only for material stages. Pure model: `site/subsidy_phase_spine.mjs`. Verify: `node --test test/subsidy_phase_spine.test.mjs test/procurement_lifecycle_stitch.test.mjs`.

**Feed-down partial join (hard rule):** when `join.method=city-record-hearing` and
`join.feed_status=unavailable`, later unmatched stages (board / closing /
compliance) must use **not_yet_ingested** (class-a “Not yet shown here…”) — never
class-(b) “the city does not publish.” Only after a successful Build NYC project-
feed join may aged empty stages use `not_published`. Pure stamp:
`stampSubsidyFeedUnavailable` in `worker/src/lib/subsidy_lifecycle.mjs`. UI
defensive remap in `subsidyStageHTML` when `feed_status=unavailable`.

Young hearings still use “check back” (`too_soon`). Show parsed City Record costs
when present. Characterization: `test/subsidy_lifecycle.test.mjs`,
`test/ida_notice_defects.test.mjs`, `test/subsidy_hearing_money.test.mjs`,
`test/procurement_lifecycle_stitch.test.mjs`. Aged demo ids: `20220525018`
(non-null parsed cost), `20231004016`, `20240617012`.

## Intermediate City Record procurement stages (money chain)

Money lifecycle stages include City Record intermediates between solicitation and
award: `intent_to_negotiate` → `vendor_list` → `intent_to_award` (plus
solicitation / award). Intent to Award is **not** collapsed into solicitation.
Matched-only: intermediates appear when the focal notice or a PIN-sibling
related notice carries that `type_of_notice_description`. Worker
`fetchRelatedProcurementNotices` gathers PIN-siblings (D1 → SODA); pure pick
`pickCityRecordStageNotices` / `assembleLifecycle({ relatedNotices })`.
Succession order: `LIFECYCLE_STAGE_ORDER` in `site/index.html` (keep single-line
for extractConst). Verify:
`node --test test/contract/procurement_lifecycle.test.mjs
test/lifecycle_render.test.mjs worker/test/checkbook_lifecycle.test.mjs`.

## Checkbook Contracts row identity

Checkbook's Contracts domain returns **multiple rows per `prime_contract_id`** (one Prime Vendor row with amounts, plus Sub Vendor / expense-category slices with $0 on prime fields). Lifecycle assembly collapses rows with `aggregateContractsById` before `classifyStage` — one distinct id = matched; ≥2 distinct ids = ambiguous. Field case: notice `20231222103` / `CT107120248803393`. Do not count raw Contracts rows as separate contracts. Spending rows stay uncollapsed (many payments per contract is normal). Pure lib: `worker/src/lib/checkbook_lifecycle.mjs`.

## Paid-to-date one-owner (payments card ↔ Follow-the-Dollars)

Both surfaces use the same resolution (`lifecycleResolvedPayment` in `site/index.html`; server `recoverPaymentFromRegisteredJoin` after PASSPort fill). Prefer spending-feed totals; fall back to registration `spent_to_date` when the join has it. **"Unavailable" only when neither path has a figure** — never invent confident $0 over a spending-error when registration spent is also 0. Field case: notice `20240723114` (PASSPort registered $4.02M paid while payment stage was unknown). Characterization: `test/lifecycle_coherence_field_cases.test.mjs`.

## Notice payment panel (deep link + vendor match)

- Payments-card → dollars: `#notice/<id>?focus=follow-the-dollars` (never bare `#follow-the-dollars` — applyHash falls through to Money). Scroll after lifecycle render via `scrollToLifecycleFocus`.
- Outbound Checkbook: `checkbookSearchUrl({contractId, pin, vendor})` → smart_search when a term exists.
- Vendor mismatch: `vendorNamesMatch` (vendorStem + truncation/token overlap). HNTB truncation must not warn; true mismatches still do. Soft variant copy: `lifecycle_dollars_vendor_variant_html`.
- Payment honesty: Checkbook Spending rejects `pin` (code 1101) — join by `contract_id` after Contracts. Three states via `payment_state`: `paid` / `verified_zero` / `unavailable` (never confident `$0` on feed error).
- Characterization: `node --test test/lifecycle_coherence_field_cases.test.mjs test/lifecycle_render.test.mjs test/unit.test.mjs` and `cd worker && node --test test/checkbook_lifecycle.test.mjs`.

## Capital Projects planning pointer (`n7gv-k5yt`)

Class-(b) pointer for `procurement-planning-budget` only. Dataset has **no
PIN/EPIN**; agency+name fuzzy join measured **≤1%** on modern Procurement
(2026-07-30) — below usefulness. Do not edge-materialize. Receipt:
`site/data/capital_project_sources/verification_receipts/capital_projects_2026-07-30.json`.
Helpers: `worker/src/lib/capital_projects_join.mjs`.

## Civil Service List closed-exam aggregates (`vx8i-nprf`)

PII hard rule: exam-level group-by only (`list_count`, dates, `title_count`).
Closed-exam exam_no overlap **44.54%** (494/1,109) — ship post-list depth;
open-exam overlap 0%. Artifact:
`site/data/exam_sources/civil_service_list_aggregates.json` joined at build via
`tools/build_staffing_exams.mjs` + `worker/src/lib/civil_service_list_join.mjs`.
Closed exams that leave the current FY annual snapshot stay joinable through
`list_depth_closed_exams.json` (open 7xxx series has 0% list presence). UI:
`list_joined` when list depth attaches; empty aggregate slots use class-(a)
`not_yet_ingested` (`career_outcomes_not_yet_ingested_html`) — never class-(b)
city-withhold for aggregates. Individual scores remain class-(b).

## Exam process spine (application → list → appointment)

Multi-stage lifecycle for one `exam_number`: **application → list_establishment
→ certification → appointment**. Pure builder:
`site/exam_process_spine.mjs` (re-exported as `worker/src/lib/exam_process_spine.mjs`).
Joins the DCAS schedule / NOE application window, Civil Service List aggregates,
and DCAS annual outcome counts — never invents post-cycle events. Empty stages
use class-(a) `not_yet_ingested` naming the public source; never re-label
aggregates as class-(b) "city does not publish". Static career-guide steps remain
teaching copy only. UI: `examProcessSpineHTML` on exam detail cards (`#exam/{n}`);
metrics grid stays for joined counts. Civic-time kinds (library-only):
`staffing.application_window` / `list_established` / `certification` /
`appointment` via `mapExamProcessSpineToCivic`. Metric:
`exam_process_spine_completeness_rate`. Verify:
`node --test test/exam_process_spine.test.mjs`.

## Exam fee / salary (NOE path)

Fee and starting salary come **only** from public Notice of Examination bodies,
never the annual schedule table (`4ptz-hmtc` has no fee columns). Sources:
`dcas_open_competitive.json` (live open-window snapshot) plus
`noe_fee_salary_densify.json` (body-parsed densify cache for multi-exam and
other NOEs the open page does not list). Build retains NOE fields when an exam
drops off the open snapshot (`retainNoeDetailFields`) and merges densify via
`applyNoeDensifyRecord` (`STAFFING_EXAMS_SCHEMA_VERSION` bump when densify shape
changes). Schedule-only nulls stamp `fee_salary_gap.class = not_yet_ingested`
(class a); class b only if a linked NOE omits the field. UI:
`examFeeSalaryView` + `career_fee_salary_not_yet_ingested_html`. Field case:
exam `7016` Caseworker fee `$68` / salary `$48,206`. Deep-link `#exam/<id>`
keeps hash + paints detail shell first (`showExam` / `paintExamDetailShell` /
`serializeState`). Receipt:
`site/data/exam_sources/verification_receipts/noe_fee_salary_densify_latest.json`.
Verify: `node --test test/exam_fee_salary.test.mjs test/noe_fee_salary.test.mjs
test/deadline_exam_cards.test.mjs`.

## Digest watermark recovery (catch-up digests)

**markSeen policy (hard rule):** `markSeen` advances the delivery-adjacent seen set
ONLY after a real send (`if (send && rows.length)`), never on observe. The old
`!capped` gate advanced seen during dry-runs and quiet runs, silently swallowing
fresh notices so the next run treated them as already-seen — the watermark-poisoning
bug. Applies to all three paths: config watches, `processOneSub`, `processAwardSub`.

**Catch-up mode** (`runCatchUpDigests`): when delivery was broken for days, recovery
sends the **missed stream since the lastsent watermark**, not a single post-unclog drip.
Procedure: detect lag (≥ `minLagDays`) → clear seen → recompute query with raised limit
+ `start_date >= watermark` floor → send one clearly-labeled catch-up email → advance
watermark only on success. Tracks `digest_catchup` stats separately from normal volume.

**Triggers:**
- Admin: `POST /admin/digest-catchup` (ADMIN_KEY, body `{ minLagDays?, subKeys? }`)
- Cron: env `DIGEST_CATCH_UP=1` (one-shot; prefer admin for operator control)

**Stats:** `/stats` digests block carries `catch_up_sent_today`,
`catch_up_sent_all_time`, `catch_up_last_run`, `lagging_subs`. Operator can show
catch-up rows via daylog `action: "catch_up"` (and `traffic_class: "catch_up"`).

**Ops correctness (day-scoped recount):** `correctnessCheck` in
`worker/src/lib/digest_ops.mjs` must **not** flag catch-up sends as
`phantom_send` / `count_mismatch` when a focus-day recount is 0 or lower than
the multi-day recovery total. Detect via `action` / `traffic_class` / `mode`
`catch_up` (historical rows may only have `action`). Result includes
`catchUpExempt`. Characterization: `node --test test/digest_ops.test.mjs`.

**Catch-up daylog under queue mode:** `runCatchUpDigests` always merges stamped
daylog entries (`action`/`traffic_class: catch_up` via `toDayLogEntry`) even when
`QUEUE_DIGESTS=true` — queue daily fan-out only seeds the daylog; catch-up is a
separate path and must not skip observability. **Daily lag recovery stamp:**
`processOneSub` / `processAccountRollup` set `traffic_class: "catch_up"` when
lastsent lag is **>1 day** and fresh notices are sent (`isMultiDayLagRecovery`);
email copy stays normal daily (`action: match`). `toRollupDayLogEntry` preserves
the stamp. Without the stamp, desk shows false `phantom_send` for multi-day
recovery under queue mode.

Characterization: `node --test test/markseen_policy.test.mjs test/digest_catchup.test.mjs`.

## Digest email time + action awareness (render only)

Digest HTML (`subDigestHtml` / rollup) **and** the Alerts-tab Preview dig items
(`digItemHTML` / `aPreview`) share one pure model: `site/digest_item_awareness.mjs`
(worker re-export `worker/src/lib/digest_item_awareness.mjs`). Phase + open /
closing-soon / closed from **event** time; specific next step when ingested
fields support it. Desk daylog (`digest_ops`) stays **send-level** (noticeIds +
deep links + outcome labels) — it does not re-render email item HTML.
**Delivery-continuity regressions:**
`worker/test/digest_delivery_continuity.test.mjs`. Preview + ops continuity:
`test/digest_preview_awareness.test.mjs`,
`worker/test/digest_ops_awareness_continuity.test.mjs`.
Verify: `node --test worker/test/digest_item_awareness.test.mjs
worker/test/digest_delivery_continuity.test.mjs
worker/test/digest_ops_awareness_continuity.test.mjs
test/digest_preview_awareness.test.mjs worker/test/alert_temporal.test.mjs`.
Evidence: `node tools/render_digest_awareness_evidence.mjs` and
`node tools/render_preview_ops_parity_evidence.mjs`.

## Civic-time event contract

Shared event envelope + bounded kind registry for Money/Rules/Land/Meetings.
Clocks: valid, publication, observation, processing — never invent publication from
processing. ADR: `docs/adr/civic-time-event-contract.md`. Pure lib:
`worker/src/lib/civic_time.mjs` (Rules/Land/Meetings adapters; Money production adapter
`mapMoneyLifecycleToCivic` / `attachMoneyCivicEvents` on `computeLifecycle` →
`civic_events` on `/contract-lifecycle`). PASSPort RFx production spine (same path):
matched `rfx_detail` → `mapPassportRfxToCivic` emits `procurement.solicitation_opened`
(from `release_date`) and `procurement.solicitation_due` (from `due_date`); addenda kind
is registered but not emitted until a publisher date column exists on `public_rfx_data`.
Award continues as City Record notice_published / registration stages. Metrics:
`money_spine_adapter_coverage` (notices with ≥1 Money civic event / procurement
lifecycles); `rfx_spine_adapter_coverage` (matched-RFx lifecycles with ≥1 RFx production
event / matched RFx); `temporal_completeness_rate` (mean share of
event/publication/observed/processed clocks filled per civic-time event, by spine,
joined to source-contract health via `temporalCompletenessScorecard`). Verify:
`node --test worker/test/civic_time_contract.test.mjs worker/test/temporal_completeness.test.mjs worker/test/checkbook_lifecycle.test.mjs && node worker/scripts/civic-time-diff.mjs --fixtures worker/test/fixtures/civic-time --check && node worker/scripts/temporal-completeness-scorecard.mjs --fixtures worker/test/fixtures/civic-time --check`.
Digest delivery identity remains `docs/digest-time-ontology.md` (separate concern).

## Subject registry (cross-spine subject_ref)

Shared `kind:id` subject vocabulary + typed links so civic-time, lifecycle, ER source
records, claim layer, and ops action objects resolve the **same** real-world object
without silently rewriting `notice:` into `contract:`. Pure lib:
`worker/src/lib/subject_registry.mjs`. Product surfaces:
`assembleLifecycle` stamps notice↔contract; `linksFromRuleRecord` /
`linksFromMeetingRecord` stamp rules materialization (`rules:materialized:v2`) and
meeting-outcomes (`meeting-outcomes:materialized:v2`) with notice↔`rules` /
notice↔`legistar-event` only when the join matched (no speculative stamps).
Rules multi-notice stitch also emits notice↔notice `same_rulemaking` edges when
proposal/hearing/adoption City Record siblings share a high-confidence join
(`related_notices` + `rulemaking_subject_ref` on the materialization row). Metrics:
`cross_subject_link_rate` on PIN-bearing awards
(`worker/test/fixtures/subject-registry/pin_bearing_awards.json`);
`rules_meetings_subject_link_rate` on matched rules/meetings records. ADR:
`docs/adr/subject-registry.md`. Verify:
`node --test worker/test/subject_registry.test.mjs worker/test/nyc_rules.test.mjs
worker/test/rulemaking_siblings.test.mjs worker/test/legistar.test.mjs`.

## Ops contract (desk ↔ worker)

Versioned machine-readable ops schema so private desk panels stay mechanically aligned
with the public worker (digest modes, daylog actions/fields, stats metrics, admin routes
+ auth classes, KV prefixes, feature flags). No secrets; never on public `/stats`.

- Pure builder: `worker/src/lib/ops_contract.mjs` → committed fixture
  `worker/ops-contract.v1.json`
- Served: `GET /admin/ops-contract` (`ADMIN_KEY`, fail closed)
- Usage `traffic_class`: `production` | `developer` (`blob7`; public SQL keeps production
  only). Developer key is `ANALYTICS_DEV_KEY` (not `USAGE_KEY` / Haiku meter).
- Verify: `node --test worker/test/ops_contract.test.mjs`

## Digest time ontology

Digest freshness uses semantic delivery keys, not source timestamps: event time controls
actionability, publication/recorded time are provenance, and source identity + actionable state
is the idempotency key. This lets a late Rules/Legistar enrichment notify once without a
republish sending twice. Contract: `docs/digest-time-ontology.md`; characterization:
`node --test worker/test/alert_temporal.test.mjs`.

## Non-Council hearing outcomes (process spine)

Non-Council hearings reconstruct **notice_published → hearing → outcome →
minutes** as a process spine (same chain presentation as property/exam/franchise).
Pure builder: `site/non_council_hearing_spine.mjs` (re-export
`worker/src/lib/non_council_hearing_spine.mjs`). UI:
`nonCouncilHearingOutcomesHTML` on unmatched non-Council meeting-outcomes.

- **Fillable from City Record:** notice publication (`start_date`) and hearing
  (`event_date`) when present.
- **Structural class-(b):** outcome/votes and minutes — no citywide machine
  feed; never invent votes. Gap slots use
  `meeting_outcomes_non_council_not_published_html` with real HTTPS landings via
  `nonCouncilWhereHTML` / `nonCouncilBodyLinks` (agency-mapped BP when known +
  CB directory) — never text-only "where".
- **Council path unchanged:** Legistar agenda→matter→action→vote→attachment.
  Detection: `isCityCouncilNotice` on `agency_name`.
- Civic-time kinds (library-only): `meetings.non_council_notice` /
  `meetings.non_council_hearing` + `mapNonCouncilHearingSpineToCivic` (matched
  stages only). Metric: `non_council_hearing_spine_completeness_rate` (mean
  **fillable_rate** over eligible spines; outcome/minutes excluded from
  fillable).
- Verify: `node --test test/non_council_hearing_spine.test.mjs
  test/meeting_view_readability.test.mjs test/gap_taxonomy.test.mjs`.

## Alerts multi-watch rollup surface (#alerts)

Public demonstration of account-level digest rollup + preference-center path on
the Alerts tab. Delivery remains worker rollup (`worker/src/lib/rollup.mjs` +
`alerts.mjs`): one email when an account has more than one active watch, sections
per watch. The UI groups related watches by **topic / agency / geography** for
review (empty agency/geo = unscoped, never a false “city withheld” label) and
shows a fixture-backed consolidated digest mock plus the prefs cutover copy.

- Pure helpers: `site/alerts_rollup_prefs.mjs`
- Deep link: `#alerts?view=rollup` (demo id `alerts-rollup-prefs`)
- Manage watches uses session `prefsUrl` when recognized, else `/prefs`
- Verify: `node --test test/alerts_rollup_prefs.test.mjs` and existing
  `cd worker && node --test test/rollup.test.mjs test/prefs_lib.test.mjs test/prefs.test.mjs test/digest_rollup.test.mjs`

## Digest rollup + preference center

Account-level digest: when an email has **>1 active watch**, one consolidated
email per day (sections per watch); one email = one send unit. Preference
center: `GET/POST /prefs` (token `sc: "prefs"`). Edits take effect **next daily
cron (~9am ET)**. Unsub: per-watch `{k}` or all-watches `{all:1,e}`. Admin
dry-run: `GET /admin/digest-rollup?key=&email=`. Design:
[`docs/digest-rollup-prefs.md`](docs/digest-rollup-prefs.md). Tests:
`cd worker && node --test test/rollup.test.mjs test/prefs_lib.test.mjs test/prefs.test.mjs test/digest_rollup.test.mjs`.

## Magic-link session + server pins

Digest notice links carry a pins-scoped optin-token (`sc: "pins"`, ~30d) as `?s=`
on `/r/...`. Exchange sets HttpOnly `cs_session` cookie (~14d); token never
forwards to the final cityscroll.org URL. Scope is READ + pin sync +
preference-center bootstrap. Recognized `GET /session` returns the account email
and clean `/prefs` URL; cookie-authenticated `GET /prefs` mints the narrower prefs
token used by its forms. Watch mutations, unsubscribe, and confirm keep purpose
tokens and never accept the session directly.

- Worker: `session.mjs`, `pins.mjs`, pure helpers `lib/session.mjs`
- KV pin store: `pins:<opaqueActorId(email)>` in SUBS (alongside subscriptions)
- Client: `invStore`/`invSave` still localStorage; recognized sessions merge
  (union, dedupe by type+id) then read/write `/pins` with `credentials:include`
- Banner: `#sessionBanner` ("Not you?" → `/session/logout`)
- Characterization: `node --test worker/test/session_pins.test.mjs test/session_pins_client.test.mjs`

## Microsoft Clarity (optional heatmaps)

Dormant until a project id is set. Loader: `site/clarity.js` (all public pages).
Config: `window.CROL_CLARITY_PROJECT_ID`, meta `crol-clarity-project-id`, or
`CONFIGURED_PROJECT_ID` in that file — leave empty to keep off. Skips on DNT/GPC;
masks form inputs; operator must set dashboard Masking mode to **Strict**.
Characterization: `node --test test/clarity.test.mjs`. Privacy copy: About → Privacy.

## Public feedback

Team inbox is **feedback@cityscroll.org** (footer mailto on `site/index.html` /
`site/about.html`, About form one-liner, worker `FEEDBACK_TO` / `DEFAULT_TO`).
`/feedback` is rate-limited + validated; **no Turnstile** on form or handler.
Fails closed without `RESEND_API_KEY` + `FEEDBACK` KV only. Characterization:
`node --test worker/test/feedback.test.mjs test/homepage_cta.test.mjs`.

## Versioned action log

Successful pin/watch interventions and false-split desk dispositions append privacy-safe rows to
D1 `action_log` through `worker/src/lib/action_log.mjs`; no actor, email, IP, cookie, account, or
session identifier is accepted. Desk evidence keeps operator-facing actor/note fields separately;
the product log only records pair id + enumerated decision. Same/different review actions export
to gold-ready candidates via `tools/export_review_actions_to_gold.mjs` (never overwrites
`gold_vN.jsonl`). Contract and characterization: `docs/action-log.md`,
`node --test worker/test/action_log.test.mjs worker/test/false_split_evidence.test.mjs
test/review_action_export.test.mjs`.

## Entity resolution (foundation)

Link-not-merge taxonomy ADR: [`docs/adr/entity-resolution-taxonomy.md`](docs/adr/entity-resolution-taxonomy.md).
Full five-table sketch: [`docs/entity-resolution/schema-sketch.sql`](docs/entity-resolution/schema-sketch.sql).
No LLM matching as primary matcher. No public consumer reads link tables yet.

**source_records dual-write (er-02):** migration `worker/migrations/0008_source_records.sql`;
flags `CITY_RECORD_SOURCE_RECORD_DUAL_WRITE=true` and `ENTITY_LINK_DUAL_WRITE=true` in the
production Worker vars enable the fail-soft shadow path on City Record ingest; beta explicitly
sets both false. Integration characterization: `node --test worker/test/er_ingest_integration.test.mjs`.
Verify: `node --test worker/test/source_record_dual_write.test.mjs`.

**Source-observation coverage (er-22 + Checkbook + Legistar):** machine-checked importer
inventory and **live** row-count honesty live in `entity_resolution/source_coverage.json`.
Adapter readiness (flag + fixture + schema) is tracked separately from production coverage.
`dual_write.after` is one of `complete` / `partial` / `stale` / `empty-declared-live` / `gap`
and **must** match measured `live_observation.row_count` — a stream with 0 rows must not report
`complete`. Pure gate: `entity_resolution/evaluation/source_coverage_honesty.mjs` (emits
coverage-dimension bug cards for empty-declared-live). PASSPort contracts/RFx use
`PASSPORT_SOURCE_RECORD_DUAL_WRITE`; Checkbook Contracts and Spending request-time XML rows share
`CHECKBOOK_SOURCE_RECORD_DUAL_WRITE` (fail-soft; Prime/Sub Vendor slices and payment documents
keep distinct `source_system_id`s via `worker/src/lib/checkbook_source_records.mjs`). Legistar
meeting materialization dual-writes Events/EventItems/Votes/Attachments under
`LEGISTAR_SOURCE_RECORD_DUAL_WRITE` (`worker/src/lib/legistar_source_records.mjs`). Public reads
do not consume the observations. Measured live (2026-08-02): Checkbook contracts+spending
`complete`; PASSPort contracts+RFx `complete` (ingest dual-write); Legistar events/items/votes
`complete` (meeting-outcomes dual-write); Legistar attachments `empty-declared-live` (nested
Attachments bag empty — Agenda/Minutes live on Events); City Record `partial`; NYCHA, ABO,
doing-business, NYCIDA `gap`. Named metric `source_coverage` = live complete/total (**7/13**).
Verify:
`node tools/check_er_source_coverage.mjs --matrix entity_resolution/source_coverage.json &&
node --test test/source_coverage_honesty.test.mjs worker/test/er_source_coverage.test.mjs
worker/test/checkbook_source_records.test.mjs worker/test/legistar_source_records.test.mjs`.

**entity_link + resolution_run (er-07):** migration `worker/migrations/0009_entity_link.sql`
(+ `canonical_entity` for link targets). Opt-in shadow writer only for exact-stem
`auto_link` cases (`method=vendor_stem_v1`): pure
`worker/src/lib/entity_link.mjs`; production writes are shadow-only and public reads do not
consume these tables.
Verify: `node --test worker/test/entity_link_schema.test.mjs`.

**Package boundary (er-08):** modular monolith under `entity_resolution/`
(`normalizers`, `candidate_generation`, `features`, `matchers`, `policies`,
`evaluation`, `review`) — in-process only, **no public HTTP ER routes**.
Extract criteria + non-goals: `entity_resolution/README.md`. Verify:
`node --test worker/test/entity_resolution_package.test.mjs`.

**Normalize lib (er-03):** `entity_resolution/normalizers/` owns `vendorStem` (+
agency `canonicalAgency` re-export / `sameAgency`). `worker/src/lib/normalize.mjs`
and `compile.mjs` re-export for call-site stability. Equal/distinct pin table:
`worker/test/fixtures/normalize_pairs.json`. Verify:
`node --test worker/test/vendor_stem.test.mjs worker/test/normalize_fixtures.test.mjs`.

**Agency rename residual (gold false_split):** alias dual names in
`worker/src/lib/agencies.mjs` `GROUPS` so ER stem + identity enrichment share one
`canonical_id` (DoITT→OTI, county DA↔borough DA office, Business→SBS). Keep site
ids stable so `agency_crosswalk.json` keys still match. Borough DAs stay distinct.
Verify: `node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v0.jsonl --blocker token_v0`
→ `false_split=0` `false_merge=0` `recall=1`. Captures:
`python3 tools/capture_agency_false_splits.py`.

Gold set + metrics harness (eval only): `entity_resolution/eval/` —
`gold_v0.jsonl` (versioned; never silent-mutate labels/membership) and
`run_metrics.mjs` (also re-exported from `entity_resolution/evaluation/`). Verify:
`node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v0.jsonl --dry-run`
(prints precision/recall/candidate_recall/unresolved_rate/false_merge/false_split;
nulls OK until matchers).

**Candidate generation v0 (er-05):** offline token/stem blocker
`entity_resolution/eval/blockers/token_v0.mjs` — reused by the package candidate-generation
surface; it remains matcher-neutral and does not merge source rows.
Verify:
`node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v0.jsonl --blocker token_v0`
(`candidate_recall` ∈ [0,1]; blocked-in/out true matches printed).
Characterization: `node --test test/entity_resolution_blocker.test.mjs`.
Details: `entity_resolution/eval/README.md`.

**Silver authority harness (er-11):** `entity_resolution/eval/run_authority.mjs`
derives silver labels from the newest immutable `source_records` snapshots.
Shared PIN/EPIN or contract ids measure `authority_recall`; name-similar rows with
disjoint comparable ids measure `authority_conflict_auto_link_rate`. The committed
fixture is characterization data, not a production measurement. Verify:
`node --test test/entity_resolution_authority.test.mjs`.

**Features + matcher (er-09, extended by er-19):** `entity_resolution/features/` extracts
deterministic family-aware stem/token/authority-key/length signals;
`entity_resolution/matchers/` emits
`same` / `different` / `unresolved` without LLM scoring. PIN and EPIN share one candidate
identifier family; blocked-out true matches remain visible in the metrics report. Verify:
`node --test worker/test/entity_resolution_matcher.test.mjs` and
`node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v0.jsonl --blocker token_v0`.

**Scoped authority keys (er-19):** PIN/EPIN matcher evidence is a complete
`(scheme, issuing authority, value, scope)` tuple from
`entity_resolution/authority_keys/`, never raw-value equality across schemes or scopes.
Parser fixtures: `entity_resolution/eval/fixtures/authority_key_pin_epin_v1.json`.
Verify: `node --test test/authority_key_registry.test.mjs test/entity_resolution_authority.test.mjs`.

**Live false-split desk (er-10):** keyed GET `/admin/possibly-same` reads recent
`source_records`, blocks them with `token_v0`, and excludes pairs sharing a
`canonical_entity_id`; it never writes review or merge state. Pure/read path:
`worker/src/lib/possibly_same.mjs`. Characterization:
`node --test worker/test/possibly_same_admin.test.mjs`.

**False-split evidence tray (er-14):** the same authenticated route renders source-linked
records and accepts `same` / `different` / `defer` dispositions. Migration
`worker/migrations/0010_false_split_disposition.sql` makes those events append-only;
they never update `entity_link`. Characterization:
`node --test worker/test/false_split_evidence.test.mjs`.

**Assertion evidence rail (er-18):** conflicting amount/date values in the tray retain
their exact publisher field and value as source assertions; normalization and conflict
detection are separately labeled CityScroll interpretations and never select a winner.
Pure model: `entity_resolution/review/assertion_evidence.mjs`. Characterization:
`node --test test/entity_resolution_assertion_evidence.test.mjs`.

**Evidence claim layer (public):** source assertion ≠ CityScroll interpretation ≠
derived conclusion. Charter: `docs/adr/evidence-assertion-layer.md`. Shared builders:
`worker/src/lib/claim_layer.mjs`. First product surface: OCP award side-car disagreements
on notice lifecycle (`lifecycleOcpAwardHTML` + `corroborateAward` claim_layer rows).
Dossier display name is a `derived_conclusion`, not a publisher field. Metric:
`public_claim_labeled_disagree_rate` (OCP-joined awards with field disagreements that
carry complete claim_layer labels / all such disagreements) —
`measurePublicClaimLabeledDisagreeRate`; field cases
`worker/test/fixtures/claim-layer/ocp_joined_awards.json`. Verify:
`node --test worker/test/claim_layer.test.mjs worker/test/ocp_awards.test.mjs
test/lifecycle_render.test.mjs`. Captures:
`python3 tools/capture_assertion_claim_layer.py`.

**Private evidence workspace (er-17):** the authenticated
`/admin/possibly-same?pair=` view expands a selected pair into its connected candidate
component, grouped into independent publisher rails. It composes the assertion rail and
append-only disposition history without selecting canonical values or changing links.
Pure model: `entity_resolution/review/investigation_workspace.mjs`. Characterization and
capture: `node --test worker/test/private_evidence_workspace.test.mjs`,
`python3 tools/capture_private_evidence_workspace.py`.

**Public entity dossier (er-15) — foundation, not yet a live product surface:**
`GET /entity-dossier?id=` reads canonical entities and linked immutable source
snapshots when a published `canonical_entity` id exists. **Production measured
2026-08-01:** name-shaped and contract subject ids used on demos (e.g.
`vendor:name:…`, `contract:CT…`) return **404** with
`public_status: "not_yet_public"` — do **not** market dossier as live. Subject
registry on `/contract-lifecycle` (`subject_refs` / `subject_links`) **is**
healthy and remains the live cross-spine surface. When a dossier does resolve:
assertions keep publisher provenance; disagreements keep every value; missing
fields mean only “not observed in linked records”; each linked record surfaces
`link_confidence` (`strong` / `tentative` / `not_scored`). Metric:
`public_entity_link_confidence_rate`. Pure model:
`entity_resolution/publication/dossier.mjs` + `link_confidence.mjs`; Worker:
`worker/src/entity_dossier.mjs`. Verify:
`node --test worker/test/entity_dossier.test.mjs worker/test/entity_resolution_publication.test.mjs`.

**Public relationship graph (er-16) — same gate as dossier:**
`GET /entity-relationships?id=` projects linked procurement observations when a
canonical entity exists; otherwise **404** + `public_status: "not_yet_public"`.
Do not market as live for subject-registry ids. When resolved: named edge types,
publisher provenance, public-safe confidence; depth/fan-out caps. Pure model:
`entity_resolution/publication/relationship_graph.mjs`; Worker:
`worker/src/public_relationship_graph.mjs`. Verify:
`node --test worker/test/public_relationship_graph.test.mjs`; captures:
`python3 tools/capture_public_relationship_graph.py`.

**Clerical audit (er-12):** `tools/export_er_clerical_audit.mjs` emits a
false-split-priority sample (`near_miss` plus `auto_link` control), CSV label
sheet, and receipt under `entity_resolution/eval/audits/<date>/`. Live mode is
read-only and records a `notices_replay` fallback when shadow tables are empty.
Gold promotion only creates a new `gold_vN.jsonl`; it never overwrites a version.
Characterization: `node --test test/entity_resolution_clerical_audit.test.mjs`.

**Entity-centric audit (er-20):** `tools/export_entity_audit_sample.mjs` samples
whole resolved entities from the er-13 component report across false-split,
large-cluster, singleton, low-confidence, authority-key, and control strata.
The label sheet carries first-order inclusion probabilities; weighted rates
fail closed as `insufficient` for undersampled strata. Verify:
`node --test worker/test/entity_audit_sampling.test.mjs`.

**Shadow monitoring (er-23):** `tools/run_er_shadow_monitor.mjs` reads D1 with
bounded `SELECT` queries or the committed fixture and emits provenance-stamped
rates/distributions under `entity_resolution/eval/monitoring/`. Missing
populations are `insufficient`; receipt comparisons refuse changed policy/window
versions. Verify: `node --test test/entity_resolution_shadow_monitor.test.mjs &&
node tools/run_er_shadow_monitor.mjs --fixture`.

## Property location extraction

Site geography for Property Disposition: `site/property_location.mjs`
(`propertyLocationFromRow`). Worker `/property-locations` imports the same
module — keep edge and client in lockstep. Scope text is title +
START_MARKER body chunks only; lease-surrender / voluntary-hearing language
is covered. When markers yield no local signal, a bounded body fallback
accepts **exactly one borough + Block/Lot** (never multi-borough clerk lists
or street addresses from hearing dial-in / office boilerplate). Exemplar
false-negative: notice `20241112003` (Manhattan Block 644 Lot 1). Golden +
unit: `node --test test/contract/property_location_golden.test.mjs
test/contract/property_location.test.mjs`. Feed cards deep-link
`#notice/{id}` (title + Open notice), same pattern as Money dig items.

**Notice-detail BBL parcel fallback:** `fillAddressLinks` geocodes
`street_address_1` first; when that is missing or unresolvable on Property
Disposition, it uses `primaryPropertyBbl` + `parcelLinksFromBbl` from the same
extractor so ZoLa / ACRIS / Who Owns What still open from body tax-lot text.
Provenance distinguishes GeoSearch vs notice tax-lot (i18n keys
`parcel_via_*`). Demo: `property-bbl-fallback` → `#notice/20241112003`.

## Property disposition process spine

Multi-notice lifecycle for one parcel/asset: **hearing → auction_or_rfp →
award_or_conveyance**. Pure builder: `worker/src/lib/property_disposition_spine.mjs`
(`groupDispositionSpines` / `buildPropertyDispositionSpine`). Join keys are
strict **BBL** or **borough + block/lot** (never bare block alone); same
`agency_name` required. Materialized on `/property-locations` as
`disposition_spines` + per-row `disposition_stage` / `disposition_subject_ref`
via `attachDispositionSpines` in `buildPropertyView`. Notice detail mounts
`propertyDispositionSpineHTML` / `loadPropertyDispositionSpine` (`#ndisposition`)
with phase presentation from `site/property_phase_spine.mjs` (aggregate
verbatim-repeated titles + dedupe source URLs per phase).

**Property domain explorer (list):** pure `site/property_explorer.mjs` groups
multi-notice disposition subjects into one list entry, filters by process stage
(`#processrail`), and stamps next-action keys + BBL entity links (ZoLa when a
10-digit BBL exists; honest “no tax-lot BBL” when not). Temporal
`propStage` / `PROP_STAGES` remain a secondary When rail — do not re-label them
as process stages. Empty spine stages use class-(a) `not_yet_ingested` naming
City Record Online; never invent auction/award events. Metric:
`property_disposition_spine_completeness_rate`. Verify:
`node --test test/property_disposition_spine.test.mjs test/property_phase_spine.test.mjs
test/property_explorer.test.mjs worker/test/property.test.mjs`.


## Franchise / concession review spine (FCRC)

Multi-notice lifecycle for one franchise or concession matter: **solicitation →
public_hearing → committee_meeting → award**. Pure builder:
`worker/src/lib/franchise_concession_spine.mjs` (`groupFranchiseConcessionSpines` /
`buildFranchiseConcessionSpine`). Join keys are strict **counterparty vendorStem**
(intent-to-award / between-City / whereby / sold-to firm names), **annual plan year**
(`plan:fyYYYY`), **concession id** / Parks solicitation #, or **FCRC rules** subject —
never bare monthly calendar keys. SODA universe is FCRC agency + title patterns
(joint public hearing / franchise agreement); bare MOCS is excluded so LL63 notices
do not crowd the 300-row window. Client eligibility also drops Board Meetings
rosters that merely list FCRC. Materialized on `GET /franchise-concessions` as
`franchise_spines` + per-row stage/subject via `attachFranchiseConcessionSpines`
in `worker/src/franchise_concession.mjs`. Notice detail mounts
`franchiseConcessionSpineHTML` / `loadFranchiseConcessionSpine` (`#nfranchise`).

**EI cross-link:** `observationFromFranchise` → domain `franchise` with
`named_franchisee` vendor edges when a firm party resolves (OneChronos, Flushing GC
field cases). Calendar-only FCRC meetings without parties stay out of EI.

**Wrong universe:** City Council "Subcommittee on Zoning and Franchises" is land use —
not FCRC. Empty stages use class-(a) `not_yet_ingested` naming City Record Online;
never re-label as class-(b) "city does not publish". Metric:
`franchise_concession_spine_completeness_rate`. Civic-time kinds:
`franchise.solicitation` / `public_hearing` / `committee_meeting` / `award`. Verify:
`node --test test/franchise_concession_spine.test.mjs test/cross_domain_object_links.test.mjs`.

## Structured notice-body facts

Pure parser: `worker/src/lib/notice_facts.mjs`. It extracts only explicitly labeled
PIN/EPIN values, submission/testimony deadlines, and applicant/owner parties, retaining
the source excerpt for every fact. Ingest stores the full result in `structured_facts`;
only a unique PIN/EPIN or unique submission deadline may fill an absent source column,
so existing alert and contract-spine paths can consume it. Publisher columns always win.
Characterization and real-notice metrics: `node --test test/notice_facts.test.mjs
worker/test/ingest_map.test.mjs`.

## Rules event spine

NYC Rules lifecycle dates remain distinct events in `worker/src/lib/rules.mjs`:
proposal publication, public hearing, comment close, adoption, and effective date.
Date-only fields are New York calendar dates, not inferred clock times; comment close
events carry alert metadata. Digests cite comment-close by `valid_at` from the spine
(`worker/src/lib/alert_temporal.mjs` → `commentCloseValidAt`), not publication or
processing time. The `/rules` read model is `rules:materialized:v2`, and Agency Rules
notice detail owns the public spine (same `.chain` pattern as the Money contract
timeline). Public demo: `#notice/20260714029` (`rules-lifecycle-spine` in
`site/demo/demo-links.json`).

**Multi-notice rulemaking stitch:** one rulemaking often spans multiple
City Record rows (proposal / hearing / adoption). `attachRulemakingSiblings` in
`worker/src/lib/rules.mjs` groups high-confidence siblings (shared NYC Rules id,
shared *specific* RCNY section ref **plus** title-core floor, or agency +
title-core overlap ≥ 0.55 within a 540-day window) and stamps
`rulemaking_subject_ref`, `related_notices[]`, and `rulemaking_join` on
`buildRuleView` rows (served on `/rules` + counts `multi_notice_rulemakings`).
Ambiguous pairs stay separate subjects. Subject registry adds `same_rulemaking`
notice↔notice links — never merges `notice:` identities.

**Generic-ref ban (load-bearing):** `extractRulemakingRefTokens` drops bare
`title N`, bare title-level `N RCNY`, non-numeric "sections", and chapter-alone.
`shared_reference` always requires the title-core floor — the same 34 RCNY §4-01
can be amended by unrelated DOT matters (FHV parking vs bicycle racks). Field
case: demo `#notice/20260714029` must not list bicycle racks / truck routes /
FY agenda as siblings. False-merge proxy
`measureRulemakingSiblingFalseMerge` scores **all** multi-notice methods
(including `shared_reference`).

**City Record lookback (load-bearing for multi-notice):** materialization pulls
Agency Rules with `CITY_RECORD_RULES_LOOKBACK_DAYS = 540` (aligned with the sibling
window) and a hard `CITY_RECORD_RULES_LIMIT = 500` (single SODA page — ~355 rows at
540d). A 14-day window left `multi_notice_rulemakings=0` because siblings almost
never co-appeared. `RULES_VIEW_VERSION` bumps force young KV rebuild after the
widen (v5 = generic-ref false-merge hotfix). Title-core noise strips DCWP-style
`NOH`/`NOA` / "Rules Relating to" so widening does not chain-merge unrelated
house-style titles; confidence thresholds stay strict (false merge worse than
split). Join measurement receipt:
`site/data/rules_sources/verification_receipts/rulemaking_sibling_stitch_2026-08-02.json`.

**Public rules lens:** `stitchRulemakingRecord` /
`buildRulesPhaseView` in `site/rules_phase_spine.mjs` (via `loadRuleLifecycle`)
merge confident siblings into one phase-group lifecycle and list sibling
notices — only when `rulemaking_join` is high-confidence multi-notice.
Verify:
`node --test worker/test/rulemaking_siblings.test.mjs worker/test/nyc_rules.test.mjs
worker/test/subject_registry.test.mjs test/rules_phase_spine.test.mjs`.

**Rules domain explorer (list):** pure `site/rules_explorer.mjs` groups
high-confidence multi-notice rulemakings into one list entry, filters by
process phase (`#rulesprocessrail`: proposal → public process → adoption →
effective), and stamps next-action keys + agency entity links (`#agency/…`)
plus comment/hearing destinations when NYC Rules fields exist. Flat SODA wall
is not the product surface — same list-ontology shape as
`site/property_explorer.mjs`. Detail timeline stays `rules_phase_spine.mjs`.
Verify: `node --test test/rules_explorer.test.mjs test/rules_phase_spine.test.mjs`.
Captures: `python3 tools/capture_rules_ops_ontology.py`.

**RSS egress (hard):** `worker/src/rules.mjs` must send `RULES_RSS_HEADERS`
(`User-Agent` + RSS Accept) on `https://rules.cityofnewyork.us/feed/`. An empty or
missing User-Agent gets Cloudflare HTTP 403 challenge HTML ("Just a moment…"), so
Workers subrequests with no default UA produce zero enrichment rows. Challenge HTML
is treated as a fetch failure (`looksLikeBotChallenge`), not an empty feed.
**Stale-enrichment retry:** `handleRules` rebuilds when
`source.enrichment.status === "stale"` even if `generated_at` is younger than the
36h age gate (`rulesViewNeedsRefresh`) — otherwise a failed materialization sticks
until max-age after egress is fixed. Verify:
`node --test worker/test/nyc_rules.test.mjs worker/test/rules_event_spine.test.mjs
test/rules_deadline_render.test.mjs worker/test/alert_temporal.test.mjs` and
`python3 test/standards/demo_links.py`. Captures:
`python3 tools/capture_rule_event_spine.py` (before/after at 390 and 1440).

## Multi-dimension improvement flywheel

Standing MAPE loops under `ontology/` emit a ranked, deduplicated card queue (not a
one-shot backlog). Dimensions: data-integrity, readability, ontology-enrichment,
coverage, cross-source-consistency. Entrypoint:
`node tools/flywheel-run.mjs --fixture --emit <dir>`. Idempotent ledger:
`ontology/queue/ledger.json`. Consumer contract + schedule:
[`docs/multi-flywheel.md`](docs/multi-flywheel.md). Verify:
`./tools/verify_multi_flywheel.sh`. Hourly CI artifact: `multi-flywheel-queue`
(`.github/workflows/multi-flywheel.yml`). Recurring classes append to
`ontology/engineering-lessons.md`. Do not hand-author parallel metric-driven
roadmap cards; re-run the flywheel after merges.

**Actionability sample (honesty):** `actionability_rate_sample` is the **deep**
destination-class rate over a committed handoff sample — not
`ACTION_TYPES.length` (that always yielded rate=1 and could not police
search-page / landing / unavailable gaps). Classes: `deep` / `scoped_search` /
`search_page` / `landing` / `unavailable` / `local` / `unknown`. Pure lib:
`ontology/actionability_sample.mjs`; fixture:
`ontology/fixtures/dimensions/actionability_sample.json` (primary kinetic
`compileActionRail` rows + static lifecycle handoff URLs). Named metric rate =
deep / sample_size; deep rate < 0.5 emits `actionability-low`. Verify:
`node --test test/actionability_sample.test.mjs` and
`./tools/verify_ontology_flywheel.sh`.

**data-integrity core:** population **not-published-rate** credibility audit —
for every “city does not publish X” register, sample recent + historical entries;
~100% not-published with public-source evidence → broken-join / never-ingested /
mislabeled red-flag card (not a polite class-(b) mask). Pure helpers:
`ontology/dimensions/not_published_rate.mjs`; samples:
`ontology/fixtures/dimensions/not_published_claim_samples.json`.

## Prediction calibration scorecard

Every public per-matter prediction domain must clear the assertion-native backtest
in `worker/src/lib/prediction_calibration.mjs`; below the ship bar, expose only the
cohort statistic. Verify the calibrated pass, deliberate miscalibrated failure,
and byte-stable artifact with:
`node worker/scripts/prediction-calibration-scorecard.mjs --fixtures worker/test/fixtures/predictions --check`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
