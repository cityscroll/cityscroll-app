# Ontology (catalog + multi-dimension improvement flywheel)

Backstage **object–link–action catalog** and **MAPE improvement flywheels** for CityScroll.
Not a microservice, not a public route, not a graph database.

## Layout

| Path | Role |
| --- | --- |
| `registry.v0.json` | Committed catalog of object types, link types, event kinds, assertions, kinetic actions |
| `load.mjs` / `sync.mjs` / `live_inventory.mjs` | Load registry; import live allowlists; fail on drift |
| `flywheel.mjs` | Pure receipt + enrichment card planner (ontology-enrichment dimension) |
| `flywheel_run.mjs` | Multi-dimension orchestrator (all dimensions → reconciled queue) |
| `dimensions/` | Evaluators: data-integrity (**population not-published-rate** core), readability, ontology-enrichment, coverage, cross-source-consistency |
| `dimensions/not_published_rate.mjs` | Pure rate + classification for “city does not publish X” credibility audit |
| `card_queue.mjs` | Rank, dedupe, ledger reconcile (idempotent emit) |
| `engineering_lessons.mjs` + `engineering-lessons.md` | Recurring-class extraction |
| `cross_spine.mjs` | Pure cross-spine agreement checks |
| `fixtures/cross_spine/` | Pass/fail subject bundles |
| `fixtures/dimensions/` | Feature / view / disagreement inventories |
| `queue/` | Emitted-queue schema + idempotency ledger |
| `index.mjs` | Package exports |

Docs: [`docs/multi-flywheel.md`](../docs/multi-flywheel.md) · ADR: [`docs/adr/ontology-registry-v0.md`](../docs/adr/ontology-registry-v0.md).

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

## Schedule

Hourly GitHub Action: `.github/workflows/multi-flywheel.yml` → artifact `multi-flywheel-queue`.
