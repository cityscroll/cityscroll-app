# Civic Graph

CityScroll’s backstage **object–link–action registry** and the **evaluation harness**
that measures whether intelligence work actually deepened coverage, agreement,
actionability, or grounding.

This is not a public graph database and not a production write path. It is the single
catalog that unifies:

| Layer | Live sources (examples) | Registry home |
| --- | --- | --- |
| Semantic objects | Public relationship graph nodes, notices, agencies, vendors | `object_types` |
| Identity | ER type families, `canonical_entity`, `source_records` | `er_type_families` + identity objects |
| Links | Public graph edges, ER same-as / separate, product joins | `link_types` |
| Clocked events | Civic-time `EVENT_KIND_REGISTRY` | `event_kinds` |
| Assertions | Source assertion vs product interpretation | `assertion_*` |
| Kinetic actions | Reader action rail + privacy-safe action log | `kinetic_action_types` |

**Identity is not the whole graph.** Entity resolution remains link-not-merge: four type
families plus shadow dual-write. The Civic Graph catalogs the wider civic noun set
(payments, meetings, exams, franchise, …) including types that are still `unregistered`
or `grounding: gap`.

## Grounding states

| State | Meaning |
| --- | --- |
| `built` | First-class product noun with stable ids and durable backing |
| `partial` | Present in product paths (spine, dual-write, allowlist) but incomplete |
| `gap` | Named type with little or no first-class grounding yet |

`status` (registered / unregistered) answers “is this live allowlist id cataloged?”
`grounding` answers “how deep is the product realization?”

## Evaluation harness (MAPE)

| Stage | What runs |
| --- | --- |
| **Monitor** | `source_coverage`, gap taxonomy, registry sync, cross-spine fixtures, actionability sample, grounding summary |
| **Analyze** | `buildIntelligenceReceipt` → coverage / ER / agreement / actionability / grounding metrics |
| **Plan** | `planEnrichmentCards` + multi-dimension `flywheel-run` → ranked cards with `verify:` gates |
| **Execute** | Write cards + receipts only in this package; agent dispatch is external |

Reuse existing offline harnesses rather than inventing parallel scorers:

- ER gold: `entity_resolution/eval/run_metrics.mjs`
- Shadow monitor: `tools/run_er_shadow_monitor.mjs`
- Cross-spine: `tools/cross_spine_validate.mjs`
- Intelligence receipt / cards: `tools/intelligence_flywheel.mjs`
- Multi-dimension queue: `tools/flywheel-run.mjs` (scheduled hourly)

Ship dual-write or spine expansion only when these metrics show a real class-(a) or
grounding gap — not because a static roadmap row said so.

## Package

```
ontology/
  registry.v0.json    # Civic Graph catalog (+ civic_graph.remaining_stack)
  grounding.mjs       # built | partial | gap
  load.mjs / sync.mjs
  flywheel.mjs        # intelligence receipt + cards
  flywheel_run.mjs    # multi-dimension orchestrator
  cross_spine.mjs
  dimensions/         # coverage, agreement-ish, readability, …
```

## Verify

```bash
./tools/verify_ontology_flywheel.sh
# or
node --test test/ontology_registry.test.mjs test/intelligence_flywheel.test.mjs
node tools/intelligence_flywheel.mjs --fixture --emit-cards /tmp/cs-civic-graph
```

## Remaining stack (after v0)

Listed also under `registry.v0.json` → `civic_graph.remaining_stack`:

1. **P3 — Coverage / first-class objects** along `grounding: gap` + dual-write holes
2. **P4 — Production civic-time writer** only after adapters stay stable under the harness
3. **P5 — Officials / votes as objects** when person-level retention stays complete

## Related

- ADR: [`docs/adr/ontology-registry-v0.md`](adr/ontology-registry-v0.md)
- Multi-dimension flywheel: [`docs/multi-flywheel.md`](multi-flywheel.md)
- ER taxonomy: [`docs/adr/entity-resolution-taxonomy.md`](adr/entity-resolution-taxonomy.md)
- Civic-time: [`docs/adr/civic-time-event-contract.md`](adr/civic-time-event-contract.md)

## Committee and community-board geography promotion

The committee and community-board candidates are now registered as bounded Civic
Graph object families. Committee identity is the publisher-issued Legistar
`OfficeRecordBodyId`; `BodyName` is a mutable label. The `official → member_of →
committee` relation is descriptive and temporal only. Each accepted OfficeRecord
observation keeps its source-row hash and retrieval timestamp, including repeated
person/body rows; current membership is a derived view and never replaces history.
The authenticated 30-person receipt is the publication gate. On 2026-08-12 the
Legistar token was unavailable in the build environment, so the committee node
design is registered but public membership edges remain held:
[`committee_sample_2026-08-12.json`](../site/data/committee_graph/verification_receipts/committee_sample_2026-08-12.json).

Community boards use the committed source registry's `body_id` as the stable
identity boundary for both projections of one civic body: a place projection
under location and an organization projection under People + organizations.
The organization declares membership, meeting, and recommendation relation
families, but keeps each family unknown until a verified board source earns the
edge. The 59-board agency crosswalk entry remains an index and directory, not a
replacement for board-level identities. The published geography read model maps
each board to its regular community district and exposes a many-to-many
`community-district → intersects → council-district` overlay. The overlay uses
polygon segment crossing or containment with boundary-touch semantics; it does
not use a centroid shortcut. The 2026-05-26 boundary vintage is stamped on every
derived edge. The dated receipt reproduces all 237 measured pairs across 59
regular community districts (4.02 Council districts per community district):
[`overlay_2026-08-12.json`](../site/data/community_board_geography/verification_receipts/overlay_2026-08-12.json).
