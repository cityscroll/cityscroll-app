# Civic Graph (catalog + multi-dimension improvement flywheel)

Backstage **Civic Graph**: the unified **object–link–action catalog** and **MAPE
improvement flywheels** for CityScroll. Not a microservice, not a public route,
not a graph database.

Entity resolution type families remain the **link-not-merge identity layer** —
they do not replace the wider civic noun set in `registry.v0.json`.

Each object and link type carries a **grounding** state (`built` | `partial` |
`gap`) from the measured existence matrix. The evaluation harness scores
coverage, agreement, actionability, and grounding, then emits ranked enrichment
cards only when metrics show a real gap.

## Layout

| Path | Role |
| --- | --- |
| `registry.v0.json` | Civic Graph catalog: object types, link types, event kinds, assertions, kinetic actions + grounding |
| `grounding.mjs` | Grounding states, validation, receipt metrics |
| `load.mjs` / `sync.mjs` / `live_inventory.mjs` | Load registry; import live allowlists; fail on drift |
| `flywheel.mjs` | Pure intelligence receipt + enrichment card planner (ontology-enrichment dimension) |
| `action_path_coverage.mjs` | Grounded Action Path coverage ratios and diagnostic classes |
| `flywheel_run.mjs` | Multi-dimension orchestrator (all dimensions → reconciled queue) |
| `dimensions/` | Evaluators: data-integrity (**population not-published-rate** core), readability, ontology-enrichment, coverage, cross-source-consistency, ontology-coherence, action-path |
| `dimensions/not_published_rate.mjs` | Pure rate + classification for “city does not publish X” credibility audit |
| `card_queue.mjs` | Rank, dedupe, ledger reconcile (idempotent emit) |
| `engineering_lessons.mjs` + `engineering-lessons.md` | Recurring-class extraction |
| `cross_spine.mjs` | Pure cross-spine agreement checks |
| `fixtures/cross_spine/` | Pass/fail subject bundles |
| `fixtures/dimensions/` | Feature / view / disagreement inventories |
| `queue/` | Emitted-queue schema + idempotency ledger |
| `person.mjs` | Source-qualified person projection, `person_identity_link.v1` builder, capability boundary |
| `person_identity_link_ledger.mjs` + `person_identity_links.jsonl` | Append-only reviewed same-person ledger, accepted-only `canonical_person_ref` materialization, diagnostics listing (`node tools/check_person_identity_link_ledger.mjs --check`) |
| `land_use_filing.mjs` | LDP-23: land-use filing obligation, filing document, and Racial Equity Report envelope contracts, the five filing relations, and an as-of projector |
| `index.mjs` | Package exports |

Docs: [`docs/civic-graph.md`](../docs/civic-graph.md) · [`docs/multi-flywheel.md`](../docs/multi-flywheel.md) · ADR: [`docs/adr/ontology-registry-v0.md`](../docs/adr/ontology-registry-v0.md) · [`docs/adr/land-use-filing-ontology.md`](../docs/adr/land-use-filing-ontology.md).

## Verify

```bash
./tools/verify_multi_flywheel.sh
# or
node --test test/ontology_registry.test.mjs test/intelligence_flywheel.test.mjs \
  test/multi_flywheel.test.mjs test/multi_flywheel_dimensions.test.mjs
node tools/flywheel-run.mjs --fixture --emit /tmp/cs-multi-flywheel
node tools/intelligence_flywheel.mjs --fixture --emit-cards /tmp/cs-intel
```

## Rules

- Every live allowlist id must be `registered` or `unregistered` in the registry.
- Unregistered entries need a reason.
- Cards are metric-driven (dimensions re-measure); do not hand-maintain a parallel
  enrichment roadmap in place of re-running the flywheel.
- Emitted cards always carry a machine-checkable `verify` and a `demo_win`.
- The ledger prevents re-emitting open or fixed cards (regression only when verify fails).
- The reviewed same-person ledger is append-only: a new decision is a new line,
  never an edit of a stored one, and only an accepted current record materializes
  a `canonical_person_ref`.

## Schedule

Hourly GitHub Action: `.github/workflows/multi-flywheel.yml` → artifact `multi-flywheel-queue`.
