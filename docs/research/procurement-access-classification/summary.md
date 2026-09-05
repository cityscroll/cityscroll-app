# Access classification: which solicitation fields are reachable without sign-in

Card PPD-07, research lane `access_feasibility`. Method, thresholds, exclusion
rules, and the exact definition of each class are pre-registered in
[preregistration.md](preregistration.md); the machine-readable result, with
per-field and per-agency counts, is [classification.json](classification.json).
This page is a reading of that file and adds nothing to it.

## What was examined, and what was not

Committed records only: 13,791 procurement records spanning 101 agencies, plus
27,670 committed source observations, the committed source-contract register,
and the committed attachment metadata. Observation vintage: the committed
browse projection and read model are stamped `2026-08-18T04:05:51.552Z`; the
committed attachment metadata is stamped `2026-08-09T01:41:39.752Z`.

No live retrieval, no scraping, and no credential automation is part of this
lane. Nothing here signs in to anything, and no tool in this card takes a URL
argument. Where the committed corpus cannot answer the question for a field,
the answer is `unstable` with the shortfall stated, rather than a firmer answer
bought by reaching for a network.

## Result

| Field | Label | Class | Observed / examined | Agencies |
| --- | --- | --- | --- | --- |
| `solicitation_title` | Solicitation title | accessible | 13791 / 13791 | 101 |
| `publishing_agency` | Publishing agency | accessible | 13790 / 13791 | 101 |
| `solicitation_identifier` | Solicitation identifier (PIN or EPIN) | accessible | 13786 / 13791 | 98 |
| `procurement_method` | Procurement method | accessible | 12770 / 13791 | 65 |
| `published_amount` | Published amount | accessible | 13788 / 13791 | 100 |
| `official_notice_pointer` | Official notice pointer | accessible | 12899 / 13791 | 44 |
| `response_due_date` | Response due date | unstable | 3 / 27670 | 2 |
| `solicitation_release_date` | Solicitation release date | unstable | 2 / 27670 | 2 |
| `published_contact` | Published contact | unstable | 0 / 27670 | 0 |
| `pre_bid_conference` | Pre-bid or pre-proposal conference | unstable | 0 / 27670 | 0 |
| `certification_goal_marker` | Certification goal marker | unstable | 0 / 27670 | 0 |
| `solicitation_package_documents` | Solicitation package documents | authenticated | 8 / 13791 | 0 |
| `qa_content` | Question and answer content | authenticated | 0 / 27670 | 0 |
| `amendment_documents` | Amendment documents | unavailable | 0 / 27670 | 0 |
| `published_bid_results` | Published bid results | unstable | 1 / 1 | 0 |

Totals: 6 accessible, 2 authenticated, 1 unavailable, 6 unstable, across 15
examined fields.

## Reading the result

**The identity layer is reachable; the pursuit layer largely is not.** Every
field that identifies a matter -- title, agency, identifier, method, a
published amount, and a pointer back to the official notice -- is observed
across a broad cross-agency sample. Every field a vendor actually needs in
order to prepare a response -- the package, the question-and-answer content,
the amendments -- is not.

**`authenticated` and `unavailable` are different disappointments.** The
solicitation package and the question-and-answer content sit behind a portal
sign-in: the publisher has them, and a vendor can get them by signing in. That
is worth saying plainly in the handoff, because it turns a dead end into a next
step. Amendment documents are carried by no public source this product observes
at all; no sign-in reaches them either.

**`unstable` is a statement about this repository, not about the publisher.**
Six fields -- the response due date, the release date, a published contact, a
pre-bid conference, and a certification goal marker among them -- are declared
by a source contract or resolved by a shipped surface, but the committed corpus
is award-weighted and trims its notice snapshots to a handful of identity
columns. The honest answer is that the committed record cannot tell. It is not
that the field is absent from the publisher, and the classification says so in
each field's own `basis`.

**Published bid results stay out of reach at this vintage.** The historical
tabulation source is disabled for product reads, its strict joins reach 9.07%
of the historical overlap window and 0% of records since 2025, and the one
committed authority-native observation is a single record. The class is
`unstable`, and no part of this card stands up a replacement source.

## What the product does with this

`site/procurement_handoff_copy.mjs` turns the `authenticated` and `unavailable`
rows of the classification file into the line the procurement detail handoff
shows beneath the official records: what requires signing in, or what no public
source carries, plus when this product last observed the matter. That date is
read from the record being displayed and never from the clock -- a clock
reading would tell a vendor that a stale record is fresh. Fields classed
`accessible` or `unstable` produce no line at all; putting a research
limitation in front of a vendor as a fact about their opportunity is the
failure this copy exists to avoid.
