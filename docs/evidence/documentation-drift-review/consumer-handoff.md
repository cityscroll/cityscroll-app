# Where these findings go, and what is still open

The documentation-claim findings join the review path that already exists. No new
schedule, no new recipient list, and no new public dashboard was added for them.

## What runs, and where

| Surface | What it does |
|---|---|
| `.github/workflows/architecture-reconciliation.yml` | Runs `node tools/documentation_drift_review.mjs --check` alongside the existing reconciliation and the frozen canary replay, on pull requests touching the covered documents, in the merge group, and on the existing daily schedule. |
| `tools/backtest_architecture_canaries.mjs --check` | Replays the frozen audited counterexamples and their positive controls in the same job. |
| `test/documentation_drift_review.test.mjs` | Asserts the observer, the registry, the frozen replay, the determinism properties, and the committed rehearsal receipt in the unit family. |

The daily cadence is the one the architecture reconciliation already has. This
lane introduces no second scheduler, and the repository's standing contract that
no new scheduler, mail route, or recipient list is introduced to add a review lane
is recorded in `docs/evidence/public-user-guide/review-cadence-handoff.md`.

## The consumer rehearsal

`node tools/documentation_drift_review.mjs --rehearse-lineage` drives the shared
outbox in `tools/external_schedule_outbox.mjs` — the same deduplicating mechanism
the existing scheduled jobs use, keyed on the same job-id and run-key
conventions — with an issue intent of `none`. The replay client throws on any
mutation, so a clean replay is itself the proof that nothing outward was opened,
commented on, or closed.

The receipt is committed at `consumer-rehearsal-receipt.json` and is reproduced by
a test. It runs over the frozen audited fixture and its corrected control rather
than the working tree, so it is deterministic and does not move when an unrelated
document is edited. Five stages:

| Stage | What it proves |
|---|---|
| `first-occurrence` | Sixteen findings arrive as new, under one outbox event. |
| `unchanged-replay-same-slot` | The same slot replayed produces the same event id, the same content hash, zero new findings, and still one outbox event. |
| `unchanged-replay-next-slot` | The next slot with unchanged inputs produces zero new findings; the sixteen persist rather than repeating as work. |
| `resolution` | Correcting the documents resolves all sixteen and reports a healthy status. |
| `recurrence` | Reintroducing the drift raises the findings again under the identities they had at first occurrence, so a recurrence is recognisable as one rather than as new work. |

## What is still open

The review desk that decides on an assembled batch is not in this repository.
`docs/evidence/public-user-guide/review-cadence-handoff.md` records that boundary
and the interface both halves need: the batch identity fields, the decision
vocabulary, the entry point and its receipt, and the deduplication conventions
already used there.

This lane satisfies the public half of that interface — a stable job id, a stable
run key, a stable per-finding identity, a content hash over the review evidence,
and a delta that separates new, persisting and resolved findings. It cannot
exercise the private half, and does not claim to. **That obligation stays open.**
Closing it needs, from the repository holding the weekly review, the exact entry
point that assembles a batch and the receipt it produces, so a rehearsal can prove
one documentation finding arrived once inside a real batch and that a replay
produced no duplicate. Until then the rehearsal above is a rehearsal against the
shared outbox, not proof of delivery into that desk.

Reviewer fields, scheduler paths, queue state, and credentials stay on the private
side. Nothing in the report schema could carry them: the report has no assignee,
reviewer, queue, priority or desk field, and its findings carry only a document
path, a line, the matched claim text, and the committed owner that contradicts it.
