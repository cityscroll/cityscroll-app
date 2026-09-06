# Diagnostic repair card producer

The Desk repair queue groups repeated source and join conditions into one
issue per source contract, condition, and adapter. This producer turns those
**revalidated repairable** issues into deduplicated engineering candidate cards
with a stable lineage.

It is operator tooling. It does not change public resident copy, Worker
responses, or the served site.

## Schedule

| Field | Value |
| --- | --- |
| Interval | 3600 seconds (hourly) |
| Trigger | `ops/launchd/com.cityscroll.diagnostic-card-producer.plist.template` |
| Runner | `tools/run_diagnostic_card_producer.sh` |
| Installer | `tools/install_diagnostic_card_producer.sh` |
| Policy | `data/diagnostic-card-producer.v1.json` |

Unchanged conditions produce no notification. A dry-run writes a receipt and
touches nothing else.

## Kill switch

The job is a no-op when `CITYSCROLL_DIAGNOSTIC_CARD_PRODUCER` is `off`, `0`,
`false`, or `disabled`, or when `.diagnostic-card-producer.off` exists at the
repository root or in the producer state directory.

## What becomes a card

Only queue states `repair-candidate` and `regressed` can mint or reopen a
card, and only after the current pass revalidates the issue key against the
closed identity. Expected absence, source-policy limitation, failed
collection, and unproven causal stories do not become cards and do not report
zero outstanding findings.

Two identical runs keep one card. A changed last-seen value updates evidence
on that lineage. An existing active or implemented engineering record is
linked instead of proposing a duplicate. Human edits to title, story, and
acceptance are preserved; the producer only refreshes managed evidence.

A resolved finding closes only after a fresh successful check. Recurrence
reopens the same lineage.

## Generated proposal contract

Generated proposals are operator engineering cards. They must pass
`tools/diagnostic_card_fitness.py` before they are written.

<p id="repair-card-contract">Every generated repair card uses this page as its spec anchor and names a runnable verify command from the owning repository, never a local-machine path.</p>
