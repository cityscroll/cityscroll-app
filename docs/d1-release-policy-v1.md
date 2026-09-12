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
3. Apply keyed delta-upsert batches with bounded retries. The fence is settled
   before the first write and re-checked at every batch boundary. A run whose
   generation is below the one the fence already holds is stale and is rejected
   before any mutation becomes visible, leaving a receipt that names both the
   stale generation and the current one; the current generation stays
   publishable. Each batch commits a deterministic checkpoint row in the same
   D1 import transaction as its application mutations. A retry or later run
   recovers that marker and does not replay the completed batch. Canary batches
   use their full-plan identities, so the wide phase does not reapply the
   canary slice.
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

Receipt `estimated_writes` and `observed_writes` fields count application-row
mutations represented by the delta batches. An observed count means the batch's
transactional checkpoint proves those mutations committed. The counts exclude
checkpoint and other control-plane writes, and they are operational counters,
not Cloudflare billing totals; the provider invoice remains authoritative.

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

## Watermark provenance in a receipt

Each model in a publication receipt carries the lexicographic extremes of its
partition watermarks, recorded exactly as the source published them. A watermark
is the manifest's source snapshot field, and that field has two published forms:
a single instant, and a composite of the vintages of every source that fed one
partition, joined on `|`, sometimes with a published row count as its first
component. The keyword search model's agency families use the composite form so
the token stays byte-stable across rebuilds when the inputs are unchanged, and
it gains a component whenever that model gains a source.

A receipt therefore bounds a watermark as a composite rather than as a single
instant: at most 1024 characters, at most 32 `|`-joined components, and at most
120 characters per component, with a secret-shaped component still refused. The
per-component bound is the width this field as a whole once allowed, so the
bounds are a strict widening and every watermark that validated before still
validates. The recorded value is never shortened to fit. The delta plan compares these tokens
component by component to decide whether a partition's watermark regressed, so a
truncated token in a receipt would no longer name the vintage that was actually
published. Widening these bounds is a deliberate contract change made in
`tools/d1_publication_receipt.mjs`, and the receipt is built over the live
publication snapshot in the unit suite so an unexpected watermark shape fails on
the pull request rather than in the deploy.

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
