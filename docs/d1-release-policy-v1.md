# D1 release policy v1

This policy makes D1 release control the default for the Worker release. The
operating budget report links here.

## When publication is considered

The Worker workflow runs for pushes to `main` only when its `on.push.paths`
filters match. The filters cover the Worker, shared runtime and data inputs,
builders, warehouse inputs, and this workflow. A manual `workflow_dispatch` is
also available for an operator-directed retry or recovery action.

The workflow computes the D1 deploy fingerprint before it reads the last
published fingerprint. The publication gate then compares the two. An
unchanged fingerprint produces a visible receipt with `outcome: "skipped"`,
`reason: "fingerprint-unchanged"`, and zero writes. A changed fingerprint is
the only ordinary trigger for D1 publication; the manual force input is an
explicit operator bypass and remains visible in the decision evidence.

## Ordinary publication path

The ordinary path is the fenced, idempotent delta path:

1. Capture the partition snapshot and produce a partitioned delta plan.
2. Claim a generation fence before writing.
3. Apply keyed delta-upsert batches with bounded retries, checking the fence at
   every batch boundary. Replaying a completed batch is safe because its keys
   and operation order are deterministic.
4. Run the bounded canary and stop on any finding, watermark mismatch, or
   failed representative query.
5. Reconcile the accepted generation before it can serve. A finding or
   truncated reconcile is not consistent and cannot be promoted.
6. Retain the publication decision, batch, canary, reconcile, generation, and
   zero-write evidence as the append-only local JSONL receipt and the retained
   workflow artifact; the best-effort KV mirror is supplementary.

The checked-in policy data in `worker/d1-release-policy.json` owns the canary,
reconcile, abort, budget, and rollback bounds. The policy check verifies this
workflow order and refuses a rebuild reference in the ordinary path.

## Exceptional rebuild and rollback

A full rebuild is exceptional: use the [D1 explicit rebuild procedure](d1-explicit-rebuild-v1.md)
for a schema or key migration, corrupted derived state, or a deliberately
selected backfill. It is staged, bounded, receipt-producing, and must reconcile
before serving; it is never silently selected by an ordinary push.

The `disable_incremental_publication` workflow input is the rollback flag. When
true, it pauses incremental publication, keeps the decision and receipt
evidence, and leaves recovery to the bounded, operator-controlled explicit
rebuild procedure. It does not switch ordinary pushes to a full rebuild. The
policy field `incremental_publication.enabled` remains true so the default is
incremental publication when the flag is not set.

## Budget guardrail and escalation

The guardrail is a rolling 30-day count window, not a guessed dollar model. It
reads these measured fields from retained receipts:

- rows written: `totals.observed_writes`, summed across the window;
- batches: `totals.batch_count`, summed across the window; and
- generations: non-null `generation`, counted across the window.

The current count thresholds are recorded in the policy data file:
`rows_written=100000`, `batch_count=250`, and `generation_count=50`. These are
operating guardrails for escalation, not a claim about provider pricing. When
any threshold is reached, tell the `site-owner`, pause incremental publication
with the rollback flag, preserve the receipts, and require an explicit recovery
review before resuming. The measured receipt id and window must accompany that
review; no baseline or cost estimate is invented here.

Cloudflare's final invoice is the authority for billed cost; dashboard usage
may lag and is not treated as a final invoice.
