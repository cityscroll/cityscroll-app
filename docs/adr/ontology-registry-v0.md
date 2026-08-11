# ADR: Civic Graph registry v0 (catalog + flywheel seam)

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-01 |
| Updated | 2026-08-11 (grounding states + design-matrix link catalog) |
| Scope | Catalog + pure evaluation flywheel — no production graph store, no public route |
| Product name | **Civic Graph** (object–link–action registry + evaluation harness) |
| Supersedes | — |
| Related | `docs/adr/entity-resolution-taxonomy.md`, `docs/adr/civic-time-event-contract.md`, `docs/action-log.md`, `docs/civic-graph.md` |

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
