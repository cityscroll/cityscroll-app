# Pre-registration: which solicitation fields are reachable without sign-in

Workstream: procurement pursuit decision surface. Card: PPD-07, lane
`access_feasibility`.

Written **before the classification was produced**. Its content hash is
recorded in `site/procurement_research_lanes.json` by
`node tools/procurement_research_lane_gates.mjs --register access_feasibility`,
so a later edit to this file is detectable. The lane may not begin until
`node tools/procurement_research_lane_gates.mjs --check` passes, which requires
every one of cards PPD-01 through PPD-06 to carry its own evidence first.

## Question

For each solicitation field a vendor needs in order to decide whether to
pursue a matter: is that field reachable from public records without signing
in to a publisher's system, and does the answer hold across agencies?

## Method, and its hard boundaries

The classification reads **only** records already committed to this
repository: the committed procurement read model, the committed browse
projection, the committed source-contract register, the committed attachment
metadata, and the workstream's committed fixture ledger.

- No live retrieval of any kind. No HTTP request, no browser, no headless
  client.
- No scraping. Nothing is parsed out of a remote page.
- No credential automation. No sign-in is attempted, scripted, stored, or
  simulated, for any publisher, by any part of this lane.

Where the committed corpus cannot answer the question for a field, the answer
is `unstable` with the reason stated. Reaching for the network to convert an
`unstable` into a firmer class is out of scope for this lane by construction,
not by oversight.

## Classes, and the exact rule for each

Every examined field gets exactly one class, from a fixed vocabulary:

- **`accessible`** — a public source contract in the committed register
  declares the field, and it is observed on at least 200 committed records
  spanning at least 10 distinct agencies, at a presence rate of at least 30%
  within the records of the source that declares it. The 30% figure is this
  repository's own existing usefulness threshold for source joins, reused here
  rather than reinvented.
- **`authenticated`** — a committed measurement or the shipped product's own
  disclosure register records that the field's content is reachable only after
  signing in to the publisher's system.
- **`unavailable`** — no source contract in the committed register declares the
  field, and no committed observation carries it. This class states what the
  public sources this repository observes actually carry. It is not a claim
  that a publisher withholds the field.
- **`unstable`** — a source contract declares the field, but the committed
  sample is below the thresholds above, or the source's own measured coverage
  sits below this repository's usefulness threshold, or the source is disabled
  for product reads. This class means "the committed record cannot tell", not
  "the field is absent".

## Exact fields examined

Solicitation title; publishing agency; solicitation identifier (PIN or EPIN);
procurement method; published amount; official notice pointer; response due
date; solicitation release date; published contact; pre-bid or pre-proposal
conference; certification goal marker; solicitation package documents; question
and answer content; amendment documents; published bid results.

## Data vintage

The observation vintage is the `generated_at` stamp carried by the committed
procurement read model and browse projection that the classification reads,
recorded in the output file itself. The classification is a statement about
that vintage and no other. It is not refreshed, extended, or topped up from any
live source.

## Exclusion rules

1. A record with no agency label is counted in the corpus total and excluded
   from every per-agency count, rather than being assigned to a placeholder
   agency.
2. An empty string, a whitespace-only string, and a null are all "not
   observed"; none of them is counted as a value.
3. A field observed on fewer than 200 records, or across fewer than 10
   agencies, may not be classed `accessible` regardless of its presence rate.
4. No field is classed by inspection of a single fixture. A fixture may
   illustrate a class; it may not establish one.

<!-- forbidden-claims-vocabulary:start -->
## Statements this lane is forbidden to make

The same limits the sibling lane carries apply here, in the same words: no
causation, no favoritism, no irregularity, no illegality, and no claim about
bidder counts. In addition, this lane may not state or imply that a publisher
deliberately restricts a field. An `authenticated` or `unavailable` class is a
statement about what this repository can observe from public records, and
never a characterization of a publisher's intent.
<!-- forbidden-claims-vocabulary:end -->

## What the handoff must say

Where a field is `authenticated` or `unavailable`, the product's existing
handoff to the source portal must say so plainly: what requires signing in,
and when this repository last observed the matter. The last-observed date comes
from the record being displayed. It is never read from the clock, because a
clock reading would tell a vendor that a stale record is fresh.
