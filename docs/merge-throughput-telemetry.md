# Merge-throughput telemetry

`tools/merge_throughput_telemetry.mjs` is the deterministic collector for the
MT-1 queue telemetry contract. A scheduler supplies a normalized GitHub
snapshot as `source.json`; the collector writes one source/run-qualified receipt
for each pull request, merge-group attempt, and required check, plus daily
gauges and a self-contained HTML dashboard.

The source snapshot is intentionally separate from the outputs. A scheduled
read-only acquisition can populate it from GitHub pull-request timelines,
check-runs, and merge-group runs using `gh api`/the repository's read-only CLI.
The collector itself never mutates GitHub state. `source_run_id`, source
document digests, and artifact hashes make a rerun idempotent and auditable.

## Queueing decomposition

The daily read model uses one shared observation window for all denominators:

```text
L = λW
```

`L` is time-weighted queued PR inventory, `λ` is PR arrivals per day, and `W`
is mean queued time for the same PR cohort. The receipt also reports the
inventory-flow balance (`arrivals - successful_dequeues`) separately from a
gate service-loss signal. A failed check or ejection identifies a candidate
gate signal; it does not establish root-cause attribution by itself.

Every value carries a basis and a measurement state. `measured` means the
source supplied a measured observation, `derived` means the value was calculated
from those observations, `estimated` marks an explicitly estimated source
snapshot or timing/attribution, and `unknown` is used when a pending,
missing, or unavailable source observation cannot support a number. Unknown
durations and conclusions are never represented as zero or success.

## Fixture replay

The committed fixture covers clean service, two ejected attempts, a rerun that
clears a required-check failure, and pending/unavailable required checks:

```sh
node tools/merge_throughput_telemetry.mjs \
  --fixture test/fixtures/merge-throughput --check
node --test test/merge_throughput_telemetry.test.mjs
```

To materialize a new snapshot's outputs, use `--write --output <directory>`.
The output directory contains `per-pr-receipts.json`,
`per-attempt-receipts.json`, `per-required-check-receipts.json`,
`required-check-gauges.json`, `daily-gauges.json`, `receipt.json`, and
`dashboard.html`.

## Known flaky-shard reruns

`tools/known_flake_rerun.mjs` is the bounded policy projection for the existing
routes-focus fresh-runner retry job. It reads the corpus-derived registry in
`data/known-flake-signatures.v1.json`, joins each observation to MT-1's
per-attempt and required-check receipts, and emits an auditable original/retry
receipt. Matching is exact on the typed signature, check, source identity, and
browser-artifact identity. Unknown signatures and changed or missing identities
stay visible without an automatic rerun. A third consistent failure escalates
as a real failure; it does not receive another automatic retry.

Replay the committed policy fixture with:

```sh
node tools/known_flake_rerun.mjs \
  --fixture test/fixtures/merge-throughput --check
node --test test/known_flake_rerun.test.mjs
```
