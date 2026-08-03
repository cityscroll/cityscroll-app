# Multi-dimension improvement flywheel

Standing MAPE loops that **monitor** product inventories, **analyze** for gaps,
**plan** ranked improvement cards, and re-measure after fixes. Agent **execute**
is external: this system emits a machine-readable queue; a dispatcher fans work
out and closes cards when `verify:` gates pass.

Public vocabulary is neutral. This is an object–link–action **catalog** plus
**improvement dimensions**, not a named third-party product.

## Dimensions

| Dimension | What it monitors | Emits when |
| --- | --- | --- |
| `data-integrity` | **Core:** population not-published-rate for every “city does not publish X” register (recent + historical sample). Secondary: always-null feature inventory | ~100% not-published with public-source data (broken join / never-ingested / mislabeled); undersampled claims; always-null features |
| `readability` | Views that render joined data | Weak hierarchy, over-density, data-dump smell |
| `ontology-enrichment` | Registry sync, class-(a) gaps, dual-write, cross-spine | Metric-driven enrichment (legacy intelligence flywheel) |
| `coverage` | Declared `source_contracts` vs observation coverage | Declared-not-ingested or dual-write gap |
| `cross-source-consistency` | Disagreement inventory + cross-spine fail fixtures | Unreconciled source disagreements |
| `location-resolution` | Golden-corpus located rates, **map** `district_activity` per-lens located rates, community + council district resolution on geocoded pins, boundary vintage | Stated places remain unlocated, a map lens is zero-located with a non-empty corpus (`map-zero-located-*`), either district is missing, or a boundary source is stale/unlabeled |

### Data-integrity core: not-published-rate credibility audit

A false “the city does not publish X” damages credibility more than a visible gap.
The continuous test (pure, re-run every flywheel schedule):

1. **Enumerate** class-(b) / withheld registers from `site/data/gap_taxonomy.json` plus sample inventory extras.
2. **Sample** recent + historical product entries per claim (fixture inventory today; live side-car later).
3. **Rate** = `not_published_count / n`. Thresholds: red ≥ 0.95, suspicious ≥ 0.85, min sample 10.
4. **Flag** ~100% rates when `public_source_has_data` (or investigation needed). Classify `broken_join` / `never_ingested` / `mislabeled` / `genuinely_withheld`.
5. **Do not** emit join-bug cards for verified genuine withholds (e.g. package documents, individual exam results).

Implementation: `ontology/dimensions/not_published_rate.mjs` + samples in
`ontology/fixtures/dimensions/not_published_claim_samples.json`. Cross-source
claim coverage is measured per join family in
`ontology/fixtures/dimensions/cross_source_disagreements.json`; each family below
full coverage emits one card.

Location inputs are deterministically exported from the two pinned golden
corpora plus the geocoded civic-scope fixture:

```bash
node tools/build_location_resolution_inventory.mjs
node tools/build_location_resolution_inventory.mjs --check
```

The existing `ontology-enrichment` evaluator also consumes the temporal
completeness and procurement lifecycle-coherence scorecards. This keeps civic
time and lifecycle regressions in the established enrichment loop rather than
creating a parallel process dimension.

Each dimension is an evaluator under `ontology/dimensions/`. New dimensions
register in `ontology/dimensions/index.mjs` and `DIMENSION_IDS`.

## Entrypoint

```bash
# Full run (fixture inventories; no network)
node tools/flywheel-run.mjs --fixture --emit /tmp/mf-out

# Subset
node tools/flywheel-run.mjs --fixture --emit /tmp/mf-out --dimensions coverage,data-integrity

# Idempotent ledger merge (skip already-open / already-fixed)
node tools/flywheel-run.mjs --fixture --emit /tmp/mf-out --update-ledger

# Append recurring lesson classes
node tools/flywheel-run.mjs --fixture --emit /tmp/mf-out --write-lessons

# Full verify gate
./tools/verify_multi_flywheel.sh
```

### Outputs (`--emit <dir>`)

| File | Role |
| --- | --- |
| `queue.json` | **Contract** — ranked, deduplicated cards + stats + dimension metrics |
| `cards.jsonl` | One card object per line for streaming consumers |
| `receipt.json` | Run summary (hashes, counts, lesson classes) |
| `cards/*.md` | Human-readable cards |

Schema: `ontology/queue/schema.v0.json` (`cityscroll.multi_flywheel_queue.v0`).

## Card contract

Every emitted card includes:

- `id` — stable (`crol-list/mf-{dimension}-{slug}`)
- `dimension` — one of the six ids above
- `title`, `rank`, `rank_score`
- `verify` — machine-checkable predicate (usually a `node --test` / tool command)
- `demo_win` — what a fixed card unlocks for a reader
- `evidence` — structured measurement that triggered the card
- `lesson_class` — optional recurring-class key for engineering lessons

## Idempotency (reconciliation)

Ledger: `ontology/queue/ledger.json` (`cityscroll.multi_flywheel_ledger.v0`).

| Prior status | On re-run |
| --- | --- |
| (none) | Emit as `new` |
| `proposed` / `open` / `in_progress` | Skip (unless `--refresh-open`) |
| `fixed` / `closed` + verify still passes | Never re-emit |
| `fixed` / `closed` + verify fails | Re-emit as `regression` |
| `wontfix` | Never re-emit |

Fixed cards auto-close in the consumer when their `verify` command exits 0; the
next flywheel run then skips them. Pass verify results into
`reconcileQueue(..., { verify_results })` from automation if desired.

## How a dispatcher consumes the queue

1. **Fetch** the latest `queue.json` (CI artifact `multi-flywheel-queue` from the
   hourly workflow, or a local `--emit` directory).
2. **Filter** to cards not already claimed in the ledger / work tracker.
3. **Fan out** one work unit per card (branch + fix + run the card’s `verify`).
4. **On verify pass**, mark the ledger entry `fixed` (or merge via
   `--update-ledger` after `applyVerifyToLedger`).
5. **On verify fail after a prior fix**, treat as regression (the flywheel will
   re-emit on the next schedule).
6. **Do not** hand-author a parallel roadmap for the same metric-driven gaps;
   re-run the flywheel after merges so ranks stay current.

Suggested consumer sketch (pseudo):

```text
queue = read("queue.json")
for card in queue.cards:
  if ledger[card.id].status in (open, fixed, wontfix): continue
  claim(card)
  implement(card)
  if shell(card.verify) == 0:
    ledger[card.id].status = fixed
  else:
    leave open / retry
write(ledger)
```

## Schedule

`.github/workflows/multi-flywheel.yml`

- **Cron:** hourly at minute 17 (`17 * * * *`)
- **Also:** `workflow_dispatch`, and pushes that touch ontology / inventories
- **Artifact:** `multi-flywheel-queue` (14-day retention)
- **No production writes**, no secrets required for fixture mode

## Engineering lessons

When a `lesson_class` appears ≥2 times in one run, the runner can append a
durable note to `ontology/engineering-lessons.md` (`--write-lessons`). Lessons
are append-only and keyed by class token so re-runs stay idempotent.

## Layout

| Path | Role |
| --- | --- |
| `ontology/registry.v0.json` | Object–link–action catalog |
| `ontology/flywheel.mjs` | Legacy intelligence receipt + enrichment planner |
| `ontology/flywheel_run.mjs` | Multi-dimension orchestrator (pure) |
| `ontology/dimensions/*` | Per-dimension evaluators |
| `ontology/card_queue.mjs` | Rank, dedupe, ledger reconcile |
| `ontology/engineering_lessons.mjs` | Recurring-class extraction |
| `ontology/fixtures/dimensions/` | Feature / view / disagreement inventories |
| `ontology/queue/` | Schema + ledger |
| `tools/flywheel-run.mjs` | CLI |
| `tools/intelligence_flywheel.mjs` | Single-dimension (enrichment) CLI |
| `tools/verify_multi_flywheel.sh` | Full verify gate |

## Related

- ADR: [`docs/adr/ontology-registry-v0.md`](adr/ontology-registry-v0.md)
- Package readme: [`ontology/README.md`](../ontology/README.md)
