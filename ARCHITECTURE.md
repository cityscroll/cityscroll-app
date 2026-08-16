# CityScroll architecture

This is an **arc42-lite** narrative: a short architecture record for a human reader. It is the entry point for the future C4 model, ADRs, and generated architecture facts. The detailed map remains in [`docs/architecture.md`](docs/architecture.md); this page explains the shape and the important boundaries without copying its source inventory.

## Goals and constraints

CityScroll makes New York City public records easier to follow by interest, place, agency, vendor, project, parcel, and civic process. The product currently presents contracts, staffing, zoning, property, rules, meetings, and related alerts. A record page should lead with plain meaning and a supported next action, while preserving the official source and the limits of what the source publishes. The [README](README.md) describes the public entry points and the main user journeys.

The main constraints are visible in the existing design:

- Public sources remain the source of truth. CityScroll may normalize, join, cache, and materialize them, but it must not silently turn an absent value into a fact. The source contract register in [`site/data/source_contracts.json`](site/data/source_contracts.json) and its generated view in [`docs/data-sources.md`](docs/data-sources.md) define the delivery and evidence boundary.
- The ordinary read path is precompute-first. Committed site data, build artifacts, and Worker projections make common views predictable; live upstream calls remain for interactive freshness, explicit lookups, ingestion, verification, or a documented fallback. The delivery audit is [`docs/precompute-first-inventory-2026-07-29.md`](docs/precompute-first-inventory-2026-07-29.md).
- The site must remain useful when Worker-backed features are unavailable. The static/browser surface has its own data and graceful fallback paths; alerts, feeds, natural-language search, forecasting, and other server features can degrade separately.
- Identity joins are links, not merges. A source record keeps its publisher identity; cross-source links need a named rule, provenance, and the required confidence or review gate.

Open rationale is not implied by implementation. Where this narrative names a policy without an ADR that records its reason, it says `rationale required` in [Important decisions](#important-decisions).

## System context

Visitors use the canonical CityScroll site in a browser. The static `site/` tree supplies markup, styles, committed data, and ordered browser-native modules. The route and module ownership map is [`docs/module-map.md`](docs/module-map.md). The browser can read public Socrata and geospatial sources directly for selected live or hybrid views, and it calls the Worker for edge-cached, parameterized, stateful, or secret-backed features.

The Cloudflare Worker in `worker/` is the server boundary. Its public API host is `api.cityscroll.org`, with `api.crol-list.org` retained as a compatibility alias. Bounded reader routes also run on the canonical site for Near You, Following, and preferences. The routes, domains, and two daily cron triggers are declared in [`worker/wrangler.toml`](worker/wrangler.toml). The Worker handles notice ingest, search and translation caches, alerts, feeds, Checkbook lookups and forecasts, entity views, operator routes, and the scheduled rebuilds described in [`docs/architecture.md`](docs/architecture.md).

The system consumes City Record and other NYC Open Data feeds, DCAS and Legistar data, Checkbook NYC, ZAP, GeoSearch, MapPLUTO, DOB data, ABO datasets, Anthropic for the metered natural-language route, Resend for email, and Cloudflare services. Each source has its own contract and may be live-only, inline-at-build, or edge-materialized. A source that is not published or not joined stays an explicit gap; the product does not infer the missing stage.

The main external outputs are the public site and record documents, saved-search feeds, email digests, public aggregate statistics, and bounded public entity and process views. Operator and spend views are keyed server routes. The system has no CLI product surface; deployment is through the site and Worker pipelines documented in [`docs/release/cloudflare-native-builds.md`](docs/release/cloudflare-native-builds.md).

## Building blocks

The repository is a modular monolith with separate browser, edge, and host-data seams:

- **Site.** `site/index.html`, `site/app/`, and pure `site/*.mjs` modules own browser presentation, route state, scopes, process timelines, actions, and progressive disclosure. `site/data/` holds committed read models and source-contract artifacts. The loader and module boundaries are recorded in [`docs/module-map.md`](docs/module-map.md).
- **Worker.** `worker/src/worker.mjs` routes requests. Feature modules own ingest, notices, alerts, feeds, Checkbook, vendor and entity views, property and hearing projections, translations, usage, and scheduled work. The Worker uses Web APIs and does not open the warehouse on a request.
- **Cloudflare state.** The active production configuration has D1 `DB` (`crol-notices`) for the recent-notice mirror, FTS and durable workflow tables; KV `NL_METER` for metering; `ALERT_STATE` for digests, counters, forecasts, and versioned read models; `SUBS` for confirmed subscriptions and rate limits; and `FEEDBACK` for stored feedback and rate limits. Analytics Engine `USAGE_ANALYTICS` stores bounded aggregate events. Queue `DIGEST_QUEUE` fans out digest jobs to `crol-digests`, with a retrying consumer and dead-letter queue. These bindings are declared in [`worker/wrangler.toml`](worker/wrangler.toml).
- **R2 source vault.** The source-vault flag is `false` and the `SOURCE_VAULT` R2 binding is commented out in the current configuration. R2 is therefore a reserved, inactive seam, not a live dependency. Its current state is intentionally left null until the configuration and content-policy gates enable it.
- **Warehouse.** `warehouse/` is the host-side factory for bulk public data and batch joins. Ingest writes gitignored raw files, Parquet tables, and a DuckDB catalog; small fixtures, manifests, and proof receipts are committed. Node seams query or export bounded rows, and builders turn them into JSON read models for `site/data/` and Worker twins. [`warehouse/README.md`](warehouse/README.md) documents the one-job, headroom-gated workflow.
- **Entity resolution.** [`entity_resolution/`](entity_resolution/) is an in-process package, not an HTTP microservice. It normalizes publisher values, generates candidates, scores them, applies conservative link or review policy, and publishes allowlisted public records. `cross_domain/` materializes provenance-bearing links across civic domains without merging publisher subjects. Its boundary and ADR links are in [`entity_resolution/README.md`](entity_resolution/README.md).
- **Ontology.** [`ontology/`](ontology/) is the backstage Civic Graph catalog and improvement flywheel. It registers civic objects, links, events, assertions, and actions with grounding states, then evaluates coverage, integrity, readability, and consistency. It is engineering infrastructure, not a public graph database or route. The registry decision is [`docs/adr/ontology-registry-v0.md`](docs/adr/ontology-registry-v0.md).
- **Community-board dual role.** Each community board is one stable civic body keyed by the publisher-backed `body_id` (`community-board:{borough-cb-NN}`). That identity boundary is shared by two projections: a place projection for the board district, whose geographic `covers` relation keeps its existing publication gate, and an organization projection for the public body that can later carry members, meetings, and recommendations. The organization relation families (`has_member` / `member_of`, `hosts_meeting`, and `issues_recommendation`) are declared separately and remain unknown until the source inventory earns those edges; no relationship is inferred from the entity declaration. The citywide **Community Boards** agency entry remains an index, not a replacement for the 59 board-level identities.
- **Materialization seam.** Builders under `tools/`, `warehouse/lib/`, and Worker refresh code create compact, versioned projections. The browser and edge routes read those projections first, then use a bounded live fallback where the source contract allows it. The generated data files are artifacts; their builders and checks are the authority.

## Runtime scenarios

**A visitor searches.** The browser loads the static shell and its ordered modules. A default lens reads committed or build-rendered data, then may refresh a live source or call an edge endpoint according to its source contract. Scope state travels in the route and is reused by Browse, Now, Near You, Following, maps, and record links. The pure scope adapter is [`site/scope_v0.mjs`](site/scope_v0.mjs).

**A visitor opens a record.** The site renders a source-backed document and adds supported process stages, entity links, location facts, actions, attachments, or related records. Hydration can ask the Worker for a notice, D1 mirror row, materialized projection, or exact external lookup. Missing evidence remains a named absence; a failed or unavailable upstream is not cached as an empty fact.

**The daily jobs run.** The `10:00 UTC` cron performs the delivery-free digest shadow rehearsal. The `13:00 UTC` cron refreshes the D1 notice mirror, pre-warms prior-cycle data, rebuilds hearing and Property views, refreshes vendor projections and other read models, then evaluates alerts. With queue delivery enabled, one digest job is sent per subscription to the queue; the consumer retries independently and sends poison jobs to the dead-letter queue. The shadow-hold and send-cap rules are implemented in Worker code and documented in [`docs/architecture.md`](docs/architecture.md).

**A data build runs.** Host tooling ingests a bounded source or fixture into the warehouse, verifies counts and checksums, and exports a compact materialization. A builder writes the site artifact and, where needed, the Worker twin. Tests compare the pure producer and consumer contracts. The Worker request path consumes the result; it does not query DuckDB or Parquet directly.

**A join is proposed or published.** Entity-resolution code normalizes values and generates candidates. A scorer supplies evidence, a policy decides auto-link versus review versus separate, and a publication serializer removes desk-only fields. Cross-domain relation policy keeps uncertain candidates in shadow or evidence-only state. The relevant ADRs are [`docs/adr/entity-resolution-taxonomy.md`](docs/adr/entity-resolution-taxonomy.md), [`docs/adr/cross-domain-object-links.md`](docs/adr/cross-domain-object-links.md), and [`docs/adr/evidence-assertion-layer.md`](docs/adr/evidence-assertion-layer.md).

## Cross-cutting concepts

- **Provenance and evidence.** Values retain their publisher source, source URL where available, observed time, and derivation status. Public serializers expose only the allowed evidence and coarse confidence; raw snapshots, matcher scores, review identity, and desk notes stay private.
- **Honest missingness.** `null`, unavailable, not yet joined, and not published are different states. A projection may be empty because it found no qualifying rows, or unavailable because its source failed; readers must not collapse those cases.
- **Link-not-merge identity.** A canonical agency, vendor, official, project, parcel, or person can connect records without rewriting the records into one publisher object. Exact identifiers and conservative policies own the public edge; ambiguous text stays plain or evidence-only.
- **Dual-role civic identity.** A single publisher-backed `body_id` can anchor distinct place and organization projections when the source describes one stable civic body in both roles. Projection-specific relation families retain their own evidence gates: community-board geography is published only through the existing `covers` gate, while membership, meeting, and recommendation families remain unknown until sourced.
- **Materialization and freshness.** A read model has a producer, schema, timestamp or version, bounded scope, and fallback behavior. Source contracts define whether freshness favors a live request, build-time snapshot, or edge projection.
- **Privacy and spend limits.** Stateful features are rate-limited and capped. Analytics uses enumerated dimensions and no visitor identifier. LLM and email paths fail closed or degrade when their required configuration is absent.
- **Shared pure seams.** Browser and Worker implementations share small pure adapters for scopes, geography, process stages, relation policy, and read-model shapes. Tests protect parity at those seams instead of relying on one large runtime module.
- **Architecture as code.** This page is the human narrative. The detailed map, ADRs, source contracts, builder checks, and future generated facts should remain the machine-near records. When the generated architecture-facts artifact exists, it should link back here rather than duplicate this prose.

## Proposed invariant: resident-surface rendering standard

**Status: PROPOSED — rationale-to-confirm by the site owner.** This standard protects plain-language
and cognitive accessibility for residents. It describes the intended public rendering boundary;
the implementation and its machine check are present, while the broader rationale remains open for
confirmation.

Resident-facing surfaces must not expose implementation-facing snake_case schema, column, or method
vocabulary, `Unavailable` debug rows, or reconciliation disclaimers in their default content.
Evidence and provenance may remain available through an explicit, user-invoked details affordance,
but internal field names and debug placeholders are not resident copy. The shared reader-label
adapter is [`site/reader_surface_labels.mjs`](site/reader_surface_labels.mjs), and shared edge
renderers consume it before producing visible labels.

The architectural fitness function is the fully enforced full-surface
[rendered schema-vocabulary census](test/standards/rendered_schema_vocabulary.py). It enumerates
the built documents plus route, tab, facet, scope, and detail states, and fails on any residual
vocabulary or default debug copy across that set—not only on pages changed by a patch. Changes to
resident renderers must keep this invariant and its full built-site sweep green.

## Important decisions

## Proposed rationale: home cold-load wire budget

**Status: PROPOSED — rationale-to-confirm by the site owner.** This section records the
reasoning behind the current deliberate ceiling; it is not a settled product or performance
policy until confirmed.

The `home.cold` `wireBytes` budget protects the weight of the first uncached visit to the home
surface, including the resources needed before the browser has a warm cache. Audience impact is
an assumption to confirm: this budget is intended to protect NYC residents opening the site on
slow networks, lower-end mobile devices, or data-capped connections. The measurement is a
compressed-byte guard for page weight, not a claim about any particular resident's connection or
device.

A hard number and ratchet exist to make silent page-weight creep visible. Every new home-surface
dependency or user-facing card consumes part of a shared allowance, so adding it should be a
conscious trade rather than the default outcome of an otherwise successful feature merge. The
proposed `460000`-byte ceiling is deliberately above the current main measurement of about
`447729` bytes, leaving `12271` bytes of near-term headroom. Those values and the audience
assumption remain proposed until the site owner confirms them.

Loosening the ceiling has a real cost: a higher ceiling can make first paint slower on weak
connections and transfers more data on each uncached visit. Holding it too tightly has a
different cost: it can block useful user-facing features or encourage code contortions such as
deferring the Property feed, which removes required first-load content and breaks route and
accessibility contracts. The current posture is therefore a deliberate, reviewable ceiling with
explicit headroom, not permission for unbounded growth. The deeper optimization toward the old
`435000` aspiration remains a tracked follow-on, not an abandoned goal.

An **ADR** (architecture decision record) captures a decision, its context, and its consequences. This section is the index for those records; it does not invent rationale from the current implementation.

- **Static site plus Cloudflare Worker.** The browser surface stays deployable as static files, while the Worker provides secrets, state, scheduled work, edge reads, and delivery. This split is evidenced by [`site/`](site/) and [`worker/wrangler.toml`](worker/wrangler.toml). Rationale: `rationale required`.
- **Materialized read models first.** Ordinary views use committed or edge materializations, with live sources retained for freshness and bounded fallback. The delivery tiers and current exceptions are recorded in [`docs/precompute-first-inventory-2026-07-29.md`](docs/precompute-first-inventory-2026-07-29.md). Rationale: `rationale required`.
- **Warehouse as factory, not request dependency.** DuckDB and Parquet support offline ownership and batch joins; builders export JSON consumed by the site and Worker. This boundary is implemented in [`warehouse/README.md`](warehouse/README.md) and the warehouse lookup libraries. Rationale: `rationale required`.
- **Identity links, not destructive merges.** The taxonomy ADR and the entity-resolution package define a link-not-merge model with review and publication gates. See [`docs/adr/entity-resolution-taxonomy.md`](docs/adr/entity-resolution-taxonomy.md). Rationale is recorded by that ADR.
- **Civic Graph as a catalog and flywheel.** The ontology registry is backstage engineering infrastructure with grounding and gap states, not a public graph database. See [`docs/adr/ontology-registry-v0.md`](docs/adr/ontology-registry-v0.md). Rationale is recorded by that ADR.
- **Community boards as dual-role civic bodies.** Board identity is publisher-keyed by `body_id` and shared by place and organization projections. Geographic `covers` remains separately gated; organization relation families are declared without unsourced edges, and the aggregate Community Boards agency remains an index. The separate `recommendation` catalog object gives a publisher-keyed board output a stable target without conflating it with a meeting or matter; it remains unregistered and at grounding `gap` until the exact publisher identity, date, and retained source document are present. Rationale is recorded in [`docs/adr/ontology-registry-v0.md`](docs/adr/ontology-registry-v0.md).
- **R2 source vault remains disabled.** `SOURCE_VAULT_ENABLED = "false"` and the binding is commented out in [`worker/wrangler.toml`](worker/wrangler.toml); this narrative does not claim custody is active. Rationale: `rationale required`.
- **Architecture facts are generated at verification time.** LA4's machine-owned evidence is generated in memory by [`tools/build_architecture_facts.mjs`](tools/build_architecture_facts.mjs) and checked against the C4 model and ADRs by [`tools/reconcile_architecture.mjs`](tools/reconcile_architecture.mjs). Pull-request, merge-group, and scheduled checks retain short-lived downloadable evidence; generated JSON is not committed. The facts record observed configuration and ontology counts; they do not supply design rationale. Rationale: `rationale required`.
