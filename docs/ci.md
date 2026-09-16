# Continuous integration

## Merge-queue check trim

The site owner approved trimming the merge-queue (`merge_group`) build to the
checks that depend on the merge base, so a queue entry finishes in roughly
15–20 minutes instead of 45+. Every `pull_request` run and every post-merge
`push` to `main` keeps the full check set.

Only the slow browser-driven classes are trimmed on `merge_group`: accessibility
shards and their aggregator, performance serial baseline and raw-sample shards,
and the Playwright functional layer. The performance budgets aggregate is also
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

### Still run on `merge_group` (not all are ruleset-required)

These jobs must still run and report on merge-group builds even when they are
not ruleset-required contexts:

- every Unit family and the `Unit tests (site + worker)` aggregator
- every Time-travel shifted family (`Time-travel (…)` matrix)
- `Merge-group inventory preflight`
- `Shared browser site artifact`
- Architecture reconciliation (`Reconcile architecture evidence`)
- Home path leak guard (`Reject absolute home paths`)
- Pages-bundle no-Node-built-ins gate (inside Unit family `site-node`, via
  `tools/check_pages_bundle_node_builtins.mjs` and
  `test/pages_bundle_node_builtins.test.mjs`)

### Risk

Combination-only regressions in the trimmed classes (accessibility, performance,
Playwright functional) surface on the post-merge `push` to `main` run, which
still executes the full set.
