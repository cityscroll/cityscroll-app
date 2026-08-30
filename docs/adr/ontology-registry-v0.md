# ADR: Civic Graph registry v0 (catalog + flywheel seam)

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-01 |
| Updated | 2026-08-27 (community-board people and temporal role contract) |
| Scope | Catalog + pure evaluation flywheel — no production graph store, no public route |
| Product name | **Civic Graph** (object–link–action registry + evaluation harness) |
| Supersedes | — |
| Related | `docs/adr/entity-resolution-taxonomy.md`, `docs/adr/civic-time-event-contract.md`, `docs/action-log.md`, `docs/civic-graph.md`, `docs/adr/person-source-identity-seam.md` |

## Context

CityScroll already ships entity resolution (link-not-merge), public relationship graph
allowlists, civic-time event kinds, assertion classifications, reader next-actions, and a
privacy-safe product action log. Those type systems lived in separate modules without a
single catalog, so cross-spine agreement and enrichment planning could not be automated.

Roadmap tranches alone do not prove intelligence depth. The product needs a **named object–
link–action registry** (the Civic Graph) and a **MAPE flywheel** that measures coverage,
agreement, actionability, and **grounding**, then emits enrichment work (P3+) instead of
hand-carding it.

## Decision

### 1. Commit `ontology/registry.v0.json`

A versioned catalog of:

- object types (semantic, identity, kinetic objects, spine)
- link types (public graph edges, ER identity links, explicit unregistered product joins)
- civic-time event kinds
- assertion classifications and facts
- kinetic reader actions, deliveries, outcomes, and product method-log actions
- ER type families, ER decisions, process-spine join confidence

Every **live allowlist id** imported from product code must appear with
`status: "registered"` or `status: "unregistered"` (with a reason when unregistered).
Characterization: `test/ontology_registry.test.mjs` via `ontology/sync.mjs`.

Every object type, link type, event kind, and kinetic action also carries
**`grounding`**: `built` | `partial` | `gap` — measured product depth from the existence
matrix (not the same axis as catalog `status`). Unregistered entries must not claim
`built`. Pure helpers: `ontology/grounding.mjs`.

### 1a. Community-board recommendation target

The registry includes a distinct `recommendation` object type for the community-board
`issues_recommendation` relation. This is an intentional catalog addition, not a claim that
recommendations are currently materialized: the object remains `status: "unregistered"` and
`grounding: "gap"` until a publisher-keyed recommendation is retained with its exact date and
source document. A separate target is necessary because a board recommendation has different
semantics and provenance from a meeting, matter, or member; using one of those existing objects
would blur the relation contract and make an output look more certain than its source supports.
The source contract therefore promotes no edge from names, titles, venues, or inference alone.

### 1b. Community-board people and temporal roles

Community Board people use a source-qualified identity, `community-board-person:{board_id}:{publisher_person_id|reviewed_local_id}`.
This is intentionally distinct from `official:{PersonId}`, which remains the City Council/Legistar
person identity and its Council-specific profile routes. A later generic `person` layer may attach
only through explicit evidence; it is not required for this source identity.

The person-role contract keeps `member_of`, `chairs`, `staffed_by`, and `works_for` as separate
relationships and retains `valid_from`, `valid_to`, `observed_on`, and the source document and
receipt. The role vocabulary is closed: `appointed_member`, `board_chair`, `board_officer`,
`committee_chair`, `committee_member`, `public_committee_member`, `district_manager`, and `staff`.
Board-local identity is never merged across boards, with Council officials, or by display-name
equality. Employment and public committee participation do not establish board membership or
voting power.

### 1c. Generic person projection and explicit same-person links

The additive `cityscroll.person.v1` projection gives each immutable source identity a generic
envelope, such as `person:legistar:7801` or
`person:community-board:manhattan-cb-06:<publisher-key>`. The envelope retains issuer and source
scope, and display-name equality never creates identity. Council `official:{PersonId}` and
Community Board `community-board-person:{board}:{key}` remain the source identities consumed by
their existing graph, search, and route contracts; the generic envelope is not a replacement.

`person_identity_link.v1` is an explicit reviewed assertion between two generic source-qualified
identities. It carries `candidate`, `accepted`, or `rejected` status, the fixed
`explicit_reviewed_assertion` method, inspectable evidence, and observation/review clocks. Only an
accepted link may populate `canonical_person_ref`; source identities and their edges remain
addressable after acceptance. This increment does not materialize a merged view or a generic
person route.

Capability selection is allowlisted by object type and profile family. Generic `person` objects
cannot select Council votes, committee memberships, lobbying, campaign finance, or the
`/officials/{id}/` route. Those capabilities remain available only to the exact legacy
`official:{PersonId}` object and its existing Council profile family. Community Board, agency,
and vendor-contact profiles therefore remain separate even when their display names match.

### 2. Zero production risk for v0

- No Worker route, no D1 migration, no dual-write flag change, no public API.
- No graph database.
- Registry is documentation + drift gate only until a later card opts into production writers.

### 3. MAPE flywheel harness (fixture-first)

Pure modules under `ontology/` plus CLIs:

| Piece | Path |
| --- | --- |
| Receipt builder | `ontology/flywheel.mjs` → `cityscroll.intelligence_receipt.v0` |
| Cross-spine checks | `ontology/cross_spine.mjs` + `ontology/fixtures/cross_spine/` |
| CLI receipt | `tools/intelligence_receipt.mjs --fixture` |
| CLI flywheel | `tools/intelligence_flywheel.mjs --fixture --emit-cards <dir>` |
| CLI cross-spine | `tools/cross_spine_validate.mjs` |

**Monitor** committed inventories (`source_coverage`, gap taxonomy, registry sync, pass
cross-spine fixtures, destination-class actionability sample). **Analyze** into metrics.
**Plan** ranked enrichment cards (coverage, gap_a, contradiction, er_quality, actionability,
registry). **Execute** in this card means write cards + receipt only — agent dispatch remains
the software-factory / ops layer.

`actionability_rate_sample` is deep-link rate over
`ontology/fixtures/dimensions/actionability_sample.json` (via
`ontology/actionability_sample.mjs`), not `ACTION_TYPES.length`.

P3+ work is **flywheel-emitted**, not hand-authored in this ADR.

## Non-goals

- Production civic-time event store
- Expanding dual-write coverage in this card (emitted as coverage cards)
- Officials/votes objects (cataloged `unregistered` until retention exists)
- LLM matchers or auto-merge

## Consequences

- Adding a public graph node/edge, event kind, assertion fact, or action type without updating
  the registry fails CI characterization.
- Operators can run the flywheel offline and get a ranked enrichment backlog with `verify:` gates.
- Later production writers must map into registry ids rather than invent parallel vocabularies.

## Verify

```bash
node --test test/ontology_registry.test.mjs test/intelligence_flywheel.test.mjs
node tools/cross_spine_validate.mjs
node tools/intelligence_flywheel.mjs --fixture --emit-cards /tmp/cs-intel-flywheel
test -f /tmp/cs-intel-flywheel/receipt.json
```

Or: `./tools/verify_ontology_flywheel.sh`

## Rollback

Delete `ontology/`, `tools/intelligence_*.mjs`, `tools/cross_spine_validate.mjs`,
`tools/verify_ontology_flywheel.sh`, the two characterization tests, this ADR, and the
`ACTION_TYPES` / `ACTION_DELIVERIES` exports from `site/action_registry.js` if unused.
No migration or route to reverse.
