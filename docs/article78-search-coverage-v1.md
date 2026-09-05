# A78-03: grading court-search coverage, so only searched negatives count

A78-01 (`docs/article78-litigation-ontology-v1.md`) made the bounded court
search a stored record instead of a footnote, so a challenge-watch value of
zero has to name the search behind it. A78-02
(`docs/article78-historical-fixture-v1.md`) added thirteen documented projects
as a QA-only regression fixture. A78-03 adds the missing half: a **grade** for
how well each determination was actually searched, and an admission rule that
keeps inadequately searched determinations out of the denominator instead of
quietly counting them as negatives.

This card adds no new record shape. The bounded-search detail it grades on
lives on A78-01's existing `search_coverage` record, extended additively.

## Why a denominator is a claim about coverage

"Three of two hundred land-use approvals were challenged" is a statement about
two hundred determinations, not three. It is true only if somebody looked for
a challenge to the other hundred and ninety-seven — in a system that could
have shown one, under identifiers that would have matched it, over a window
long enough to contain the filing. Nothing in a court record says whether that
happened.

Without a grade, an unsearched determination and an unchallenged one produce
the same zero, and a prevalence computed over the mixture is unfalsifiable: no
observation can move it, because the population it is drawn over is not
defined. Grading each bounded search, admitting only well-covered negatives,
and reporting the excluded remainder turns that unfalsifiable number into a
measurable one over a defensible eligible population — with the part nobody
can speak to still visible rather than absorbed.

## The negative rule: published opinions are not a filing denominator

The freely accessible source is the published Official Reports, and it is
incomplete as a filing denominator **by construction**. An opinion exists only
where a court wrote one. A proceeding that settled, was withdrawn, was
discontinued, or was decided from the bench leaves no published opinion at
all. So the absence of an opinion is evidence about publication, and never
about filing.

Three rules follow, and all three are enforced in code rather than described
here:

- grade A requires a **docket** search as well as an opinion search
  (`has_docket_system`), so an opinion-only search can never reach the top
  rung however good its identifiers and horizon;
- an unsearched determination is never admitted as a negative example
  (`admitNegatives`), and a determination whose only receipts are themselves
  recorded unusable is treated exactly like one nobody searched;
- nothing here fetches. Receipts describe searches somebody already ran and
  wrote down. There is no client, no endpoint, no credential and no scraper in
  this layer, and a test asserts as much over the module's own source.

## The grades

`gradeCoverage({ determination, receipts })`
(`warehouse/lib/article78_search_coverage.mjs`) returns the grade together
with everything that produced it: `receipts_considered`, `identifiers_used`,
`horizon`, `systems_searched`, `variants_tried`,
`docket_details_unavailable`, and the `reasons`. Every rule that was tried
appears in `reasons`, with the predicates that carried or sank it, so a reader
can see that A was missed for want of an opinion search rather than guess.

| Grade | What it means |
| --- | --- |
| **A** | A docket search **and** an opinion search, under adequate identifiers, over the limitations window plus the documented margin |
| **B** | Multiple systems searched with some docket detail visible, **or** adequate identifiers over a shorter horizon |
| **C** | A search is on file, but it is a single system, or its identifiers are name-only, or its horizon is truncated |
| **U** | No usable search of this determination is on file: either no receipt names it, or every receipt that does is itself recorded unusable |

**Adequate identifiers** means an index number, which names one proceeding, or
a determination identifier together with an exact party name, which is the
same strength assembled from two halves. A name on its own is not adequate:
agencies, developers and community groups recur across unrelated proceedings,
and abbreviations collide.

**An adequate horizon** means the searched windows contiguously span the whole
limitations window and run at least **28 days** past its close. That margin is
documented rather than arbitrary: four weeks absorbs docketing lag, because a
petition filed on the last day of the window does not appear in a docket index
the same day, and a search that stopped at the close would miss it and still
look complete. Separate searches with a gap between them do not cover the gap
— `mergeSearchedIntervals` merges only contiguous windows, so taking the outer
bounds of a set of searches can never overstate what was looked at.

Every threshold above lives in one exported object, `COVERAGE_GRADE_POLICY`,
as data. The predicate implementations sit beside it in code, because a
threshold is a policy choice and a comparison is not; a test asserts that no
predicate compares against a numeric literal of its own.

Grading is deterministic. It reads no clock, sorts every list it returns, and
depends on nothing but the determination context and the receipts handed to
it. The same receipts always produce the same grade.

## What a bounded-search receipt records

A78-01's `search_coverage` record gains three fields, all optional so that
every receipt written against the original contract still validates unchanged:

- **`systems_searched`** — a closed vocabulary of `official_reports`,
  `nyscef` and `webcivil_supreme`, plus `other` carrying a required free-text
  `label`. Naming a system is a record of what a person searched; it is not a
  capability. No system here has a documented source contract in
  `site/data/source_contracts.json`, and none of this code knows how to query
  any of them.
- **`variants_tried`** — the identifier and name variants the search was
  actually run under (`index_number`, `determination_identifier`,
  `party_name`, `party_name_abbreviation`,
  `party_name_alternate_spelling`, `caption_fragment`), each with the value
  that was typed in.
- **`docket_details_unavailable`** — which docket fields the source did not
  expose, so that "the search found nothing" stops looking the same as "the
  search could not see filing dates at all".

`assertBoundedSearchReceipts` holds a receipt to that standard where A78-01's
validator, being additive, cannot. A receipt that records none of it can still
be stored; it simply cannot support a grade above C.

## The admission rule and the denominator

`admitNegatives(determinations)` admits only grade A and B negatives into
internal challenge evaluation. Grade C and U determinations come back under
`excluded`, by grade, with the reasons that put them there — they are neither
dropped nor counted as negatives, because the **size of the excluded
remainder is itself the measurement**. A prevalence over ninety admitted
determinations with a hundred and ten excluded is a very different claim from
the same prevalence over two hundred, and carrying the remainder is the only
way to tell them apart.

`eligibleDenominator(determinations)` derives the eligible count from those
recorded grades and reports the remainder by grade. There is deliberately no
way to pass a total in: a denominator asserted from outside — "there were two
hundred approvals that year" — silently readmits every determination nobody
searched, which is the failure this card exists to prevent.
`assertDerivedDenominator` is the callable form of the arithmetic that has to
hold: eligible plus excluded equals examined, or the number is an asserted
total wearing a derivation's clothes.

Admission is not the same as counting. A grade B determination is admitted
into evaluation and may still come back "not established" — A78-01's own
adequacy checks still apply per receipt, and a search that ran before the
limitations window closed still produces `null` rather than a zero.

## How it reaches A78-01

A78-01 does not import A78-03; the grade travels across the seam as a value.
`challengeWatchValue` takes an optional `coverageGrade`, names it on every
result under `basis.coverage_grade`, and refuses to produce a number under a
grade outside its countable set — so a C or U determination yields `null`
whatever any single receipt claims for itself. `coverageGradeFor` on this side
derives the value to pass. When no grade is supplied, `challengeWatchValue`
rolls the stored per-receipt grades up with the same rule
(`rollUpCoverageGrade`), so the two agree by construction.

## Running it

```bash
npm run warehouse:article78:backtest
node --test test/warehouse_article78_search_coverage.test.mjs \
  test/warehouse_article78_litigation.test.mjs \
  test/warehouse_article78_historical_fixture.test.mjs
```

The backtest receipt carries a `coverage` section: a grade per determination
with the reasons behind it, the admission split, and the eligible denominator
with its excluded remainder. Every number in that section is wrapped by
A78-02's `diagnosticMetric` and marked `diagnostic_only`. That is not
decoration — these counts are computed over a small synthetic fixture, and an
eligible-determination count escaping the receipt unmarked would read as a
statement about how often land-use approvals are searched, which it is not and
can never be.

The thirteen-project historical fixture carries a coverage receipt per project
and exercises the whole ladder: nine grade A, one B (250 Water Street — two
docket systems searched with docket detail visible, but no opinion search and
a horizon that stops two months before the window closes), two C (single
system, agency abbreviation for an identifier, truncated horizon), and one U
(Mott Haven Educational Campus, whose only receipt consulted published
opinions alone and is itself recorded unusable). Four of those are pinned as
`coverage_grade` expectations in the fixture index, so the gate fails if the
ladder shifts under them.
