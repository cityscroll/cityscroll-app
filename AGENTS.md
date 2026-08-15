# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

- Committee traversal exposes `public_reverse_edges` from the same accepted
  `member_of` observation in `site/committee_graph.mjs`; browse renders the
  exact-ID `has member` pivot, while held/empty/unknown graph states stay
  non-linking. Keep committee target routes closed until a verified route is
  materialized. Focused proof: `test/committee_graph.test.mjs`,
  `test/committee_memberships.test.mjs`, and `test/official_connections_scope.test.mjs`.

- Community-board `hosts_meeting` edges live beside the exact source join in
  `site/community_board_source_join.mjs` (re-exported by
  `site/community_board_institution_edges.mjs`). They target
  `meeting:{source}:{key}` only after exact board/date/publisher evidence plus a
  retained receipt and URL; held edges retain typed identity but never an
  `href`. Board, Browse, and meeting-document pivots consume that same edge
  payload. Focused proof: `test/community_board_institution_edges.test.mjs`.

- Browse document facets are edge-rendered first and then hydrated by the SPA. Agency
  `entity_refs_all` links must be passed into the live lens agency control before feed
  loading; see `site/agency_scope_route.mjs` and `test/functional/28_agency_scope_links.py`.
- **Staffing agency scope:** hydrate `staffingFilters.agency` from the typed facet (same as
  Money), identity-match City Record spellings (`DEPT OF PARKS & RECREATION` ↔
  `agency:id:parks-and-recreation`), and re-query SODA when scoped — the citywide 80-row
  hires snapshot is not agency-complete. Under an agency scope, lead with appointments;
  exams only when publisher certification edges join them (`site/staffing_agency_scope.mjs`).
  Detector: `test/offered_facet_actually_filters.test.mjs` — facet-exhaustive inventory
  driven from Browse configs + borough/exam/disposition/procurement/constellation
  scope modules (not agency-only). Asserts non-empty strict subset + claim match for
  every offered value present in fixtures; multi-value place bags (meetings
  `affected_area.boroughs`, property `property_location.boroughs`, money `place`)
  are first-class. Property/browse borough filtering reads structured place bags
  in `site/browse_view.mjs` (`rowBoroughs` / `rowMatchesBorough`).
- Place-scoped Property routes use `site/property_scope_fallback.mjs`: if the scoped current
  view is empty but the same scope has closed records, the route opens the archive view so a
  valid place link does not present a misleading empty result. Coverage is in
  `test/property_scope_fallback.test.mjs` (fixture: `test/fixtures/property_scope/`).

- **Agency-head entities:** `entity_resolution/leaders/index.mjs` materializes publisher-backed
  `person-leader` entities from `worker/src/data/agency_crosswalk.json`; `/agency` exposes the
  descriptor and the agency profile renders a strong, agency-scoped link. Use
  `entity_resolution/referents/index.mjs` for named heads, agency-scoped role mentions, and
  exact unique opaque aliases only. Unscoped or ambiguous referents remain plain text.
- **Cross-spine edge routing:** `entity_resolution/cross_domain/edge_policy.mjs` is the shared
  four-tier router (`deterministic`, `public_inferred`, `evidence_only`, `no_edge`). Keep
  uncertain candidates in `shadow_edges` only; verify the frozen relation gates with
  `node tools/cross_spine_eval.mjs --check-policy` and cover public omission in
  `worker/test/public_relationship_graph.test.mjs`.
- **Notice mandate backlinks:** public-only reverse index of mandate → notice edges for
  `/notices/<id>`. SPA-safe renderer `site/notice_mandate_backlinks.mjs` (no bridge/ER
  imports); build-time index `tools/lib/notice_mandate_backlinks_index.mjs` →
  `site/data/notice_mandate_backlinks_lookup.json` via
  `node tools/build_notice_mandate_backlinks.mjs`. Collectors include contracts, meetings,
  land, rules **and report filing receipts**. Edge stamps in `renderEdgeNotice`; SPA
  hydrates through `fillContext` in `site/app/notice-context.mjs` and skips when the edge
  card is already present. Public rows may carry a bare `mandate_id` (product filter key)
  so the card can offer “Watch this mandate” via `mandateFollowHref` — never store graph
  `subject_ref` / `mandate:` prefixes on the public artifact. Empty-safe: no absence copy,
  no profile-blocking fetch on miss. Verify: `node --test test/notice_mandate_backlinks.test.mjs`
  and `test/functional/24_notice_document_features.py`.
- **Land-use procedure nodes:** the closed `land_use_procedure_v1` vocabulary lives in
  `worker/src/lib/subject_registry.mjs`. `site/mandate_land_use_bridge.mjs` composes
  mandate → procedure ← project only when both evaluated edges are public; the direct
  `mandate_land_use` identity-and-phase gate remains separate and must not be weakened.
- **Community-board meeting labels:** `site/non_council_outcome_panel.mjs` promotes a notice
  to an official board label only from the receipt-backed
  `cityscroll.community_board_source_join.v1` contract (`exact_board_date_publisher_identifier`);
  the older exact body/date/matter gate remains separate for decision details. Unjoined notices
  stay on their City Record/unknown surface.
- **Community-board meeting index:** `site/data/community_board_meeting_index.json` is the
  bounded source-native event read model, refreshed by
  `node tools/build_community_board_meeting_index.mjs`. It currently contains only explicit
  Schema.org Event records (55 events across 9 of 59 boards); every row carries a source receipt
  and an unjoined `cityscroll.community_board_source_join.v1` result. Static Browse builds merge
  the rows in `tools/build_primary_documents.mjs`; the Meetings client appends the same artifact
  in `site/app/feed-actions.mjs`. Expand coverage only with an adapter that preserves explicit
  publisher identity/date evidence. Minutes are a separate typed source role from meetings;
  Manhattan CB6's image-linked Airtable archive is recorded as `airtable_v1` and browser-required,
  so the source link is public while records remain un-ingested until an explicit fetch is available.
- **Shared meeting object:** `site/meeting_object_contract.mjs` is the narrow waist for City
  Record and community-board meeting producers. IDs are source-qualified (`meeting:<system>:<key>`)
  and preserve publisher keys; `/meetings/{meeting_id}` is canonical while City Record notice
  URLs remain compatibility links. Keep title/date-only identity and board-name-as-agency
  substitutions out of new meeting rows. Focused proof: `test/meeting_object_contract.test.mjs`.
- **Shared meeting read model:** `site/shared_meeting_read_model.mjs` combines the two
  source-qualified producers with one freshness envelope. `tools/build_primary_documents.mjs`
  materializes `site/data/shared_meeting_read_model.json`; Pages edge resolves
  `/meetings/<canonical-id>` by exact ID and renders the matched row from that safe data path.
  Do not restore per-ID static files: encoded community-board URLs contain reserved path
  characters that static hosting normalizes before filesystem lookup. Worker `/hearings` consumes
  the same bounded board snapshot, while the SPA falls back to the shared artifact rather than
  appending a second board fetch. Verify with
  `test/shared_meeting_read_model.test.mjs` and the focused meeting contract tests.
- **City Record meeting notice materialization:** `site/data/meeting_notice_materialization.json`
  is the build-time rich notice input for current dated meetings. Its explicit predicate lives in
  `site/city_record_meeting.mjs`, and `tools/build_meeting_notice_materialization.mjs` refreshes it
  from the City Record snapshot plus validated RequestDetail source links. The meeting route must
  resolve exact IDs from the shared artifact only; missing IDs remain honest 404s.

## PR and CI preflight

- Plain-language accessibility copy uses `test/standards/no_disclaimer_slop.py`, which scans
  rendered HTML, i18n source, page-template strings, and generated HTML. It is warn-first;
  set `NO_DISCLAIMER_SLOP_MODE=block` locally or the repository variable of the same name in
  CI after the curated pattern set is calibrated. Reviewed exceptions use the adjacent
  `no_disclaimer_slop_allowlist.txt` or a local `no-disclaimer-slop: ignore` comment.
- Run `make prepush` (or `./tools/preflight-required-checks.sh`) before creating or
  handing back a PR URL and before opening a pull request. Install the versioned
  pre-push hook once per clone with `make install-hooks` (`core.hooksPath=tools/git-hooks`);
  the hook rejects pushes that fail the fast preflight and runs `--full` when the
  push range touches `site/**`. Bypass only with `git push --no-verify` (CI still must pass).
- Full browser preflight starts `tools/local_site_server.py` on an OS-assigned port
  (`CROL_TEST_PORT=0` by default) and exports `CROL_BASE`. Set `CROL_TEST_PORT` only
  for local debugging; checks must not reclaim a shared fixed port. CI browser jobs use
  the same route-aware server: a plain static server cannot resolve clean document routes
  after the finite legacy-fragment forwarding shim runs.
- Module-graph fingerprint: after intentional `site/app/` edits, validate with
  `node tools/site_module_architecture.mjs --check` (or `make module-graph-digest`).
  The digest is derived at check time rather than committed; one-time token_reduction /
  hard-coded after_bytes migration assertions were retired.
- Test-clock auditor (`node tools/audit-test-clocks.mjs`) runs in local preflight **and**
  the CI unit job. PR gates must not set `CROL_BASE` to production hosts
  (`test/ci_no_prod_origin_gates.test.mjs`); scheduled cutover-regression owns live prod.
- After a gate-fixing merge to `main`, `.github/workflows/rerun-stale-pr-checks.yml`
  re-queues open PRs whose failing CI run predates that merge.
- Independent scheduled correctness monitors use `tools/external_schedule_runner.mjs`
  and the idempotent local outbox in `tools/external_schedule_outbox.mjs`; the manifest
  and ownership audit are `tools/external_schedule_jobs.json` and
  `node tools/audit_scheduler_ownership.mjs --check`. The targeted Actions files are
  manual migration markers only; do not restore their schedules or issue loops.
- Elder merge-slot policy (oldest ready PR reservation) is `tools/elder_merge_slot.mjs` +
  `elder_slot` in `tools/merge_queue_policy.json`. The one-auto-merge seat cap itself
  lives outside this repo and should call that policy before seating a younger PR.

## Shared node-page layout (static documents)

Standalone exam / parcel / pack / digest / agency documents share one layout
grammar: `site/civic_document_chrome.mjs` (`renderNodeBack` / `renderNodeActions`
/ `renderNodeFooter` / `renderNodeSection` / `renderNodeProvenance`) + `node-*`
rules in `site/civic-documents.css`. Exam keeps historical `exam-*` class names;
composed objects keep `civic-object-*`; both inherit the shared rules. Rebuild:
`node tools/build_exam_documents.mjs`,
`node tools/build_composed_object_documents.mjs`,
`node tools/build_agency_constellation_documents.mjs`,
`node tools/build_agency_documents.mjs`.
**Agency constellation HTML** (`site/agencies/<id>/index.html`) is a **build/deploy
artifact** — gitignored; never commit the regenerated pages in capability PRs.
Production emits them through `tools/build_cloudflare_pages.mjs`. Commit only the
lookup (`site/data/agency_constellation_lookup.json`) and the directory index
(`site/agencies/index.html`). Parcel sections are **civic-process ordered**
(`PARCEL_PROCESS_SECTION_ORDER` in `site/parcel_scope.mjs`: property disposition
→ land-use process → tax-lien status → related actions). Labels via
`parcelSectionLabel` in `site/composed_object_documents.mjs` (do not inline a
partial ternary — `ll48` must not fall through to "Land-use process"). Source
names stay off section organizers; official records use trailing `↗` via
`officialSourceLink` / `parcelItemOfficialSource` only.
Evidence captures: `python3 tools/capture_node_page_design.py --label after`.

**Reader surface (same shape as `sub_outreach.mjs` / property commercial sale-gate):**
omit empty sections entirely via `renderNodeSection` (no “not yet shown” /
“no data” absence announcements); never print pipeline source keys or
`subject_ref` text (machine identity stays on `data-subject-ref` only); keep
plain-English source attribution and world-fact limits (e.g. individual scores
are not public). Detector: `detectNodePageCruft` in `civic_document_chrome.mjs`.

## Main site module boundaries

- **Typed edge summaries:** `site/edge_summary.mjs` is the shared normalization and rail renderer
  for Browse intersections, agency constellation categories, vendor footprints, and bounded
  mandate previews. Producers own read-model counts and scoped hrefs; keep `matched`, `empty`,
  and `unknown` distinct and preserve null counts. `rankEdgeSummaryRecords` changes display order
  only and must never remove a supported family. Agency and vendor readers render every supported
  category, including honest empty/unknown rows; gated place/committee neighborhoods use
  `unknown`, not `empty`, when publication is withheld. The agency lookup is regenerated with
  `node tools/build_agency_constellation_documents.mjs --check`.
- **Incremental derived facts:** `site/derived_feature_rollup.mjs` is the presentation-neutral
  accumulator for category/edge counts, valid/observed date spans, explicit lifecycle buckets,
  and freshness. It keeps corpus totals separate from bounded preview rows, deduplicates repeated
  graph deliveries, and is attached to agency categories, edge summaries, and civic-time
  projections without adding technical detail to resident copy. Focused proof lives in
  `test/agency_constellation.test.mjs`.

- Start JavaScript tasks at `docs/module-map.md`; do not load all of `site/app/` by default.
  `site/index.html` owns markup/CSS, `site/app/main.mjs` owns ordered loading, and application
  modules stay below 100 KB. Source-extraction tests read modules through
  `test/helpers/site_source.mjs`; rendered split parity is
  `python3 test/functional/21_module_dom_equivalence.py`.
- **Module-graph digest (Unit CI):** `node --test test/site_module_architecture.test.mjs`
  derives the fingerprint from the current loader graph and verifies that every
  `site/app/*.mjs` module is registered exactly once, with no orphan or unregistered files.
  Pure libs loaded only via dynamic `import()` (not listed in `SITE_MODULES`) do not need
  graph registration; still re-run the test when an *app* module that imports them changes.
- Browse scope uses the pure `site/scope_v0.mjs` adapter; existing DOM controls, hashes,
  map state, presets, and watch drafts remain the state owners. Do not add a parallel scope
  store. Verify cross-surface round trips with `node --test test/scope_v0.test.mjs`.
- Hydrated Meetings borough/location scopes must filter the current hearing rows through
  `filterMeetingRowsByAffectedArea` before any stamped district-bag materialization. The map
  artifact is a read model and can lag newly published or multi-borough hearings; community-
  district and council-district scopes may still use the stamped bag for their finer geometry.
- Property is route-lazy through `site/app/main.mjs`'s activation registry. Keep routing state
  eager; initial Property/notice deep links load the lens before `routing.mjs`, and later hash or
  tab activation passes through the existing router/tab owner rather than adding another store.
- Land project connections are a semantic response contract, not an HTTP-status contract:
  `/zap-outcomes` must return all five exact-key groups or explicitly mark
  `sections.project_connections` unavailable. The client retries the alternate Worker host for an
  incomplete 200 and otherwise renders an honest unavailable card. Keep the Pages readiness gate,
  the post-deploy API smoke (`node tools/project_connections_smoke.mjs`), and the focused browser
  smoke (`python3 test/functional/27_project_connections_live.py`) together.
- Following is static-first at `site/following/index.html` and edge-rendered at `GET /following`
  through the shared `site/following_view.mjs` renderer. A saved scope is the single contract for
  its summary, preview count, results, and `/subscribe` form. Create flow: live conjunction rule
  line (`composeWatchRuleSentence`), digItem-shaped preview cards, cadence radio cards with
  quiet-day/weekly consequences, pack attention cost (`packAttentionCopy`). Client promotes
  Your watches first when `/following/personal` returns ≥1 watch (manage-first tabs). Canonical
  manage URL is `/following/#your-following` (digest footers use session exchange when a token
  is available; `/prefs` remains account-level). Personal watches load only through
  `/following/personal`; `site/app/alerts.mjs` is not part of the home loader graph.
  Suggested Watch sets are results-backed: `site/following_suggestions.mjs` gates and counts the
  editorial shapes against the canonical open money, rules, and meetings snapshots. Both
  `tools/build_following_page.mjs` and `worker/src/following.mjs` must pass that generated registry
  to the shared renderer; do not render the static registry directly as public suggestions.
- Vendor profiles receive their city-footprint read model inside the daily
  `refreshVendorProfiles` KV bucket. The section header, destination link, and destination result
  label share `result_count_receipt`; keep parity covered by
  `test/functional/26_vendor_footprint_scope_count.py`. Confirmed identity links and name mentions
  are separate reader tiers, and an absent footprint must render as unavailable without a second
  profile-blocking request.
- Static-first standalone documents load `site/brand.css` plus `site/civic-documents.css` through
  `site/civic_document_chrome.mjs`; do not inline a page-local palette or type stack. Run
  `python3 test/standards/civic_token_contract.py` after adding or generating a shipped document.

## Primary document routes

- Now, Near you, Following, and Browse are the primary navigation documents. Contracts,
  Staffing, Zoning, Property, Rules, and Meetings remain complete source views under
  `/browse/<facet>/`; the existing application modules enhance their build-rendered HTML.
- Browse concept landings at `/browse/people/` and `/browse/places/` are static documents in
  the `tab-browse` pane, not SPA lenses. Their `.tabbtn` links must delegate to native
  navigation, and client boot must recognize their routes without falling back to Contracts.
- `node tools/build_primary_documents.mjs` builds the bounded Now and Browse defaults.
  `site/_worker.js` delegates document requests to `site/pages_edge.mjs`; notice permalinks are
  edge-rendered at `/notices/<request_id>`, while entity and matter hashes remain unchanged.
- `site/legacy_hash_forward.mjs` is the finite fragment-to-document compatibility bridge.
  Update its grammar through `site/route_migration.mjs`, then rebuild and review
  `docs/url-migration-map.csv` and `docs/url-migration-map.md` with
  `node tools/build_url_migration_map.mjs`. The public Stats document and API are explicit
  exclusions and must retain their current routes and semantics.
- `test/functional/24_notice_document_features.py` is the required browser parity gate for
  `/notices/<request_id>` translation, action/watch controls, disclosures, and language-carrying
  copy links. Notice-document enhancement changes must extend this route-level test.

## Digest cron deploy safety

- Production Worker deploys must run `node tools/wait_for_digest_cron_window.mjs`
  immediately before `wrangler deploy`. Wrangler rewrites Cron Trigger configuration,
  so the guard keeps deploys outside 12:40–13:05 UTC around the 13:00 digest.
- The 13:00 scheduled handler must call `runAlerts` before advisory daily read-model refreshes;
  those upstream refreshes can be slow or fail after the delivery critical path. The ordering
  contract is covered by `node --test worker/test/digest_schedule_order.test.mjs`.
- Cloudflare Pages remains the origin for `cityscroll.org` and `www.cityscroll.org`. Bounded
  Worker zone routes serve canonical `/near-you*`, `/following*`, and `/prefs*` documents;
  Worker custom domains remain `api.cityscroll.org` and the `api.crol-list.org` compatibility alias.

## Digest shadow delivery holds

- `worker/src/digest_shadow_hold.mjs` is the single policy layer for scoped 09:00 delivery
  holds. Named redlines hold only `affected_digest_ids`. Store failures retry three times, then
  use today's persisted state when usable; otherwise missing/unavailable state fails open loudly
  until the last `READY` rehearsal is 3 days old. At that boundary all sends hold, and the next
  `READY` run triggers watermark catch-up before normal delivery. Run-level redlines without
  digest scope remain fail-open. Machine receipts use `digest-shadow-degraded-decision.v1`, live
  on `/admin/digest-shadow`, and are copied into the daylog envelope's `shadowHoldDecision`.
  The D1 migration is `worker/migrations/0015_digest_shadow_hold.sql`.
- The repair cutoff is 12:45 UTC, the configured delivery boundary is 13:00 UTC, and leases
  expire at 14:00 UTC. Producer and queue-consumer paths both enforce the same opaque digest
  identity. Verify with `node --test worker/test/digest_shadow_hold.test.mjs
  worker/test/digest_shadow.test.mjs worker/test/digest_catchup.test.mjs
  worker/test/digest_rollup.test.mjs`.
- Ontology inventory additions enter only the private digest rehearsal through
  `worker/src/lib/ontology_delta_alert.mjs`. Stable `absent-to-present` transition keys reconcile
  through `ontology_delta_shadow_events`; only the winning insert is exposed as a candidate, while
  later rehearsals retain digest-compatible `deduplicated` receipts. The default inventory pair is
  the committed entity-intelligence Worker artifact against `site/data/ontology_inventory_baseline.json`.
  Verify with `node --test worker/test/ontology_delta_alert.test.mjs worker/test/digest_shadow.test.mjs`.

## CI path fast paths and merge queue

- Required checks always report a conclusion (never stay missing). Fast paths:
  `changelog_only` (the machine changelog data file) and `docs_only` (`tools/docs-only-path-guard.sh`)
  skip the full unit suite; non-frontend PRs skip browser a11y / reading-level
  heavy work while still posting SUCCESS. Performance budgets (20-sample p95) use a
  narrower `perf` path filter (site HTML/CSS/JS/media + budget harness) — not all of
  `site/**` — so data-only / worker-only diffs report SUCCESS without the long measure.
  Performance is not a merge-queue required check (`tools/merge_queue_policy.json`).
- **No live production origin in PR / merge-group gates.** Demo-link and a11y contracts
  in `ci.yml` serve `site/` from the runner (`http://127.0.0.1:8000/`). Cloudflare Pages
  PR deploys use a numbered preview branch and smoke that preview URL; production alias
  + `cityscroll.org` route parity run only on main. Live production demo-link sampling
  lives in scheduled `cutover-regression.yml`. Guard:
  `node --test test/ci_no_prod_origin_gates.test.mjs`.
- Stray-English: **Unit static lint only** (`test/standards/stray_english.py`). The runtime
  multi-locale walk (`test/functional/13_stray_english.py`) is **not** a CI job or required
  check — optional locally via that script or `run_stray_english_shards.sh`. Required merge
  checks are Unit, Accessibility + language, and Reading-level (three total).
- Playwright installs go through `.github/actions/setup-playwright` (browser cache for a11y/perf).
- Merge-queue parameters: `tools/merge_queue_policy.json` + `node tools/apply_merge_queue_policy.mjs`
  (short train wait). Concurrent merge-when-ready seating for this repo is capped outside this tree;
  elder reservation thresholds for that seater are `elder_slot` / `tools/elder_merge_slot.mjs`.
- Preset fallback refreshes run `node tools/validate_presets.mjs --write` only when CI detects
  inherited fallback drift; transiently unresolved live suggestions retain their inherited
  filter/count, while `--check` still compares generated fallbacks against live counts.

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

Official decision trails remain a bounded read model until both fixed promotion
bars clear: at least 95% exact person-id retention in the dated Legistar audit
and at least 30 distinct retained roll-call events. The current coverage block
is materialized in `site/data/person_votes_lookup.json` by
`site/official_connections.mjs`; below the gate, reader copy must remain
“published roll calls in this corpus.” Exact `entity:official:<person_id>` plus
`votes_on` owns composed scope. Never promote name-derived officials.
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

**Vendor constellation (gc-08):** `site/vendor_footprint.mjs` groups a vendor's
linked objects by section — awards, **contracts** (PASSPort Public + Checkbook
Contracts corroboration, VI-02; a distinct `object_kind` from the award notice —
never lump into "awards" or "payments"), payments, land, property, rules,
meetings, franchise — each with confirmed/mention counts and a typed scope-v0
"view all" link (`vendorFootprintScopeHref`). `vendorAgencyIntersectionHref`
composes one fast, reliable suggestion (vendor ∩ named agency) reusing the
vendor's own top-agency data already fetched for the profile's agency chips —
it does not add a new fetch or a new scope facet. "Follow this vendor"
(`data-follow="vendor"` → `alerts_context_carry.mjs` → `#alerts?lens=entity`)
and the entity-lens digest compile (`worker/src/lib/compile.mjs` /
`compile_d1.mjs`, `kind !== "agency"` branch) predate this card — no new watch
machinery was added. The "money domain, multiple object_kinds" split here is a
different measurement from `docs/evidence/vendor-footprint-coverage.json`'s
`multi_domain_vendor_rate` gate (which counts entities matched across the 7
cross-domain **domains** — money/land/property/rules/meetings/people/franchise —
inside the capped 200-root materialization); see
`docs/evidence/vendor-linkage-gate-verification-2026-08-05.json` for both
measurements side by side plus the live PASSPort-joined-cohort resolved-same
rate. Verify: `node --test test/vendor_footprint.test.mjs
worker/test/entity_intelligence.test.mjs`.

**PASSPort → EI densify (money multi-kind):** entity-intelligence feeds from the
population-backed census in `site/data/procurement_spine_sources.json`
(`rows.passport_contracts`, capped at the measured 1,550-row payload ceiling)
plus OCP awards preferred by the
existing PIN↔EPIN join — not from the 2-row
`passport_contracts_materialization` Checkbook-crosswalk demo alone. Selection
helpers: `selectPassportContractsForMaterialization` /
`selectOcpAwardsForMaterialization` in `tools/lib/entity_intelligence_build.mjs`.
Selection is agency-stratified round-robin within the cap so census order does
not starve later agencies. Measure the graph and payload ceiling with
`node tools/measure_passport_ei_densify.mjs`; receipt:
`docs/evidence/passport-ei-densify/comparison.json`. Rebuild:
`node tools/build_entity_intelligence.mjs`. Verify:
`node --test test/procurement_spine_ei_densify.test.mjs`.

**Checkbook Contracts population feed:**
`warehouse/scripts/checkbook_contracts.mjs` pages explicit fiscal-year
partitions with count-drift failure, checksummed resumable checkpoints, and a
100,000-row hard ceiling. It collapses prime/subvendor slices to one exact
`prime_contract_id`, measures PASSPort and modern City Record overlap before
selection, and publishes only the bounded slice in
`site/data/procurement_spine_sources.json`. Refresh with
`node warehouse/scripts/checkbook_contracts.mjs --publish --refresh --fiscal-years
2025,2026,2027 --page-size 999 --graph-cap 500`; verify with `--check` and
`node --test test/checkbook_contracts_collector.test.mjs`.

## DuckDB + parquet warehouse (WH-01…WH-06)

Local lake under `warehouse/` (bulk raw/parquet/duckdb gitignored). CPU-capped
ingest: single-job lock, headroom gate, `taskpolicy`/nice wrap, tiny row
defaults; full Socrata export only via `--bulk --ack-large` (one dataset at a
time). Setup + fixture proof:

**ABO residual bridge (RC-4):** authority mapping remains source scoping, not
notice-level evidence. The fixed 50-notice sample produced 1 labeled match
(2%), 50% fuzzy precision, and 4 ambiguous groups, so the 30% usefulness / 95%
precision gates stop all edges. Do not promote broad title similarity. Guarded
fixture proof and DuckDB materialization:
`warehouse/.venv/bin/python warehouse/scripts/abo_awards_run.py --from-fixture
--force-headroom`; detector: `node --test test/abo_awards_residual.test.mjs`.
Payload contract: `site/data/abo_award_residual_lookup.json` (+ Worker twin),
currently an honest empty match map. The notice reader is
`site/abo_award_panel.mjs` + `site/app/authority-award.mjs`; it renders only an
accepted, receipt-gated edge and otherwise leaves the notice unchanged. Verify with
`node --test test/abo_awards_residual.test.mjs test/abo_award_panel.test.mjs`.

**T0 attachment metadata:** City Record `document_links` is the archive source
before 2025; it is effectively empty from 2025 onward, so the guarded host-side
collector uses polite (at least 1.2 seconds/request) RequestDetail deltas for the
modern era. It excludes Changes in Personnel, stores metadata only, checkpoints,
and writes `attachment_metadata` plus `attachment_metadata_by_notice`. The Worker
only serves precomputed rows; it never scrapes the portal. Fixture proof:
`warehouse/.venv/bin/python warehouse/scripts/attachment_metadata_run.py
--from-fixture --limit 25`.

**T1 attachment inline text:** build-time extract over the T0 inventory for
high-value office classes (docx/pdf; legacy `.doc` is an honest skip). Pure
helpers `warehouse/lib/attachment_text.mjs` + binary extractors
`warehouse/lib/attachment_text_extract.py` (docx via stdlib zipfile, pdf via
pypdf). Guarded runner
`warehouse/.venv/bin/python warehouse/scripts/attachment_text_run.py
--from-fixture --limit 25` (size cap 5 MB, ≤25 docs/run, polite delay, receipt,
no binaries/OCR stored). Text is stamped beside T0 rows
(`extracted_text` / `text_preview` / `text_status`), served on
`GET /attachment-metadata`, and merged into the D1 notices `haystack` with
provenance marker `attachment-text`. Notice UI uses progressive disclosure
(`.attachment-extract`, collapsed by default). Exemplar: notice `20240515016`
(Cannonsville). Capture: `python3 tools/capture_attachment_text.py`.

**T2 attachment structured tables:** same T0 inventory + T1 document classes.
docx tables via native `w:tbl`; PDF text-layer row recovery only (no OCR —
empty/image PDFs stamp an honest miss). Pure helpers
`warehouse/lib/attachment_tables.mjs` + extractor
`warehouse/lib/attachment_tables_extract.py`. Guarded runner
`warehouse/.venv/bin/python warehouse/scripts/attachment_tables_run.py
--from-fixture --limit 25`. **Storage:** JSON payloads now (lookup + D1
`extracted_tables` text); parquet/DuckDB only after measured thresholds —
decision record `docs/adr/attachment-tables-storage.md`. Cell text feeds
haystack with provenance `attachment-tables`. Notice UI:
`site/attachment_tables_ui.mjs` (dynamic-import from `fillContext` only — not
on home cold wireBytes) → `.attachment-tables` progressive disclosure + real
HTML tables (click column header to sort). Golden: Cannonsville species +
stand tables on `#notice/20240515016`. Capture:
`python3 tools/capture_attachment_tables.py`. Verify:
`node --test test/attachment_tables.test.mjs
worker/test/attachment_metadata.test.mjs`.

**T3 embeddings (landed):** build-time nearest-neighbor over T1 text materializes
**precomputed related edges** only (`docs/adr/attachment-text-embeddings.md`) —
no query-time embed (query embedding would need a live model or client weights).
Pure lib `warehouse/lib/attachment_embeddings.mjs` (hashed n-gram TF-IDF,
local/CI-safe); artifact `site/data/attachment_related_notices.json` (+ Worker
twin); UI `.attachment-related` on notice detail. Rebuild:
`node tools/build_attachment_related.mjs` / `--check`. Golden: Cannonsville
`20240515016` → water-supply forest neighbors keyword “Cannonsville” misses.
Proof: `warehouse/receipts/proof/att_t3_attachment_embeddings_latest.json`.
T2 tables and T3 related-edges share notice chrome but not write ownership.

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

## Map exploration surface (cs-geo-04)

The static-first Near-you surface renders the shared scope, exact records and
counts, special place bags, SVG choropleth, and equivalent area list before
JavaScript. `site/app/map.mjs` is a route-only island that adopts those nodes for
pan, zoom, drill-down, geolocation, and focus synchronization; it must never join
the home loader or rebuild the page root. Common pages are built by
`tools/build_near_you_pages.mjs`; uncommon scopes use the same renderer at canonical
`GET /near-you` Worker routes. API-host document requests permanently redirect to the
canonical host. The legacy `#map` route forwards into this
surface. See `docs/module-map.md`.

**All five map lenses** (land / property / rules / meetings / money) roll through
`tools/lib/district_activity.mjs` at build time: land uses ZAP publisher CDs +
council join via CD-centroid PIP (`cd_centroid_council`); property and geocoded
pins use boundary-layer point-in-polygon; meetings / rules / money use the
human-derivation location chain (below). Venue / vendor addresses upgrade from
borough-only to CD + council via the offline civic gazetteer
(`site/civic_address_geocode.mjs` → PIP). Never invent districts for unlocated
rows. `--check` fails if meetings are counted but zero-located, and if land or
meetings have coarser density while council-district is all-zero.

**First-class non-polygon bags:** `citywide` (rules that apply everywhere, citywide
phrase awards) and `virtual` (virtual-only meetings with no matter pin). The map
list renders them as labeled rows at every level; district detail also notes
citywide items that apply city-scale without counting them into polygons.

**Geography subject graph:** `district_activity.geography_subjects` materializes
canonical borough / regular community-district / council-district nodes and one
routed `located_in` candidate per polygon membership. Publisher, structured-bag,
PIP, and centroid placements are public; weak agency-HQ / vendor fallbacks remain
`evidence_only`. Citywide, virtual, and unlocated never become polygon subjects.
Rebuild and verify the reconciled receipt at
`docs/evidence/geography-subjects/located-in-audit.json` with
`node tools/build_district_activity.mjs --check`.

**Near-you explanation paths:** `site/near_you_explanation_path.mjs` composes
only public `located_in` edges with the public-only
`notice_mandate_backlinks_lookup.json` reverse index during the district build.
The shared Near-you renderer selects one strongest candidate matching the exact
displayed place; special bags and response addresses never imply a district
mandate, while meeting venues stay explicitly labeled as logistics rather than
matter place. Verify with `test/near_you_explanation_path.test.mjs` and the
Near-you build check.

**Deploy wiring (load-bearing):** `tools/build_district_activity.mjs` runs inside
`.github/actions/build-site` before the provider-neutral Pages artifact is assembled, so
map density never ships stale against locator code. `built_at` advances on every
site deploy. Committed `site/data/district_activity.json` (+ worker twin) is the
offline source of truth; rebuild after densifying domain observations.

**Human-derivation doctrine (location extractors):** extraction gives up only
after reading a notice the way a location-interested human would — not at the
first missing structured geo field. Pure lib `site/location_derivation.mjs`
(evidence spans + method + confidence, same shape as `notice_facts` deadlines):

| Lens | Where a human looks | Methods (strong → weak) |
|---|---|---|
| **Meetings** | Matter place in title/body ("Borough of X", tax block, park name); hearing **venue** line / `street_address_1`; sponsor agency HQ last | `matter_body_borough` → `matter_title_place` → `venue_column` / `venue_line` → `civic_address_pip` → `agency_hq` |
| **Land** | ZAP `community_district` (+ publisher council when present) | `cd_centroid_council` when council field absent |
| **Rules** | Affected-geography phrases and titled borough/district scope — **not** the comment-drop venue | `rule-scope` / `matter_title_place`; default **citywide** when no local pin |
| **Money** | Title/body place phrases, citywide wording, borough-scoped agencies (BP/CB), neighborhood gazetteer, CD tokens (`MN04`); OCP has **no** service-borough column. Vendor address is weak fallback only (org HQ ≠ service geography) | `matter_title_place` / `citywide_phrase` / `agency_service_area` / `community_board` → `civic_address_pip` / weak `vendor_address` |

Confidence tiers ride on the stamp (`strong` / `derived` / `weak`); agency-HQ
and vendor-address pins are weaker than a venue line or matter borough phrase.
Only after every human-visible derivation fails is a row **unlocated**, and the
payload records `unlocated_reason` (e.g. `virtual_only`, `no_place_signal`).
Venue is not matter for rules; for meetings map density, venue is a legitimate
"where is this happening" pin when the matter has no place. Virtual-only with no
matter pin goes to the `virtual` bag (not silent unlocated). Unlocated is a
first-class map bag (distinct from district zeros). Money lens shows coverage
framing when most awards are citywide / unlocated.

Densify stamps (no raw body on the public surface):
`tools/build_rules_meetings_domain_observations.mjs` → `affected_area` /
`rule_location` on domain observations (addresses kept for offline geocode);
money densify: `tools/build_money_domain_observations.mjs` →
`site/data/money_domain_observations.json` (OCP awards + open RFPs with compact
`place` stamps; map corpus — separate from the OCP pin warehouse lookup used for
lifecycle side-cars). Map client loads `district_activity.json` with
`cache: "no-cache"` so deploy rebuilds reach returning browsers (origin already
sends `max-age=0, must-revalidate`). Verify:

```bash
node tools/build_money_domain_observations.mjs --check
node tools/build_rules_meetings_domain_observations.mjs --check
node tools/build_district_activity.mjs
node tools/build_district_activity.mjs --check
node --test test/location_derivation.test.mjs test/map_exploration.test.mjs test/map_surface.test.mjs
python3 tools/capture_map_exploration.py
```

Artifacts: `site/data/district_activity.json` (stamped with `boundary_vintage`,
`sources.*.by_method`, `unlocated_reasons`, `citywide`, `virtual`, and exact
`district_items` request-id bags for all five map lenses), pure UI helpers
`site/map_exploration.mjs`, build lib `tools/lib/district_activity.mjs`, gazetteer
`site/civic_address_geocode.mjs`. Canonical links use `/near-you/` and its GET
scope; legacy `#map` links forward there. District tap-through uses the same
versioned scope and existing `cd=` / `council=` / `boro=` list grammar. Tax-lien **cycle context**
inlines on Property Disposition notices/cards whose parcel BBLs appear on a
published DOF list (ladder + deadline countdown + leave-rate line + action
rail — pure `site/tax_lien_cycle_context.mjs`). The aggregate tables are
archive-only at `#property?view=tax-lien` (not linked from the property lens
header). The location-resolution
flywheel dimension reads `district_activity.sources` and emits
`map-zero-located-{lens}` when a non-empty corpus lands at 0 located, plus
`map-granularity-council-{lens}` / `map-granularity-cd-{lens}` when coarser density
collapses to all-zero at a finer level (`granularityCollapseFindings`).

## Contract response-address geography

Contract action-rail destinations materialize in
`site/data/contract_action_address_locations.json` through
`node tools/build_contract_action_locations.mjs`; validate with `--check` and
`node --test test/contract_action_location.test.mjs test/map_exploration.test.mjs`.
This is a supplemental procurement-logistics basis only: submission offices,
pre-bid venues, and document-pickup counters retain `is_place_of_performance: false`
and must never merge into Money performance-place counts. Map district counts and
Money list filters share the sidecar's exact location predicate.

## District boundary layer (cs-geo-01 + cs-geo-02)

Community districts and City Council districts resolve from **one committed
boundary layer**, not live GIS. Source contracts
`community-district-boundaries` (`5crt-au7u`) and
`city-council-district-boundaries` (`872g-cjhh`); build:

```bash
node tools/build_district_boundaries.mjs
node tools/build_district_boundaries.mjs --check
# compat alias:
node tools/build_council_district_boundaries.mjs --check
```

Artifact: `site/data/district_boundaries.json` (+ worker twin) with labeled
`boundary_vintage` (top-level and per-source), simplified polygons, community
ids `M01`…`R18` (+ JIAs), council ids `"1"`…`"51"`. Council-only twin
`council_district_boundaries.json` remains for older paths. Pure lookup:
`site/council_district_lookup.mjs` (`resolveCommunityDistrict` /
`resolveCouncilDistrict` / `resolveDistricts`). Location awareness resolves
both from the layer (MapPLUTO CD is fallback only); Land share links use
`#land?cd=Q04&council=25`. Unresolved points stay null — never invent.

Verify: `node --test test/council_district_lookup.test.mjs test/location_awareness.test.mjs`
Capture: `python3 tools/capture_council_district_filter.py --before HEAD^`.

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
| Data page charts | 5 live SODA aggregates on legacy `data.html` | `site/data/data_page_charts.json` | Snapshot first, then live SODA refresh (`data.html` now redirects; artifact retained for rebuild/CI) |
| Land default list + outcome detail | SODA `hgx4-8ukb` Active ULURP 40 and per-selection `/zap-outcomes` | `site/data/land_default_ulurp.json` | List and selected outcome snapshot first; filter/keyword/geo stay live, and outcomes older than six hours may refresh without replacing first paint |
| Meeting decision outcomes | Per-notice `/meeting-outcomes` fetch after document render | `site/data/meeting_outcomes_snapshot.json` | Notice documents inline known outcome HTML or an honest-absent line; the client endpoint may enhance freshness |
| Property first paint | Full 1.2MB `/property-locations` body dumps | Slim list default; `?full=1` keeps complete KV view | Already daily edge materialization |
| Money default open RFPs | Live SODA open solicitations 40 on `#` / Money open | `site/data/money_default_open.json` | Snapshot first (drop past-due rows client-side); filter/keyword/method/award stay live |
| Money agency dropdown | Live SODA agency group-by (~2s cold) | `site/data/money_procurement_agencies.json` | Snapshot first; hybrid SODA refresh |
| Staffing default hires | Live SODA last-80 APPOINTED | `site/data/staffing_default_hires.json` | Snapshot first; live SODA refresh; keyword/payroll stay live |
| Public `/stats` | Live City Record corpus aggregate on `stats.html` | Daily cron `prewarmStats` → edge cache | Corpus, source, language, and recency facts only; product-use telemetry stays on authenticated `/admin/stats` |

Evidence boundary: screenshots of authenticated or internal operations surfaces are private
artifacts. Never commit them, link them from public review surfaces, or place them under `docs/`.
Public reviews may state that the destination was verified visually and publish only public-page
captures.

Rebuild snapshots: `node tools/build_batch_precompute_snapshots.mjs` (pure lib:
`tools/lib/batch_precompute_snapshots.mjs`) and `node tools/build_meeting_outcomes_snapshot.mjs`.
Property slim: `worker/src/lib/property_list.mjs`. Verify:
`node --test test/batch_precompute_snapshots.test.mjs test/meeting_outcomes_static.test.mjs
worker/test/property.test.mjs worker/test/stats.test.mjs`.
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
`ulurp-recommendations` and `ulurp-recommendation-pdfs` are **live** for a **sparse** Borough President panel gated on the recommendation-row denominator (~88% hit rate), not ZAP-universe catalog coverage (0.54% contrast only). Lookup `site/data/ulurp_recommendations_lookup.json`; panel `site/ulurp_recommendation_panel.mjs`; gate policy `ontology/join_gate_policy.mjs`. **Wrong universe:** Property Disposition notices are not ZAP projects. Strategies and receipts: `worker/src/lib/ulurp_recommendations_join.mjs`, `site/data/ulurp_recommendation_sources/`.

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

**Notice-level ZAP project spine:** City Record land notices (`#notice/{id}`)
mount the same phase-grouped ULURP timeline on `#nland` when a strict warehouse
join resolves. Pure join: `site/notice_land_spine.mjs` (ULURP / project-id →
`zap_projects_warehouse_lookup.json`); spine + statutory clocks + zoning stats
from edge `GET /zap-outcomes` via existing `landSpineHTML` / `land_phase_spine.mjs`
(no live ZAP API from the browser). Property Disposition is the wrong universe —
never eligible. Demo: `#notice/20230912001` → project `2022M0258`. **ULURP
tokens** live in `site/ulurp_tokens.mjs` (re-exported by notice-land + worker):
isolated 6-digit body + whole-word 2–4 letter action code — never swallow Zoom
meeting ids (`91467302621 Meeting` → false `302621MEET`) or phone/Webex hex.
Join scorecard: `docs/evidence/notice-land-join-resolution.json`; public copy
lint: `python3 test/standards/public_surface_vocab.py --gate`. Verify:
`node --test test/notice_land_spine.test.mjs`. Capture:
`python3 tools/capture_notice_land_zap_spine.py`.

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

**Land current-stage pointer (stranded outcomes):** `deriveLandCurrentPhaseId` in
`site/land_phase_spine.mjs` must not keep an earlier phase as `current` when a
later phase already has terminal completions (e.g. CB still "In Progress" while
BP/CPC completed — field case `2019K0190`). Advance past missing outcome rows;
mark those earlier phases `outcome_status: no_recorded_outcome`. Verify:
`node --test test/land_phase_spine.test.mjs test/ontology_coherence.test.mjs`.
Capture: `python3 tools/capture_land_stage_coherence.py`.

**ULURP pipeline position + ZAP hearing logistics:** Public status
“In Public Review” is the overall frame; Community Board / Borough President /
CPC / Council / Mayor is the current step inside it. `buildUlurpPipelinePosition`
joins phase view + statutory clock into one sentence on the land detail spine
(“Public review — step N of M: …”). Hearing venue/livestream free text lives on
ZAP disposition `dcp-publichearinglocation` (+ `dcp-dateofpublichearing` with
clock time) — parse in `worker/src/lib/zap_hearing_logistics.mjs`, stamp
`hearing_logistics` on `/zap-outcomes`, and feed the land action rail (maps
attend + watch live). The individual-project shape is an array only when exact
disposition evidence exists; honest absence is `null`, and milestone review
sessions do not become venue/livestream evidence. Fixed-sample measurement uses
`tools/measure_zap_hearing_logistics.mjs`. Land filter `status=hearings` reads
`site/data/land_upcoming_hearings.json`, materialized by a polite ZAP sweep of
**all** sell-facing Open Data projects (`In Public Review` / `Noticed` /
`Active` / `Filed`): list ids from SODA `hgx4-8ukb`, fetch each project from
the ZAP API, extract logistics, keep only future dates. Synthetic/demo pad rows
are forbidden (detector: `detectSyntheticUpcomingHearings` in
`tools/lib/land_upcoming_hearings.mjs`; `--check` on deploy via build-site).
Fixtures stay under `test/fixtures/zap_hearing_logistics/` only.

```bash
node tools/build_land_upcoming_hearings.mjs --live          # production refresh
node tools/build_land_upcoming_hearings.mjs --fixture       # test fixtures only
node tools/build_land_upcoming_hearings.mjs --check         # synthetic-row gate
node tools/measure_zap_hearing_logistics.mjs --live --limit 50 \
  --sample site/data/zap_outcome_sources/verification_receipts/zap_hearing_logistics_2026-08-04.json
node --test test/zap_hearing_logistics.test.mjs test/land_upcoming_hearings.test.mjs
```

Scheduled: `.github/workflows/land-upcoming-hearings.yml` (daily). Receipt:
`warehouse/receipts/proof/land_upcoming_hearings_latest.json`. Field case:
`#land/2024Q0292`. Capture: `python3 tools/capture_zap_hearing_logistics.py`.

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
Decision), an accessible full roll-call **table** in the decision panel
(`meetingRollCallTableHTML`), and deep-links names to `#official/{id}` (optional
`?notice=&event=` hearing scope). **Person page (precompute-first):**
`site/data/person_votes_lookup.json` indexes densified by_person rows by
official id — rebuild with `node tools/build_person_votes_lookup.mjs` (also
written when people densify runs). Pure lib: `site/person_votes.mjs`. Entity
intelligence loads people from `site/data/people_domain_observations.json`
(built via `tools/build_rules_meetings_domain_observations.mjs` from
meeting-outcomes `by_person`). Never invent roll call for `tally_only`.
Immutable `source_records` dual-write for Legistar Events/EventItems/Votes/
Attachments is live under `LEGISTAR_SOURCE_RECORD_DUAL_WRITE`
(`worker/src/lib/legistar_source_records.mjs`).
Writes are chunked and stream-isolated; `refreshMeetingOutcomes` returns
`dual_write` stats (not cached on the public KV view). On-demand operator
trigger: `POST /admin/meeting-outcomes-refresh` (`ADMIN_KEY`). Nested
Attachments can honestly be empty when product documents are only event
Agenda/Minutes on Events (those fields ride on `nyc_legistar_events` snapshots).
Verify: `node --test test/official_entity_family.test.mjs
test/person_votes.test.mjs test/meeting_view_readability.test.mjs
test/legistar_client.test.mjs test/contract/meeting_outcomes.test.mjs
worker/test/legistar_source_records.test.mjs`.
Demo: `#official/7801` (recent votes) · `#official/7801?notice=20260706036&event=22526`
(hearing scope) · notice `20260706036` full roll call.

**Person hub + influence edges:** Council Members `uvw5-9znb` is the official
identity hub — `council_member_id` equals Legistar PersonId (demos 7801/7785).
Rebuild: `node tools/build_person_hub.mjs` → `site/data/person_hub_lookup.json`
(district/term on `#official/{id}`). eLobbyist `fmf3-knd8` and CFB `rjkp-yttg`
bind via exact unique person-name keys only (`entity_resolution/officials/
person_name.mjs`, `lobby_targets.mjs`, `org_resolve.mjs`; site builders
`site/official_influence.mjs`). Materialize only when kill-sample usefulness
≥30% and reviewed precision ≥95%: `node tools/build_official_influence.mjs`.
Receipt: `site/data/person_hub_sources/verification_receipts/`. Decision-
constellation promotion (≥30 roll-call events) remains independent of the hub.
**Source-records dual-write (shadow):** host retention
`node tools/retain_person_hub_source_records.mjs --from-fixture --publish` (+
`--check`) keeps publisher rows as `source_records`-shaped snapshots under
`PERSON_HUB_SOURCE_RECORD_DUAL_WRITE` (`worker/src/lib/person_hub_source_records.mjs`).
Public pages do not read those observations. Verify:
`node --test test/person_hub.test.mjs test/official_influence.test.mjs
test/person_hub_source_records.test.mjs worker/test/person_hub_source_records.test.mjs`.

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

### Generated source-topology view

`node tools/data_source_graph.mjs` derives the desk-consumable topology at the ignored,
untracked paths `docs/data-source-graph.{json,html}` from source contracts, warehouse
configs/receipts, and Worker cron code. The site build runs generation followed by
`--check`; the latter fails if any declared input changes without rebuilding the artifact.
Do not commit the generated HTML or JSON: the broad receipt manifest makes either file a
shared merge-conflict source. The HTML remains dependency-free and byte-stable for
unchanged inputs, and the composite build action exposes `data-source-graph-dir` for the
authenticated desk deploy without changing its paths or access gate.
Surface labels are derived from each contract’s `name` + `used_for` (see `SURFACE_RULES`);
person hub / lobby / CFB map to **Officials**, not Land (avoid bare `district` in the Land
rule). Coverage prefers `join_measurement.verdict` when present. Blocked-source nodes are
declared only in `site/data/gap_taxonomy.json` under `partnership_blocked_sources`;
downstream authenticated-desk consumers should regenerate from `data-source-graph-dir`
after updating their crol-list revision. This repository does not deploy the desk.
Public capability summary for third parties lives in root `README.md`; the desk
`/capabilities` board is a separate private-team surface.

When adding a new lifecycle empty state: pick class a or b with evidence, add or update the inventory row, use the matching register in English and all shipping locales, and extend the characterization test. Prefer pointing new work at the inventory over inventing a third gap register. After landing a source or stamping `join_measurement`, run `depot_rederive.mjs` so realized coverage, candidate crosswalks, and the ranked queue stay current.

### Lifecycle rendering coherence (notice detail)

Precompute-first on the notice page: never live Checkbook proxy; never render `lifecycle_unknown_html` (“Could not reach…”) as a public data gap. Coerce `unknown` → taxonomy unmatched, or **passed** when a later stage is matched. No-PIN collapses Checkbook stages into the single class-(b) note. Format zero amounts with `lifecycleMoney` (`$0` / `—`), never literal `null`.

**Phase-group timeline (procurement):** presentation groups stages under Solicitation → Selection (City Record intermediates) → Award and registration → Payments via `site/procurement_phase_spine.mjs` (same shape as land `land_phase_spine` — do not fork a second generic component). Action-first lead for the current phase; earlier phases under disclosure; one outbound source family per phase. Verify: `node --test test/procurement_phase_spine.test.mjs test/lifecycle_render.test.mjs`.

**Compact template (cognitive load):** contract lifecycle is a stepper (`.lc-stepper`) plus detail cards only for populated / attention stages. Future unmatched steps stay grey chips — do **not** emit a per-stage “Not yet shown here — lives in {source}” paragraph or a repeated Checkbook URL. Unmatched OCP / RFx side-cars also collapse until matched. Methodology lives in a “How this timeline works” disclosure (source *names*, no extra outbound links). One actionable source link on the current stage only. Solicitations lead with the action rail + how-to-respond (`buildApply`) before lifecycle. Class-(a)/(b) strings remain in i18n and the gap inventory for other surfaces and when precompute later fills a stage. Characterization: `node --test test/lifecycle_render.test.mjs test/lifecycle_coherence_field_cases.test.mjs`. Evidence: `docs/screenshots/notice-template-rethink/`.

**Notice action rail (no punt):** “What can I do now?” must extract concrete response steps from the notice itself — package/submit URL from the body when present, plus contact, deadline, method, and submit-to address from City Record fields. Never ship “Use the response instructions in the official notice” as the primary CTA. Logic: `site/action_registry.js` (`solicitationHandoff` / `notice_extracted`); render: `actionRailGuideHTML` in `site/index.html`. Verify: `node --test test/action-rail.test.mjs test/notice_action_rail.test.mjs`.

**Award action rail (no watch-only punt):** Award notices already carry vendor, amount, PIN, and `/contract-lifecycle` registration/spending. Primary CTA is dollars/vendor/registration-aware (`awardHandoff` → `system: award_lifecycle`) — e.g. awarded-to, registered date, pending registration, Checkbook handoff — never “Watch this notice” as the only next step. **Intent to Award / Intent to Negotiate / Vendor List** are selection-phase guides (not a solicitation bid CTA). Closed awards never say “bid.” Fields only when present; empty lifecycle degrades to notice + watch. Verify: `node --test test/action-rail.test.mjs test/notice_action_rail.test.mjs`.

**Award → prime → M/WBE-goal join + sub-outreach surface:** `GET /contract-lifecycle`
stamps `award_prime_goal` (`cityscroll.award_prime_goal.v1`) via pure
`worker/src/lib/award_prime_goal.mjs` — prime identity (`vendorStem` +
`subject_ref`), canonical agency, dollars, industry chips (City Record
`category_description` + PASSPort industry/commodity when present), and an
honest-absent subcontract-goal slot (`status: not_published`, never invents
goal %). Assembly version **v3** requires the side-car on cache hits.
**Sub-outreach surface (notice card):** pure `site/sub_outreach.mjs` + mount
from `loadLifecycle` into `#nsuboutreach` / `#dsuboutreach`. Renders only
prime / agency / dollars / industry chips / `possible_subcontract_window`
callout when `status=open_candidate`. **Hard rule:** when
`subcontract_goal` is `not_published`, paint **nothing** for goals (no
apology / “data unavailable” box). The reporting gap lives only in gap
taxonomy id `procurement-subcontract-goal-percent`. Verify:
`node --test worker/test/award_prime_goal.test.mjs worker/test/checkbook_lifecycle.test.mjs
test/sub_outreach.test.mjs`.


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


## Machine changelog harvest

Team data contract: `site/changelog-data.json` (not repo-root). Workflow:
`.github/workflows/update-changelog.yml` → `tools/prepare-changelog-base.sh` →
`tools/gen_changelog.mjs`. Editorial bar: `changelog:major` **and** an accepted user-impact
heading (canonical `## What this means for you`; aliases in `tools/changelog_extract.mjs`).
**Vacuity tripwire:** a major label with nothing extractable fails the job. Characterization:
`test/changelog_*.test.mjs`, `test/changelog_entry_gate.test.mjs`.

The workflow publishes only that file to the existing `bot/changelog-update` branch. It does
not generate `site/changelog.html`, open a pull request, or enter the merge queue. Path guard:
`tools/changelog-path-guard.sh`. Characterization: `test/changelog_queue_checks.test.mjs`.

## Live-URL smoke target sets

Cloudflare Pages is the public origin for `cityscroll.org` and `www.cityscroll.org`;
GitHub Pages remains deployed as the fallback origin. Post-deploy gate:
`node tools/live_url_smoke.mjs` (default set includes apex, www, crol-list redirect
host, about). Scheduled production monitoring runs `node tools/cutover_regression.mjs`
and is intentionally not a pull-request or merge-queue check. Named opt-in sets do
not change production routing:

- `--set pages-dev` — direct Pages hostname only (or `--base-url https://cityscroll.pages.dev`)
- `--set post-flip` — Pages-primary URL matrix **plus** named incident checks (EMAIL HEALTH, STATS SANITY, WORKER ACCESS, HUMAN-PATH JOURNEY in `tools/post_flip_checks.mjs` + `tools/human_path_journey.py`)

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
and agency entity links. Place-based local / citywide / unlocated **grouping is
opt-in** (`group=place`; default is a single chronological list) — near-me and
affected-area filters are the primary place path (cs-geo-02 retirement).
Same-agency same-day notices collapse to one event card; same-agency same-matter
decides text can collapse a multi-notice journey. Detail vote spine stays
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

## Staffing list-establishment predictions

Build-time application-close → list-established ECDF lives in
`worker/src/lib/staffing_list_prediction.mjs`. Its exact normalized exam-number
join uses `site/data/exam_sources/annual_schedule_history.json` (historical
revisions of the existing `4ptz-hmtc` schedule source) and exam-level-only
`civil_service_list_aggregates.json`; refresh the former with
`node tools/build_staffing_exams.mjs --refresh-prediction-history`. Cohorts are
open-competitive / promotion with n≥20, else citywide. The strict pre-2025 / 2025+
scorecard controls whether `cityscroll.prediction.v0` per-exam dates emit;
below-bar builds expose only the cohort statistic. Authoritative join, miss,
quantile, calibration, and privacy evidence is
`verification_receipts/staffing_list_establishment_prediction_latest.json`.
Verify: `node --test test/staffing_list_prediction.test.mjs
worker/test/prediction_calibration_scorecard.test.mjs` and
`node tools/build_staffing_exams.mjs --check`.

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
`node --test test/exam_process_spine.test.mjs test/exam_cycle_coherence.test.mjs`.

**Cycle coherence (hard):** DCAS exam numbers name one filing cycle. Build join
(`tools/build_staffing_exams.mjs`) and spine drop annual outcomes / list rows
when `published_on` / `established_date` is on or before `application_end`
unless the exam is explicitly continuous / walk-in (`filing_mode` etc.). Bare
`exam_number` matches that land list/cert/hire events inside an open application
window are the mis-join class (field case: open `#exam/6125` must not paint
mid-window hires). Metric `exam_cycle_temporal_incoherence_count` is stamped on
the staffing artifact and sampled by the data-integrity flywheel dimension.
Continuous filing may keep post-list during an open window only when labeled.

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

## NOE differentiators (exam cards + filters)

Interface preference: Open Data has **no** NOE body corpus (`4ptz-hmtc` schedule,
`vx8i-nprf` lists). Best bulk is OASys `GetActiveExams` (fee, promotional,
examParts EEE/MC). Full quals/residency/salary range come from polite
build-time NOE HTML parse (`/OASysWeb/noe?examId=`), cached as
`site/data/exam_sources/noe_differentiators.json`. Pure lib:
`worker/src/lib/noe_differentiators.mjs`; rebuild
`node tools/build_noe_differentiators.mjs` (or `--from-text-fixtures`).
`build_staffing_exams.mjs` merges fill-only and stamps `exam_format`,
`salary_band`, `fee_level`, `no_experience_required`, `card_leads`. Cards lead
with differentiators; filters: format / salary band / fee / no-experience.
Precompute-first — no live fetch at render. Exemplars: Police Officer `7312`
(MC, $0 fee), Caseworker `7016` (EEE, bachelor's, no experience), Automotive
Service Worker `7013` (EEE, experience). Verify:
`node --test test/noe_differentiators.test.mjs`.

## Exam interest-area / series taxonomy

Interest areas (public safety, social services, trades, admin, IT, etc.) are a
**data mapping**, not hard-coded rules in the build: committed file
`site/data/exam_sources/interest_area_taxonomy.json` (title rules + optional
`exam_overrides` / `title_code_overrides`). Pure lib:
`site/exam_interest_taxonomy.mjs`. `tools/build_staffing_exams.mjs` tags every
exam `interest_area` and emits `interest_taxonomy` on
`site/data/staffing_exams.json` — area descriptors plus per-area exam lists
with open / upcoming / closed window counts. Areas mark `subscribable` for a
future alerts surface; that surface is a **separate gated card** (not shipped
here). Rebuild after mapping edits: `node tools/build_staffing_exams.mjs`.
Verify: `node --test test/exam_interest_taxonomy.test.mjs`.

## Title-code alias spine

`site/data/exam_sources/title_code_alias_registry.json` is the exact-label
alias registry built from Jobs NYC Postings (`kpav-sd4t`) and the canonical NYC
Civil Service Titles table (`nzjr-3966`). It accepts only a unique normalized
label with one canonical code; ambiguous labels are excluded. Rebuild the
registry with `node tools/build_title_code_alias_registry.mjs`, then run
`node tools/build_title_code_family_coverage.mjs` to measure historical
coverage and residual-only Fellegi–Sunter precision. Candidate scores remain
review-only; the family UI promotion flags are owned by that coverage artifact.

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

**Stats:** authenticated `/admin/stats` digests block carries `catch_up_sent_today`,
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

## Digest delivery UI (email as first-class surface)

Rendered digests are product UI: multi-watch rollup opens with total new · since ·
TOC jump links (`rollupTocEntries` / `rollupDigestHtml`); quiet sections are
one-line (`Label — no new matches`), not full item chrome. Match evidence sits
under the title before actions (`evidenceLineHtml` / `digEvidenceHTML`, brand
blue rule). Quiet/heartbeat bodies include a still-subscribed sentence; prefs
edits “apply to the next digest (about 9am Eastern)” while unsubscribe is
immediate. Heartbeat is documented at 14 days (not user-tunable without product
OK). Following list preview stays a slim title/summary subset — dig-item
awareness remains `digItemHTML` ↔ `subDigestHtml` only. Verify:
`cd worker && node --test test/digest_delivery_ui.test.mjs test/digest_rollup.test.mjs
test/rollup.test.mjs test/prefs_lib.test.mjs` and
`node --test test/digest_preview_awareness.test.mjs test/alerts_rollup_prefs.test.mjs`.
Docs: `docs/digest-rollup-prefs.md`.

## Context-carrying alert entry

"Watch this notice" / header "Want email updates?" / "Watch this search" land on
`#alerts?lens=&filter=&notice=` (same hash-param shape as saved-search health
fix links). Pure scope helpers: `site/alerts_context_carry.mjs`. Prefill +
seeded `digItemHTML` preview (real email template, not a mock):
`prefillAlertFromLink` in `site/app/boot.mjs`. Header CTA hrefs update via
`syncAlertsEntryHrefs`. Verify: `node --test test/alerts_context_carry.test.mjs
test/prefill_alert_from_link.test.mjs test/digest_preview_awareness.test.mjs`.
Capture: `python3 tools/capture_alerts_context_carry.py`. Demo:
`alerts-context-carry-notice` → notice `20260716009`.

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
joined to source-contract health via `temporalCompletenessScorecard`).

**Flag-gated durable writer (default off):** `worker/src/lib/civic_time_writer.mjs`
appends envelopes to D1 `civic_time_events` (migration `0019`) only when
`CIVIC_TIME_EVENT_WRITE=true`. Unset/`false` keeps the pure seam (no writes). Wired
fail-soft after Money attach in `worker/src/checkbook_lifecycle.mjs`. No public
reads yet. Verify:
`node --test worker/test/civic_time_contract.test.mjs worker/test/civic_time_writer.test.mjs worker/test/temporal_completeness.test.mjs worker/test/checkbook_lifecycle.test.mjs && node worker/scripts/civic-time-diff.mjs --fixtures worker/test/fixtures/civic-time --check && node worker/scripts/temporal-completeness-scorecard.mjs --fixtures worker/test/fixtures/civic-time --check`.
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
- Usage `traffic_class`: `production` | `developer` (`blob7`; private operational SQL keeps production
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
- Manage watches sends recognized readers to `/following/#your-following`; that
  surface mints purpose-scoped form credentials without putting tokens in URLs
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
on `/r/...`. Exchange sets the HttpOnly `cs_session` cookie (~14d) on the
`cityscroll.org` parent domain so API endpoints and canonical documents share one
recognized-session truth; token never forwards to the final cityscroll.org URL.
Scope is READ + pin sync + preference-center bootstrap. Recognized `GET /session`
returns the account email plus clean `/following/#your-following` and `/prefs`
destinations. `/following/personal` renders the account watches first and mints a
narrower prefs token into inline cadence, pause, and unsubscribe forms;
cookie-authenticated `GET /prefs` uses the same bootstrap even when a stale URL
token is present. Watch mutations, unsubscribe, and confirm keep purpose tokens
and never accept the session directly. Compatibility Worker hosts cannot set the
canonical parent-domain cookie, so credentialed client calls never fail over to
them and their session endpoints must report anonymous rather than split identity.

- Worker: `session.mjs`, `pins.mjs`, pure helpers `lib/session.mjs`
- KV pin store: `pins:<opaqueActorId(email)>` in SUBS (alongside subscriptions)
- Client: `invStore`/`invSave` still localStorage; recognized sessions merge
  (union, dedupe by type+id) then read/write `/pins` with `credentials:include`
- Banner: `#sessionBanner` ("Not you?" → `/session/logout`)
- Characterization: `node --test worker/test/session_pins.test.mjs
  worker/test/prefs.test.mjs worker/test/following.test.mjs
  test/session_pins_client.test.mjs test/homepage_cta.test.mjs` and
  `python3 test/functional/28_session_coherence.py`

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
doing-business, NYCIDA `gap`. Person-hub constellation (Council Members / eLobbyist / CFB)
host retention + dual-write landed 2026-08-11. Named metric `source_coverage` = live
complete/total (**10/16**).
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

**Agency rename / successor densify:** OTI roster `t3jq-9nkf`
`alternate_or_former_names` densifies into `former_names` stamps on
`worker/src/data/agency_crosswalk.json` via `tools/build_agency_successors.mjs`
(pure lib `tools/lib/agency_successors.mjs`). Residual renames that must share a
route id land in `site/agency_identity.mjs` `AGENCY_GROUPS` (not a bulk browser
alias module — home.cold wireBytes). Kill sample must clear ≥95% precision with
zero hard-negative merges before materializing. Verify:
`node --test test/agency_successors.test.mjs worker/test/agency_identity.test.mjs`
and `node tools/build_agency_successors.mjs --check --fixture`. Gold:
`node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v0.jsonl --blocker token_v0`
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

**Features + matcher (er-09, extended by er-19 + VI-03):** `entity_resolution/features/`
extracts deterministic family-aware stem/token/authority-key/length signals plus VI-03
proximity features (typo, truncation, abbreviation, DBA);
`entity_resolution/matchers/` emits `same` / `different` / `unresolved` without LLM scoring.
PIN and EPIN share one candidate identifier family; blocked-out true matches remain visible
in the metrics report. Verify:
`node --test worker/test/entity_resolution_matcher.test.mjs` and
`node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v1.jsonl --blocker token_v0`.

**VI-03 live-distribution ER (conservative alias policy):** expands gold to `gold_v1.jsonl`
(56 cases: v0 + typo/truncation/abbreviation/DBA/alias/successor/unsafe-granularity strata).
Features v2 adds `typo_proximity` (bounded Levenshtein ≤2 on vendor stems),
`stem_truncation` (prefix-with-tail ≤4), `abbreviation_matches` (CNTR→CENTER etc.),
and `extractDba` (DBA/FKA/AKA parsing). Matcher v2 (`conventional_v2`) adds conservative
same-decisions on these features — no threshold-only retune. Policy v1 (`conservative_v1`)
activates auto-link on high-confidence matcher same + reviewed alias-registry matches
(`entity_resolution/review/alias_registry.json`); unresolved stays unresolved; hard-id
conflicts are never overridden. Pipeline prediction (`--pipeline` flag): precision=1,
recall=1, false_merge=0, false_split=0 on gold_v1. Gold additions carry `stratum` +
`provenance` (reviewer=agent, date). Verify:
`node entity_resolution/eval/run_metrics.mjs --gold entity_resolution/eval/gold_v1.jsonl --blocker token_v0 --pipeline`.

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

## Property commercial payload (surplus-goods buyer)

**Commercial lens organization:** list cards lead with commercial glance; chip
rails filter item type / sale method / price band; `#propsort` covers closing
soon / price / newest. Export columns + watch filters: `asset`, `saleMethod`,
`priceBand`. Non-sales (`sale_eligible=false`) stay on the general list but drop
from commercial-filtered views. Verify: `node --test test/property_commercial_lens.test.mjs`.
Capture: `python3 tools/capture_property_lens_organization.py`.



Primary persona on `#property`: glancing surplus-goods buyer — **WHAT / HOW MUCH /
DEAL? / when-bid**. Secondary: real-property developers, community land-reuse
(same facts, different next steps). Pure extractor:
`site/property_commercial.mjs` (worker re-export
`worker/src/lib/property_commercial.mjs`). Stamped on `/property-locations` via
`attachPropertyCommercial` after disposition spines. Categories: `vehicle`,
`timber`, `equipment`, `real_property`, `scrap_materials`, `other` (legacy URL
keys `vehequip`/`forest`/`realty` normalize).

**Sale gate (load-bearing):** detail `#ncommercial` mounts only when
`hasCommercialSaleSignals` / `sale_eligible` is true — sale method, labeled
price facts, bid participation steps / marketplace URL, or a confidently
sale-shaped item category. Disposition-but-not-sale classes
(`destruction`, `transfer`, `abandonment` via `classifyDispositionSaleClass`)
with zero hard sale signals render **no commercial panel** (field case:
`#notice/20260526003` NYPD pending destruction). Absent subsections render
nothing — never per-slot apology boxes; methodology lives in one collapsed
how-toggle. Evidence spans snap to word boundaries with ellipses. Empty-state
density is sampled in the surface-load (wackness) dimension
(`emptyStateDensity` / apology-phrase greps). Class-split receipt:
`docs/evidence/property-empty-state-axe/disposition-sale-class-split.json`.
List prime position is item + $ + close-date; deal signal only when the notice
states both appraisal/assessed **and** minimum bid/upset — never invent market
comps. Attachment titles (T0 metadata) may name item lists / volume reports.
Action rail consumes `commercial.participation.package_url` for marketplace
handoffs (GovDeals etc.). Verify:
`node --test test/property_commercial.test.mjs worker/test/property.test.mjs
test/action-rail.test.mjs test/multi_flywheel_dimensions.test.mjs`. Capture:
`python3 tools/capture_property_commercial.py` and
`python3 tools/capture_property_empty_state_axe.py`.

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

**Civic-time registration (cs-pred-07):** registered kinds
`property.disposition_hearing` / `property.auction_or_rfp` /
`property.award_or_conveyance` (lens `property`); adapter
`mapPropertyDispositionSpineToCivic` in `worker/src/lib/civic_time.mjs`. Fail-closed
aliases `disposition_*` on spine events. `property_site` is registered in
`ontology/registry.v0.json`. Distinct from any future tax-lien-sale kinds — do
not reuse these names for lien stages.

**Disposition-timing predictions:** method `phase_duration_ecdf` over the small
Property Disposition history (`site/data/property_sources/property_disposition_history.json`,
~243 notices). Parcel-joined hearing→auction pairs are rare (often 0); the
shipped citywide cohort is auction-notice publication→scheduled `event_date`
(n≈34). Shared calibration scorecard fails the ≥50-resolved ship bar →
**cohort_statistic_only** (no per-matter dates). Pure model:
`worker/src/lib/property_disposition_timing.mjs`; client attach:
`site/property_disposition_timing.mjs`; artifact:
`site/data/property_disposition_timing_model.json`. Rebuild:
`node tools/build_property_disposition_timing.mjs`. Formula:
`docs/formulas/property-disposition-timing.md`. Verify:
`node --test test/property_disposition_timing.test.mjs`. Capture:
`python3 tools/capture_property_disposition_timing.py`.

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

**Solicitation procurement-method + M/WBE chips** (nested under
`structured_facts.procurement_method`): pure
`site/solicitation_procurement_method.mjs` (worker re-export
`worker/src/lib/solicitation_procurement_method.mjs`) extracts Admin Code §6-129
M/WBE goal citations, M/WBE Noncompetitive Small Purchase (PPB §3-08), and
accelerated-procurement markers (PPB §3-07), then derives a response floor with
rule source — 20 calendar days (competitive default), 27 calendar days (§6-129),
or 3 business days (accelerated). Priority: accelerated → §6-129 → default for
Procurement solicitations only. Label-bound (no calendar math on start/due).
Surface: `site/mwbe_goal_surface.mjs` chips on Money list rows (distinctive
markers only — no default 20-day spam) + notice detail `#nmwbe` / `#dmwbe`
(`loadSolicitationMwbe`). Verify:
`node --test test/solicitation_procurement_method.test.mjs test/notice_facts.test.mjs
worker/test/ingest_map.test.mjs test/mwbe_goal_surface.test.mjs`.

## Rules association monitor pack

Curated multi-watch **templates** for association verticals (registry data, not code),
rules **action bands** (comment open / hearing / adopted), shepherded **participation**
scaffold on open comment windows, and **member blurbs** on Agency Rules notices.

- Registry: `site/data/watch_templates.json` (add a vertical = data)
- Pure libs: `site/watch_templates.mjs`, `site/rules_action_bands.mjs`,
  `site/rules_participation.mjs`, `site/rules_member_blurb.mjs`
- Subscribe instantiates each watch via existing `POST /subscribe` (one confirm per watch)
- Capture: `python3 tools/capture_rules_association_monitor.py`
- Verify: `node --test test/rules_association_monitor.test.mjs`

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

## Civic Graph + multi-dimension improvement flywheel

**Civic Graph** is the backstage object–link–action catalog at
`ontology/registry.v0.json` (overview: [`docs/civic-graph.md`](docs/civic-graph.md);
ADR: [`docs/adr/ontology-registry-v0.md`](docs/adr/ontology-registry-v0.md)).
Each object/link carries **grounding** `built` | `partial` | `gap` (helpers:
`ontology/grounding.mjs`). ER type families remain the link-not-merge identity
layer — not the whole ontology. The evaluation harness scores coverage,
agreement, actionability, and grounding (`tools/intelligence_flywheel.mjs` +
multi-dimension `tools/flywheel-run.mjs`) and emits ranked enrichment cards only
when metrics show a real gap.

Standing MAPE loops under `ontology/` emit a ranked, deduplicated card queue (not a
one-shot backlog). Dimensions: data-integrity, readability, ontology-enrichment,
coverage, cross-source-consistency, location-resolution, surface-load,
**ontology-coherence** (logical contradictions in generated lifecycle payloads —
current stage past deadline, later-stage completions while current, completion
order, future-dated actuals, exam post-list during open application window).
Rule registry + pure audit: `ontology/dimensions/ontology_coherence.mjs`;
inventory `ontology/fixtures/dimensions/ontology_coherence_payloads.json`;
CLI `node tools/audit_ontology_coherence.mjs`. Entrypoint:
`node tools/flywheel-run.mjs --fixture --emit <dir>`. Idempotent ledger:
`ontology/queue/ledger/cards/*.json` (per-card source of truth; `ontology/queue/ledger.json` is a thin pointer). Consumer contract + schedule:
[`docs/multi-flywheel.md`](docs/multi-flywheel.md). Verify:
`./tools/verify_ontology_flywheel.sh` and `node --test test/ontology_coherence.test.mjs`.
Join false-negative guard: `ontology/join_gate_policy.mjs` + lesson `join-false-negative` in `ontology/engineering-lessons.md` (prefer product join strategies; gate on joinable-candidate denominators). Hourly CI artifact: `multi-flywheel-queue` (`.github/workflows/multi-flywheel.yml`).
Recurring classes append to `ontology/engineering-lessons.md`. Do not hand-author
parallel metric-driven roadmap cards; re-run the flywheel after merges.

**Civic Graph capability ladder (`cg-v*`):** metric-driven cards inside
`ontology-enrichment` from
`ontology/dimensions/civic_graph_capability.mjs` + fixture
`ontology/fixtures/dimensions/civic_graph_capability_ladder.json`. Emit while
payment / influence / roll-call / mandate thresholds fail (v1 payment registry+
surface → v2 influence + densify + official walk → v3 mandate densify); quiet
when fixture metrics clear. Characterization:
`node --test test/civic_graph_capability_ladder.test.mjs`.

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

## Rules adoption-lag predictions (cs-pred-05)

First statistical prediction domain on `cityscroll.prediction.v0`. Comment-close →
adoption gaps from City Record Agency Rules history (sibling stitch reused from
`worker/src/lib/rules.mjs`), right-censored KM/ECDF, method `phase_duration_ecdf`,
predicted kind `rules.adoption`. Batch-only precompute — no per-request inference.
Ship-bar thresholds come from `prediction_calibration.mjs` (`MINIMUM_RESOLVED`,
interval nominal/tolerance); short phase durations use expanding-window
walk-forward evidence (single New-Year open-at-T is too thin for this domain).

```bash
node tools/build_rules_adoption_predictions.mjs
node tools/build_rules_adoption_predictions.mjs --check
node --test test/rules_adoption_lag.test.mjs worker/test/prediction_contract.test.mjs
python3 tools/capture_rules_adoption_lag.py
```

Artifacts: `site/data/rules_adoption_lag_model.json`,
`site/data/rules_adoption_predictions.json`,
`docs/evidence/rules-adoption-lag/backtest.json`, formula
`docs/formulas/rules-adoption-lag.md`. Ghost Estimate segment only after
comment_close (`site/rules_adoption_lag_view.mjs`); digest line on band
transitions only (`adoptionLagDigestItem`).

## Award → registration dwell (Human Services)

Build-time dwell from City Record Online Human Services/Client Services **Award**
notices to a joined registration day (PASSPort Public `registration_date` via
strict PIN↔EPIN join; Checkbook-shaped side-car accepted in fixtures). Pure lib:
`worker/src/lib/award_registration_dwell.mjs`. **Honesty:** unfound registration
is `registration_status: unknown` with `dwell_days: null` — never a zero that
reads as instant. Same-day registration is `found` with `dwell_days: 0`.
Registration before City Record award publication is kept as a signed (negative)
dwell.

**Notice strip:** pure `site/award_registration_dwell_view.mjs` + compact
`site/data/award_registration_dwell_lookup.json`; mounts `#nregdwell` on HS
award notices (payment-honesty frame when found; quiet unmatched line or clean
absence when unknown / out of corpus). Loader: `loadAwardRegistrationDwell` in
`site/app/procurement-phase.mjs`.

```bash
node tools/build_award_registration_dwell.mjs --fixture
node tools/build_award_registration_dwell.mjs --fetch-awards --fetch-passport
node tools/build_award_registration_dwell.mjs --check
node --test test/award_registration_dwell.test.mjs test/award_registration_dwell_view.test.mjs
```

Artifacts: `site/data/award_registration_dwell.json` (summary + distribution),
`site/data/award_registration_dwell_observations.json` (per-award found/unknown),
`site/data/award_registration_dwell_lookup.json` (compact by-id for the strip),
`docs/formulas/award-registration-dwell.md`,
`warehouse/receipts/proof/award_registration_dwell_latest.json`.

## Tax-lien sale progression predictions

DOF Tax Lien Sale Lists (`9rz4-mjek`) drive a BBL-exact 90 → 60 → 30 → 10 →
final-sale phase spine. `tools/build_tax_lien_sale_predictions.mjs` requires at
least three historical cycles, holds out the latest cycle for the shared
prediction scorecard, and emits `site/data/tax_lien_sale_{summary,bbl}.json`.
When the scorecard is below the per-property ship bar, property pages must show
only the BBL's published stage/outcome plus borough cohort statistics. A final
sale means the lien was sold; later foreclosure is outside this dataset and is
never predicted.

**Product surface (demote-don't-delete):** primary UI is notice/card **cycle
context** (`buildTaxLienCycleContext` / `loadTaxLienForNotice`) — not the
standalone stats page. Archive deep link `#property?view=tax-lien` keeps full
borough/NTA tables behind a disclosure. Disposition notices reuse the same
envelope via `buildDispositionCycleContext` (phase position + timing line).
Class survey + carded deferrals: `PROPERTY_CYCLE_CONTEXT_SURVEY` in
`site/tax_lien_cycle_context.mjs`. Capture:
`python3 tools/capture_tax_lien_sale_predictions.py`. Verify:
`node --test test/tax_lien_sale_prediction.test.mjs test/tax_lien_cycle_context.test.mjs test/ontology_registry.test.mjs`.

## ZAP duration, outcome base rates, and applicant conditioning

The unconditioned land model is materialized by
`tools/build_zoning_statistics.mjs` from the capped ZAP warehouse (or SODA
fallback) plus the resumable public action-status cache
(`warehouse/raw/zap-action-outcomes/`). Cohorts use action type + borough with
an n>=20 back-off; statutory clocks remain authoritative for act-by dates.

**Applicant-conditioned outcome rates (cs-pred-11)** live in the same artifact
under `applicant_conditioning` — same cohort summarizer, entity-resolution join
on `primary_applicant` (agency preferred alias + ZAP acronyms, else vendor
stem), n>=20 floor. Public UI always shows the unconditioned base rate beside
any conditioned rate; when the time-split Brier backtest does not beat the base
rate, `render_mode` is `descriptive_history` (no occurrence emission).
Formula + false-positive modes: `about.html#applicant-conditioned-ulurp`,
`docs/formulas/applicant-conditioned-ulurp-outcomes.md`.

```bash
node tools/build_zoning_statistics.mjs --applicant-only   # extend existing model
node tools/build_zoning_statistics.mjs --check
node --test test/zoning_statistics.test.mjs
python3 tools/capture_applicant_conditioned_ulurp.py
```

## Outbound action-link integrity

NYC Rules `wfw:commentRss` is syndication metadata, not a resident comment
page. Normalize it only at the RSS boundary with `normalizeRuleActionUrl` in
`worker/src/lib/rules.mjs` so action rails, timelines, and digests share the
resident-facing rule URL. The representative live sweep is
`node tools/audit-action-links.mjs --live`; it is scheduled by
`.github/workflows/action-links-live.yml` and treats City Record's HTTP-200
error redirect as a soft 404.

**Specificity class (missed-detection law):** a destination can resolve HTTP 200
and still be wrong when it is a known **generic hub** for a system that publishes
a per-item deep URL. `tools/audit-action-links.mjs` keeps
`DEEP_LINK_SYSTEMS` (OASys NOE `noe?examId=`, PASSPort `process_manage_extranet/:rfp_id`,
NYC Rules `/rule/:slug/`, ZAP `/projects/:id`) and
`assessLinkSpecificity` / `collectSpecificityFindings`. Product samples that still
point at examsforjobs / OASys home / portal roots while a deep pattern is known
are **low-specificity** findings — not OK just because the lobby loads.

## OASys exam deep links (staffing apply)

OASys `examId` ≠ DCAS exam number. Build-time map from
`GET https://a856-exams.nyc.gov/OASysWeb/api/Exam/GetActiveExams` joins on
`examNumber` → `site/data/exam_sources/oasys_exam_map.json`. Staffing rebuild
stamps `official_application_url` =
`https://a856-exams.nyc.gov/OASysWeb/noe?examId={id}` and
`application_handoff_mode: deep`. Unmapped open exams keep
`https://www.nyc.gov/examsforjobs` with label **Browse OASys exams**. Pure lib:
`tools/lib/oasys_exam_map.mjs`. Rebuild:
`node tools/build_oasys_exam_map.mjs` then
`node tools/build_staffing_exams.mjs`. Verify:
`node --test test/oasys_exam_map.test.mjs test/deadline_exam_cards.test.mjs
test/action-rail.test.mjs test/action_link_integrity.test.mjs`.

## Property list close chips + closing soon (regression bar)

- Close-date i18n uses `{date}` only (`property_commercial_close` / `_closed`). The
  intentional `$` before `{amt}` is for **price** badges (`badge_min_bid` etc.) —
  never copy that pattern onto date chips or you get `closes $September…`.
- Default `closing_soon` sorts **open soonest first**, undated next, **closed last**
  under a labeled Closed / archive section; closed cards use `property_action_closed`
  (no live bid/RFP rail). Pure helpers: `stampPropertyExplorerTemporal`,
  `sortPropertyExplorerEntries` in `site/property_explorer.mjs`.
- Detectors: `site/property_list_sanity.mjs` (currency-before-month chip lint +
  default-view past-deadline check), wired into surface-load sampling. Capture:
  `python3 tools/capture_property_date_chip_hotfix.py`.

## Map drill-through scope (list hash carry)

Map bag and area detail links must land on filtered lists through the canonical
scope adapter — not bare lens routes. All five map lenses consume the stamped
`district_activity.district_items` membership, so the number on the map and the
request IDs admitted to the list share one placement pass. Pure builders:
`mapDrillListHash`, `bucketFeedLinks`, `areaFeedLinks`, `districtBagItemIds` in
`site/map_exploration.mjs`. COUNT-EQUALS-LIST characterization:
`test/map_exploration.test.mjs`. Capture:
`python3 tools/capture_map_drill_context.py`.

## Lens filter template (Property is the reference instance)

The Property lens is the reference for the shared **lens filter template** (principles +
exemplars + capability-parity ledger in [`docs/design-principles-lens.md`](docs/design-principles-lens.md);
per-lens rollout cards in [`docs/lens-filter-template.md`](docs/lens-filter-template.md)).
Shape: one primary facet rail visible (Property = **Item type**), all secondary facets in a
`.lens-more-filters` `<details>` (the `.utility-overflow` idiom, **not** `.controls` — the
`@media(max-width:680px){.controls{display:none}}` money-tray rule would hide them); the
selected-filters summary + Clear reuses `renderSearchComponents` → `[data-search-state="property"]`
(`clear_filters_btn`); sort sits beside a visible count in `.lens-resultbar`; the process
stepper folds into a "How this list works" disclosure.

- **Small-multiples collapse (Tufte):** `clusterRepeatedEntries` (lens-neutral, in
  `site/property_explorer.mjs`) folds ≥3 near-identical single notices (agency + asset +
  stage + title-stem) into one `kind:"cluster"` card with count + date range, expandable.
  Multi-notice spines (`kind:"disposition"`) are never re-clustered.
- **Exact same-except-k collapse:** `site/same_consolidation.mjs` is the shared pure
  view-model utility for list rows whose declared displayed fields are identical except
  for one or more declared differentiators. It preserves original member rows for
  expansion and leaves exports on the raw list. The current exact activation is Staffing
  appointments (≥3 rows, person name differs); Meetings and Property retain their richer
  lifecycle/subject clustering. Guard labels and loose qualifying repeats with
  `node tools/check-collapsed-group-labels.mjs`; verify count/list/export integrity with
  `node --test test/same_consolidation.test.mjs` and
  `python3 test/functional/22_same_consolidation.py`.
- **Archive never leads:** when `propStageSel==="all"`, `renderPropExplorer` renders current
  (open/upcoming/undated) first, then the labeled closed block; when nothing is current it
  leads with the honest `property_nothing_current` line, not the archive.
- Verify: `node --test test/property_explorer.test.mjs`. Capture before/after:
  `python3 tools/capture_property_lens_reground.py` (`CROL_REGROUND_LABEL=before|after`).

## Alerts single-subscribe re-ground

`#alerts` is one subscribe flow (scope → optional refine → email → frequency → preview →
subscribe), not a 60-second wizard plus a parallel Build-an-alert form. Advanced watch types
and examples live in a closed “More ways to watch” disclosure; multi-watch rollup is behind
“Manage existing alerts” (opens on `#alerts?view=rollup`). Agency/vendor Follow writes
`#alerts?lens=entity&filter={…}` via `alerts_context_carry` (same hash contract as PR 419).
Bare `#alerts` resets the draft. Verify: `node --test test/alerts_reground.test.mjs
test/alerts_context_carry.test.mjs test/prefill_alert_from_link.test.mjs`. Capture:
`python3 tools/capture_alerts_reground.py` (`CROL_REGROUND_LABEL=before|after`).

## Council-district weekly preset

`Follow a district` is one `lens:"district"` weekly watch, not four child watches.
Preview and Worker replay both read `site/data/district_weekly_digests.json`, built by
`node tools/build_district_activity.mjs` from the existing geo-placement helpers. Action
sections are positive and honest-absent. Verify: `node tools/build_district_activity.mjs
--check` and `node --test test/district_weekly_digest.test.mjs
worker/test/district_weekly_digest.test.mjs`.

## NYCEDC project-document feed

RC-2 is the host-side, checkpointed NYCEDC workbook/minutes collector at
`warehouse/scripts/nycedc_project_documents_run.py`; its versioned reader contract is
`warehouse/schemas/nycedc_project_feed.v1.schema.json`. Re-run the deterministic gate with
`warehouse/.venv/bin/python warehouse/scripts/nycedc_project_documents_run.py --from-fixture --limit 25 --force-headroom`
then `node tools/build_subsidy_project_lookup.mjs`; verify with
`node tools/build_subsidy_project_lookup.mjs --check` and
`node --test test/nycedc_project_documents.test.mjs test/subsidy_project_panel.test.mjs
worker/test/subsidy_project_lookup.test.mjs`.
Never materialize a City Record edge unless the fixed-sample receipt clears 30% with no false
positives or unreviewed candidates; missing facts stay null, and hearing publication never
implies board approval.

## Procurement planning infrastructure (RC-1)

Host-side FY2027 MOCS LL63/LL1 XLSX collection plus Capital Projects Dashboard
`fb86-vt7u` lives in `warehouse/scripts/procurement_plans_run.py`. The production
materialization contains 11,566 MOCS rows and 50,000 capital-project rows in
the checksum manifest `site/data/procurement_planning_payload.json` and
10,000-row shards under `site/data/procurement_planning_payload/`. Re-measured
2026-08-11 on identifier-bearing plans with product passport prefix joins:
LL63→PASSPort 92/121 (76.0%), LL1→PASSPort 1/3 (33.3%), precision 1.0 — 146
bridge edges ship via `procurement_planning_thread_lookup.json`
(`site/data/procurement_plan_sources/verification_receipts/procurement_plans_2026-08-11.json`).
City Record and capital-dashboard paths remain stopped. Remeasure:
`python3 tools/remeasure_rc1_plan_passport_prefix.py --publish`. Verify with
`node --test test/procurement_plans.test.mjs test/join_gate_policy.test.mjs`.

## Non-Council minutes and vote registry

The RC-3 source inventory is
`site/data/non_council_outcome_sources/source_registry.json`: all 59 community
boards and five borough presidents are represented, but coverage is reported by
body rather than as citywide. Collectable minutes indexes expanded **8 → 17**
on 2026-08-11. The authoritative kill sample
(`verification_receipts/non_council_minutes_votes_2026-08-11.json`) still
measures **0/10** exact joins after that expansion (prior 0/10 at 8 pages
retained as `…_2026-08-04.json`). The join is **exact body + date + publisher
ULURP identifiers only** (`exact_body_date_publisher_ulurp` in
`warehouse/lib/non_council_outcomes.mjs`); slug/name matter tokens never promote.
`policy.join_bridge_enabled` remains **false** and the committed outcome lookup
is empty until **both** bars clear: usefulness ≥30% join rate **and** reviewed
precision 100% on the proposed-join sample. Precision review receipt:
`warehouse/receipts/proof/rc3_non_council_outcome_precision_2026-08-05.json`
(regenerated with the fixture collector). Rebuild/check with
`node tools/build_non_council_source_registry.mjs --check`; exercise the guarded
warehouse path with
`warehouse/.venv/bin/python warehouse/scripts/non_council_outcomes_run.py --from-fixture --limit 8 --max-docs 10`.
Verify: `node --test test/non_council_outcomes_infrastructure.test.mjs`.

The resident board source surface is built from the explicit 59-board artifact
`site/data/non_council_outcome_sources/board_source_inventory.json` joined to
the registry by `site/community-board-scorecard.mjs`; rebuild/check with
`node tools/build_community_board_scorecard.mjs --check`. Source roles and
collection states are rendered with human labels, while unresolved inventory
rows stay `absent_in_pass` internally and never become an absence claim.
The calendar/minutes role contract is rebuilt with
`node tools/build_community_board_source_inventory.mjs` and checked against the
registry with `node tools/build_non_council_source_registry.mjs --check`. The
registry's `source_roles.upcoming_meetings` and `source_roles.minutes` URLs are
authoritative; each observed role has a dated receipt, publisher origin,
fetchability/access note, archive-depth value, and role-specific stable-key
strategy in `site/data/non_council_outcome_sources/verification_receipts/`.

## Franchise/concession MOCS plan bridge

The production fixed sample of 100 modern franchise/concession notices against 11,566 FY2027
MOCS LL63/LL1 rows produced 0 identifier or reviewed title/time edges, so procurement-plan
context must not appear on the franchise timeline. Receipt:
`site/data/franchise_concession_sources/verification_receipts/franchise_mocs_plans_2026-08-04.json`.
Reproduce with `node tools/measure_franchise_mocs_plan_join.mjs` after collecting the staged
MOCS plan JSONL; verify with `node --test test/franchise_mocs_plan_join.test.mjs`.

## Neighborhood search geography

Neighborhood queries resolve through the committed NYC Planning NTA 2020
gazetteer (`site/data/neighborhood_gazetteer.json`, source dataset `9nt8-h7nd`)
and the pure matcher in `site/neighborhood_search.mjs`. Property and Land reuse
the existing community-district boundary keys, so map drill counts and list
filters stay in parity. Rebuild with `node tools/build_neighborhood_gazetteer.mjs`;
verify with `node --test test/neighborhood_search.test.mjs` and measure with
`node tools/benchmark_neighborhood_search.mjs`.
## Property typed timed events

Property notice dates are typed by `site/property_timed_events.mjs`; do not reuse a bare
`event_date` as an action deadline. Each event retains an exact source-field span, and
accommodation boilerplate must never become a bid deadline. Verify extraction, temporal
bands, and honest-empty behavior with `node --test test/property_timed_events.test.mjs`,
then rerun `node tools/property_a11y_census.mjs --as-of 2026-08-04 --format markdown`.

## Property default-feed qualification

The default Property feed is action-first: `site/property_explorer.mjs` admits an entry only
when a member has a live typed event or a source-grounded participatory action. Closed results,
passive document review, pointer notices, and honest fallbacks remain in `#property?view=archive`;
they are not deleted. Preserve the raw-notice conservation invariant and archive safety detector
in `test/property_explorer.test.mjs` when changing Property events, actions, grouping, or filters.

## Property plain-language summaries

Property detail summaries come from `site/property_plain_summary.mjs`. A classifier match alone
must never force a template: each generated fact needs an exact reader-visible source receipt,
and deviations fall back to the original City Record text. Property lens cards compose their
one-sentence lead from those accepted facts; do not add a second list-only extractor, and keep
fallback titles unchanged. The census ratchets authored-summary grade, lens-view grade, and
template coverage together. Verify the real-notice fixtures with `node --test
test/property_plain_summary.test.mjs`, then rerun the Property accessibility census.

## Learned semantic retrieval trial

The bounded MiniLM + `sqlite-vec` experiment in
`warehouse/experiments/semantic-layer-trial/` concluded `not-worth-it`: hybrid retrieval
added no successful query coverage over BM25, and the reviewed join-candidate yield stayed
below the existing usefulness gate. Keep semantic output candidate-only and do not infer a
production vector layer from the existing hashed TF-IDF T3 related-reading artifact. Source,
failure analysis, costs, and rerun commands are in
`docs/research/semantic-layer-trial-2026-08-04.md`.
The corpus sanitizer runs at ingest, must be idempotent, and reports the exact record, rule,
and matched substring on failure; do not replace that diagnostic with a generic validation error.

Production lexical notice ranking is the narrower follow-on: `worker/migrations/0016_notice_fts.sql`
owns the rebuildable D1 FTS5 index, while `worker/src/lib/notices.mjs` owns BM25 query/fallback
behavior. Keep ranked retrieval limited to explicitly adopted routes; run
`node tools/semantic_layer_trial.mjs --retrieval-only --check` and
`node --test worker/test/notices_search.test.mjs` after changing tokenization, ranking, or refresh.
Before D1 export, use `worker/sql/notice_fts_export_prepare.sql`, then replay migration `0016` on
both the live and restored databases.

## Agency cross-category constellation (v1)

- Pure model: `site/agency_constellation.mjs`. Build:
  `node tools/build_agency_constellation_documents.mjs` (+ `--check`).
- **Committed:** `site/data/agency_constellation_lookup.json` only (plus the
  directory listing `site/agencies/index.html` from
  `build_agency_documents.mjs`).
- **Build artifact (gitignored):** `site/agencies/<canonical_id>/index.html`
  — emit at build/deploy via `tools/build_cloudflare_pages.mjs` (same generator).
  Do **not** regenerate and commit these ~100 pages in capability PRs; they were
  the main rebase-collision surface. **CI / prepush full:** generate before the
  local site server (`tools/preflight-required-checks.sh --full` and the
  Accessibility job in `.github/workflows/ci.yml`) so axe, demo-links, and
  agency-scope gates hit constellation HTML — not the SPA fallback. Local
  servers serve them when present after a build; missing pages fall through to
  the interactive SPA (`?tab=`).
- Categories: contracts + meetings + rules (entity-intelligence agency edges),
  **mandates** (rules → obligations facet + process-conformance expected vs evidence), and staffing exams
  (publisher `certified_to_agency` edges **intersected with** the staffing-guide
  corpus in `site/data/staffing_exams.json` — only exams that have `/exams/:id/`
  documents are listed/counted; historical civil-service list rows alone must not
  become links). Match basis stamped
  `agency_canonical_v1+publisher_certification_record_v1+statute_actor_alias_v1`.
  Unmatched `/exams/:id/` never falls through to the SPA contracts shell
  (`handleExam` requires `data-exam-document="1"`; otherwise 404
  `exam-unavailable`). Detector: `test/agency_exam_document_links.test.mjs`.
- Edge serves constellation HTML when present; `?tab=` keeps the interactive SPA.
- **Edge object hrefs (document hosts):** `constellationObjectHref` in
  `site/agency_constellation_model.mjs` turns notice rows into `/notices/<id>`
  (never SPA `#notice/<id>` — that keeps the browser on the agency page) and
  Passport/Checkbook contract rows without a City Record notice into
  `/vendors/<stem>/`. Exact warrant chips stay `?claim=` inspectors. Rebuild
  pages after model edits. Capture: `python3 tools/capture_agency_page_links.py`.
- **Provenance inspector (EBCG general):** pure `site/graph_edge_provenance.mjs`
  attaches where/how/warrant-class claims to each listed edge. Always-on chrome
  is a subtle warrant token (`exact` / `probable` / `reviewed`); full where/how
  lives in the inspector. Deep-link `?claim=<category>:<subject_ref>` (e.g.
  `/agencies/parks-and-recreation/?claim=contracts:notice:20210514115`).
  Public list = standable edges only (tentative links stay off the page).
  Capture: `python3 tools/capture_edge_provenance_inspector.py`.
- Verify: `node --test test/agency_constellation.test.mjs test/agency_obligations.test.mjs test/graph_edge_provenance.test.mjs`.
  Demo: `/agencies/parks-and-recreation/` and demo-links
  `agency-edge-provenance-parks`.
- Agency constellation capability HTML lives in
  `site/agency_constellation_sections/`. Each module exports a section descriptor
  and is registered in `site/agency_constellation_section_registry.mjs`; keep
  `site/agency_constellation.mjs` limited to the shared document frame.

## Community-board constellation (v1)

- Pure model and renderer: `site/community_board_constellation.mjs`; materialize the
  59 board documents and committed lookup with
  `node tools/build_community_board_constellation_documents.mjs` (+ `--check`).
- Board pages under `site/community-boards/<body_id>/` are build/deploy artifacts;
  `/community-boards/` remains the aggregate source directory. The model reuses
  `edge_summary.mjs`, `local_constellation.mjs`, and civic document chrome. Keep
  meetings and institution edges `unknown` until publisher-keyed joins exist.
- Route closure and resident vocabulary are covered by
  `test/community_board_constellation.test.mjs` and the built-site
  `test/standards/rendered_schema_vocabulary.py` census.

## Agency statutory mandates (v1 free-watch)

- User-facing term and public lens is **mandates**; legacy `obligations`
  remains as alias/storage for upstream vocabulary and old watches. Pure model: `site/agency_obligations.mjs`. Shape:
  **agency → duty → deadline → recurrence**. Product copy states those facts
  plainly; machine fields (`observation.status`, quote-verify certification)
  stay off the public surface.
- Certification: **auto-certified** via mechanical quote verification
  (`auto_certified_quote_verify_v1`); quote-miss rows remain `auto_candidate`.
- Materialize from independent backfill `tools/law_mandates/output/our.json`
  (gitignored): `node tools/build_agency_obligations.mjs --input <our.json>`.
  Committed public artifact: `site/data/agency_obligations_lookup.json`.
  Fixture: `test/fixtures/agency_obligations/our_sample.json` (`--fixture`).
- Free watch (world-state, not document keyword match):
  public `lens: "mandates"` (+ legacy `obligations` alias/redirect) +
  `{ agency_id, agency }` via `agencyObligationsFollowHref` → Following /
  `compileSub` loads the lookup. Optional refinements: `deliverable_type`
  (report|rulemaking|program|data publication|other), `windowDays` (1–365), and
  exact `mandate_id` (canonical bare id or legacy `mandate:`/`obligation:` ref via
  `canonicalMandateId` — no free-text duty matching; exact watches skip the
  agency-wide window so preview ≡ digest for that duty). Sanitize fields live in
  `worker/src/lib/filter.mjs` (`LENSES.mandates` / `LENSES.obligations`); feed
  preview uses `feedItems("obligation", …)`. Confirm copy: `describeFilter` mandates line.
- Provenance: each row links `source.legistar_url` (mandate → source law) via
  `legistarMatterUrl` — Gateway `M=L&ID=` for matter ids (never
  `LegislationDetail.aspx?ID=&G=S`, which returns Invalid parameters).
- Rebuild constellation after obligations refresh so agency pages pick up the
  facet: `node tools/build_agency_constellation_documents.mjs`.

## Civic Time Ledger (as-of view)

- Compact valid-time filter on agency constellation documents: pure
  `site/civic_time_ledger.mjs` + browser `site/civic_time_ledger_runtime.mjs`,
  shareable `?as_of=YYYY-MM-DD`. UI is one-line purpose + date picker + result;
  deeper copy stays behind a `?` details affordance.
- Filters on **valid / publication** clocks on linked records only. System-time
  is not a public axis (history not retained — do not invent or surface it).
  Render the control only when `asOfFilterCanNarrow(view)` is true (≥2 dated
  items across ≥2 days); inert controls stay off the page.
- Rebuild pages with `node tools/build_agency_constellation_documents.mjs`.
  Verify: `node --test test/civic_time_ledger.test.mjs test/agency_constellation.test.mjs`.
  Capture: `python3 tools/capture_civic_time_ledger.py`. Demo:
  `/agencies/parks-and-recreation/?as_of=2024-06-01`,
  `/agencies/probation/?as_of=2024-06-01`.


## Process conformance · expected vs evidence (v1)

- First praxis surface for process mining / conformance-checking on civic
  lifecycles: per-mandate **expected** civic event (rule filing, report, …) +
  deadline vs whether matching **evidence** appears in current sources.
- Pure model: `site/process_conformance.mjs`. Build:
  `node tools/build_process_conformance.mjs` (+ `--check`). Artifact:
  `site/data/process_conformance_lookup.json`. Capture:
  `python3 tools/capture_process_conformance.py`.
- Reader labels are **evidence-relative** (not City Record-relative): Evidence
  found · Expected; no matching evidence in current sources · on track ·
  awaiting an evidence detector. Keep machine status keys (`observed`,
  `expected_not_yet_observed`, …) and `is_compliance_verdict: false` /
  `data-compliance-verdict="not_adjudicated"`. Matched evidence links use the
  filing title + ↗ only — never a primary "City Record" button. Join only when
  the public-record signal is reliable; otherwise leave enrichment pending —
  never invent observations.
- v1 detectors: `rulemaking` and `report` against Agency Rules / report-shaped
  City Record notices (agency identity + topic-token join). Other deliverable
  types wait for a stronger detector.
- **Report densify:** `site/data/reports_domain_observations.json` via
  `node tools/build_reports_domain_observations.mjs` (Special Materials annual
  reports; excludes concept papers and procurement). Structural join
  `city_record_annual_report_publication_v1` when a duty requires publishing an
  annual report in the City Record. Demo: CCHR
  `/agencies/commission-on-human-rights/#mandates-reports`.
- Rulemaking evidence stamps are derived by the pure
  `site/rule_evidence_stamps.mjs` extractor. The rules snapshot builder reads
  source body fields transiently, commits only bounded topic/citation keys,
  lifecycle/date enums, and discards the prose. When SODA bodies are empty,
  `node tools/densify_rule_evidence_attachments.mjs` densifies from City Record
  GetFile PDFs (bounded, polite). Citation match requires a **strong** key
  (`nyc-charter:*` / `nyc-admin-code:*` / subsection-bearing `section:*`) —
  bare `section:1` never publishes. `normalizeObservationCandidate` and
  `evaluateRuleEvidence` consume the stamp through the existing `mandate_rule`
  policy gate. Refresh rules alone with
  `node tools/build_rules_meetings_domain_observations.mjs --rules-only`; then
  attachment densify + `node tools/build_process_conformance.mjs`. Verify with
  `node --test test/rule_evidence_stamps.test.mjs test/rule_attachment_densify.test.mjs`.
  Demo: Sanitation CWZ `/agencies/sanitation/#mandates-rules`.
- Surface: agency constellation `#mandates-conformance` (shareable
  `/agencies/<id>/#mandates-conformance`). Seams left for full event logs and
  Process Mining Manifesto enrichment later.
- Verify: `node --test test/process_conformance.test.mjs test/reports_domain_observations.test.mjs`.
  Measurement: `docs/evidence/mandate-graph-densify/join-measurement.json`.

## Mandate graph neighbors (mandate-specific, not agency-wide)

- **Per-row only:** **Source law** (exact `matter_id` / `source.legistar_url`)
  plus optional real mandate→entity chips via `mandate_links` /
  `mandateScopedLinksFromRecord`. Never paint agency-wide
  `agencyCategoryBrowseHref` chips on every mandate card — that looked like
  “connections” while linking the whole agency (`published_by_agency` /
  `agency:id`), identical across mandates.
- **Section chrome only:** honest **Browse agency Rules / Meetings / Contracts**
  (`data-scope="agency"`) via `renderMandateSectionNeighborActions`.
- Pure helpers: `site/mandate_graph_neighbors.mjs` (honest H2/nav titles when
  `observed_links` / `filing_receipts` are 0 — no “Filing receipts” claim without
  a receipt). Wired into rules / reports / predictions / conformance renderers.
- Never fabricate mandate→entity filing edges; densify waves are separate.
  Coverage is sparse today (citywide process-conformance observed edges are few;
  notice reverse-backlinks remain the public edge inventory).
- Verify: `node --test test/mandate_graph_neighbors.test.mjs`. Capture:
  `python3 tools/capture_mandate_graph_01.py` and
  `docs/screenshots/mandate-edges-specific/`. Demo:
  `/agencies/environmental-protection/#mandates-rules`,
  `/agencies/parks-and-recreation/#mandates-rules`.

## Mandates → Rules constellation card (v1)

- Agency-level bridge from **rulemaking** mandates (`deliverable_type =
  rulemaking`) to the agency's **Rules-lens** City Record filings on the
  constellation. Join path: mandate → agency identity → Rules records;
  per-mandate observed filings reuse process-conformance topic joins when they hit.
- Pure model: `site/mandate_rules_bridge.mjs` (`buildMandateRulesBridgeView` /
  `renderMandateRulesBridgeSection`). Wired from
  `site/agency_constellation.mjs` as `view.mandates_rules`. Shareable
  `/agencies/<id>/#mandates-rules`. Section scopes: Browse agency Rules,
  Watch rulemaking mandates (obligations free-watch), Follow Rules activity.
  Per-row actions: see **Mandate graph neighbors** above (Source law + real
  linked filings only).
- Rebuild: `node tools/build_agency_constellation_documents.mjs`. Capture:
  `python3 tools/capture_mandate_rules_bridge.py`. Verify:
  `node --test test/mandate_rules_bridge.test.mjs`. Demo Parks:
  `/agencies/parks-and-recreation/#mandates-rules`.

## Mandates → Required Reports receipt card (v1)

- Agency-level bridge from **report** mandates (`deliverable_type = report`) to
  an observed City Record **filing receipt** when process-conformance topic join
  hits. Unmatched mandates list duty + deadline only — no absence caveats.
  H2 says “Filing receipts” only when `filing_receipts > 0`.
- Pure model: `site/mandate_reports_receipt.mjs` (`buildMandateReportsReceiptView`
  / `renderMandateReportsReceiptSection`). Wired from
  `site/agency_constellation.mjs` as `view.mandates_reports`. Shareable
  `/agencies/<id>/#mandates-reports`. Watch scope: report free-watch.
- Rebuild: `node tools/build_agency_constellation_documents.mjs`. Capture:
  `python3 tools/capture_mandate_reports_receipt.py`. Verify:
  `node --test test/mandate_reports_receipt.test.mjs`. Demo Parks:
  `/agencies/parks-and-recreation/#mandates-reports`.

## Mandates prediction-alerts (capstone)

- Deadline/recurrence → expected public-record event for **rulemaking** and
  **report** mandates so free-watch digests fire earlier-stage alerts ahead of
  the deadline (scenario: mandate → predicted event → alert → later observed).
- Pure model: `site/mandate_prediction_alerts.mjs` (`projectExpectedDeadline`,
  `buildMandatePrediction`, `mandatePredictionDigestRowsForAgency`,
  `renderMandatePredictionsSection`). Method `mandate_deadline_cadence_v1` —
  no ML; seam for richer models later. Never invents undated calendar days.
- Digest: `compileSub` obligations lens merges prediction rows into the free-watch
  transform; email HTML + feed summary name expected event + days-to-deadline.
- Surface: `view.mandates_predictions` on agency constellation; shareable
  `/agencies/<id>/#mandates-predictions`. Rebuild constellation after model
  edits: `node tools/build_agency_constellation_documents.mjs`.
- Capture: `python3 tools/capture_mandate_prediction_alerts.py`. Verify:
  `node --test test/mandate_prediction_alerts.test.mjs`. Real-data digest
  field case: NYPD annual/quarterly report roll-forward within 90 days.
  Demo Parks: `/agencies/parks-and-recreation/#mandates-predictions`.


## Checkbook Spending payment retention

Host-side bulk path for individual Checkbook payment rows (not spent-to-date
summaries only): `warehouse/scripts/checkbook_spending.mjs` + pure
`warehouse/lib/checkbook_spending.mjs`. Seeds the population-backed Checkbook
Contracts graph, pulls Spending by `contract_id` (PIN rejected on Spending),
retains each payment as a `source_records`-shaped snapshot
(`checkbookSpendingSourceSystemId`), and measures payment↔contract usefulness +
precision. Materialize the graph slice only when usefulness ≥30% and precision
≥95%. Residual pin recovery reuses `pin_prefix_of_epin` from
`worker/src/lib/passport_join.mjs`. Request-time dual-write remains
`CHECKBOOK_SOURCE_RECORD_DUAL_WRITE` on lifecycle. Receipt:
`site/data/checkbook_spending_sources/verification_receipts/checkbook_spending_payment_retention_2026-08-11.json`.
Verify: `node --test test/checkbook_spending_collector.test.mjs` and
`node warehouse/scripts/checkbook_spending.mjs --check`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
