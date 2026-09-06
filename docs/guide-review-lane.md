# The guide review lane

The public guide is prose about a site that keeps changing. Nothing in this
repository can decide whether an article still reads true — that is a person's
job. What this repository can do is tell that person, once a week, which
articles have a reason to be looked at.

This document is the contract for that half. It describes what the app produces,
what it deliberately does not produce, and the one piece of the loop that lives
outside this repository.

## What the lane is, in one line

A deterministic projection from the tracked guide sources to a list of
observations, keyed so the same observation twice is one item of work.

## Two dates that must never merge

| Field | Who writes it | What it means |
| --- | --- | --- |
| `last_reviewed` | an editor, by hand, in the article source | a person read this article against the live site and stands behind it |
| `checked_at` | the review run, from an explicit argument | a machine looked at the article's dependencies at this moment |

A check never becomes a review. `site/guide_review_source.mjs` reads
`last_reviewed` and has no code path that writes one, and the report schema has
no field that could carry a proposed value. Machine evidence suggests editorial
work; only an editor's own edit to the article source moves a review date.

Both of these are separate again from civic-data freshness, which belongs to the
source contracts and is reported on the data-health surface, not here.

## Inputs

All four are public and already have owners:

| Input | Path |
| --- | --- |
| guide articles | `site/guide/_articles/` |
| demo manifest | `site/demo/demo-links.json` |
| capability registry | `capabilities/registry.mjs` |
| source contracts | `site/data/source_contracts.json` |

Example pairing reuses `PRODUCT_UPDATE_JOINS` from
`site/product_updates_source.mjs`. The lane adds no second registry of example
URLs; if a journey is demonstrable, it is demonstrable through the manifest the
product-updates lane already reads.

## Per-article public metadata

An article source may declare, in its front matter:

```yaml
published: 2026-09-05
updated: 2026-09-05
demos:
  - semantic-search-housing
historical_demos:
  - semantic-search-housing
capabilities:
  - search.federated@1
source_contracts:
  - city-record
depends_on:
  - site/search_document.mjs
```

`depends_on` names the code that owns the behaviour the article describes, so a
change to that code raises the article rather than the whole guide.
`historical_demos` marks an example that is deliberately dated; it must be a
subset of `demos` and must be accompanied by a `historical_note`.

An unknown front-matter key fails the build. That is what keeps private review
state — an assignee, a queue position, a desk link — out of a public source
file: there is no key it could be written under.

## Findings

Five kinds, a closed and sorted vocabulary:

| Kind | Raised when |
| --- | --- |
| `broken_example` | a cited example did not behave as the article describes |
| `changed_behavior` | a path in `depends_on` changed in the window |
| `check_unavailable` | a check could not run, or an identifier no longer resolves |
| `possible_new_journey` | a demonstrated journey no article cites |
| `review_due` | no review recorded, an update after the review, or the interval elapsed |

Two distinctions carry weight:

* An example that could not be checked is **not** a broken example. An
  unreachable host produces `check_unavailable`, so an outage never reads as a
  documentation failure.
* An example the article already frames as historical is expected to behave like
  its own era. A failure there is not a breakage, which is how a useful dated
  example stays on the page instead of being deleted for being old.

Each finding carries a `finding_id` derived from its kind, article, and subject.
The same observation in a later run is the same identity, so a repeated report
produces no repeated work.

## What the lane will not do

* It does not schedule itself. There is no cron entry, no launchd job, and no
  GitHub Actions schedule; the existing weekly flow calls it.
* It does not open, comment on, or close anything. The rehearsal path uses the
  shared outbox with an intent of `none` and a client that throws on any
  mutation.
* It does not change product-update delivery, consent, recipients, approval, or
  anything under `/following/`.
* It does not endorse, publish, withdraw, or rewrite guide prose.
* It adds no review dashboard. The output is one section for a review flow that
  already exists.

## Commands

```sh
# every identifier a guide article cites still resolves (no clock, no date)
node tools/build_guide_review.mjs --check

# a report for one window
node tools/build_guide_review.mjs --checked-at=2026-09-05 --since=origin/main

# the section a review flow includes
node tools/build_guide_review.mjs --section --checked-at=2026-09-05

# prove replay and deduplication without reaching any outward surface
node tools/build_guide_review.mjs --rehearse --checked-at=2026-09-05 --run-key=2026-W36
```

`--checked-at` is required for anything that produces a report. The tool refuses
to invent it, because a projection that reads a clock cannot be rebuilt and
compared.

Reports are written under the ignored `.artifacts/` tree. They describe one
moment rather than the state of the site, so they are not tracked.

## The remaining private handoff

The weekly candidate assembly and the review desk are not in this repository and
cannot be named from here. See
`docs/evidence/public-user-guide/review-cadence-handoff.md` for what that half
holds: reviewer identity, assignment, queue state, and credentials.

This change delivers and tests the app-side half in full. One acceptance item
stays open until the private consumer runs it:

> **Open:** an exact rehearsal receipt from the private weekly consumer, showing
> it reading a `cityscroll.guide_review.v1` report, folding the section into its
> existing digest, and producing no duplicate item on a replay.

The handoff needed for that is narrow and entirely on the private side:

1. Call `node tools/build_guide_review.mjs --section --checked-at=<the run date>
   --since=<the previous run's commit>` and include the returned section.
2. Key deduplication on `job_id` + `run_key`, which produce the same `event_id`
   the existing scheduled jobs use, and on each finding's `finding_id`.
3. Keep assignment, queue position, and reviewer identity on that side. Nothing
   in this schema will accept them.

Until that receipt exists, this repository claims only what it can prove: the
report contract, the finding vocabulary, the deduplication behaviour, and a
rehearsal that reaches no outward surface.
