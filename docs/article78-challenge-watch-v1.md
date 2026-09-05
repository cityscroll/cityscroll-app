# A78-04: cutoff-aware challenge-watch signals that never stand on a statement alone

A78-01 (`docs/article78-litigation-ontology-v1.md`) made the bounded court
search a stored record. A78-02 (`docs/article78-historical-fixture-v1.md`)
added thirteen documented projects as a QA-only regression fixture. A78-03
(`docs/article78-search-coverage-v1.md`) graded how well each determination was
actually searched. A78-04 adds the first watch feature built on top of them: a
**challenge watch** over one determination, derived as of an explicit cutoff
from evidence that was public by that date.

It adds no new record shape. It reads A78-01's determination context and
search-coverage receipts, A78-03's grade, and the environmental-review
ontology's own `review_event`, `government_action` and `public_position`
vocabulary.

## Why the most available signal is the least useful one

The easiest thing to know about an environmental review is whether it produced
an environmental impact statement. It is also the thing that separates least.
Large projects routinely produce one and are never challenged: the document
records how big and complicated the action is, not whether anybody disputed it.
A watch that fires on document class reproduces the list of conspicuous
projects a reader could already have written down, and calls it a signal.

So the rule this card is built around is a refusal, expressed as data in
`CHALLENGE_WATCH_POLICY` rather than as scattered conditionals:

- a watch may reach `high` only when it rests on a **specific preserved issue**
  or a **named participant**, plus at least one further recorded feature;
- an environmental impact statement or positive declaration can never carry a
  watch above `baseline` — alone, or together with any other feature that
  merely describes how large the action is;
- both halves are asserted on the *result* by `assertChallengeWatchSignal`, not
  only while deriving it, so a future caller that assembles a result by hand
  cannot get past the ceiling either.

## The levels

`deriveChallengeWatch({ determination, review, positions, signals, coverage, as_of })`
(`warehouse/lib/article78_challenge_watch.mjs`) returns
`{ level, features, basis, as_of, label }`.

| level | what it means |
| --- | --- |
| `high` | a specific preserved issue or a named participant is on the public record, together with at least one further recorded feature |
| `elevated` | recorded evidence beyond the size and document class of the review |
| `baseline` | nothing on the record beyond the size and document class of the review |
| `"null"` | the watch may not speak about this determination at all |

`"null"` is a level rather than a missing field, so a consumer switching on
`level` handles it like any other and a `null_reason` says which of the three
refusals applied: the court-search coverage grades C or U (A78-03), the
determination was not final and binding as of the cutoff, or nobody recorded
whether it ever became final.

## The features

Each feature is a record, not a bare boolean: it carries its `present` flag,
its value, the **public date** of the evidence that established it, the
evidence references themselves, the only wording a consumer may render for it,
and a rival explanation for what else could have produced it.

| feature | established by | anchors a `high` watch? |
| --- | --- | --- |
| `document_class` | `review_event` rows: a positive declaration or a published statement | never — this is the ceiling rule |
| `organized_opposition` | a public position of `oppose` from a resolved, named organization | yes |
| `preserved_issue` | an issue named and reaffirmed across two dates (SEQRA-07 issue preservation), or a record naming a specific preserved issue | yes |
| `adverse_public_body_signal` | a recorded adverse signal, or an `oppose` position from a community board, elected office or agency | no |
| `multiple_discretionary_actions` | two or more discretionary approvals the action required | never — conspicuousness only |
| `sensitive_receptor` | a recorded sensitive receptor near the action | no |
| `prior_administrative_challenge` | an earlier administrative challenge on the record | no |
| `labor_organization_participation` | a public position of `oppose` from a resolved labor organization | yes |

A position with no resolved `organization` decoration contributes to issue
preservation but never to a named-participant feature, because the feature is
about a *named* participant. Both named-participant features apply the same
stance test — a recorded `oppose` — so an organization on the record in
support is a participant but not filing-watch evidence. Treating any union
appearance as adverse is exactly the reading the labor rule below exists to
prevent.

Issue preservation is computed through SEQRA-07's `computeIssuePreservation`
(`warehouse/lib/seqra_issue_coalition_signals.mjs`) rather than a second
implementation of the same rule, and it stays stance-neutral as that signal
defines it: it measures what was formally raised and reaffirmed, not who was
against the action.

## Cutoff discipline

Every derivation takes an explicit `as_of`; there is no default and no clock,
so the same inputs always produce the same object. Within it:

- every feature carries the public date of the evidence that established it,
  and `assertChallengeWatchSignal` refuses a present feature that cites
  evidence with no public date;
- evidence published after the cutoff is **excluded and reported**: each
  exclusion appears in `basis` as an `excluded_evidence` entry naming the
  channel, the reason, the count and the record ids;
- undated evidence is excluded on exactly the same footing as evidence
  published too late. A record that never says when it became public cannot
  support a claim about what was knowable on a given day;
- moving the cutoff earlier can only lower the level or null it. That is a
  property of the rules, not a convention: the feature set is monotone in the
  cutoff, the document class takes the strongest class any admitted event
  established rather than the latest, and the level ladder is monotone in the
  feature set. Two tests assert it by sweeping cutoffs forward — one over
  synthetic inputs, one over the documented fixture.

One thing is deliberately **not** cutoff-filtered: the A78-03 coverage grade.
The cutoff governs what the watch is allowed to *know*; the grade governs
whether it is allowed to *speak at all*. A grade is a property of the
observation program behind a determination, not of the world as of a date, and
a watch over a determination nobody could adequately search is unfalsifiable
however good its features look.

## The labor rule

A labor organization on the public record is a named participant and nothing
more. Its participation raises filing-watch evidence exactly the way an
advocacy group's does — a test asserts that swapping the organization type
between `labor_organization` and `advocacy_group` produces the identical level
— and it carries, as a field on the feature record rather than as a convention
somebody has to remember:

    suppression: "no motive, misconduct, or legal-viability inference"

`LABOR_PARTICIPATION_SUPPRESSION_RULE` spells the same rule out in a sentence
for a surface with room for one, and extends it to developer and community
participation. Every wording a consumer is given is a constant in this module,
and a test asserts that none of them contains "motive", "misconduct", "bad
faith", "meritless" or "frivolous" — so a consumer looking at a `true` cannot
render a motive claim from it without writing the sentence itself, which is the
failure this rule exists to prevent.

The City Point fixture case is the worked example: a wage-framed
environmental-review theory that in fact obtained no relief, raised alongside a
neighborhood group's preserved objection. The watch is `high` because a
specific issue was named and reaffirmed and two organizations are named on the
record; the recorded case outcome says separately that the theory obtained
nothing. Neither statement is evidence for the other.

## Labelling

The output is a **challenge watch**. `CHALLENGE_WATCH_LABEL` is the only name
it has, it appears on every result object and inside every level wording, and
`assertChallengeWatchSignal` refuses a result labelled anything else.

The register this is not allowed to drift into lives in
`FORBIDDEN_CHALLENGE_WATCH_PREDICTION_WORDINGS` — sentences that turn recorded
process evidence into a forecast about what a court will do.
`assertNoChallengeWatchPredictionWording` refuses any rendering containing one,
`renderChallengeWatchLevel` asserts its own output before returning it, and a
lint test scans every A78 module, tool, document, fixture and test for the
whole list, exempting only the frozen array that declares it.

The Bronx Metro-North fixture case is the boundary this labelling protects: a
full statement covering four bundled discretionary approvals, with nothing on
the record naming a preserved issue or a participant. Its own recorded search
grades C, so the honest answer there is `"null"`; the fixture states an
admissible grade as an explicit premise on a second expectation so the feature
rules themselves are exercised, and the answer is `baseline`.

## How it reaches the rest of the workstream

A78-01's `challengeWatchValue` counts challenges a recorded search actually
located after the fact. This is the forward-looking companion: a watch over
evidence public by a cutoff. The two share the coverage grade and nothing else,
and they are deliberately separate schemas —
`cityscroll.article78_challenge_watch.v1` for the count,
`cityscroll.article78_challenge_watch_signal.v1` for the watch — so a consumer
can never mistake one for the other.

## Running it

    npm run warehouse:article78:backtest
    node --test test/warehouse_article78_challenge_watch.test.mjs

The backtest prints a `diagnostic_only` challenge-watch section: every watch
derived over the fixture projects that carry documented inputs, with the
features that produced it and the evidence its cutoff excluded. Those levels
are computed over a hand-picked sample of newsworthy projects; a distribution
read off them would report the selection and nothing else. The section also
re-enforces the ceiling and the labelling over its own output rather than
trusting the module that produced it.
