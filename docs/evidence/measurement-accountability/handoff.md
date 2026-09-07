# The measurement review's handoff to the weekly cadence

This lane is built to join a review that already exists rather than start one. This file records
what is reachable from this repository, what is not, and the exact interface the other half
needs — and it states plainly that integration is not complete until that half has actually run
it and returned a receipt.

## The cadence's owner, configuration and consumer

Nothing in this repository runs weekly, and this change does not add anything that does. The
scheduled checks reachable here are the daily jobs declared in
`tools/external_schedule_jobs.json`, whose scheduler is declared `independent` in that same
file; the one this change adds, `stats-daily-snapshot-monitor`, is daily like the rest.

The weekly candidate assembly, its schedule configuration, and the review desk that decides on
an assembled batch are all outside this repository, and the private-side record identifier is
deliberately not published here.
[`../public-user-guide/review-cadence-handoff.md`](../public-user-guide/review-cadence-handoff.md)
is the authority for that boundary and states it in full: a batch of candidates is assembled
outside this repository, and a review desk kept entirely outside it records an approve, reject,
or request-edits decision bound to that exact batch. Reviewer identity, assignment, queue state
and credentials stay there, and this schema has no key any of them could arrive under.

So this file cannot name the weekly job, its owner, or its consumer. What it can do is pin the
interface exactly, which is what a later change needs.

## What this repository publishes for that half

| Contract | Owner | What it carries |
| --- | --- | --- |
| `cityscroll.measurement_review.v1` | `site/measurement_review_source.mjs` | The report: five declared checks, a sorted closed finding vocabulary, a stable `finding_id` per observation, the tracked inputs it read, and a `content_hash` over its own evidence. |
| `cityscroll.measurement_review_finding.v1` | the same module | One observation: kind, subject, detail, evidence. No verdict, no assignee, no queue position, and no field that could carry one. |
| `cityscroll.stats_publication_finding.v1` | `tools/stats_publication_monitor.mjs` | The daily-publication observation the review's fifth check consumes, with its named failing stage. |

## The exact resolved handoff

1. **Call it.** Once per weekly run:

   ```sh
   node tools/build_measurement_review.mjs --section \
     --checked-at=<the run date> \
     --observation=<a captured observation> \
     --run-key=<the run's own key>
   ```

   `--observation` is a JSON file with two optional keys, `reconciliation` and `publication`,
   holding the `search_usage_lineage.reconciliation` block from the authenticated desk response
   and the finding the daily monitor produced. Omitting either makes its check report
   `check_unavailable` rather than a pass, so a run with no observation is visibly a run that
   could not check those two things.

2. **Deduplicate on the keys already in use.** `job_id` is `measurement-review` and `run_key` is
   the run's own key; together they produce the same `event_id` derivation the existing
   scheduled jobs use (`sha256(job_id + "\n" + run_key)`, first 32 hex characters). Within a
   report, each finding's `finding_id` is `sha256(kind + "\n" + subject)`, first 32 characters,
   so the same observation in a later run is the same item of work.

3. **Treat a finding as a suggestion inside a batch.** A finding is machine evidence that a
   published claim and the thing it describes have parted company. It is never a decision that a
   figure should change, and the report carries no field that could express one. The decision
   vocabulary stays the batch's: approve, reject, request_edits.

4. **Send nothing back.** This lane reads nothing from the private side and needs no credential,
   no callback and no write path. Assignment, queue position and reviewer identity stay where
   they are.

## Rehearsal, on this side

The whole handoff is rehearsable here without reaching any outward surface. The rehearsal writes
through the shared outbox with an intent of `none` and a client that throws on every mutation,
so a clean replay is itself the proof that nothing was opened, commented on or closed:

```sh
node tools/build_measurement_review.mjs --rehearse --checked-at=2026-09-06 --run-key=2026-W36
node tools/build_measurement_review.mjs --rehearse --checked-at=2026-09-06 --run-key=2026-W36
```

Observed on 2026-09-06: the first run reports `2 new, 0 unchanged, 0 resolved, replay ok`; the
second reports `0 new, 2 unchanged, 0 resolved, replay ok`, on the same event id. The two
findings are both `check_unavailable`, because no observation was supplied — which is the
correct answer for a rehearsal that reads nothing live.

## Open: the integration receipt

**Open.** An exact rehearsal receipt from the private weekly consumer, showing it reading a
`cityscroll.measurement_review.v1` section, folding it into its existing batch, and producing no
duplicate item on a replay.

Integration is not complete until that receipt exists. A handoff document is not a receipt, and
this repository does not claim the integration on the strength of one. Until then, what is
claimed here is only what is proved here: the report contract, the five checks, the finding
vocabulary, the deduplication behaviour, and a rehearsal that reaches no outward surface.

The published page does not wait on it: every figure on it is produced, reconciled and watched
by the mechanisms above, all of which run without the review lane.
