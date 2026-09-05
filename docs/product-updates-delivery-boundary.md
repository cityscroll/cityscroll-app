# Product-updates delivery boundary

## What exists today

This repository publishes a public product-updates artifact
(`site/product_updates_source.mjs`) and can check a batch of candidates
assembled outside this repository — the candidate assembler — against that
artifact for honesty (`site/product_updates_honesty.mjs`). The candidate
assembler hands an assembled batch to a review desk kept entirely outside
this repository, which records an approve, reject, or request-edits
decision for that batch, bound to it by `batch_id`, `source_artifact_hash`,
and `content_hash`, with a `decided_at` timestamp and an opaque reviewer
identity.

`site/product_updates_delivery.mjs` adds one gate,
`authorizeDelivery(...)`, that a future delivery adapter must call with that
approval, the batch, the current public artifact, and a deliverable honesty
receipt. It refuses a batch that was never approved, was edited after
approval, no longer matches the artifact it was approved against, lacks a
consistent deliverable honesty receipt, or has already been recorded as
delivered. It sends nothing and writes nothing.

## The boundary

**No delivery adapter exists in this repository.** Until one is built and
explicitly wired in, no product-update batch is sent by email, and no
product-update batch is delivered to `/following/` — regardless of a
batch's `batch_id`, `source_artifact_hash`, `content_hash`, or `decided_at`,
and regardless of what the review desk decided. An approval record is an
input to a gate, not a trigger for delivery. `test/following_route.test.mjs`
asserts that the rendered `/following/` surface carries no product-update
batch content and that no module under the Following surface imports
`site/product_updates_delivery.mjs`.

This card does not change, and does not authorize changing, any existing
topicless-signup or topic-watch behavior on `/following/`. Those flows are
unrelated to product updates and are untouched.

## Owner decisions still open

The following are explicitly undecided. Nothing in this repository chooses
among these options; a delivery adapter cannot be built until an owner
decides them.

- **Recipient eligibility.** Who receives a delivered product-update batch:
  every `/following/` subscriber, only subscribers who opted into a
  specific update channel, a separate product-updates mailing list, or some
  other eligible set. Not decided.
- **Cadence.** Whether delivery is per-batch (as soon as one is approved),
  on a fixed schedule (e.g. weekly digest), or batched with existing
  `/following/` digests. Not decided.
- **Suppression.** Whether a recipient can be suppressed from a specific
  batch or category, how long a suppression lasts, and whether suppression
  is per-recipient or estate-wide. Not decided.
- **Sender.** What address or identity sends a delivered batch, and whether
  it differs from the sender used for `/following/` watch notifications.
  Not decided.
- **Retry.** Whether a failed delivery attempt is retried, how many times,
  on what backoff, and whether a retried delivery must re-run
  `authorizeDelivery` against a possibly-changed artifact. Not decided.
- **Unsubscribe.** Whether product-update delivery has its own unsubscribe
  mechanism, shares the one `/following/` already has, or is not
  unsubscribable because it is not yet delivered at all. Not decided.

Building a delivery adapter requires an owner decision on each item above.
This document records that they are open; it does not resolve them.
