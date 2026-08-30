# Project agent memory

- **WH-02 bulk revival:** `warehouse/scripts/verify_bulk_receipts.py --check` validates the
  committed four-source manifest and receipts while warning when intentionally gitignored
  raw/Parquet artifacts are absent locally. `warehouse/scripts/ingest.py --resume` revalidates
  stage metadata and checkpoint page hashes before reuse; bulk runs require a real headroom probe.

- **WH-04 ER replay:** `warehouse/lib/er_batch.mjs` pins warehouse batches to the WH-02 OCP
  snapshot, resumes only after checkpoint hash/limit/stage revalidation, and keeps unresolved
  or rejected pairs out of identity. Promotion past the 200-row proof stays blocked.
  `warehouse/scripts/verify_er_batch_receipt.py --check` validates the committed receipt.

- **Action Path v0:** `site/action_path_v0.mjs` is the pure, actorless projection over the
  authoritative `site/action_registry.js` action object. It requires provenance-bearing evidence,
  preserves multiple continuation candidates without selecting one, and suppresses unsupported or
  lossy scope continuations; focused proof is `test/action_path_v0.test.mjs`.

- **Post-event outcome transitions:** `site/civic_outcome_transition.mjs` is the pure,
  source-backed projection for consequential rulemaking adoption/effectiveness and Council
  matter action/vote updates. `worker/src/lib/alert_temporal.mjs` reconciles exact Rules follow
  subjects with one-shot transition keys; unchanged refreshes stay silent. Focused proof is
  `test/civic_outcome_transition.test.mjs`.

- **Exact continuation replay:** `worker/src/lib/continuation_replay.mjs` is the pure fail-closed
  capability over scope-v0, Following, SODA, and D1. The current exact relation family is bounded
  `rules.request_ids` membership; matter and broad/body-level fallbacks remain unsupported. Proof
  is `worker/test/continuation_replay.test.mjs`.

- **Council hearing matter continuation:** `site/council_hearing_matter_continuation.mjs` projects
  only the materialized `exact_date_body_tokens` City Record → Council join; it preserves every
  exact matter, keeps multiple matters as choices, and omits continuation for unmatched/no-matter
  cases. `site/council_hearing_action_path.mjs` composes that projection through Action Path v0;
  proof is `test/council_hearing_matter_continuation.test.mjs`.

- **Generic person contract:** `ontology/person.mjs` owns the additive
  `cityscroll.person.v1` source-qualified envelope and `person_identity_link.v1` reviewed
  `same_person` relation. It never rewrites `official:{PersonId}` or
  `community-board-person:{board}:{key}` identities and its capability allowlist keeps generic,
  Community Board, agency, and vendor-contact profiles out of Council-only surfaces. No generic
  person route or source adapter is implied; focused proof is `test/person_ontology.test.mjs`.
  Representation inventory and source-identity seam:
  `docs/evidence/person-representation-inventory.md`,
  `docs/adr/person-source-identity-seam.md`.

- **Community Board people and roles:** `site/community_board_relations.mjs` is the source-qualified,
  board-local contract for `community-board-person` identities and temporal role edges. Keep these
  distinct from Council `official` identities and routes; refresh the grounded CB people artifact
  with the constellation builder and verify with `test/community_board_people.test.mjs`.

- **Community Board search projections:** `site/board_search_producer.mjs` owns board-local
  `community-board-committee` SearchDocuments; `site/community_board_people_search_producer.mjs`
  owns grounded `community-board-person` documents. Both feed the keyword index as separate typed
  objects with board context; keep `site/committee_search_producer.mjs` Council/Legistar-specific
  and rebuild with `node tools/build_keyword_search_index.mjs`.

- **Keyword index delivery:** `site/keyword_search_index_shards.mjs` owns the compressed,
  family-sharded keyword index manifest and integrity checks. `node tools/build_keyword_search_index.mjs`
  regenerates the committed gzip/Brotli shards; `--check` fails closed when the source projection
  differs. `tools/build_worker_d1_read_models.mjs` consumes the family shards directly, so the
  removed monolithic JSON must not be reintroduced as a D1 build input.

- **Independent Checkbook payment population (AP-08):** `warehouse/payment_populations.v0.json`
  declares the fiscal-year `Spending` API acquisition separately from the bounded
  `warehouse/scripts/checkbook_spending.mjs` graph-enrichment collector. The acquisition script
  streams page-level normalization, identity measurement, CSV output, and reconciliation; its
  committed receipt and agency proof are under `warehouse/receipts/proof/`. Do not use the
  contract-enrichment row count as a spending denominator.

- **Procurement Intent Radar Phase 0:** `test/fixtures/procurement_intent_radar/gold_fixtures.v0.json`
  and `test/fixtures/procurement_intent_radar/schema.v0.json` are the versioned gold/negative
  contract for future-action extraction; the executable gate is
  `test/procurement_intent_radar_fixtures.test.mjs`. Keep upstream source fields temporally
  sealed and keep `retained_data_present` false until exact EPIN rows are actually retained.

- **Procurement Intent Radar corpus backtest:** `tools/backtest_procurement_intent_radar.mjs`
  emits the deterministic JSON/report pair under `warehouse/fixtures/procurement-intent-radar/`
  and `docs/evidence/procurement-intent-radar/`. It evaluates each assertion at its meeting-date
  cutoff through the shared prediction evaluator; the current five-case gold pack is measured but
  bounded, so promotion remains withheld until a recurrent 2022–2025 corpus is retained.

- **Community Board payroll staff counts (CB-MONEY-06):**
  `site/community_board_payroll_identity.mjs` binds Citywide Payroll
  `payroll_number` to `community-board:{borough-cb-NN}` using the CB-MONEY-00
  expense-budget code roster and reviewed exact `agency_name` labels, including
  Staten Island's publisher `COMMUNITY BD` spelling. Rebuild the ACTIVE-row
  staff-count artifact and receipt with
  `node tools/build_community_board_payroll_staff_count.mjs`; `--check` verifies
  them. Per-board dollars and title mix stay withheld while every board is below
  the five-row suppression floor. Employee rows are never served. Do not extend
  CB-MONEY-00 `FINANCIAL_SOURCES`. Focused proof is
  `test/community_board_payroll_identity.test.mjs`.

- **Adopted Community Board budget facts (CB-MONEY-01):** `site/community_board_adopted_budget.mjs`
  materializes the pinned Expense Budget fiscal-year/publication slice only after exact
  `site/data/community_board_financial_identity_crosswalk.json` resolution. Rebuild the source-
  qualified read model and receipt with `node tools/build_community_board_adopted_budget.mjs`;
  `--check` verifies the CB-MONEY-00 artifact hash and slice. Components are published only when
  the source P/O indicator semantics reconcile; unmatched rows remain in the receipt.

- **Historical land-use Council actor resolution (LUP2-C3):**
  `worker/src/lib/land_prediction_actor_resolution.mjs` joins each application location to a
  temporally valid Council boundary and the person hub's historical `terms[]`, emitting only exact
  `official:{PersonId}` identities. It never uses `current_term` or a current district as a
  historical fallback; missing, conflicting, and unqualified boundary/term evidence remains
  explicit `unknown`, while source-backed vacancy records emit `vacant`. Multi-location results
  preserve one district/officeholder row per location. Focused proof is
  `worker/test/land_prediction_actor_resolution.test.mjs`.

- **Project-specific Council stance (LUP2-C4):**
  `worker/src/lib/land_prediction_member_stance.mjs` is the source-preserving application/member
  evidence contract. Its resolver keeps confidence separate from direction, makes latest-clock
  conflicts explicit as `mixed_or_unclear`, preserves superseded history, and never turns unknown
  or political proxies into a stance. Focused proof is
  `worker/test/land_prediction_member_stance.test.mjs`.

- **Stage-aware institutional feature vector (LUP2-C5):**
  `worker/src/lib/land_prediction_features.mjs` adapts the C2 snapshot and C4 stance contracts
  into one cutoff-aware layer with explicit sparse-feature unknowns, evidence traces, and a
  learnable local-member-by-stage interaction. It supplies no coefficients or veto rule; focused
  proof and the contract shape are in `worker/test/land_prediction_features.test.mjs` and
  `docs/land-use-prediction-features-v1.md`.

- **Interpretable land-use predictor (LUP2-C6):**
  `worker/src/lib/land_prediction_predictor.mjs` fits a deterministic, regularized logistic model
  only from outcome-after-cutoff C5 vectors, measures Brier/log-loss calibration, and emits
  evidence-linked feature-state explanations. It remains `shadow_only_until_backtest_gate`; the
  incumbent `land_prediction_baseline_v1` is retained through `predictLandUse` fallback behavior.
  Focused proof is `worker/test/land_prediction_predictor.test.mjs` and usage is documented in
  `docs/land-use-prediction-predictor-v2.md`.

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- **Source-preserving civic institutions:** `ontology/civic_institution.mjs` defines the additive
  `cityscroll.civic_institution.v1` envelope, exact-only `cityscroll.entity_link.v1` from retained
  source observations, and the institution-to-institution
  `cityscroll.civic_institution_role_edge.v1` contract. Role edges reuse civic-institution
  identities, keep unknown/held/unresolved non-linking, and project `agency:id:*` plus legacy
  relation ids as compatibility. Agency profiles materialize identity disclosure through
  `tools/lib/agency_identity_evidence.mjs`; focused proof is in
  `test/civic_institution.test.mjs`, `test/civic_institution_role_edge.test.mjs`, and
  `test/civic_institution_profile.test.mjs`.

- Add durable project-specific notes here as they are discovered through real work.
- **Legacy repository-name prevention:** `tools/check_stale_repo_name.mjs` is the CI and local
  check-runner gate; retained compatibility and historical lines are documented in
  `.github/legacy-name-allowlist.txt`, with focused proof in
  `test/stale_name_guard.test.mjs`. `--write` remaps exact-line entries and drops stale
  ones; it never allowlists a new occurrence. In CI (`LEGACY_ALLOWLIST_BASE_SHA`) a new
  allowlist entry must cover content already present at the merge-base with `main` — the
  growth rule, including `future:` semantics, is documented in the allowlist header.

- **PASSPort RFx procedural state (PLA-01):** `site/procurement_process_events.mjs` projects
  retained `passport_public_rfx` observations into explicit, source-receipt-linked canonical
  states while preserving the literal publisher status. The shared materializer is
  `tools/build_shared_procurement_read_model.mjs`; focused proof is
  `test/procurement_process_events.test.mjs`.

- **Observed procurement-event strip (PLA-02):** `site/procurement_process_events.mjs` also
  projects City Record, PASSPort/Checkbook contract, and payment observations into the same
  chronological `process_events` list. `site/procurement_document.mjs` renders one
  `#procurement-process` strip of observed events with source-record expansion and omits
  unobserved intermediates; legacy `stages` remain on the object. Focused proof is
  `test/procurement_process_events.test.mjs`.

- Release-surface reconciliation: tools/release_surface_reconciliation.mjs is the typed,
  fail-closed join for production release evidence. tools/worker_trigger_coverage.mjs derives
  local Worker imports and verifies that both Worker trigger surfaces cover them; the focused gate
  is node --test test/release_surface_reconciliation.test.mjs && node tools/check_release_surface_reconciliation.mjs --check.
- **Deployment-health receipts:** `tools/deployment_health_receipt.mjs` is the independent
  Pages/Worker boundary receipt plus set-completeness check. The required production set is
  exactly Cloudflare Pages and Cloudflare Worker in `docs/release/cloudflare-native-builds.json`.
  Each deploy workflow writes `.artifacts/deployment-health/<boundary>.json`; reconciliation is
  COMPLETE only when both receipts are independently verifiable and match the merged SHA.
  Digest/scheduler watchdog receipts and the aggregate release-surface receipt are not substitutes.
  Proof: `test/deployment_health_receipt.test.mjs` and
  `node tools/check_deployment_health.mjs --check`.
- **Public-site generation postcondition:** `tools/build_public_site.mjs` calls
  `tools/generation_output_guard.mjs` after copying the public tree. The guard requires a
  non-empty `index.html`, writes `.artifacts/generation-output-receipt.json`, and fails before
  delivery when the required entrypoint is missing; regression coverage is in
  `test/generation_output_guard.test.mjs`.
- **Card-projection reconciliation completeness:** `tools/card_reconciliation_guard.mjs`
  compares a source card inventory with declared projection paths by stable card id.
  Missing, omitted, stale, mismatched, or malformed inventories fail closed and name the
  card plus the affected projection; a complete check does not rewrite card status.
  Sibling projections stay represented when one projection is incomplete. Verify with
  `node tools/check_card_reconciliation.mjs --check` and
  `test/card_reconciliation_guard.test.mjs`. Keep this guard separate from generation-output
  and freshness checks.

- **Owner-proof evidence store:** `tools/evidence_store.py` writes immutable WebP/AVIF captures
  to SHA-256 content-addressed objects and a PR/card/phase/viewport receipt index; the
  content-parity harness records both required full-page viewports and rejects local-only URLs.
  Verify the store with `node tools/verify_evidence_store.mjs --check`; functional goldens stay
  in-repo and CI installs `tools/requirements-evidence-store.txt` for the DuckDB index backend.

- **Registered-contract analytical projection:** `site/analytical_projection_contract.mjs` is the
  versioned AP-01 registry; `tools/build_analytical_registered_contracts.mjs` materializes the
  full normalized Checkbook population into `site/data/analytics_registered_contracts.json` and
  `warehouse/receipts/proof/analytics_registered_contracts_population_latest.json`. The
  Contracts Compare / Overview panel in `site/app/money-list.mjs` reads that precomputed artifact
  only in Recent Awards mode. Group links use `ap_agency` / `ap_vendor` plus optional FY and
  amount filters so the ordinary Contracts list can drill into the same population slice.
  City Record exact/none/missing-PIN coverage is a closed Data coverage/methodology disclosure
  at `#contracts-analytics-coverage`, not first-paint matrix chrome; copy reports whether
  CityScroll found an exact notice.

- **Actual-payments analytical fact (AP-09):** `site/analytical_payment_projection.mjs` and
  `site/data/analytics_payments.json` are the separate AP-08 payment fact. The Compare / Overview
  view switches between registered-contract value and actual payments, preserving agency/vendor/
  fiscal-year filters while visibly dropping fact-specific filters. Payment groups link to their
  payment transaction scope and related registered-contract scope; do not blend their dollar
  measures or use the bounded graph-enrichment payment rows as a population denominator.

- **Newer and alternate source registry (SV-2):** `site/data/source_vintage_alternates.json` is the
  source-qualified registry for verified newer or alternate official publication paths. Validate it
  with `node tools/verify_source_vintage_registry.mjs`; `tools/source_vintage_status.mjs` consumes
  the registry through `loadSourceVintageStatusInputs`. The founding Comptroller ACFR entry is
  contextual evidence for IBO and is never a drop-in replacement for IBO staffing semantics.

- **IBO agency fiscal history (AP-11):** `warehouse/scripts/ibo_fiscal_history.py` ingests the
  checkpointed FY2022 IBO Agency Expenditures and Actual Full-Time Positions XLSX artifacts under
  `warehouse/sources/ibo-fiscal-history/`. It keeps publisher units, fiscal-year-end staffing
  semantics, source labels, and unresolved identity decisions; regenerate the deterministic
  materialization and receipt with the command in `docs/ibo-fiscal-history.md`.

- **Public performance-evidence coverage (AP-10):** `site/analytical_performance_evidence.mjs`
  is the separate source-bounded projection for public performance terms and evaluation documents.
  `tools/build_analytical_performance_evidence.mjs` materializes its contract-scoped states and
  exact source passages. Missing passages remain `no-located-evidence` and unresolved; this state
  never implies an outcome, vendor failure, or performance score. Keep the financial registered
  contract and payment facts separate from this evidence-availability fact.

- **Agency procurement fiscal context (AP-12):** `site/agency_fiscal_context.mjs` joins the AP-03
  registered-contract and AP-09 payment projections to AP-11 only through a matched canonical
  agency identity. Authoritative IBO rows are accepted only for exact canonical IDs; an explicit
  legacy context may fill an agency absent from IBO as an internal fallback and never enters IBO
  rankings. Its materialization is `site/data/agency_fiscal_context.json`, refreshed with
  `node tools/build_agency_fiscal_context.mjs`; missing fiscal history stays `unknown`, and the
  renderer keeps expenditure, staffing, registered value, and payments as separate measures with
  source provenance and drill-through links. Focused proof is `test/agency_fiscal_context.test.mjs`.

- **Vendor concentration projection:** `vendorConcentration` in
  `site/analytical_projection.mjs` computes agency-scoped prime-vendor shares from the
  explicit selected-scope registered-value denominator. Named-vendor top-5/top-10 shares
  exclude the separately displayed `Unknown / not published` bucket; use
  `test/analytical_projection.test.mjs` and
  `test/functional/29_procurement_analytical_projection_drillthrough.py` for focused proof.

- **Observer-coverage canaries:** `architecture/observer-canaries.json` is the
  single registration for architecture-affecting surfaces. Facts
  `observer_coverage`, the reconciliation workflow path filter, and the
  watermark all consume that list — do not infer it or hand-maintain a second
  canary inventory. `tools/build_architecture_facts.mjs` emits
  `observed_paths`, `known_canaries`, and `unmapped_surfaces`. The extractor
  first-class-observes production search (`worker/src/search.mjs` collection
  families), the keyword-index builder, constellation model/producers/materializer
  plus the PASSPort graph ceiling, Exams public-eligibility, Pages-edge
  routes and renderer, and the primary-document materializer.
  A remaining registered canary must be observed the same way or acknowledged
  by ADR — do not silence `unmapped_surfaces`. The reconciler treats a
  non-empty `unmapped_surfaces` set as first-class `unknown_surface` drift.
  `test/architecture_path_coverage.test.mjs` fails if a listed path is absent
  from `.github/workflows/architecture-reconciliation.yml` trigger paths; keep
  `site/**` and `tools/build_*.mjs` on that filter so search, constellation,
  and materializer canaries fire CI. Advance the compact watermark at
  `architecture/generated/watermark.json` with an explicit reviewed
  `node tools/reconcile_architecture.mjs --write-watermark`, never as a
  `--check` side effect. Watermark-vs-current-facts fingerprint drift is the
  reconciler `--check` (advisory architecture job), not a Unit assertion.
  Proof: `test/architecture_facts.test.mjs`,
  `test/architecture_path_coverage.test.mjs`,
  `test/architecture_watermark.test.mjs`, and
  `test/reconcile_architecture.test.mjs`.

- **Near You generic geography spine:** `tools/lib/district_activity.mjs` materializes
  the role-, basis-, source-, and vintage-preserving `place.geographies` envelope plus
  the `geography_items` membership index consumed by Near You and geography-watch
  replay. The public scope allowlist is borough, Community District, Council District,
  NTA 2020, and Police Precinct; Sanitation District and BID remain ingestion-only.
  Legacy `boro` / `cd` / `council` routes and watch fields remain compatibility wires.
  Rebuild with `node tools/build_district_activity.mjs`; focused proof is
  `test/near_you_geography_scope.test.mjs`, `test/scope_v0.test.mjs`, and
  `worker/test/alerts_geography_scope.test.mjs`.

- **Architecture doc invariant consistency:** `docs/architecture.md` is the canonical
  engineer register; its resident-read section carries the authoritative invariant from
  `architecture/resident-read-policy.json`. `tools/reconcile_architecture.mjs --check`
  treats a contradictory request-time publisher-read assertion in root `ARCHITECTURE.md`
  as drift. The root narrative may summarize or link but must not grant behavior the
  canonical invariant forbids. Proof: `test/reconcile_architecture.test.mjs`.

- **Architecture canary backtest + change-history (LA11):**
  `tools/backtest_architecture_canaries.mjs --check` replays the frozen set in
  `architecture/backtests/frozen-set.json`. Seeded cases are land-action
  collapse plus PRs #1076 (constellation ceiling), #1058 (Committees→search),
  and #1056 (Exams eligibility). Visibility cases go through
  `tools/architecture_canary_visibility_observer.mjs`; land-action stays on
  `tools/architecture_land_action_observer.mjs`. The live
  `filterLandSnapshot` binding now admits default-review ELURP (`2024Q0356`);
  silent drop remains the frozen/synthetic drift fixture, not the current
  list. Change-history is projected from committed watermarks by
  `tools/architecture_change_history.mjs` — no full-facts retention.
  Proof: `test/architecture_history_backtest.test.mjs` and
  `test/architecture_land_action_collapse.test.mjs`.

- **Cited semantic retrieval:** `worker/src/cited_retrieval.mjs` is the
  retrieval-only adapter from `worker/src/semantic_candidates.mjs` into the
  transport-neutral `capabilities/cited_passages.mjs` contract and versioned
  MCP `retrieve_cited_passages` structured output. The MCP structured content
  must remain byte-compatible with the direct provider. A citation is
  `matched` only when candidate, source-passage map, and corpus-manifest IDs
  agree exactly; missing evidence remains `unknown`, and the contract never
  emits answers or civic relationships. Ask CityScroll quotes those matched
  citations through `site/ask_cited_synthesis.mjs`; `/nl` emits `cited_quotes`
  as a sibling and the Ask card never generates answers, relationships, or
  legal conclusions. Focused proof:
  `worker/test/cited_passages_capability.test.mjs`,
  `worker/test/cited_retrieval.test.mjs`,
  `worker/test/mcp.test.mjs`, and `test/ask_cited_synthesis.test.mjs`.

- **Mandate category conformance:** `site/mandate_category_conformance.mjs` is the
  adapter from the meeting, contract, and land-use bridge read models into the
  shared `site/process_conformance.mjs` surface. Relation-specific bridges still
  own evidence and publication gates; the adapter owns the cross-category
  `appeared` / `not_yet_observed` / `data_incomplete` projection and one
  data-as-of. `tools/build_process_conformance.mjs` materializes accepted edge
  claims in `edge_observations`; keep claim-inspector links attached to every
  appeared edge. The report detector treats an extracted deadline as the first
  cycle only for an explicit repeated cadence; agency and topic evidence remain
  required for later-cycle filings. Focused proof: `test/process_conformance.test.mjs`
  plus the three mandate bridge tests.

- **Agency procurement conformance:** `site/agency_lifecycle_conformance.mjs` aggregates the
  bounded case envelopes from `site/procurement_event_log.mjs` into expected stages, observed
  traces, stage completeness, and method-labeled deviation counts. Publication is fail-closed
  when a case key or event clock is incomplete. Refresh the committed lookup with
  `node tools/build_agency_lifecycle_conformance.mjs`; focused proof remains in
  `test/process_conformance.test.mjs`.

- **Procurement publication policy:** `ontology/registry.v0.json` contains the versioned PPB
  Rule § 3-08 method/stage registry; `ontology/procurement_policy.mjs` is its fail-closed
  resolver. A `not_required` obligation requires an exact method-family, category, amount, and
  effective-date match. Publisher-label ambiguity or source absence remains `unknown` coverage,
  never a legal exemption. Focused proof: `test/procurement_policy_registry.test.mjs`.
- **External award vendor links:** `site/app/money-history.mjs` keeps vendor labels in ABO/Checkbook
  award panels as plain text because `/vendors/:name/` is a City Record award profile and cannot
  show those external-source rows. Keep the external source link scoped to its source dataset or
  contract record; do not reuse the generic vendor pivot without a cross-source profile join.
  Focused proof: `test/external_awards.test.mjs`.
- **Procurement coverage labels:** `site/procurement_coverage_labels.mjs` is the resident
  projector. Ordinary matched small-purchase rows may say public solicitation is not required;
  M/WBE award-notice absence renders only after `required` plus `source_checked_no_record`.
  Put counts in the sentence (`N observed, publisher reports M`); empty facets stay silent
  without a publisher figure; never emit an always-on incompleteness caveat or a compliance
  verdict. Exact publisher labels only — variants stay unlabeled. Proof:
  `test/procurement_coverage_labels.test.mjs`.

- Committee traversal exposes `public_reverse_edges` from the same accepted
  `member_of` observation in `site/committee_graph.mjs`; browse renders the
  exact-ID `has member` pivot, while held/empty/unknown graph states stay
  non-linking. Official-profile committee names use a diamond constellation
  link only for those exact BodyId routes; unverified names stay ordinary
  `ui-static-fact` text. Exact published BodyIds resolve through the edge-rendered
  `/committees/<id>/` document in `site/committee_document.mjs`; official profiles and the
  People directory may link only to that closed route. Focused proof:
  `test/committee_graph.test.mjs`, `test/committee_memberships.test.mjs`,
  `test/official_profile_committee_graph.test.mjs`, and `test/primary_document_routes.test.mjs`.

- Community-board `hosts_meeting` edges live beside the exact source join in
  `site/community_board_source_join.mjs` (re-exported by
  `site/community_board_institution_edges.mjs`). They target
  `meeting:{source}:{key}` only after exact board/date/publisher evidence plus a
  retained receipt and URL; held edges retain typed identity but never an
  `href`. Board, Browse, and meeting-document pivots consume that same edge
  payload. `tools/build_community_board_constellation_documents.mjs` recovers
  missing carried edges from source-native rows through
  `communityBoardMeetingEdgeFromSourceRow`, using the index generation time as
  the freshness clock; only accepted edges enter board-page meeting counts.
  Focused proof: `test/community_board_institution_edges.test.mjs` and
  `test/community_board_meeting_lens_parity.test.mjs`.

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
- **People/Staffing/Exams surface identity:** `site/browse_surface_contracts.mjs` is the sole
  registry for their public route, source domain, navigation family, and logical
  builder/controller owners. Their independent row/view owners are
  `site/people_organizations_surface.mjs`, `site/staffing_surface.mjs`, and
  `site/exams_surface.mjs`; Staffing and Exams hydrate through their matching `site/app/`
  controllers. Legacy hashes translate by intent only in `site/route_migration.mjs`; never add an
  active-runtime alias between owners. Focused proof: `test/browse_surface_contract.test.mjs`,
  `test/primary_document_routes.test.mjs`, and `test/route_migration.test.mjs`.
- **Exams Interest Area multi-select + public eligibility:** records keep a single
  `interest_area` (optional `interest_areas` preserved when present). Browse selects many
  areas with OR matching via `CrolStaffing.normalizeInterestSelection` /
  `filterExams`; URL wire is sorted `interest=a,b` (single-id links stay valid).
  "Anyone who qualifies" is fail-closed `open_competitive` only
  (`eligibilityFor` + `isPublicEligibility`) — promotion/internal/unknown never
  silently count as public. Interest counts are under-current-filter. Proof:
  `test/exams_interest_eligibility_multiselect.test.mjs`.
- Place-scoped Property routes use `site/property_scope_fallback.mjs`: if the scoped current
  view is empty but the same scope has closed records, the route opens the archive view so a
  valid place link does not present a misleading empty result. Coverage is in
  `test/property_scope_fallback.test.mjs` (fixture: `test/fixtures/property_scope/`).

- **Agency-head entities:** `entity_resolution/leaders/index.mjs` materializes publisher-backed
  `person-leader` entities from `worker/src/data/agency_crosswalk.json`; `/agency` exposes the
  descriptor and the agency profile renders a strong, agency-scoped link. Use
  `entity_resolution/referents/index.mjs` for named heads, agency-scoped role mentions, and
  exact unique opaque aliases only. Unscoped or ambiguous referents remain plain text.
- **Ask/device entity phrasing:** `site/canonical_entity_interpretation.mjs` is the request-path
  adapter over `canonicalAgency` / `resolveAgencyIdentity` (`site/agency_identity.mjs`,
  re-exported by `entity_resolution/normalizers/agency.mjs`) and optional reviewed
  `entity_resolution/review/alias_registry.json` names. Unique reviewed hits may emit
  `agency:id:<canonical_id>`; unmatched input stays plain text and must not mint an id from
  the unmatched slug. `NL_AGENCY_ALIASES` in `site/nl_parse.js` is a classic-script fallback
  only — do not copy it into graph identity. Proof: `test/canonical_entity_interpretation.test.mjs`
  plus the `gq-dot-agency-alias` / `gq-housing-department-alias` / `gq-unresolved-agency-phrase`
  golden queries.
- **Cross-spine edge routing:** `entity_resolution/cross_domain/edge_policy.mjs` is the shared
  four-tier router (`deterministic`, `public_inferred`, `evidence_only`, `no_edge`). Keep
  uncertain candidates in `shadow_edges` only; verify the frozen relation gates with
  `node tools/cross_spine_eval.mjs --check-policy` and cover public omission in
  `worker/test/public_relationship_graph.test.mjs`.
- **Public assertion traversal:** `site/assertion_inspector.mjs` hydrates accepted production
  bundles into the versioned `entity_resolution/provenance_graph.mjs` read model and serves the
  resident-safe `/assertions/` subject and immutable assertion targets through
  `site/pages_edge.mjs`. Stamp entry links only from admitted source rows; incomplete,
  provisional, or probabilistic edges stay out of links and verified totals. Production proof:
  `test/assertion_inspector.test.mjs` plus `test/browse_scope_contract.test.mjs`.
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
- **Notice/object link targets:** `site/notice_object_links.mjs` is the projection narrow waist:
  notices remain publication evidence, stable E-PIN award notices target the exact procurement
  scope, and `/mandates/<id>` is emitted only after the warrant + subject + action +
  trigger/deadline gate passes. `site/mandate_document.mjs` resolves those exact IDs and projects
  provenance-complete, standable contract/rule/meeting rows from
  `site/data/process_conformance_lookup.json`; evidence-only and incomplete edges stay absent.
  Focused proof: `test/notice_object_links.test.mjs`, `test/process_conformance.test.mjs`, and
  `test/mandate_graph_neighbors.test.mjs`.
- **Land-use procedure nodes:** the closed `land_use_procedure_v2` vocabulary lives in
  `worker/src/lib/subject_registry.mjs` (`ulurp` | `elurp` | `non_ulurp`). Action
  families come from `LAND_USE_ACTION_CODE_FAMILY` in `site/land_use_action_type.mjs`
  (`LD` is `legal_document`, not landmark; `PQ`/`PC` are acquisition, not site
  selection). Graph `landActionKinds` and `LAND_USE_ACTION_FAMILY_KINDS` consume
  that map — do not keep a parallel code→family table.
  `site/mandate_land_use_bridge.mjs` composes mandate → procedure ← project only
  when both evaluated edges are public; the direct `mandate_land_use`
  identity-and-phase gate remains a family match and must not be weakened.
- **Land regulatory-effect axis:** `site/land_regulatory_effect.mjs` is the fail-closed
  ZM brief-pair extractor and versioned max-FAR lookup. Upzone/downzone is a derived
  property, never an action family; materialized rows retain its basis, while public chips
  render only high/medium confidence and unknown stays absent. Focused proof:
  `test/land_regulatory_effect_axis.test.mjs`. Build-time consumers use the thin
  `ontology/land_regulatory_effect.mjs` re-export; browser-facing modules must stay inside
  `site/` because the public artifact does not copy sibling source trees.
- **Community-board meeting labels:** `site/non_council_outcome_panel.mjs` promotes a notice
  to an official board label only from the receipt-backed
  `cityscroll.community_board_source_join.v1` contract (`exact_board_date_publisher_identifier`);
  the older exact body/date/matter gate remains separate for decision details. Unjoined notices
  stay on their City Record/unknown surface.
- **Community-board bylaws:** `site/community_board_bylaws.mjs` is the source-qualified
  `bylaw-version` and `governed_by` contract. It resolves only board-local current versions,
  retains superseded history, and answers material governance questions with explicit
  `source_does_not_establish` when a rule is missing. The committed sample source is
  `site/data/community_board_bylaws.json`; focused proof is
  `test/community_board_bylaws.test.mjs`.
- **Community Board participation:** `site/community_board_participation.mjs` projects retained
  board-local governance rules and explicitly scoped application sources into compact,
  source-qualified participation rows, then composes the selected-board Ways to participate
  section. Closed, stale, or unknown application windows never produce a CTA; Follow and
  Calendar reuse existing board-identity routes. Rebuild
  `site/data/community_board_participation.json` and its receipt with
  `node tools/build_community_board_participation.mjs`. Focused proof is
  `test/community_board_participation.test.mjs` and
  `test/community_board_constellation.test.mjs`.
- **Ambiguous community-board search:** `site/community_board_search.mjs` is the shared static/live
  projection for bare-number chooser state, explicit civic-context defaults, canonical card labels,
  and stable rank-without-hiding order. Bare `community board 3` keeps all five borough candidates;
  a place context or exact board choice changes group order rather than filtering alternates. Keep
  `site/browse_view.mjs` and `site/app/feed-actions.mjs` on that projection. Focused proof:
  `test/borough_scope_links.test.mjs` and `test/hearing_widening.test.mjs`.
- **Community-board meeting index:** `site/data/community_board_meeting_index.json` is the
  bounded source-native event read model, refreshed by
  `node tools/build_community_board_meeting_index.mjs`. It contains explicit Schema.org Event
  records plus reviewed NYC-hosted calendar entries from `nyc_official_calendar_v1`; that adapter
  activates only for a source classified as an `explicit board calendar` and requires a heading,
  publisher date/time, and page-declared year. `google_calendar_v1` also harvests a public
  Google Calendar embed: it reads `src`/`cid` calendar ids from the page (URL-encoded or
  base64) and fetches `https://calendar.google.com/calendar/ical/<id>/public/basic.ics`.
  Recurring VEVENTs keep `UID::date` identity; a private ICS 404 or a feed with no upcoming
  instances stays honestly empty. Direct `.ics` URLs (Manhattan CB7) still parse in place.
  `pdf_calendar_v1` follows official agenda/calendar PDFs linked from those pages and emits
  a meeting only when the PDF text has a real date AND clock time plus a full-board /
  general-board / public-hearing / executive-board identity. Bare agendas, past-only
  schedules, image-only PDFs, and "usually 6pm" copy stay documents, not events.
  `airtable_v1` reads a public shared-view id from an embed, fetches the signed
  `readSharedViewData` payload, and maps Date/Name/record fields; auth-gated views
  and office-closure rows stay empty. Cloudflare Turnstile calendars stay
  browser-protected honest states rather than a live-browser build dependency. When the page has no publisher event ID, retain the
  meeting card but keep its `hosts_meeting` graph edge held. Every row carries a source receipt and
  an unjoined `cityscroll.community_board_source_join.v1` result. Static Browse builds merge the
  rows in `tools/build_primary_documents.mjs`; the Meetings client appends the same artifact in
  `site/app/feed-actions.mjs`. Minutes are a separate typed source role from meetings;
  Manhattan CB6's image-linked Airtable archive is recorded as `airtable_v1` and browser-required,
  so the source link is public while records remain un-ingested until an explicit fetch is available.
  Focused proof: `test/community_board_source_adapters.test.mjs` and
  `test/cb_minutes_gap_report.test.mjs`.
- **Shared meeting object:** `site/meeting_object_contract.mjs` is the narrow waist for City
  Record and community-board meeting producers. IDs are source-qualified (`meeting:<system>:<key>`)
  and preserve publisher keys; `/meetings/{meeting_id}` is canonical while City Record notice
  URLs remain compatibility links. Keep title/date-only identity and board-name-as-agency
  substitutions out of new meeting rows. Focused proof: `test/meeting_object_contract.test.mjs`.
- **Meeting process profiles:** `site/meeting_process_profile.mjs` keeps observed event/publication
  facts separate from versioned normative expectations. Past dates, generic meeting types, and
  participation links never prove held/agenda state; community-board and unknown families remain
  descriptive and emit no rulemaking role. Focused proof: `test/meeting_process_profile.test.mjs`.
- **Shared meeting read model:** `site/shared_meeting_read_model.mjs` combines the two
  source-qualified producers with one freshness envelope. `tools/build_primary_documents.mjs`
  materializes `site/data/shared_meeting_read_model.json`; Pages edge resolves
  `/meetings/<canonical-id>` by exact ID and renders the matched row from that safe data path.
  Do not restore per-ID static files: encoded community-board URLs contain reserved path
  characters that static hosting normalizes before filesystem lookup. Worker `/hearings` consumes
  the same bounded board snapshot, while the SPA falls back to the shared artifact rather than
  appending a second board fetch. Verify with
  `test/shared_meeting_read_model.test.mjs` and the focused meeting contract tests.
- **Observation-fed procurement object:** `site/procurement_object_contract.mjs` constructs the
  aggregate only from accepted exact PASSPort/Checkbook `source_records` edges. Contract IDs are
  strong keys; PIN/EPIN attaches a stage only when it does not collapse multiple contracts; title,
  vendor, agency, and dates never create identity. City Record may add stage refs and compatibility
  links to an existing object but is never a constructor. Source failures belong only to the
  envelopes in `site/shared_procurement_read_model.mjs`; retained objects and nested lifecycle
  detail stay unchanged. PASSPort Public `title`, `procurement_method`, `program`, and `industry`
  stay on spine snapshots via `site/passport_public_fields.mjs` after a quality gate; PIN-only
  or identity-echo titles stay absent and the synthetic “Contract CT…” fallback remains. Do not
  invent scope, line-item pricing, deliverables, or performance location. Densify with
  `node tools/densify_passport_public_fields.mjs --from-dump <contractData.js> --write` then
  rebuild the shared model. Focused proof: `test/procurement_object_contract.test.mjs`,
  `test/shared_procurement_read_model.test.mjs`, and `test/passport_public_fields.test.mjs`.
- **PIN-family Checkbook ↔ PASSPort identity:** sharing a PIN while FMS contract-id
  strings differ is not public same-contract. `entity_resolution/cross_domain/pin_family_mismatch.mjs`
  auto-labels document-type mismatch (CTA1 vs MMA1) and same-vendor successor / later-term
  renewals as `related_instrument`. Distinct-vendor shared-PIN pairs stay on
  authenticated `GET/POST /admin/pin-family-verify`. Rebuild
  `site/data/pin_family_mismatch_review.json` with `node tools/build_pin_family_review.mjs`.
  Public `corroborates_contract` edges remain `contract_id_exact` only. Browse
  Recent Awards groups verified PIN-family siblings through
  `site/pin_sibling_grouping.mjs` as related instruments without merging
  `procurement_id`s; `needs_review` / distinct-vendor pairs stay separate
  related-candidates. Open RFPs remains solicitation-only — registered
  PASSPort-only rows live under Recent Awards. PASSPort-only objects may take a
  guarded Checkbook lookup (`site/checkbook_passport_corroboration.mjs`): an
  exact contract-id/PIN hit is evidence and must not replace the PASSPort amount;
  PIN-family or amount disagreement stays related-instrument or needs-review; a
  miss is unknown and a Checkbook hit never mints a `/procurements/<id>` route.
  Proof: `test/pin_family_mismatch.test.mjs`, `worker/test/pin_family_verify.test.mjs`,
  `test/pin_sibling_grouping.test.mjs`, and
  `test/checkbook_passport_corroboration.test.mjs`.
- **Canonical procurement product projection:** `site/procurement_search_producer.mjs` and
  `site/contract_search_bridge.mjs` project the shared procurement read model into source-independent
  SearchDocuments and typed Browse rows. Canonical identity is `procurement_id`; `request_id` is
  optional City Record evidence and must never gate Search, Browse, lifecycle, Following, or
  `/procurements/<id>`. CROL-negative PASSPort/Checkbook rows enter that live set through
  `site/crol_notice_publication_policy.mjs` — the same valid-amount (`0 < x < $10B`) and
  365-day Award window that already publishes City Record notices. Do not add a separate
  numeric publication cap, and do not label the window citywide. Money-lens digest compile
  unions City Record notices with CROL-negative rows from
  `site/data/procurement_digest_snapshot.json` (`site/procurement_digest_compile.mjs`); those
  rows keep `procurement_id` delivery identity and must not pretend to be notices.
  Refresh `site/data/shared_procurement_read_model.json`,
  `site/data/procurement_browse_rows.json`, `site/data/procurement_digest_snapshot.json`, and the
  keyword family with
  `node tools/build_shared_procurement_read_model.mjs && node tools/build_keyword_search_index.mjs`.
  Those two bundles stamp the same `coherence_receipt` (source-model fingerprint,
  `generated_at`, selected-row count, artifact hashes).
  `node tools/check_procurement_index_coherence.mjs` fails when the keyword family
  advertises a canonical object absent from the served detail model; a suppressed
  object stays out of the index with its coverage receipt.
  Focused proof: `test/crol_notice_publication_policy.test.mjs`,
  `test/universal_search_procurement_producer.test.mjs`,
  `test/procurement_browse_parity.test.mjs`, `test/procurement_following.test.mjs`,
  `test/procurement_route.test.mjs`, `test/procurement_served_index_parity.test.mjs`,
  `test/procurement_index_coherence.test.mjs`, and
  `worker/test/procurement_digest_parity.test.mjs`.
- **Procurement Pages asset sharding:** the committed
  `site/data/shared_procurement_read_model.json` is a contract-preserving manifest;
  bounded row/observation shards live under
  `site/data/shared_procurement_read_model/`. Build consumers reassemble it through
  `tools/lib/procurement_read_model_io.mjs`, while `site/pages_edge.mjs` uses the
  manifest's exact procurement-id-to-shard map. `tools/check_pages_bundle_sizes.mjs`
  enforces the 24 MiB Pages per-file guard; the Worker has its separate 52 MiB
  uncompressed Wrangler dry-run guard in `tools/worker_deploy_guard.mjs`. The
  source-native community-board meeting index follows the same manifest/shard
  pattern through `site/community_board_meeting_index_shards.mjs` and is read
  with `tools/lib/community_board_meeting_index_io.mjs`.
- **Contracts bounded query projection:** non-default Contracts Browse uses
  `site/procurement_browse_query.mjs` and Pages-build-generated
  `site/data/procurement_browse_query.json` plus
  `site/data/procurement_browse_rows/`; those deploy-time artifacts are
  gitignored and must not be committed. Rebuild them with
  `node tools/build_shared_procurement_read_model.mjs`; the query projection must stay
  field-equivalent to `filterMoneySnapshot`, and full-row hydration must retain the
  legacy fallback. Proof lives in `test/procurement_browse_query.test.mjs`.
- **Community-board meeting geography:** Near-you district activity reads the shared meeting
  model and derives a source-qualified board meeting's community district from the published
  `community-board → covers → community-district` edge in
  `site/data/community_board_geography_lookup.json`. That ontology lookup precedes venue/address
  geocoding; missing or conflicting board identity fails closed to the existing placement chain.
  Focused proof: `test/location_derivation.test.mjs` and
  `test/community_board_meeting_lens_parity.test.mjs`.
- **City Record meeting notice materialization:** `site/data/meeting_notice_materialization.json`
  is the build-time rich notice input for current dated meetings. Its explicit predicate lives in
  `site/city_record_meeting.mjs`, and `tools/build_meeting_notice_materialization.mjs` refreshes it
  from the City Record snapshot plus validated RequestDetail source links. The meeting route must
  resolve exact IDs from the shared artifact only; missing IDs remain honest 404s.

## PR and CI preflight

- **Daily refresh PR publish loop:** remaining git-backed data-refresh
  workflows (`doing-business-warehouse-lookup`, `geocoder-address-index`)
  must open PRs with repo secret `REFRESH_PR_TOKEN` (fine-grained PAT:
  Actions/Contents/Pull requests R/W), not `secrets.GITHUB_TOKEN`. GitHub
  blocks default-token PRs from triggering required checks (anti-recursion),
  which stalls merge-queue auto-merge. After `peter-evans/create-pull-request`,
  each workflow enables auto-merge via `gh pr merge "$REFRESH_PR" --auto
  --match-head-commit "$REFRESH_HEAD"` with the same PAT as `GH_TOKEN`.
  Payroll titles, land upcoming hearings, the sell-facing ZAP lookup, and
  staffing exams live in Worker cron / `ALERT_STATE` (`payroll:title-mart:v1`,
  `land:upcoming-hearings:v1`, `land:zap-lookup:v1`, `staffing:exams:v1`); they
  must not grow a refresh PR. Doing Business is weekly; the geocoder and exam
  HTML stay committed.
- Shared browser artifacts use `tools/site_artifact_identity.mjs` plus
  `.github/actions/use-site-artifact`: the run/attempt artifact and exact-input
  cache are trusted only after `_site.sha256`, commit/tree, lockfile, Node
  version, and declared build inputs verify. Keep every new `_site` consumer on
  that action rather than downloading the artifact directly.
- Plain-language accessibility copy uses `test/standards/no_disclaimer_slop.py`, which scans
  rendered HTML, i18n source, page-template strings, and generated HTML. It is warn-first;
  set `NO_DISCLAIMER_SLOP_MODE=block` locally or the repository variable of the same name in
  CI after the curated pattern set is calibrated. Reviewed exceptions use the adjacent
  `no_disclaimer_slop_allowlist.txt` or a local `no-disclaimer-slop: ignore` comment.
  Provenance restatement of per-link markers (City Record awards, Checkbook “live on”,
  timeline-lead search) is a detector class — do not allowlist it.
- Run `make prepush` (or `./tools/preflight-required-checks.sh`) before creating or
  handing back a PR URL and before opening a pull request. Install the versioned
  pre-push hook once per clone with `make install-hooks` (`core.hooksPath=tools/git-hooks`);
  the hook rejects pushes that fail the fast preflight and runs `--full` when the
  push range touches `site/**`. Bypass only with `git push --no-verify` (CI still must pass).
- Local browser dependencies use the host-persistent environment documented in
  `docs/local-accessibility-testing.md`: run `make setup-a11y` once per host and `make a11y`
  from any checkout. Do not create a checkout-local environment for this gate.
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
  `elder_slot` in `tools/merge_queue_policy.json`. GitHub owns the single native train and its
  five-entry ceiling; an external seater may feed that train but does not define another cap.
  Refresh the repository-owned removal evidence with
  `node tools/report_merge_queue_ejections.mjs --write`.
- Merge-throughput telemetry is normalized and replayed by
  `tools/merge_throughput_telemetry.mjs`; it carries source/run-qualified per-PR, per-attempt, and
  required-check receipts plus same-window Little's Law daily gauges. The committed fixture and
  dashboard are under `test/fixtures/merge-throughput/`; verify with
  `node tools/merge_throughput_telemetry.mjs --fixture test/fixtures/merge-throughput --check`.
- Known flaky-shard reruns are projected by `tools/known_flake_rerun.mjs`; its registry is
  source-linked to the incident corpus, joins MT-1 receipts, permits one existing fresh-runner
  retry only for exact signatures and unchanged identities, and escalates three consistent
  failures. Verify with `node tools/known_flake_rerun.mjs --fixture test/fixtures/merge-throughput --check`.

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

- **Contracts response-place scope:** Borough links come only from positive-count,
  basis-labeled rows in `site/contract_action_location.mjs`; they describe submission,
  pre-bid, or document-pickup logistics, never performance geography. Keep copied
  Contracts hashes and the Near You pivot on the same scope through
  `site/borough_scope_links.mjs`. Focused proof: `test/contracts_scope_links.test.mjs`.
- **Universal search contract:** `site/search_document_contract.mjs` is the pure admission
  boundary for source-independent SearchDocuments. Object types and product domains are separate
  closed vocabularies; only validated canonical object routes can be `indexed`, while retained
  notice routes remain `evidence_only`. Ranking receives frozen admitted documents and does not
  own classification. The City Record adapter is `worker/src/search.mjs`, and the search client
  groups only registered domains from `site/search_document.mjs`. Focused proof:
  `test/search_document_contract.test.mjs` plus `test/universal_search_object_gold.test.mjs`.
- **Search-quality golden queries:** `queries[]` in
  `test/fixtures/universal_search_object_gold.json` plus
  `test/universal_search_golden_queries.test.mjs` score current keyword, coverage,
  and offline Ask interpretation — including expected misses (typo) and the
  reviewed synonym hit (`gq-school-synonym`, school→education). Do not change
  retrieval to turn a documented miss green; a reviewed expander may land only
  behind a fixture that turns that miss into a hit without flipping other gold
  identities.
- **Shadow vector signal (SQ-08):** `warehouse/lib/vector_shadow_signal.mjs`
  scores hashed n-gram TF-IDF against the named lexical-miss set in
  `test/fixtures/vector_shadow_signal/lexical_miss_set.json`. Public ranking
  weight stays 0 unless a captain-authorized evaluation clears the usefulness
  gate without ranking harm; do not restore SR4 Vectorize or SR8 hybrid ranking.
  Refresh `docs/evidence/vector-shadow-signal-evaluation.{json,md}` with
  `node tools/evaluate_vector_shadow_signal.mjs`. Proof:
  `test/vector_shadow_signal.test.mjs`.
- **SearchIntent wrap projector:** `site/search_intent.mjs` is the read-only
  `cityscroll.search_intent.v1` projection over `scopeFromRouteHash` /
  `scopeFromLensState`, `resolveKeywordQuery`, and NL `sanitize`. It does not
  change those compilers. `/nl` emits the projection as `search_intent` beside
  its byte-compatible `filter`; `/search`, retrieval, and the Browse filter
  consumer remain unchanged. Focused proof: `test/search_intent_projector.test.mjs`
  and `worker/test/nl.test.mjs`.
- **Six-family keyword search:** `/search` returns `cityscroll.keyword_search_response.v1`, whose
  Contracts, People + organizations, Land, Rules, Meetings, and Exams lanes keep independent
  status, count, source, and as-of receipts. `site/keyword_matcher.mjs` is the literal-resolution
  and offset-backed evidence narrow waist. Matching is exact whole-token (plus simple +s
  plural), never infix/substring or prefix — `rat` does not match `integrated` / `rate`.
  Reviewed synonym expansions store `expansion_tokens[]` with a `reviewed_synonym_v1`
  receipt and may OR into `retrieval_groups`; they do not rewrite `canonical_tokens`.
  The closed table starts at school→education. Unreviewed synonyms and typos stay
  unexpanded. A published keyword hit must carry markable evidence of the document
  token that matched; evidence-less award recall is fail-closed. Refresh the compact
  typed-object index with
  `node tools/build_keyword_search_index.mjs`; the D1 notice mirror remains the Contracts/Rules
  source, while the client projects the flattened compatibility results through the registered
  universal-search domain lanes. Land keyword canaries `2025Q0331` / `2026K0123` miss-fill
  from live SODA by exact `project_id` when the publish-loop family has holes, and the land
  lane then reports a timestamped hybrid as-of (`published` snapshot clock plus live fetch)
  instead of looking warehouse-fresh. Proof: `test/land_keyword_soda_missfill.test.mjs`.
- **Production collection providers:** dedicated static collections enter the worker federator
  through `PRODUCTION_COLLECTION_FAMILIES` in `worker/src/search.mjs`; add each materialized family
  there rather than hand-building another coverage row. `tools/build_keyword_search_index.mjs`
  owns the matching family artifact. Domain presentation lanes may compose provider results after
  federation (People into People + organizations; Vendors into Contracts), but machine coverage
  stays collection-specific. Vendor indexing is over currently eligible roots only; tentative
  exclusions (for example Extell without a strong source observation) stay in
  `build_receipt.excluded_vendor_roots` and must not make the Vendors lens report partial.
  Registered families today: People, Agencies, Vendors, Parcels (exact-BBL Properties),
  Community boards, and Committees (published Legistar committee graph). Worker-route proof is in
  `worker/test/search.test.mjs`.
- **Semantic topic-search consumer:** `site/semantic_topic_search.mjs` is the fail-closed adapter
  for `cityscroll.semantic_retrieval.candidate_response.v1`. It verifies the sr1 corpus and sr2
  passage receipts, rejects public scores and unsafe evidence, retains the three source families
  as provenance, and groups presentation by the six source-backed civic-object families declared
  in `warehouse/experiments/semantic-layer-trial/source_manifest.json`; never infer a civic lens or
  jurisdiction from passage text. The `/search/` renderer queries passage and keyword retrieval
  in parallel, then renders a deduplicated passage-first union; a bounded passage hit must never
  suppress broader keyword-corpus recall. Focused proof:
  `test/semantic_topic_search.test.mjs` and `test/functional/29_search_results.py`.
- **Typed search handoff:** `site/search_lens_handoff.mjs` carries a selected SearchDocument into
  its established Browse route through scope v0. Keep raw and normalized topic terms separate,
  preserve place/time and structured entity context, and render only source-provided evidence
  offsets at the destination; unavailable evidence stays explicit. Contract handoffs use the
  exact object/source-observation pair in the mixed archive, not a PIN-shaped keyword query;
  `worker/src/search.mjs` resolves that pair before `site/app/money-list.mjs` filters the row.
  Query edits must remove stale handoff identity and evidence, and Back uses the stored Search
  lane. Focused proof:
  `test/search_lens_handoff.test.mjs`, `test/scope_v0.test.mjs`, and
  `test/functional/29_search_results.py`.
- **Entity SearchDocument producers:** `site/{vendor,committee,board,exam,parcel}_search_producer.mjs`
  adapt the existing canonical read models into that contract and carry matched/empty/partial/
  not-indexed coverage. Vendor aliases are reviewed-registry-only; committee publication is gated;
  board identity is borough-qualified; exams use publisher exam numbers; parcels require exact BBLs
  (a `no_zap_match` land result does not weaken parcel identity). Focused proof is the five matching
  `test/universal_search_*_producer.test.mjs` files plus the object gold set.
- **City Record search producers:** `site/city_record_search_producers.mjs` adapts exact award
  identifiers through `site/notice_object_links.mjs` and admits rules only from the bounded
  `site/data/rules_domain_observations.json` projection. Publisher sections never assign a search
  type; misses retain evidence-only receipts. Materialized attachment text may expand search text
  but cannot change the object projection. Focused proof:
  `test/universal_search_crol_producers.test.mjs` plus `worker/test/search.test.mjs`.
- **Contract award search producer:** `site/contract_award_search_producer.mjs` projects the full
  retained OCP award materialization into exact-PIN procurement SearchDocuments; optional place or
  relation evidence is additive metadata, never corpus admission. Worker Search federates that
  historical census with current D1 City Record objects, and `site/contract_search_bridge.mjs`
  restores those validated hits to keyword-scoped Browse awards beyond the bounded default
  resident snapshot. Focused proof: `test/universal_search_contract_award_producer.test.mjs`,
  `test/contract_search_bridge.test.mjs`, and `worker/test/search.test.mjs`.
- **Meeting search producer:** `site/meeting_search_producer.mjs` projects the shared two-source
  meeting read model into canonical Meeting SearchDocuments. It deduplicates only exact
  `meeting_id` values, retains publisher keys and receipts in provenance, derives `process_role`
  from meeting profiles, and carries City Record/community-board coverage separately from hits.
  Focused proof: `test/universal_search_meeting_producer.test.mjs`.
- **Agency search producer:** `site/agency_search_producer.mjs` projects the bounded agency
  constellation lookup into canonical `agency` SearchDocuments and carries matched constellation
  labels only as lexical recall fields. Identity classification stays producer-owned; reviewed
  unresolved labels remain unclassified, relation states stay in provenance, and corpus coverage
  is explicit. Focused proof: `test/universal_search_agency_producer.test.mjs`.
- **People search producer:** `site/people_search_producer.mjs` projects the promoted
  `person_hub_lookup` through exact Council Member/Legistar PersonIds into canonical `person`
  SearchDocuments on `/officials/<id>/`. Only its declared name, alias, role, agency, and district
  fields enter retrieval; unresolved rows fail closed and corpus coverage stays explicit. Focused
  proof: `test/universal_search_people_producer.test.mjs` plus the universal object gold test.
- **Cross-lens search ranking:** `site/universal_search_federator.mjs` is the pure rank-and-merge
  boundary over notices plus the seven entity indexes. Lens providers retain retrieval and match-
  evidence ownership; federation validates immutable SearchDocuments, calibrates local BM25 order,
  preserves observation refs on match edges, and reports empty, unavailable, and unindexed lenses
  distinctly. Focused proof: `test/universal_search_cross_lens_ranking.test.mjs`.
- **Universal search relevance UI:** `site/universal_search_relevance_ux.mjs` projects federated
  match fields and source lifecycle into escaped highlights, plain match reasons, typed lens labels,
  and active/archive status without reclassifying the source row. `site/search_document.mjs` owns
  browser grouping and route hydration. Focused proof:
  `test/universal_search_relevance_ux.test.mjs` and `test/functional/29_search_results.py`.
- **Universal search coverage receipt:** `site/universal_search_federator.mjs` owns observed versus
  complete counts, per-lens and per-entity-type counts, snapshot boundaries, and explicit partial,
  stale, unavailable, or unindexed states. `site/universal_search_coverage_receipt.mjs` is the
  resident-facing projection; `site/search_document.mjs` must render the API receipt rather than
  recounting results. The committed person, agency, and vendor fixtures are CI ratchets in
  `test/universal_search_coverage_guard.test.mjs`. Golden empty / partial /
  unindexed queries distinguish no-match from no-coverage and cite the same
  LA7 search canaries (`worker/src/search.mjs`,
  `tools/build_keyword_search_index.mjs`, `site/agency_search_producer.mjs`);
  a missing-people + stale-vendors query must not read as "0 across all".
  Proof: `test/universal_search_golden_queries.test.mjs`.
- **Browse object-card interactions:** `site/affordance_grammar.mjs` owns the shared
  `objectCardInteractionProjection` and title, verified-relation, canonical Copy link,
  external-handoff, and context-gated action-rail render primitives. Source adapters retain
  evidence and readiness ownership; lens renderers map those decisions into this projection
  rather than reclassifying them. `site/app/core.mjs` installs delegated Copy behavior and
  publishes the localized external-action renderer. Focused proof:
  `test/affordance_grammar_drift.test.mjs`.
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
- **Selective civic-time rematerialization:** `worker/src/lib/civic_time_writer.mjs` emits the
  closed `passport_rfx_revision` change class for same-record revisions. The exact dependency
  registry and ledger/derived-rollup recomputation live in `site/civic_time_ledger.mjs`; receipts
  preserve affected/untouched row scope, source/materializer versions, independent clocks, and
  canonical notice routes. The same module owns the page-cited theory source ledger and the
  single four-clock-to-bitemporal map: civic → valid, observation → system, while publication is
  a labeled public fallback and processing stays provenance. The notice history's legacy
  processed-time display fallback remains explicitly stamped `processing_fallback` and never
  drives system-axis as-of. Unregistered dependencies stay `unknown`. Theory and correction/as-of semantics live in
  `docs/adr/civic-time-event-contract.md`. Focused proof:
  `worker/test/civic_time_writer.test.mjs` and `test/civic_time_ledger.test.mjs`.
- **Composed graph belief time:** `site/civic_time_composed_graph.mjs` is the bounded
  `procurement_notice` bitemporal reader over retained event and typed identity-link history.
  It selects the latest observation before applying the public edge gate, so a corrected
  provisional link cannot revive or upgrade an older public edge. Receipts keep belief and
  processing time separate and reuse the four-clock map in `site/civic_time_ledger.mjs`.
  Focused proof: `test/civic_time_ledger.test.mjs`.

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
- Zoning Browse keeps action family, process stage, review procedure, and future action as
  orthogonal facets in `site/land_status_facets.mjs` / `site/land_procedure_facet.mjs`. Family
  filters `families[]` from `normalizeLandUseActionType` (list chips, `#lfamily`, follow, and
  the Near-you land bag share `landRowMatchesFamily`). Stage consumes
  `site/land_phase_spine.mjs` phase IDs; actionability is determined from the published
  event/deadline date with an injected test clock. Default procedure `review` admits ULURP +
  ELURP; `ulurp` remains the explicit ULURP-only preset; Non-ULURP is offered and stays out of
  the default. Public URLs use `family` + `stage` + `future` + `procedure`, while legacy `status` links
  remain accepted. Focused field-data proof is `test/land_action_family_facet.test.mjs`,
  `test/land_stage_action_filters.test.mjs` and
  `test/land_procedure_facet.test.mjs`. The stage-action file asserts the public-review ∩
  upcoming-hearing join invariant with a frozen fixture plus a dynamic live pick from
  `site/data/land_upcoming_hearings.json` — never pin a rolling project id (the
  committed snapshot is a last-resort floor; live rows come from Worker KV).
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
  smoke (`python3 test/functional/27_project_connections_live.py`) together. Production deploy
  workflows pin the browser smoke to committed warehouse canary `2022M0258`; the scheduled
  cutover monitor keeps the script's live-fallback default. Guard the split in
  `test/project_connections_smoke.test.mjs` so source-data drift cannot mask a successful deploy.
- Following is static-first at `site/following/index.html` and edge-rendered at `GET /following`
  through the shared `site/following_view.mjs` renderer. A saved scope is the single contract for
  its summary, preview count, results, and `/subscribe` form. Result and detail entry preserve
  that same watch plus compact preview focus through `site/following_preview_handoff.mjs`
  (`notice` / `project` / `from`); unrecognized lenses stay honest and never remap to Contracts.
  Create flow: live conjunction rule
  line (`composeWatchRuleSentence`), digItem-shaped preview cards, cadence radio cards with
  quiet-day/weekly consequences, pack attention cost (`packAttentionCopy`). Client promotes
  Your watches first when `/following/personal` returns ≥1 watch (manage-first tabs).
  Create-flow query params (`lens` / `filter` / `freq`) keep the Create tab through
  `requestedFollowingTab` even after that promotion; `#your-following` and `?tab=` still win.
  Canonical manage URL is `/following/#your-following` (digest footers use session exchange when a token
  is available; `/prefs` remains account-level). `site/following_personal_state.mjs` owns distinct
  loading, unrecognized, empty, recognized, unavailable, and error copy for that island;
  session controls stay off until the personal fetch is recognized, and cadence/pause/unsubscribe
  refresh the same watch card. Personal watches load only through
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
- **`site/_routes.json` is the Pages worker invocation boundary (load-bearing):** the edge
  renderer runs only for path patterns in `include`. A route family handled in
  `pages_edge.mjs` but missing from `include` (as `/mandates/*` was) never reaches the
  worker — Pages silently serves the SPA shell, rendering a blank document. Every new
  edge-rendered route family must be added to `include` and locked by the routing test in
  `test/primary_document_routes.test.mjs`.
- `site/legacy_hash_forward.mjs` is the finite fragment-to-document compatibility bridge.
  Update its grammar through `site/route_migration.mjs`, then rebuild and review
  `docs/url-migration-map.csv` and `docs/url-migration-map.md` with
  `node tools/build_url_migration_map.mjs`. The public Stats document and API are explicit
  exclusions and must retain their current routes and semantics.
- `test/functional/24_notice_document_features.py` is the required browser parity gate for
  `/notices/<request_id>` translation, action/watch controls, disclosures, and language-carrying
  copy links. Notice-document enhancement changes must extend this route-level test.

## Digest cron deploy safety

- Worker `GET /health` (and `GET /`) returns JSON whose `status` stays `cityscroll-worker ok`.
  Deploy paths inject `commit` (`GIT_COMMIT_SHA`) and `environment` (`WRANGLER_ENV`)
  with wrangler `--var` only — never the GitHub Action bulk `vars:` input. A route-parity
  check should `JSON.parse` the body and compare those fields, while existing text
  probes may still match `/cityscroll-worker ok/`.

- Production Worker deploys must run `node tools/wait_for_digest_cron_window.mjs`
  immediately before `wrangler deploy`. Wrangler rewrites Cron Trigger configuration,
  so the guard keeps deploys outside 12:40–13:05 UTC around the 13:00 digest.
- The 13:00 scheduled handler must call `runAlerts` before advisory daily read-model refreshes;
  those upstream refreshes can be slow or fail after the delivery critical path. The ordering
  contract is covered by `node --test worker/test/digest_schedule_order.test.mjs`.
- Cloudflare Pages remains the origin for `cityscroll.org` and `www.cityscroll.org`. Bounded
  Worker zone routes serve canonical `/near-you*`, `/following*`, and `/prefs*` documents;
  Worker custom domains remain `api.cityscroll.org` and the `api.crol-list.org` compatibility alias.
- The unused public review lane is retired from the repository. Restore it from
  `docs/beta-rebuild-recipe.md`; Cloudflare Pages and DNS teardown is a separate hosting step.
  In-bundle `?beta=<slug>` flags remain.

- **Mail-leg health:** inbound Email Routing and outbound Resend are separate rails.
  `worker/src/reliability_watchdogs.mjs` records Worker-consumer receipts and operations-mailbox
  sends. `GET /admin/reliability/mail` plus the digest/scheduler watchdogs return 503 / GitHub-red
  when a canary is unmatched; they do not email a dead alert rail. The Gmail forward stays
  dashboard-gated. Dashboard FAILED counts can be retries of one rejected message. Gate:
  `node tools/check_mail_legs.mjs` (`--live` operator-only; `--recovery` lists recoverable vs gone).
  Proof: `test/mail_legs.test.mjs` and `worker/test/reliability_watchdogs.test.mjs`. See `docs/mail-leg-health.md`.

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
- Shadow `linkProblems` accepts well-formed same-document `#fragment` hrefs whose
  target `id` is present in the rendered HTML (rollup TOC `href="#watch-N-slug"`).
  Empty / `#`-only / dangling fragments stay `broken_digest_link`. A false positive
  on those TOC anchors names the digest in `affected_digest_ids` and becomes
  `AFFECTED_DIGESTS_HELD` at 12:45, so 13:00 omits every multi-watch rollup.
- The 10:00 rehearsal (`runDigestShadow`) must pass `previewOnly: true` into
  `runAlerts`. Rehearsal is `live: false` / `persist: false` but still shares
  `env.DB`; without `previewOnly`, `enqueueNormalSection` writes
  `digest_outbox_items` that never drain while the account is held. The 13:00
  live path is unchanged.
- Ontology inventory additions enter only the private digest rehearsal through
  `worker/src/lib/ontology_delta_alert.mjs`. Stable `absent-to-present` transition keys reconcile
  through `ontology_delta_shadow_events`; only the winning insert is exposed as a candidate, while
  later rehearsals retain digest-compatible `deduplicated` receipts. The default inventory pair is
  the committed entity-intelligence Worker artifact against `site/data/ontology_inventory_baseline.json`.
  Verify with `node --test worker/test/ontology_delta_alert.test.mjs worker/test/digest_shadow.test.mjs`.

## CI path fast paths and merge queue

- Performance uses a fan-out/fan-in contract: `test/performance/verify.py` shards only raw
  sample collection, while `test/performance/performance_contract.py` is the single p95 reducer
  used by serial and aggregate paths. `test/performance/aggregate.py` must receive the exact
  0–19 sample index set for every fixture/viewport before emitting the stable `results.json`;
  serial/parallel wall spans and contention comparisons belong in the separate `pilot.json`.
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
- Live-derived suggestion fallback lives in Worker `ALERT_STATE` KV (`suggestions:validated`
  plus `preset:fallback`) from the daily cron in `worker/src/suggest.mjs`. In-code
  `FALLBACK_INDICES` / `NL_SUGGESTIONS_FALLBACK` are last-resort floors when KV is missing,
  empty, unparseable, or stale. `runSuggestionValidation` always emits every
  `SUGGESTION_LENSES` key (`[]` when a lens has no surviving candidates) so a snapshot-clock
  miss on Contracts cannot omit `byLens.money` and throw on admin refresh; the KV parsers
  accept those empty arrays without invalidating the rest of the record. A wholly empty run
  still skips the KV write. `tools/validate_presets.mjs` is an optional diagnostic, not
  a merge gate. Proof: `worker/test/suggestions.test.mjs`,
  `worker/test/admin.test.mjs`, and `test/contract/suggestion_fallback.test.mjs`.

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
`votes_on` owns composed scope. The official profile renders its precomputed
decision trail inline; do not send readers to a Meetings scope to see those
votes. Never promote name-derived officials.
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
The Worker looks up one keyed D1 row (`worker/src/lib/entity_intelligence_read_model.mjs`,
migration `0026_entity_intelligence_read_model.sql`) published from the committed
lookup by `node tools/build_worker_d1_read_models.mjs`. Do not import
`entity_intelligence_lookup.json` into the Worker bundle; a D1 miss or failure
is the existing empty/unavailable state, never a whole-corpus fallback. Proof:
`worker/test/entity_intelligence.test.mjs`,
`worker/test/d1_read_models_canary.test.mjs`.
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
(`rows.passport_contracts`). The Worker single-file lookup stays at the
measured 1,550-row gzip ceiling; the published constellation graph is the
award-corroborated census under a 20,000-row hard ceiling, sharded as
`site/data/entity_intelligence_shards/passport_graph.json` (agency previews +
vendor counts). Full daily dumps, RFx, and unresolved award joins stay
excluded. OCP awards still prefer the existing PIN↔EPIN join — not the 2-row
`passport_contracts_materialization` Checkbook-crosswalk demo. Selection
helpers: `selectPassportContractsForMaterialization` /
`selectPassportContractsForShardedGraph` /
`selectOcpAwardsForMaterialization` in `tools/lib/entity_intelligence_build.mjs`.
Selection is agency-stratified round-robin. Rebuild the core lookup with
`node tools/build_entity_intelligence.mjs`; shards only with `--graph-only`.
Measure + age/coverage receipt: `node tools/measure_passport_ei_densify.mjs`.
Verify: `node --test test/procurement_spine_ei_densify.test.mjs`.

**Checkbook Contracts population feed:**
`warehouse/scripts/checkbook_contracts.mjs` pages explicit fiscal-year
partitions with count-drift failure, checksummed resumable checkpoints, and a
100,000-row hard ceiling. It collapses prime/subvendor slices to one exact
`prime_contract_id`, measures PASSPort and modern City Record overlap before
selection, and publishes CROL-eligible rows through
`site/crol_notice_publication_policy.mjs` (City Record Award amount + 365-day
window; no separate numeric cap). Refresh with
`node warehouse/scripts/checkbook_contracts.mjs --publish --refresh --fiscal-years
2025,2026,2027 --page-size 999`; verify with `--check` and
`node --test test/checkbook_contracts_collector.test.mjs test/crol_notice_publication_policy.test.mjs`.

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

**WH-03 OCP serve:** materialize warehouse OCP into the canonical
`site/data/ocp_awards_warehouse_lookup.json`. Worker D1 deployment SQL consumes
that site copy directly; no Worker duplicate is committed. Replaces live SODA
in `fetchOcpAwardRows` for materialization hits; live SODA remains the miss
fallback. Rebuild + speed receipt:

```bash
node tools/build_ocp_warehouse_lookup.mjs --fixture --bench
# receipt: warehouse/receipts/proof/wh03_ocp_lookup_speed.json
```

**WH-05 ZAP serve + land freshness:** materialize sell-facing ZAP projects
(+ demo `2022M0258`) into `site/data/zap_projects_warehouse_lookup.json`
(+ Worker twin) as the last-resort floor. The 08:00 Worker cron writes live
SODA `hgx4-8ukb` into `ALERT_STATE` `land:zap-lookup:v1`; `GET /zap-projects-lookup`
and `fetchOpenDataRow` read KV first. Live SODA remains the miss fallback.
Do not rewrite the 10.6 MB keyword index or the 40-row default ULURP snapshot
on a daily loop — land keyword miss-fills canaries from live SODA
(`site/land_keyword_soda_missfill.mjs`). The 36-hour freshness gate is the KV
clock (`land:zap-lookup:v1`), not git age. Upcoming hearings are derived at
`0 8 * * *` from `zap-outcome:v1:{id}` plus the SODA sell-facing id list into
`ALERT_STATE` `land:upcoming-hearings:v1` (`GET /land-upcoming-hearings`);
`site/data/land_upcoming_hearings.json` is the last-resort floor.
`fetchLandDefaultProjects` prefers DuckDB only when the milestone frontier
clears `warehouse/lib/zap_freshness.mjs`; otherwise SODA. Canaries `2025Q0331`
/ `2026K0123` fail `--check`. The scheduled lookup also carries cutoff-aware
CEQR / environmental source fields via `warehouse/lib/zap_environmental_projection.mjs`
(`ceqr_number`, `ceqr_type`, `ceqr_lead_agency`, `eas_eis` as
`environmental_review_type`, current environmental milestone/date). Missing
facts stay explicit; titles, action codes, and land-use milestones never fill
them. ZAP has no `environmental_status` column, so that field remains
`source_field_absent`. Keep this depth on the warehouse lookup — not
`land_default_ulurp.json`. Overlay with
`node tools/build_zap_warehouse_lookup.mjs --overlay-environmental`. Proof:
`test/zap_environmental_projection.test.mjs`. The unit test
`test/warehouse_serve_publish_contract.test.mjs` derives its reference now from
committed twin `materialized_at` stamps — do not freeze a calendar `now`.
WH-02 bulk lag: `node tools/check_zap_bulk_freshness.mjs`
(+ optional `--rematerialize-if-stale`).

```bash
node tools/build_zap_warehouse_lookup.mjs --from-soda
node tools/refresh_land_zap_freshness.mjs
node tools/build_zap_warehouse_lookup.mjs --check --against-live
node tools/check_zap_bulk_freshness.mjs
node --test test/land_zap_freshness.test.mjs
# receipt: warehouse/receipts/proof/wh05_zap_lookup_speed.json
```

ZAP project observations are shadow-dual-written from the daily outcome prewarm
under `ZAP_PROJECT_SOURCE_RECORD_DUAL_WRITE`; the stable source key is the exact
publisher `project_id`, matching graph provenance `zap-projects:<project_id>`.
Host proof: `node tools/retain_zap_project_source_records.mjs --check`. Public
edge totals never read or count the shadow rows.

**WH-05 Doing Business serve:** materialize Doing Business Search Entities into
`site/data/doing_business_warehouse_lookup.json` (+ Worker twin) from the WH-02
optional pack (`doing-business-entities` / SODA `72mk-a8z7`). Full-catalog modes
(`bulk_warehouse` / `bulk_soda`, ~10.8k rows) make `attachDoingBusiness` skip
multi-page SODA; empty/partial snapshots remain the only live gap-fill. Serve
gate (`doingBusinessServeGateFindings`) fails `--check` on age / row-count drift
/ missing `CAMBA  INC`. Weekly refresh→publish:
`.github/workflows/doing-business-warehouse-lookup.yml` (`--from-soda`).

```bash
warehouse/.venv/bin/python warehouse/scripts/ingest.py \
  --dataset doing-business-entities --bulk --ack-large
node tools/build_doing_business_warehouse_lookup.mjs --bench
node tools/build_doing_business_warehouse_lookup.mjs --check
# receipt: warehouse/receipts/proof/wh05_doing_business_lookup_speed.json
node --test test/warehouse_wh05_lookups.test.mjs worker/test/wh05_warehouse_lookups.test.mjs
```

**Payroll title mart (optional-pack projection, not a 6.8M bulk):** SODA
`k397-673e` group-by. The 13:00 Worker cron writes `ALERT_STATE`
`payroll:title-mart:v1`; People title/payroll suggestion counts read KV first
and fall back to the committed twin
`site/data/payroll_title_warehouse_lookup.json` / Worker copy. One FY title →
`{count, min/max/avg base}` row; no employee PII. Follow-ons: agency ×
title, median bands, multi-FY, optional raw pack. Rebuild the floor with
`node tools/build_payroll_title_warehouse_lookup.mjs --from-soda --bench`;
`--check` + `node --test test/payroll_title_mart.test.mjs
worker/test/payroll_title_mart_kv.test.mjs worker/test/suggestions.test.mjs`.

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

**Land BBL→MapPLUTO centroids:** WH-06 stores `project_id → bbls[]` only.
Exact Land map pins use the committed BBL→centroid table
`site/data/bbl_mappluto_centroids_lookup.json` (pure `site/bbl_mappluto_centroids.mjs`;
`resolveLandMapLocation` precedence: authoritative point → BBL centroid → address
geocode → unresolved). The resolver must read WH-06
`site/data/zap_bbl_warehouse_lookup.json` via `collectProjectBbls` / `bblsForProject`;
list rows and a missing `/zap-outcomes` KV hit must not starve the centroid path.
Rebuild offline from a PLUTO CSV or build-time ArcGIS
batch — never live ArcGIS on the resident hot path:
`node tools/build_bbl_mappluto_centroids.mjs --from-pluto-csv <pluto.csv>` or
`--from-arcgis`; gate with `--check` (age ≤120d, ≥95% sell-facing BBL coverage,
canaries `3012660036` / `2026K0123` and `5017800015` / `2025R0257`). Focused proof:
`node --test test/bbl_mappluto_centroids.test.mjs test/land_map_resolution_model.test.mjs`.

**Land default mapability census:** `tools/lib/land_mapability_census.mjs` is the
denominator-first join of the pinned 40-row `land_default_ulurp.json` corpus to
exact WH-06 BBL keys and finite retained MapPLUTO centroids. Rebuild the
committed receipt with `node tools/build_land_mapability_census.mjs`; `--check`
verifies it. Geocoded points, district guesses, neighboring parcels, and
outcome-only coordinates stay out of the numerator. This receipt does not ship
a browse Map or change Land filters. Focused proof:
`test/land_mapability_census.test.mjs`.

**WH-07 City Record PIN-chain serve (first history projection):** materialize
procurement-with-pin siblings from the WH-07 `city_record` bulk into
`site/data/city_record_pin_chain_warehouse_lookup.json` (+ Worker twin).
`fetchRelatedProcurementNotices` prefers the materialization before D1 / live
SODA. Rebuild: `node tools/build_city_record_pin_chain_lookup.mjs` (`--fixture`
offline; DuckDB export when catalog present). Serve gate + LKG retention via
`cityRecordPinChainServeGateFindings` / `serve_publish_contract` canaries
`07219P0148001R004` + `20260723031`. Proof:
`node --test test/city_record_pin_chain_lookup.test.mjs worker/test/city_record_pin_chain_warehouse_lookup.test.mjs`.
Follow-ons: 90d/365d Money-archive index, agency rollups, refresh→publish workflow.

**Remaining bulk (sequential, only if headroom green):** optional later full
`doing-business-entities` bulk (~11k; enables zero-SODA vendor attach) when the
serve twin is not already filled via `--from-soda`. Query seam:
`warehouse/lib/query.mjs` / `warehouse/scripts/query.py`. Details:
`warehouse/README.md`.

## Warehouse batch ER (WH-04)

Reuse `entity_resolution/` (vendorStem, token_v0, scorePair, canonicalAgency) —
do **not** reimplement matchers in SQL. Capped runner (same lock + headroom +
taskpolicy wrap as ingest):

```bash
python3 "$HEADROOM_BIN"   # CONSTRAINED → defer
warehouse/.venv/bin/python warehouse/scripts/er_batch_run.py --from-fixture --limit 25 --force-headroom
warehouse/.venv/bin/python warehouse/scripts/er_batch_run.py --limit 200   # warehouse OCP slice
warehouse/.venv/bin/python warehouse/scripts/er_batch_run.py --limit 200 --resume
warehouse/.venv/bin/python warehouse/scripts/query.py \
  --sql-file warehouse/sql/examples/er_entity_links_verify.sql
```

Warehouse replay reads the retained WH-02 OCP snapshot (not a live API slice),
writes a stage checkpoint, and refuses `--resume` when the snapshot hash or
limit changed. Accepted `same` pair links keep evidence; unresolved and
rejected pairs stay off identity. The 200-row cap remains; a wider run needs a
precision review beyond that proof.

Materialized views: `er_entity_link`, `er_canonical_entity`, `er_resolution_run`,
`er_pair_receipt`, `er_ocp_vendor_resolved`. Pure lib:
`warehouse/lib/er_batch.mjs`. Proof:
`warehouse/receipts/proof/wh04_er_batch_latest.json`. Verify:
`node --test test/warehouse_er_batch.test.mjs && python3 warehouse/scripts/verify_er_batch_receipt.py --check`.

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
definitional CD∩council `intersects` multi-membership from
`site/data/community_board_geography_lookup.json` (`publisher_district` primary
method; council supplement `cd_intersects_council` — centroid PIP retired);
property and geocoded pins use boundary-layer point-in-polygon; meetings /
rules / money use the human-derivation location chain (below). Venue / vendor
addresses upgrade from borough-only to CD + council via the offline civic
gazetteer (`site/civic_address_geocode.mjs` → PIP). Never invent districts for
unlocated rows. `--check` fails if meetings are counted but zero-located, and if
land or meetings have coarser density while council-district is all-zero.

**First-class non-polygon bags:** `citywide` (rules that apply everywhere, citywide
phrase awards) and `virtual` (virtual-only meetings with no matter pin). The map
list renders them as labeled rows at every level; district detail also notes
citywide items that apply city-scale without counting them into polygons.

**Typed civic-geography primitive:** `site/civic_geography_registry.mjs` is the
closed control plane for borough, Community District, Council District, NTA 2020,
Police Precinct, Sanitation District, and BID. The latter four are ingestion/QA
only until a separate product card exposes them; keep their source contracts
backstage-only and `public_relations` empty. `tools/build_civic_geography.mjs`
owns their independent artifacts/receipts, reviewed BID identity, PIP/PLUTO QA,
DSNY congruence drift, and the vintage-gated MODA oracle;
`site/civic_geography.mjs` is the generic typed point resolver. The builder keeps
source-native normalization in `tools/lib/district_boundary_source_adapters.mjs`,
constructs independent full/simplified versioned artifacts, and projects the old
combined JSON and named district resolvers only as compatibility wrappers. Exact
area/share overlays must use full-fidelity geometry through
`site/civic_geography_overlay.mjs`; the existing 237 public CD↔Council edges retain
their compatibility semantics until a separate product migration. Per-layer
freshness and coverage belong to the existing location-resolution Data Health
dimension. Verify with `node tools/build_district_boundaries.mjs --check`,
`node tools/build_civic_geography.mjs --check`,
`node tools/benchmark_civic_geography.mjs --check`, and the civic-geography tests.

**Geography subject graph:** `district_activity.geography_subjects` materializes
canonical borough / regular community-district / council-district nodes and one
routed `located_in` candidate per polygon membership. Publisher, structured-bag,
PIP, and definitional CD∩council intersects placements are public; weak agency-HQ
/ vendor fallbacks remain `evidence_only`. Citywide, virtual, and unlocated never
become polygon subjects.
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
| **Land** | ZAP `community_district` (+ publisher council when present) | `publisher_district` + `cd_intersects_council` fan-out when council field absent |
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
| Money default open RFPs | Live SODA open solicitations 40 on `#` / Money open | `site/data/money_default_open.json` | Preserve the build-rendered cards while the compact snapshot hydrates (drop past-due rows client-side); broader filters and explicit detail selection may read `money_resident_snapshot.json` |
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

**No per-contract public page.** `contracts.html` / `vendor.html` are client-side
DataTables browse pages (Contract ID / EPIN / vendor filters are DOM-only; no
query or hash deep-link). Dump columns have no URL field. Resident official-source
for a PASSPort-only procurement is that contracts browse portal, labeled
"PASSPort Public contracts" (`passportPublicOfficialSource` in
`worker/src/lib/passport_parse.mjs`; rendered by
`procurementOfficialSourceItems` in `site/procurement_document.mjs`). Numeric
`rfp_id` still deep-links the authenticated RFx extranet for solicitations.

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
columns only (no EIN/BIN/PIN). Source contract `doing-business-entities` is served from
the committed WH-05 lookup on daily vendor-profile rebuilds (`doingBusiness` field);
live multi-page SODA is gap-fill only. Strategies and receipts:
`worker/src/lib/doing_business_join.mjs`, `site/data/doing_business_sources/`,
`site/data/doing_business_warehouse_lookup.json`. Publisher dates often use truncated
`00YY` years — normalize to `20YY` before display.

## ULURP Recommendations (`4j6i-9rmr` + PDF `gt5i-dmde`)

Land-outcome depth candidate (Borough President positions + letter PDFs). **Measured
below usefulness** (2026-07-30): strict ULURP-token join on ZAP projects with non-null
`ulurp_numbers` is **0.54%** either-source (152/27,971), **0.29%** recommendations,
**0.25%** PDFs. Borough-scoped historical catalogs (91 + 88 rows). Source contracts
`ulurp-recommendations` and `ulurp-recommendation-pdfs` are **live** for a **sparse** Borough President panel gated on the recommendation-row denominator (~88% hit rate), not ZAP-universe catalog coverage (0.54% contrast only). Lookup `site/data/ulurp_recommendations_lookup.json`; panel `site/ulurp_recommendation_panel.mjs`; gate policy `ontology/join_gate_policy.mjs`. **Wrong universe:** Property Disposition notices are not ZAP projects. Strategies and receipts: `worker/src/lib/ulurp_recommendations_join.mjs`, `site/data/ulurp_recommendation_sources/`.

**Land procedure profile contract:** `site/data/land_procedure_profiles.json` is the small,
reviewed `cityscroll.land_procedure_profiles.v1` registry for §197-a/§197-c/§197-d/§197-e
stage roles, effects, conditions, and windows. `site/land_procedure_profiles.mjs` is its
closed consumer; `buildLandPhaseView` exposes the result as the additive `procedure_profile`
normative sibling. It never creates or rewrites `record.spine` observations; milestone-only,
mixed-action, and missing-procedure inputs remain unresolved. Focused proof:
`test/land_procedure_profiles.test.mjs`.

**Land action procedure resolution:** `site/land_action_procedure_resolution.mjs`
projects additive `land_actions[]` and `procedure_resolution=uniform|mixed|unknown`
from exact action tokens plus matching ULURP/application/CEQR identifiers. Mixed
is a positive output; unsupported tokens, missing ids, and sibling copy remain
unknown. Keep `actions`, `ulurp_numbers`, `ulurp_non`, filters, routes, and
phase-spine inputs unchanged. Specimens: `2024M0244` mixed, `2025K0305` uniform,
`2026K0123` unknown. Focused proof: `test/land_action_procedure_resolution.test.mjs`.

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
`attachUlurpStatutoryPredictions` in `buildZapOutcomeRecord`. **ULURP only:**
resolve `ulurp_non` from the record or `open_data.ulurp_non` (top-level is often
null). ELURP / Non-ULURP return `status: ineligible` / `reason: wrong_procedure`
— do not invent a §197-e day table. Uncertified stays `not_certified`.
**Reader-facing phase deadlines use phase start + window days**
(`deadline_basis: phase_window`) when a milestone actual_start / prior
completion is known; `outer_bound_due_date` keeps certified+cumulative for
predictions only. Never paint the outer envelope as a live “N-day clock”
(field case `2026R0127`: Council start 2026-07-31 → due 2026-09-19, not
certified+200 = Nov 27). Insufficient timing fails closed (`due_date: null`).
UI uses the precomputed view only. Withdrawn projects close open predictions
as `withdrawn`. Verify:
`node --test test/ulurp_statutory_clock.test.mjs test/land_use_copy_council_clock.test.mjs`.
Capture: `python3 tools/capture_ulurp_statutory_clock.py`.

**Land-use action copy + detail coherence:** `/browse/zoning/` hosts acquisitions,
special permits, map changes, and rezonings. `site/land_use_action_type.mjs`
keeps `families[]` first-class (`PP`/`HA` disposition, `PQ`/`PC` acquisition;
`LD` is `legal_document`, not landmark — `HK`/`HI` are the landmark codes);
`primary` / `is_rezoning` are sole-family conveniences and must not collapse a
bundled application into “this rezoning”. Participation headings come from that
module (never the pathname). Reconcile list-row Open Data
vs zap-outcomes status, future-only next hearings, and next-phase-after-current in
`site/land_detail_coherence.mjs` / `buildLandProjectState` before render (field
cases `2023M0213`, `2026K0123`). **Filed vs Noticed** are values of the same ZAP
`public_status` enum (Open Data may lag the portal) — resolve to one reader-facing
value, never two “Public status” lines. **Notice while filing/CEQR** is a permitted
overlap (`phase.state: overlap` + explained copy), not plain “Done” after the current
step. Verify: `node --test test/land_use_copy_council_clock.test.mjs`.

**Land current-stage pointer (stranded outcomes):** `deriveLandCurrentPhaseId` in
`site/land_phase_spine.mjs` must not keep an earlier phase as `current` when a
later phase already has terminal completions (e.g. CB still "In Progress" while
BP/CPC completed — field case `2019K0190`). Advance past missing outcome rows;
mark those earlier phases `outcome_status: no_recorded_outcome`. “What's next”
must never fall back to an earlier incomplete template slot. Empty pre-review
phases the project never entered are omitted from the applicable stepper. Verify:
`node --test test/land_phase_spine.test.mjs test/ontology_coherence.test.mjs`.
Capture: `python3 tools/capture_land_stage_coherence.py`.

**ULURP pipeline position + ZAP hearing logistics:** Public status
“In Public Review” is the overall frame; Community Board / Borough President /
CPC / Council / Mayor is the current step inside it. `buildUlurpPipelinePosition`
joins phase view + statutory clock into one sentence on the land detail spine
(“Public review — step N of M: …”). Days-left only from a phase-window statutory
`due_date`. Hearing venue/livestream free text lives on
ZAP disposition `dcp-publichearinglocation` (+ `dcp-dateofpublichearing` with
clock time) — parse in `worker/src/lib/zap_hearing_logistics.mjs`, stamp
`hearing_logistics` on `/zap-outcomes`, and feed the land action rail (maps
attend + watch live). “Next hearing” is future-dated only. The individual-project shape is an array only when exact
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

Scheduled: Worker cron `0 8 * * *` → `ALERT_STATE` `land:upcoming-hearings:v1`
(`GET /land-upcoming-hearings`). The committed JSON remains the cold-KV floor;
`--check` still forbids synthetic rows. Field case: `#land/2024Q0292`. Capture:
`python3 tools/capture_zap_hearing_logistics.py`.

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
untracked paths `docs/data-source-graph.{json,html}` from source contracts, the shared
`source_health_observations` projection, gap research, warehouse configs/receipts, and Worker
cron code. Each contracted row carries the observation's contract fingerprint, three clocks,
runs/receipts, fallback state, and separate join gate; credential values are redacted before
exact errors enter the backstage artifact. Uncontracted `not_ingested` candidates and
`partnership_blocked_sources` remain dashed research paths, never live-source claims. The site
build runs generation followed by
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
after updating their repository revision. `DATA_SOURCE_GRAPH_SCHEMA_VERSION` in
`tools/data_source_graph.mjs` and `data/data-source-graph-desk-contract.v1.json`
are the desk pin: bump both together, and do not ship a producer version the
authenticated desk consumer has not added to its supported set. This repository
does not deploy the desk.
Public capability summary for third parties lives in root `README.md`; the desk
`/capabilities` board is a separate private-team surface. Its ordered, public-link input is
`site/demo/demo-links.json#capabilities`: downstream desk builds join those stable IDs to the
same entries' URLs, rationales, and browser expectations. Verify every selected production URL
with `python3 tools/verify_capability_permalinks.py` before publishing a refresh.
The public Contracts object/browse capabilities are registered in `capabilities/contracts.mjs`;
`worker/src/contracts.mjs` delegates HTTP and MCP reads to the shared procurement model and its
exact identity gate. Keep the canonical `procurement_id`, source provenance, coverage envelopes,
freshness/as-of, amount validity, and lifecycle projection aligned with the existing Contracts
UI producers; do not add request-time publisher or raw source-store reads.

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
the Worker retains the stamped Cloudflare Pages full-site failover and a raw-repository
document seam for `/docs/*` and `/README.md` only. Post-deploy gate:
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
`--refresh` re-pages the SODA group-by (never roster rows). The 08:00 Worker
cron overlays SODA schedule + exam-level list group-by + OASys `GetActiveExams`
onto `ALERT_STATE` `staffing:exams:v1`; `GET /staffing-exams` and people/guide
digest replay read KV first, committed `staffing_exams.json` as floor. Exam HTML
under `site/exams/**` stays committed. Hash exams (ids, windows, fees) so a
quiet day does not invent a content change; the 7-day serve gate is the KV
clock. Artifact stamps `list_current_as_of`, `open_window_as_of`, and
freshest-source `data_current_as_of`. Closed exams that leave the current FY
annual snapshot stay joinable through `list_depth_closed_exams.json` (open 7xxx
series has 0% list presence). UI: `list_joined` when list depth attaches; empty
aggregate slots use class-(a) `not_yet_ingested`
(`career_outcomes_not_yet_ingested_html`) — never class-(b) city-withhold for
aggregates. Individual scores remain class-(b).

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

**Localized exam-card eligibility prose:** `site/exam_reader_copy.mjs` projects
who-may-qualify / fee-waiver / residency / test-method / NOE-window labels from
normalized categories (`education_level`, `no_experience_required`, promotion)
into i18n keys. Under non-English UI never pair a translated label with raw
English `exam.qualifications`; missing locale strings fail closed to a
see-NOE line or omit. English keeps the compressed NOE-derived sentence; official
NOE links stay on the publisher PDF. Wired from `site/app/exams.mjs`. Verify:
`node --test test/exam_reader_copy.test.mjs`.

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

**Watermark-backlog fold-in (regular 13:00 digest):** when delivery was stalled or
held, the next regularly-scheduled send covers everything owed since that
subscriber's last successful delivery (`lastsent`, else `createdAt`) — not just
the last 24 hours. `attachOwedRows` folds the durable outbox into matching
watch sections on both `processOneSub` and `processAccountRollup`.
`owedForSubscriber` pages the full owed set (`listAllOwedItems`); a 500-row
SELECT must not drop the tail. No separate manual drain. When lastsent is older
than one scheduled period (daily: >1 UTC day; weekly: >7), the subject and
header say `Catching up: N items since your last digest on <date>`. Desk
`traffic_class: catch_up` stays on `isMultiDayLagRecovery` (lag >1 with fresh
rows). Proof: `worker/test/watermark_backlog_digest.test.mjs`.

**Confirmed-send ordering:** after the provider accepts an email, the single-watch,
account-rollup, award-watch, and config-watch paths persist `lastsent` and seen
identities before later outbox, counter, or statistics bookkeeping. Keep this
ordering so a partial post-send failure cannot reopen the already-delivered window;
`advanceState: false` continues to suppress these writes for previews and test
sends. A delivered account rollup advances `lastsent` for every watch in that
email (quiet and skipped-cadence sections too). Catch-up copy uses the oldest of
those watermarks, so leaving a quiet sibling stuck repeats "Catching up since
{date}" on later matching sends. Recovery must not overwrite a later `lastsent`.
`GET /admin/reliability/digest` flags a watch delivered on consecutive days whose
`lastsent` still predates day N-1. Proof: `worker/test/watermark_backlog_digest.test.mjs`
and `worker/test/reliability_watchdogs.test.mjs`.

**Catch-up evaluation** (`runCatchUpDigests`) is evaluation-only: it enqueues
owed identities into the outbox and does not send. The next regular digest is
the drain. Admin `POST /admin/digest-catchup` and `DIGEST_CATCH_UP=1` still
select lagging watches; they must not be used as a second send path.

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
with the public worker (digest modes, daylog actions/fields, stats metrics, signup
lifecycle, admin routes + auth classes, KV prefixes, feature flags). No secrets; never
on public `/stats`. `signup_lifecycle` on `GET /admin/subs` (JSON or `?view=html`) is the
SL-01 ops-visibility surface: recovered / pending-enrollment stays intermediate until a
digest day after the recovery watermark, then enrolled. Authenticated desk/admin/ops
views show the full `sub:` key and address — the 2-hex `maskKey` form collides
(`sub:36***` named two live watches). `maskKeyForLog` / `redactEmail` stay on
shared Cloudflare logs only (`console.log("alerts run")`, `digest job`, inbound).
Proof: `worker/test/admin_ops_identity.test.mjs`.

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

## Developer / e2e test accounts and recovered signups

Plus-tagged automation addresses (`+e2e`, `+scope-watch`, for example
`name+scope-watch-e2e-20260806@gmail.com`) are recognized by `isDeveloperTestEmail`
in `worker/src/lib/subscriptions.mjs`. They never count as real subscribers
(`countSubscriptionMetrics`), never receive real digests (`isWatchActive` /
`processOneSub`), and render as `test` on the ops-visibility surface
(`handleAdminSubs` / `toRosterRow`). Live signups stamp `developer_test` on the
sub record; deprecated-double-opt-in recovery writes a marker-only
`developer-test-account:` row instead of a watch.

Recovered stranded signups keep `source: recovered-from-deprecated-double-opt-in`.
`recoverDeprecatedDoubleOptIn` always applies the committed four-row manifest in
`worker/src/lib/deprecated_opt_in_recovery_manifest.mjs` (three real addresses plus
the e2e test marker). Caller-supplied rows cannot shrink that set. The daily
digest cron applies it fail-soft after `runAlerts`; `POST /admin/recover-deprecated-opt-in`
uses the same path. Recovery is identity-preserving: an already-enrolled
equivalent broad money watch (`{}` or a `sanitize()` empty filter, including
`legacy-confirm` / topicless) is kept and any recovered pending duplicate for
that address is deleted. `signupLifecycleFromRecord` projects `recovered` /
`pending-enrollment` until a digest day after the recovery watermark, then
`enrolled`. `summarizeSignupLifecycle` is the category view (`"3 recovered, pending"`
then `"enrolled"`) rendered by `GET /admin/subs?view=html`. Topicless homepage intents
stay `confirmed`. Proof:
`worker/test/recovered_signups.test.mjs`, `worker/test/subscriptions.test.mjs`,
`worker/test/rollup.test.mjs`.

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
production Worker vars enable the fail-soft shadow path on City Record ingest.
Integration characterization: `node --test worker/test/er_ingest_integration.test.mjs`.
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
`worker/src/entity_dossier.mjs`. The transport-neutral direct operation is
`entity.dossier.get@1` in `capabilities/entity_dossier.mjs`; its one HTTP adapter
preserves the existing JSON and HTML representations. Verify:
`node --test worker/test/entity_dossier_capability.test.mjs worker/test/entity_dossier.test.mjs worker/test/entity_resolution_publication.test.mjs`.

**Public relationship graph (er-16) — same gate as dossier:**
`GET /entity-relationships?id=` projects linked procurement observations when a
canonical entity exists; otherwise **404** + `public_status: "not_yet_public"`.
Do not market as live for subject-registry ids. When resolved: named edge types,
publisher provenance, public-safe confidence; depth/fan-out caps. Pure model:
`entity_resolution/publication/relationship_graph.mjs`; Worker:
`worker/src/public_relationship_graph.mjs`. The separate transport-neutral direct
operation is `entity.relationships.get@1` in
`capabilities/entity_relationships.mjs`; its HTTP adapter preserves the existing
JSON and HTML representations. Verify:
`node --test worker/test/entity_relationships_capability.test.mjs worker/test/public_relationship_graph.test.mjs`; captures:
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

**Rules related-language lane:** `site/rules_semantic_lane.mjs` is the typed,
versioned projection over the committed corpus manifest, reviewed retrieval
receipt, source-passage map, and Rules snapshot. The artifact is rebuilt with
`node tools/build_rules_semantic_lane.mjs`; runtime embeddings remain disabled,
lexical results own duplicates, and agency/process/place/date constraints are
hard publication gates. Focused proof: `test/rules_semantic_lane.test.mjs` plus
the Rules case in `test/primary_document_routes.test.mjs`.

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
City Record and capital-dashboard paths remain stopped. Live
`procurement_plans_run.py` defaults to the identifier-bearing sample; `--from-fixture`
keeps the legacy fixed-sorted sample. Remeasure:
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
production vector layer from the existing hashed TF-IDF T3 related-reading artifact. SQ-08
re-scored that hashed vector plus the frozen MiniLM receipt against the golden-suite
lexical-miss set; public ranking weight remains 0. Source, failure analysis, costs, and
rerun commands are in `docs/research/semantic-layer-trial-2026-08-04.md`.
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
- CB-MONEY-00's reviewed financial identity is the source-scoped exact-code
  crosswalk at `site/data/community_board_financial_identity_crosswalk.json`,
  built by `node tools/build_community_board_financial_identity.mjs`. Its
  receipt records source coverage and explicit no-observation states; use
  `--check` before downstream budget or payment materialization. Keep the
  generic `Community Boards` agency grouping in `site/agency_identity.mjs`
  unchanged.

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
- Retained zero-obligation laws retry through
  `tools/law_mandates/retained_retry.mjs`; fidelity labels are automated,
  source-grounded provenance rather than a publication gate. Build the public
  run receipt with `node tools/law_mandates/build_retained_retry_evidence.mjs`.
  Focused proof: `node --test test/mandates_pipeline.test.mjs`.
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

## Entity-resolution curation verdicts

- `entity_resolution/review/curation_verdicts.mjs` owns the fixed append-only
  verdict receipt and current-state projection. D1 persistence in
  `worker/src/lib/curation_verdicts.mjs` with migration `0021_curation_verdicts.sql`
  is receipt-only: policy-satisfied ACCEPT/REJECT decisions become immutable gold
  candidates through `tools/export_review_actions_to_gold.mjs`, never direct
  `entity_link` writes or promotions. REVIEW and policy-withheld decisions remain provisional.
  Public ER serializers are allowlisted and must not expose these receipt payloads.
  Focused proof: `test/review_action_export.test.mjs` and
  `test/entity_resolution_shadow_monitor.test.mjs`.
- Live desk decisions enter through `worker/src/lib/curation_review_command.mjs`:
  one idempotency key binds the exact assertion version and commits the disposition,
  verdict/effect, and command receipt in one D1 batch (`0022_curation_review_command.sql`).
  `action_log` is a fail-soft privacy-safe projection after that authoritative commit;
  never add it as a peer write. Partial-failure/retry proof is in
  `worker/test/false_split_evidence.test.mjs`.

## Evidence-bearing provenance read model (EBCG Card 1)

- `entity_resolution/provenance_graph.mjs` is the pure in-process assertion →
  evidence → decision → actor read model over the append-only ER records above —
  not a graph database, migration, route, or writer. Assertion identity is the
  immutable `assertion:<key>:v<version>`; the existing review-pair receipt target
  attaches only through the compatibility `decision_target` mapping — never treat
  the pair id as the assertion id. Public exposure goes only through
  `publicProvenanceProjection`; decisions, actors, receipts, and internal ids stay
  private. Contract details: `entity_resolution/README.md`. Verify:
  `node --test test/evidence_bearing_provenance_graph.test.mjs`.

- **Cross-source evidence receipt:** `site/cross_source_evidence_receipt.mjs`
  projects accepted exact corroboration onto the canonical procurement document
  as compact “Also recorded in Checkbook / PASSPort / OCP” rows. Amount, date,
  and PIN disagreements keep both source assertions, the publisher field, and
  the as-of basis, and label the CityScroll comparison `unresolved`; agreement
  stays a compact source-labeled confirmation. It consumes constructor joins,
  Checkbook/PASSPort corroboration, and EBCG provenance / curation decisions;
  fuzzy, related-instrument, rejected, ambiguous, unknown, and untested
  observations stay unlabeled. Canonical amounts are not rewritten. AP-06
  remains a bounded coverage consumer via `citeCityRecordCoverageFromReceipt`
  and is not an identity owner. Proof:
  `test/cross_source_evidence_receipt.test.mjs` and
  `test/analytical_projection.test.mjs`.

- **Cross-source coverage ledger (EBCG-05):** `site/cross_source_coverage_ledger.mjs`
  is the compact object-view lookup-state projection over declared publishers
  (`corroborated` | `checked-no-match` | `not-checked` | `ambiguous` |
  `unavailable` | `stale`). It reuses EBCG-01 `entity_resolution/source_coverage.json`
  for named denominators/vintages and the procurement/meeting source envelopes;
  a checked miss is never a world-absence claim. AP-06 registered-contract
  exact/none/missing-PIN counts stay a separate analytical scope. Procurement and
  meeting documents render it; focused proof is
  `test/cross_source_coverage_ledger.test.mjs`.

## Snapshot-only citywide address geocoder

- `site/precomputed_address_geocoder.mjs` is the exact full-address → BBL read boundary over the 64-shard official PAD artifact in `site/data/address-index/`. Only real and vanity PAD ranges are admitted; pseudo-addresses, ambiguity, and misses stay `unknown`. Refresh with `node tools/build_geocoder_address_index.mjs --from-live`; verify the complete committed snapshot with `--check` and `test/geocoder_snapshot.test.mjs`.

## Suggested-query destination certification

- Contracts “Try asking” candidates are certified through `site/suggestion_destination.mjs`, which replays the canonical route over the same resident snapshot, keyword SearchDocuments, and final Money filters as `site/app/money-list.mjs`. The daily Worker KV record must carry the destination route, corpus clocks, and final count; proxy-only Money counts are not display-eligible. Focused proof: `test/suggestion_destination.test.mjs` and `worker/test/suggestions.test.mjs`.

## Canonical source-health foundation

- A new civic source joins health reporting through one
  `site/data/source_contracts.json` contract. The onboarding fields, canonical-id
  observation join, three-clock plus coverage evaluation, and public/backstage
  split are in [`docs/source-health-participation.md`](docs/source-health-participation.md).
- `site/data/source_contracts.json` owns durable freshness expectations and
  public/backstage policy; transient clocks never belong there. Build the
  receipt-derived sibling with `node tools/build_source_health_observations.mjs`
  and verify it with `--check` plus `test/source_health_projection.test.mjs`.
  `ontology/source_health.mjs` evaluates the three clocks deterministically;
  D1 relationship coverage remains a separate axis. The raw observation file
  stays excluded from Pages. Build the strict allowlisted public sibling with
  `node tools/build_source_health_public_projection.mjs`; Worker `/source-health`
  serves that artifact with null-on-unavailable semantics. Public fields and
  leak guards live in `site/source_health_public_projection.mjs`. The
  desk graph is a second projection of the same observation model, not a
  second store. The resident `/data-health/` page is a materialize-first
  projection of that same public artifact (`site/data_health_page.mjs`;
  rebuild with `node tools/build_data_health_page.mjs`). It does not
  evaluate clocks at request time. The page lists every source CityScroll
  serves or copies. A served source is never dropped. ABO is observed via
  the Worker weekly KV refresh (`refreshAboAwards`) and `GET /externalaward`
  plus residual receipts; Checkbook contracts/spending use their population
  receipts. `acquisition-status-unknown` is builder blindness, not an omit
  test. Unused disabled sources with no dated clocks stay in
  `source_contracts.json`. Remaining runtime caches without a committed
  refresh receipt keep honest UNKNOWN clocks until that receipt exists.
  Honesty-conformance (historical/pointer
  never delayed by age, daily delayed only after its own breach,
  failed-acquisition plus valid fallback is Degraded, unknown clocks stay
  null, no operator field on the public surface) lives in
  `test/source_health_status.test.mjs` and
  `test/source_health_partial_observations.test.mjs`. Proof:
  `test/source_health_projection.test.mjs`,
  `test/source_health_public_projection.test.mjs`,
  `test/source_health_status.test.mjs`,
  `test/source_health_partial_observations.test.mjs`,
  `test/data_health_page.test.mjs`, and
  `worker/test/source_health.test.mjs`.
- **Stats ↔ Data health:** `/stats` remains the corpus-size surface; `/data-health/`
  is freshness and coverage. Reciprocal one-sentence links and the public footer
  entry live in `site/data_health_navigation.mjs` plus `site/stats.html`. Consume
  the committed `source_health_public.json` artifact; do not copy health clocks
  onto Stats or usage fields onto Data health. Public visibility is gated by
  `DATA_HEALTH_PUBLIC` in `site/data_health_navigation.mjs` (currently off):
  flip that one constant only after every served source on the page shows real
  clocks, not an UNKNOWN / Source-unavailable wall. Proof:
  `test/data_health_navigation.test.mjs`.

## Performance observability registry

- Maintainer/operator handoff: `docs/rum-observatory.md`. Registry extension,
  privacy, sampling, retention, query troubleshooting, Desk contract,
  independent-switch rollback, and deferred-governance candidates are
  fixture-backed (`node tools/rum_observatory_handoff.mjs --check`). The live
  pilot protocol is `docs/rum-production-pilot.md` when present. Proof:
  `test/rum_observatory_handoff.test.mjs`.
- `architecture/performance-observability.v1.json` is the only human-edited
  surface/component inventory for RUM classification, Worker validation, and
  private operator labels. Regenerate all three projections with
  `node tools/build_performance_observability.mjs`; verify drift and the
  unknown-route fail-closed invariant with `--check` and
  `test/performance_observability_registry.test.mjs`. Never add a consumer-side
  fallback that maps an unknown route to Home or Browse. Architecture facts
  project its bounded topology and sitemap-derived coverage; unclassified
  candidates stay advisory under `performance_observability.coverage` and must
  never enter the hard `observer_coverage.unmapped_surfaces` gate. The frozen
  proof is `architecture/backtests/rum-future-surface.json` plus
  `test/performance_observability_architecture.test.mjs`.
- The browser collector remains a **capability seam**: `site/analytics.js`
  schedules `site/rum_bootstrap.mjs` only on canonical production hosts after
  load + idle. Local, preview, and missing-release pages stay inert. Field
  vitals still omit missing metrics, keep per-page web-vitals ids private to
  deduplication, and deliver through `site/rum_delivery.mjs`. Refresh the byte
  receipt with `node tools/measure_rum_collector_overhead.mjs --write`.
- Component owners report readiness and interaction timing through
  `site/rum_semantic_milestones.mjs`; keep the terminal-state vocabulary
  closed, preserve feedback-before-settlement ordering, and never move DOM
  selectors into the collector. Focused proof is
  `test/rum_semantic_milestones.test.mjs`.
- The first owner instrumentation slice is
  `site/rum_static_record_instrumentation.mjs`: Home reuses
  `data-home-ready`, notice primary readiness reuses `data-edge-rendered`, and
  `site/app/notice-context.mjs` owns async context settlement. Keep record IDs,
  URLs, DOM text, and selectors out of milestone records. Focused proof is
  `test/rum_static_record_instrumentation.test.mjs`.
- Contracts owns its one-surface contract in `site/contracts_rum.mjs` and its
  browser binding in `site/app/contracts-rum.mjs`: start at the native
  filter/input action, mark feedback only after a paint, and settle after
  `site/app/money-list.mjs` renders a row or honest empty/error terminal. It
  must remain identifier-free; focused proof is
  `test/rum_browse_search_instrumentation.test.mjs`.
- Map, entity, and async-panel instrumentation lives in
  `site/rum_maps_entities_async_instrumentation.mjs`. Near You reports usable
  frame readiness separately from relevant-data or honest absence; agency
  constellation reports identity separately from related-record readiness or
  honest no-relationships; Land outcomes emit private present/absent/unavailable/error
  terminals without reader absence copy. Keep geography, entity, relationship,
  project, and record identifiers out of observations. Refresh projections
  with `node tools/build_performance_observability.mjs`. Focused proof is
  `test/rum_maps_entities_async_instrumentation.test.mjs`.
- Following owns its stateful shell and personal-watch settlement in
  `site/rum_stateful_instrumentation.mjs` and `site/app/following.mjs`:
  report the static create-flow shell separately from `/following/personal`
  retrieval, and emit catalog terminals for populated, empty (including
  unauthenticated), unavailable, and error. Keep watch, account, session,
  location, and cross-page tokens out of observations. Refresh projections
  with `node tools/build_performance_observability.mjs`. Focused proof is
  `test/rum_stateful_instrumentation.test.mjs`.
- Field-performance intake is the separate `POST /performance-events` contract
  in `worker/src/performance_events.mjs`, backed only by `RUM_ANALYTICS` /
  `crol_rum_observations_v1`. Keep its normalized one-metric-per-point layout,
  strict generated allowlist validation, and fixed health reasons independent
  from `/events`, `USAGE_ANALYTICS`, and the usage stats surfaces. Production
  is independently gated: production `[vars]` sets `RUM_INGEST_ENABLED=true`
  and the public manifest sets `production_enabled: true`. Beta/preview stay
  off. Either switch stops new writes. Local, numbered preview hosts, and
  developer tokens remain excluded. Sampling is Cloudflare weighted adaptive
  sampling, not an unsampled 100 percent of visitor rows. Operator protocol:
  `docs/rum-production-pilot.md`. Focused proof:
  `worker/test/performance_events.test.mjs`, `test/rum_delivery.test.mjs`,
  `test/rum_pilot_rollout.test.mjs`, and `worker/test/rum_pilot_rollout.test.mjs`.
- Field-performance distributions use only the bounded Worker adapter at
  `worker/src/lib/performance_query.mjs`; Desk must consume the later private
  read model rather than Analytics Engine. Sufficiency is based on retained
  `count()` rows, while population counts and percentiles use each row's
  `_sample_interval`. Honest state and retention semantics live in
  `docs/performance-query-adapter.md`; focused proof is
  `worker/test/performance_query.test.mjs`.
- Desk discovers the separate `cityscroll.admin.performance.v1` read model
  through the additive `performance` section of `worker/ops-contract.v1.json`
  and reads it only from authenticated `GET /admin/performance`. Keep its URL
  grammar in `worker/src/admin_performance.mjs` bounded, its responses private
  and no-store, and Analytics Engine credentials server-side. The RUM-07
  byte-level characterization in `worker/test/stats_routes_unchanged.test.mjs`
  protects both `/admin/stats` and public `/stats` from performance fields.
- The cross-repository Desk handoff is pinned by
  `data/rum-09-desk-contract-fixtures/desk-consumer-contract.v1.json`; keep its
  reference response, edge-state matrix, ops-contract discovery paths, and
  `worker/test/admin_performance_consumer_contract.test.mjs` aligned. The actual
  dashboard belongs only in `cityscroll-internal`, never under the public `site/`.

## Comparative signal admission

- `site/comparative_signal_admission.mjs` is the pure, closed-policy publication
  boundary over CI-01 comparative facts. Held decisions stay backstage and the
  public-only artifact is rebuilt with `node tools/build_comparative_story_signals.mjs`.
  The successor-solicitation absence control must remain `held_mnar`; focused
  proof is `test/comparative_signal_admission.test.mjs` plus
  `test/comparative_negative_control.test.mjs`.
- Comparative story signals enter the existing local-first Investigation union
  only through `site/investigation_comparative_signal.mjs`. Keep the exact claim,
  subject, peer-set route, comparison receipt reference/basis, and evidence refs
  together; shared `/inv` validation imports the same narrow waist. Held or
  provenance-incomplete inputs fail closed. Focused proof is
  `test/investigation_comparative_signal.test.mjs` and `worker/test/inv.test.mjs`.
- Frozen research packages use `site/research_package.mjs` as the pure projection
  over admitted Investigation signals and the explicit `research_package`
  discriminator in the existing `/inv` transport. Each version is a new `inv:`
  record with explicit supersession/changes; live freshness is a separate
  read-only projection and never rewrites frozen claims. Keep packages bounded to
  compact object, evidence, receipt, vintage, and source-contract references—no
  copied datasets or model-authored analysis. Focused proof is
  `test/research_package.test.mjs` and `worker/test/inv.test.mjs`.
- Comparative-pilot evaluation is reproduced with
  `node tools/evaluate_comparative_signals.mjs --check` from the frozen review
  ledger and committed read models. The machine artifact and written expansion
  recommendation live in `docs/evidence/comparative-signal-evaluation.{json,md}`;
  evaluation never enables another metric family. The single usage denominator
  is aggregate `comparative_signal_shown:visible`, paired only in aggregate with
  existing `investigation_share:add_signal`. Focused proof is
  `test/comparative_signal_evaluation.test.mjs`.

## Remote MCP public adapter boundary

- `capabilities/mcp_tool_declarations.mjs` is the thin policy inventory for the
  four registered public-read capabilities; each binding is provider-only,
  bounded, closed-world, and standard-annotated. The semantic capability files
  must not import MCP, Agents, or Cloudflare runtime packages, and Cloudflare OS
  remains a downstream composition layer. Rebuild the pinned current-client
  receipt with `node worker/scripts/build_remote_mcp_evidence.mjs`; focused proof
  is `worker/test/mcp_capability_adapter.test.mjs` and
  `worker/test/mcp_streamable_http_interop.test.mjs`.

- **CS-07 Cloudflare OS composition proof:** isolated Gadget at
  `integrations/cloudflare-os-entity-research/` runs the frozen four-tool public-read
  workbook through named-tool Gatekeeper MCP. Verify with
  `node tools/verify_cloudflare_os_proof.mjs`. Focused proof:
  `worker/test/cloudflare_os_composition.test.mjs`.

- **CS-08 Code Mode measurement:** isolated reversible A/B at
  `integrations/cloudflare-os-code-mode/` compares pinned typed Code Mode with the
  same CS-07 ordinary MCP composition. It is a measurement card, not a production
  migration. Rebuild/check `artifacts/capability-spine/cs-08-code-mode.json` with
  `node tools/verify_code_mode_measurement.mjs --repetitions 30 --require-parity
  --max-p95-regression 0.10`. A win requires zero semantic/provenance failures,
  identical fail-closed behavior, no added store reads, ≤10% p95 wall-clock
  regression, and either ≥25% lower median model-input tokens or ≥2 fewer external
  round trips. Focused proof: `worker/test/code_mode_measurement.test.mjs`.

## Client module publication

- `tools/client_module_graph.mjs` follows module scripts and local imports in
  the public HTML artifact. `tools/build_public_site.mjs` publishes any
  repository-level capability reached by that graph, and
  `tools/check_client_module_assets.mjs` verifies the built HTTP paths return
  JavaScript MIME types. The provider-neutral Pages build runs that guard;
  update the graph fixtures when adding a client capability import.

## Worker route read models

- Near You and meeting corpora are not Worker imports. Build immutable keyed
  slices with `node tools/build_worker_route_read_models.mjs --check`; CI publishes
  slices before the versioned manifests to the existing `ALERT_STATE` KV namespace.
  Request-path loading and isolate caching live in `worker/src/lib/route_read_model_kv.mjs`.
  The deploy guard is `tools/worker_deploy_guard.mjs`: it enforces the 52 MiB
  uncompressed Wrangler budget, prints the five largest inputs, and rejects empty
  route-model canaries. Focused proof is `worker/test/route_read_model_kv.test.mjs`
  and `test/worker_deploy_guard.test.mjs`.

- Community Board committee identity is owned by `site/data/non_council_outcome_sources/community_board_committees.json` and `site/community_board_committees.mjs`. It is board-local and source-qualified; `site/community_board_institution_edges.mjs` projects `has_committee` and refined `hosts_meeting` edges without using the Legistar committee graph.

- **Release-surface evidence:** `tools/release_surface_reconciliation.mjs` is the shared receipt
  contract for generation output, card/projection inventory parity, generated-evidence freshness,
  and served-artifact checks. Card completeness is owned by `tools/card_reconciliation_guard.mjs`
  and is joined into the aggregate only when inventories are supplied.
  `tools/check_release_surface_reconciliation.mjs` writes the durable
  `.artifacts/release-surface-receipt.json`; Pages CI uploads it with the generation receipt and
  artifact manifest. Keep source age limits source-declared and do not turn provider deployment
  timestamps into source acknowledgements. That aggregate is not a 2/2 Pages+Worker deployment
  health proof; use `tools/deployment_health_receipt.mjs`.

- **Community Board money read model:** `site/community_board_money.mjs` joins the landed adopted
  budget and payment actuals artifacts only by exact `board_id` plus fiscal year. Rebuild the shared
  projection and measurement receipt with `node tools/build_community_board_money.mjs`. The board
  dossier card is `#community-board-money` in `site/community_board_constellation.mjs`. Refresh
  Bronx CB1 (populated) and Bronx CB3 (payment identity unobserved) evidence at 390px and 1440px
  with `python3 tools/capture_community_board_money.py` (`--check` verifies the committed
  manifest). Focused proof is `test/community_board_money.test.mjs`. Missing, partial, unmatched,
  empty, and stale source states remain explicit, and uncertified budget/payment ratios stay null.

- **Community Board money follow feasibility:** `site/community_board_money_follow_feasibility.mjs`
  measures CB-MONEY-02 payment observations by exact retained transaction identity and calendar
  month, then stops without shipping follow replay while only one source snapshot exists. Refresh
  the deterministic measurement receipt with `node tools/build_community_board_money_follow_feasibility.mjs`
  (`--check` verifies it); focused proof is `test/community_board_money_follow_feasibility.test.mjs`.

- **Community Board money comparison:** `site/community_board_money_comparison.mjs` is the
  selection-only projection for the 59-board comparison. Run
  `node tools/build_community_board_money_comparison.mjs` to refresh its artifact and receipt; the
  existing `/community-boards/` map/table shell consumes it for labeled fiscal-year views,
  sortable metrics, dossier links, and the parity-tested map layer. It never re-aggregates the
  CB-MONEY-03 read model or introduces ratios/per-capita metrics.

- **Merge-gate audit:** `tools/merge_gate_audit.mjs` projects MT-1 required-check receipts into
  catch, runner-minute, flake, ejection, and serialized wall-time metrics. Missing observations
  remain unknown; the audit also records the shared architecture watermark serialization finding.
  Focused proof is `test/merge_gate_audit.test.mjs`; replay the contract with
  `node tools/merge_gate_audit.mjs --fixture test/fixtures/merge-throughput --check`.

- **Check-mode determinism:** `tools/determinism_lint.mjs --check` follows explicit `--check`
  commands in pull-request/merge-group workflows through local helpers and rejects ambient clock,
  timezone, random, live-network, external-data, and write dependencies. Schedule-only workflows
  are monitor roots; line-local waivers require a reasoned `determinism-lint: allow|inject` note.
  Focused proof is `test/determinism_lint.test.mjs`.

- **Authority-native procurement admission (ANP-03):** `warehouse/lib/mta_opportunities.mjs` and
  `warehouse/fixtures/authority-native-procurement/mta-opportunities.v1.json` preserve the
  Contract Reporter/MTA source rows and receipts. `node tools/build_shared_procurement_read_model.mjs`
  materializes them; exact solicitation/event/CR identifiers are the only native joins, and bid
  results remain the `bid_opening_result` stage. Focused proof is `test/mta_opportunities.test.mjs`.

- **MTA procurement observations:** `site/data/mta_procurement_sources.json` is the source-qualified
  fixture for the annual `twsw-2mqa` snapshot and MTA Construction & Development award pages.
  `worker/src/lib/mta_procurement_source_records.mjs` preserves raw/normalized evidence and exact
  source IDs; rebuild the shared model and agency projections with their existing builders. Keep
  MTA operating entities distinct from the parent aggregate and allow cross-source joins only on
  exact contract identifiers. Focused proof is `test/mta_procurement_source_records.test.mjs`.

- **Product-update candidates:** `site/product_updates_source.mjs` projects the versioned
  public `site/product-updates.json` artifact from the changelog, checked architecture
  reconciliation, frozen capability registry, and demo manifest. Joins are exact
  capability/demo identifiers only. Rebuild with `node tools/build_product_updates.mjs`;
  `--check` verifies the committed bytes. Focused proof is `test/product_updates_source.test.mjs`.

- **Mailto subscribe later experiment (FS-10):** `site/mailto_subscribe_later.mjs`
  is the fail-closed contract for encoding a reviewed Following sentence to the
  configured inbound subscribe address. It stays disabled until a named FS-05
  routing, delivery-ownership, reply, and composer evidence record is proven, and
  it never presents mailto as the default or a fallback. Rebuild with
  `node tools/build_mailto_subscribe_later.mjs`; `--check` verifies the committed
  stop receipt. Focused proof is `test/mailto_subscribe_later.test.mjs`.

- **Contextual report desk projection:** `worker/src/lib/feedback_desk.mjs` is the
  allowlisted `/admin/feedback` read model over stored `fb:` rows. It round-trips
  target, evidence, provenance, canonical URL, and target identity with explicit
  nulls; reporter email/IP/UA and adjudication notes stay off the response.
  Target reconstruction is fail-closed and never infers a claim from free text.
  Focused proof is `worker/test/feedback_desk.test.mjs` plus the admin feedback
  cases in `worker/test/admin.test.mjs`.

- **Federated search scope:** `capabilities/federated_search.mjs` owns the additive
  closed `scope` allowlist over registered lenses. Adapters must not rank, rewrite
  identity, or query an arbitrary store. Omitted scope keeps all-lens federation;
  unrequested lenses report `out_of_scope` on the `requested_scope` receipt.
  Contract: `docs/federated-search-scope.md`. Proof:
  `test/federated_search_scope.test.mjs` plus `test/federated_search_capability.test.mjs`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
