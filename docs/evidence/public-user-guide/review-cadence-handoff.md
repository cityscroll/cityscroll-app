# Public guide: where guide review joins the existing cadence

The guide is meant to join a review that already exists rather than start a new
one. This records what is reachable from this repository, what is not, and the
exact interface a later change needs on both sides of that line.

## What runs in this repository, and how often

Nothing in this repository runs weekly. Every scheduled check reachable here is
daily:

| Job | Configuration | Cadence |
| --- | --- | --- |
| Architecture reconciliation | `.github/workflows/architecture-reconciliation.yml` | `17 6 * * *` — daily at 06:17 UTC |
| Outbound action-link integrity | `tools/external_schedule_jobs.json` (`action-links-live`) | daily |
| Live source-contract drift | `tools/external_schedule_jobs.json` (`source-contracts-live`) | daily |
| Source evidence freshness | `tools/external_schedule_jobs.json` (`source-freshness-watchdog`) | daily |
| Digest shadow monitor | `tools/external_schedule_jobs.json` (`digest-shadow-monitor`) | twice daily |

The scheduler for those jobs is declared `independent` in the same manifest, and
the repository's contract is that no new scheduler, mail route, or recipient
list is introduced to add a review lane. Any earlier description of a *weekly*
job in this repository is stale; the daily architecture reconciliation is the
closest thing, and it is a different cadence with a different purpose.

## What the weekly review is, and why it is not reachable here

The weekly candidate assembly is not in this repository, and neither is the
review desk that decides on an assembled batch. This repository holds only the
public half of that boundary, which
`docs/product-updates-delivery-boundary.md` states directly: a batch of
candidates is assembled outside this repository, and a review desk kept entirely
outside this repository records an approve, reject, or request-edits decision
bound to that exact batch.

So the weekly record, its schedule configuration, and its consumer cannot be
named from here. The private-side record identifier is deliberately not
published in this repository. What *can* be pinned down exactly is the interface
between the two halves, and that is what a later change needs.

## The handoff a guide-review lane has to satisfy

### Already published by this repository

| Contract | Owner | What it carries |
| --- | --- | --- |
| `cityscroll.product_updates.v1` | `site/product_updates_source.mjs`, built into `site/product-updates.json` by `tools/build_product_updates.mjs` | The public candidate artifact, with its `as_of`, `observed_commit`, and its four declared source inputs: the changelog, the architecture reconciliation output, the capability registry, and the demo manifest. |
| `cityscroll.product_updates_honesty_receipt.v1` | `site/product_updates_honesty.mjs` | Per-candidate honesty check against the public artifact, including a demo regression state of `passing`, `broken`, or `missing` derived from the demo manifest. |
| `cityscroll.product_updates_delivery_authorization.v1` | `site/product_updates_delivery.mjs` | The single gate an adapter must pass. It refuses a batch that was never approved, was edited after approval, no longer matches the artifact it was approved against, lacks a consistent honesty receipt, or was already delivered. It sends nothing and writes nothing. |

The demo manifest is already one of the candidate artifact's declared inputs.
That is the seam a guide-review lane should use: guide articles cite demo ids,
and the regression state of those ids is already derived here. A separate
example registry would duplicate an authority that exists.

### Needed from the repository holding the weekly review

1. **The batch identity fields.** A decision is bound to a batch by `batch_id`,
   `source_artifact_hash`, and `content_hash`, with a `decided_at` timestamp and
   an opaque reviewer identity. A guide-review section has to travel inside that
   same batch identity, not beside it.
2. **The decision vocabulary.** `approve`, `reject`, and `request_edits`. A
   guide finding is a suggestion inside a batch that a person decides on; it is
   never an automatic publication or an automatic rewrite.
3. **The entry point and its receipt.** The exact command or job that assembles a
   weekly batch, and the receipt it produces, so a rehearsal can prove one guide
   section arrived once and that a replay produced no duplicate finding. Without
   that receipt, integration cannot honestly be called complete.
4. **The deduplication and job-identity conventions** already used there, so a
   guide lane reuses them instead of inventing a second scheme.

### What must not cross

Reviewer fields, scheduler paths, queue state, and credentials stay on the
private side. They must not appear in public guide HTML, in per-article
metadata, or in any artifact this repository publishes.

## What this means for sequencing

The public half can be built and proven here without the private half: the
per-article metadata, the demo-id references, the report contract, and an
executable fixture that exercises a positive finding, a stale-review reminder,
and a check-unavailable outcome. Only the consumer rehearsal in item 3 above
depends on access to the other repository, and that single acceptance stays open
until it can be run. The published guide does not wait on it.
