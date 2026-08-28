# Merge-train batch policy

`tools/merge_train_policy.mjs` is the deterministic policy projection over a
read-only batch observation snapshot. It compares one-, three-, five-, and
observed six-car batches using runner wait, per-shard wall time, successful
dequeue service rate, ejection rate, and time in queue. It recommends a bound
only after every in-ceiling candidate meets the minimum sample count.

The evaluator is advisory. It cannot apply GitHub ruleset settings. The native
policy in `tools/merge_queue_policy.json` remains `ALLGREEN` with a five-entry
build and merge ceiling. Observations above that ceiling are retained as
evidence, not admitted as a settings change.

## Generated-file serialization

The report carries a reason receipt for producer groups covering architecture
facts and the reviewed watermark, source-health outputs, i18n tables, and depot
receipts. These groups are serialized at the train boundary so dependent or
overlapping generated outputs do not enter one composition as if they were
independent.

The shared architecture watermark serialization finding remains a registered
decision. This policy references that decision and does not implement a
watermark remedy.

## Elder protection

Anti-starvation remains delegated to `tools/elder_merge_slot.mjs`. The existing
two-hour steer, six-hour reservation, and three-rebase threshold are surfaced in
the report and remain authoritative. A hard-threshold elder reserves the lead
seat of the next train before younger ready pull requests are seated.

## Fixture replay

```sh
node tools/merge_train_policy.mjs \
  --fixture test/fixtures/merge-throughput/train-policy --check
node --test test/merge_train_policy.test.mjs
```
