# A78-05: backtesting litigation with filing and durable relief scored separately

A78-01 (`docs/article78-litigation-ontology-v1.md`) made the bounded court
search and the case outcome stored records. A78-02
(`docs/article78-historical-fixture-v1.md`) added thirteen documented projects
as a QA-only regression fixture. A78-03 (`docs/article78-search-coverage-v1.md`)
graded how well each determination was actually searched and decided which ones
may contribute a negative at all. A78-04
(`docs/article78-challenge-watch-v1.md`) derived a cutoff-aware challenge watch
over each determination.

A78-05 turns those into a **comparable number**: change a challenge-watch
feature and the backtest says which way the change moved things, and by how
much. Before this card there was no such number, so a regression could land
without anything failing.

It adds no new record shape and fetches nothing. `backtestLitigation`
(`warehouse/lib/article78_backtest.mjs`) reads A78-02's fixture, A78-03's
admission rule, A78-04's watch, and A78-01's decision supersession, and it runs
inside the existing `npm run warehouse:article78:backtest` command rather than
as a second backtest tool.

## Two heads, never one number

Detecting that somebody filed is easy: a challenge leaves a docket entry, and
the recorded search either found it or did not. Saying whether the petitioner
ended up with relief they kept is hard, and it is the part a resident actually
cares about.

Blend the two into one figure and the easy half carries the hard half. Strong
filing detection would hide weak relief calibration, and nobody could see which
half moved when a feature changed. So there are two heads, they are scored over
their own units against their own thresholds, and nothing adds them together:

| head | question | unit |
| --- | --- | --- |
| `filing` | did the recorded search locate a genuine challenge to this determination? | one row per located case candidate, plus one row per eligible determination whose search located no candidate |
| `durable_relief` | did the petitioner obtain durable relief that survived supersession? | one row per genuine located challenge, plus one row per eligible determination with no genuine challenge on the record |

Scoring the filing head per *candidate* is what makes a mis-attributed search
result a false positive rather than a row nobody counted. Scoring the relief
head over unchallenged determinations as well as litigated ones is what stops
it conditioning on the filing outcome: a relief diagnostic computed only over
cases that were brought can say nothing about the determinations that were not.

Both heads predict from the same evidence — A78-04's watch level at the unit's
cutoff — and differ only in the threshold each applies. The thresholds are one
object, `ARTICLE78_BACKTEST_POLICY.heads[*].predicted_positive_levels`:

| head | predicted positive at | why |
| --- | --- | --- |
| `filing` | `baseline`, `elevated`, `high` | an established watch means the determination is final, adequately searched and inside a challenge window; on this fixture that is enough to expect a filing, and the head's own false-positive count is what makes the permissiveness visible |
| `durable_relief` | `elevated`, `high` | strictly stricter; relief is rare, and a threshold that fired on every established watch would report the filing head's recall a second time under another name |

`assertHeadsScoredSeparately` refuses any emitted field name that reads like a
combined figure, using A78-01's own `assertNoCombinedOutcomeScore` scanner
rather than a second list.

## Which relief states count as durable

A78-01 records six relief states and this head asks a binary question, so the
mapping is stated rather than assumed. `DURABLE_RELIEF_STATES` is `annulment`,
`declaratory_relief`, `injunctive_relief` and `relief_by_stipulation`.

Two states are listed with their reason in
`ARTICLE78_BACKTEST_POLICY.relief_states_not_scored_durable` rather than
quietly omitted:

- `none` — the effective decision granted the petitioner nothing.
- `remand_for_further_agency_action` — A78-01 records a remand as real relief,
  and this head still does not score it as *durable*: a remand returns the
  matter to the agency for a determination that has not been made, so what the
  petitioner ends up keeping is not yet on the record. This is a scoring
  choice, not a re-reading of the ontology, and a later card that disagrees
  should move it in that object rather than in a conditional.

A case with no decision recorded is scored as no durable relief obtained on the
record, not censored: the censored class is about what the *cutoff* could not
settle, and this is a recorded state at the cutoff.
`ARTICLE78_BACKTEST_POLICY.undecided_case_outcome` names that choice in the
same object, because it is arguable.

## The censoring rule

A determination whose limitations window is still open has not produced a
negative. It has produced a not-yet. Counting those as true negatives is the
easiest way to manufacture a specificity number out of nothing, so a censored
row is a class of its own, is never counted in any confusion cell, and carries
the reason it was censored.

| reason | when |
| --- | --- |
| `determination_not_final_at_cutoff` | the determination was not final and binding at the cutoff, so no challenge window had opened |
| `open_limitations_window` | the window had not closed at the cutoff and no challenge is on the record, so "nobody filed" is not yet a fact |
| `pending_appeal` | the record does not resolve which decision is effective for this case |

An observed event is checked before the window: a determination with a
challenge on the record is settled in that direction whatever the window is
doing.

Censoring is not the same as exclusion. A determination whose court-record
search grades C or U under A78-03 never enters either head **in either
direction** — it is reported under `excluded_determinations` with its grade,
because a determination nobody could adequately search is not a negative and is
not a not-yet either.

`assertCensoredRowsAreNotNegatives` checks the rule on the report rather than
trusting the scorer: a censored row counted in a cell is refused by name, a
censored row with no reason is refused, and the five classes must add back up
to the rows the head produced, so a dropped row cannot become a negative.

## The cutoff policy

A backtest with an implicit cutoff has already leaked. Every unit's cutoff comes
from a named policy, and the source travels on every row.

| policy | cutoff |
| --- | --- |
| `determination_final` (default) | the day the determination became final and binding — the earliest moment a watch could be acted on, and the day the limitations window opens |
| `observation_close` | the last recorded search behind the determination (A78-01's own `as_of`) |
| `explicit` | every cutoff is supplied by the caller |

`cutoffs` may accompany any policy and overrides it for the determinations it
names. A later cutoff sees more evidence and can only settle more rows; it can
never settle fewer.

## The seed diagnostic

`ARTICLE78_BACKTEST_SEED_DIAGNOSTIC` is what A78-02's thirteen documented
projects produce under the default cutoff policy. It is both the expected
receipt and the test oracle, carried as data in one place so the two cannot
drift apart, and it is checked with no tolerance:
`npm run warehouse:article78:backtest` exits non-zero when it is not reproduced
exactly.

| head | true positive | false positive | false negative | true negative | censored |
| --- | --- | --- | --- | --- | --- |
| `filing` | 10 | 1 | 0 | 0 | 2 |
| `durable_relief` | 1 | 3 | 0 | 6 | 3 |

Three determinations are excluded from both heads because their court-record
search grades C or U.

Reading it:

- The filing head's single **false positive** is the deliberate one A78-02
  built in: a case the recorded search returned for one determination that in
  fact challenges another. It is retained and explained rather than cleaned up,
  because a detection diagnostic with no false positive in it is not measuring
  detection. Keeping the two heads apart is what makes it informative — under a
  blended score it would just be noise around a good-looking total.
- The filing head has **no true negatives at all** under this policy, and that
  is the honest reading rather than a gap. At the moment each determination
  became final, "nobody filed" was not yet a fact anywhere, so both candidate
  negatives are censored instead. This fixture cannot measure filing
  specificity, and the censored count is where it says so.
- The relief head's **three false positives against one true positive** is the
  weak calibration this card exists to keep visible. The determinations whose
  watch reached `elevated` or `high` were genuinely litigated; the petitioners
  mostly obtained nothing durable.

## The negative rule

- A fixture diagnostic is never reported as population performance. The
  thirteen projects were selected for being interesting, so every count here
  describes that selection. Each one leaves the module through A78-02's
  `diagnosticMetric` (`diagnostic_only: true`), the receipt section says so in
  a sentence, and `assertAllMetricsDiagnostic` checks it rather than assuming.
- Filing and durable relief are never blended into one score.
- A censored row is never a true negative.
- Nothing here fetches anything or reads a clock. The same fixture and the same
  policy always produce the same report.
- If the fixture and the seed diagnostic ever disagree, neither is adjusted to
  close the gap: the command fails, names each differing count, and the
  disagreement is decided rather than absorbed.

## Where it runs

| | |
| --- | --- |
| module | `warehouse/lib/article78_backtest.mjs` |
| command | `npm run warehouse:article78:backtest` (`tools/backtest_article78_ontology.mjs`) |
| receipt section | `litigation_backtest` |
| tests | `test/warehouse_article78_backtest.test.mjs` |

The receipt section is checked live against the seed diagnostic rather than
byte-compared against a committed golden file, for the same reason A78-02's
expectation section is: its oracle already exists as data, and a second copy
would only be somewhere for the same numbers to drift apart.
