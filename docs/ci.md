# Continuous integration

## Merge-queue check trim

The site owner approved trimming the merge-queue (`merge_group`) build to the
checks that depend on the merge base, so a queue entry finishes in roughly
15–20 minutes instead of 45+. Every `pull_request` run and every post-merge
`push` to `main` keeps the full check set.

Only the slow browser-driven classes are trimmed on `merge_group`: accessibility
shards and their aggregator, plus the performance serial baseline and raw-sample shards.
The fixture-backed functional gap shards and their required aggregate run on both pull
requests and `merge_group`. The performance budgets aggregate is also
skipped on `merge_group` because it has no inputs once those pilots are absent
and would otherwise fail red. Reading-level stays on `merge_group` and remains
ruleset-required: it is cheap and guards copy that other merges can change.
Trimmed jobs use `if: always() && github.event_name != 'merge_group'` so their
check names are absent for queue builds rather than reported as skipped-failures.

### Ruleset required-status-check lists

The repository ruleset `main merge queue` lists required status checks by name.
A required check that never reports on a `merge_group` build blocks the queue
forever. After this trim lands, apply these exact lists to that ruleset (via
`tools/merge_queue_policy.json` / `tools/apply_merge_queue_policy.mjs`):

**Remove from the ruleset required list**

- `Accessibility + language gate (axe on every PR)`

**Remain in the ruleset required list**

- `Unit tests (site + worker)`
- `Reading-level ratchet gate (readable-or-else)`
- `Functional browser tests`

### Still run on `merge_group` (not all are ruleset-required)

These jobs must still run and report on merge-group builds even when they are
not ruleset-required contexts:

- every Unit family and the `Unit tests (site + worker)` aggregator
- every Time-travel shifted family (`Time-travel (…)` matrix)
- `Merge-group inventory preflight`
- `Shared browser site artifact`
- every required Functional browser shard and the `Functional browser tests` aggregator
- Architecture reconciliation (`Reconcile architecture evidence`)
- Home path leak guard (`Reject absolute home paths`)
- Pages-bundle no-Node-built-ins gate (inside Unit family `site-node`, via
  `tools/check_pages_bundle_node_builtins.mjs` and
  `test/pages_bundle_node_builtins.test.mjs`)

### Risk

Combination-only regressions in the trimmed accessibility and performance classes
surface on the post-merge `push` to `main` run, which still executes the full set.
The functional checks that previously existed only in the local full preflight now
block the merge queue through their dedicated required aggregate.

## Merge-queue throughput

The repository shares a free-plan runner pool (20 concurrent jobs) across every
workflow. Measured over one week of run history: one merge-group build needs a
median 14 concurrent runners, the 12-shard Time-travel matrix re-ran in full on
every `pull_request` push (the single largest runner consumer during load
spikes), and the previous 5-minute batching window almost never batched (0.88
lands per merge-group build), so bursts starved the queue and evicted entries.
Four changes, approved by the site owner, address this:

- **Ruleset stays at the declared policy.** `tools/merge_queue_policy.json`
  remains the source of truth: three required checks (Unit, Reading-level,
  Functional browser tests) and a 60-minute check response timeout. The
  scheduled merge-pipeline-guard workflow now runs
  `node tools/apply_merge_queue_policy.mjs --check`, so live ruleset drift from
  the file fails visibly instead of persisting silently.
- **Time-travel no longer runs on `pull_request`.** The matrix runs on
  `merge_group` (informational — its contexts are not ruleset-required), on
  `push` to `main`, on manual dispatch, and on a daily off-peak schedule
  (05:17 UTC). Time-shift regression signal on an individual PR is traded for
  roughly a quarter of peak runner demand; a shifted-clock failure still
  surfaces the same day through the post-merge full suite or the scheduled
  sweep.
- **Batching window is 15 minutes.** `min_entries_to_merge_wait_minutes` is 15
  so near-simultaneous green PRs share one merge-group build (2–4 entries per
  train at observed arrival rates) instead of each occupying a singleton train.
- **Home path leak guard pushes are main-only.** Its `push` trigger is scoped
  to `main`, so branch churn from automation and merge-queue bookkeeping
  branches no longer spawns single-job runs.
