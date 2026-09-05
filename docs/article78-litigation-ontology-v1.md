# Article 78 litigation, search coverage and decision supersession (A78-01)

This is the first card of the environmental review foundation's litigation
layer. Before it, a case, its filings, its claim theories and the search that
located it were undifferentiated: there was no entity for a proceeding, no
entity for the search that found one, and no way to represent a trial decision
later reversed on appeal. The card adds the record contracts, the validators,
and the two derivations that make a litigation number readable — a
challenge-watch value that resolves to the search behind it, and an effective
decision that follows explicit supersession edges.

It adds no route, no resident-facing surface and no prediction. It states what
a court record says and what a recorded search looked for, and nothing else.

## The two failures this card exists to prevent

**A negative label in litigation data is a claim about search effort.** "Zero
challenges" is never a fact about the world; it is a fact about a search. A
docket query that covered the wrong county, stopped a month short of the
limitations window, or filtered on the wrong respondent returns the same zero
as a determination nobody ever sued over, and nothing downstream can tell the
two apart. So `search_coverage` is a stored entity here, with its whole bounded
scope on the record — courts, date window, party filters, determination
filters, result count and the instant it ran — and `challengeWatchValue`
refuses to return a number that is not attached to one.

**A decision can be undone.** A trial-level annulment reversed on appeal is not
a durable win. A store that overwrites the trial decision in place, or that
reports the most recent decision by date, cannot say so. Supersession is
therefore an explicit edge carrying the procedural posture the later decision
arrived on, and `applyDecisionSupersession` resolves the effective decision by
following those edges and nothing else.

## Five record contracts

| Record | Stable key | What it holds |
| --- | --- | --- |
| `judicial_case` | `judicial_case:{court}:{index_number_or_hash}` | One Article 78 or hybrid proceeding challenging a determination, plus the search that located it |
| `case_filing` | `case_filing:{case_key}:{filing_type}:{filed_date}:{source_hash_prefix}` | One filing; decisions and orders additionally carry the case outcome |
| `claim_theory` | `claim_theory:{case_key}:{theory_category}:{claim_hash_prefix}` | One legal theory raised, kept separate from what was won |
| `search_coverage` | `search_coverage:{source}:{query_hash}:{searched_at}` | One bounded court-record search and everything it did and did not cover |
| `decision_supersession` | `decision_supersession:{superseding_decision_key}:{superseded_decision_key}` | An explicit edge from a later decision to the earlier one it disposed of |

These extend SEQRA-02's vocabulary rather than running beside it. The key
builders reuse `warehouse/lib/seqra_stable_keys.mjs`'s token normalization, so
a court name normalizes here the way an agency name does there; the filing
types and claim categories are SEQRA-02's enums unchanged; and
`projectToOntologyEntities` projects these records down onto SEQRA-02's frozen
`judicial_case` / `case_filing` / `claim_theory` / `search_coverage` entity
shapes, so the relation graph is validated with
`warehouse/lib/seqra_ontology_graph.mjs` against them rather than beside them.
The projection is lossy by design: SEQRA-02's entities carry identity and
relationship shape, and the fields this card adds stay in this card.

A determination's finality is carried in a sixth, non-entity contract. SEQRA-02's
`land_use_determination` records what the agency decided; it does not record
when that decision became **final and binding upon the petitioner**, which is
the date every Article 78 limitations question turns on. That observation
travels as a `determination_context` alongside the frozen entity rather than
bolted onto it.

### The search key is a function of the search

`hashSearchQuery` hashes the normalized scope, and the coverage key embeds that
digest. Three consequences follow, all of them wanted:

* re-running the identical query on a later day produces a new record with the
  same query hash and a different `searched_at`, so the history of looking is
  itself legible;
* widening the courts or the window produces a **different** query rather than
  silently overwriting the narrower search it replaced;
* a record whose scope no longer matches its own key is a validation finding.
  A search whose key does not follow from its own bounds cannot be reproduced,
  and an irreproducible search is not evidence.

`result_count` is the raw hit count, and is never the challenge count: a docket
search over a four-month window returns unrelated proceedings. What was
actually matched to the determination is `located_case_keys`, and the validator
refuses a record whose located cases outnumber its results.

## The challenge-watch derivation

`challengeWatchValue({ determination, cases, coverage })` returns
`{ value, basis }`.

`value` is **null**, never zero, whenever no honest count can be made:

| Reason | Meaning |
| --- | --- |
| `determination_not_final` | the determination is not recorded as final and binding, so the challenge window has not opened |
| `determination_finality_unknown` | nobody has recorded whether it became final and binding — a different fact from "it did not", and given its own reason rather than folded into the one above |
| `limitations_window_open` | the searches on file ran before the window closed, so a later petition would not be in them |
| `no_recorded_search` / `recorded_search_does_not_cover_this_determination` | no adequate search covers this determination |

A **zero** means something narrower and stronger: an adequate search ran, its
bounds are on file, and it found nothing. `basis` names the coverage records the
value rests on, so a consumer that renders the number can render what produced
it. `assertChallengeWatchResult` is the callable form of that rule — a counted
value whose basis names no coverage record raises rather than returning, which
is why "a zero with no coverage record" cannot exist in this module.

Adequacy is three separate questions, answered separately so a caller can say
which one failed: does the search name or filter on this determination, is its
coverage grade one of the countable grades (`A`/`B`, reusing SEQRA-02's
`A`/`B`/`C`/`U` ladder), and does its declared date window span the whole
limitations window. A fourth, separate check compares `searched_at` against the
close of the window — a search whose declared scope covers the window but which
ran three months before it closed is adequate in scope and premature in time,
and those are different findings.

The limitations window itself is CPLR 217(1)'s four months from final and
binding, computed with month arithmetic that clamps rather than overflows
(31 October plus four months is the last day of February, not 3 March). It is a
default, not a universal: a determination context may carry its own
`limitations_window_closes_on`, and specific land-use and municipal provisions
do carry shorter periods.

### As of when?

`asOf` defaults to the latest `searched_at` among the supplied coverage. That is
the honest answer to the question — a count of challenges is current as of the
last search that looked, not as of the moment somebody rendered a page — and it
is also what makes the derivation deterministic. Nothing in this module reads a
clock, the network or the filesystem.

## The wording is exported, not left to callers

The failure this card exists to prevent is a consumer looking at `value === 0`
and writing the sentence itself. So the sentences are constants:

```
CHALLENGE_WATCH_ZERO_WORDING     "no challenge found after the recorded search"
CHALLENGE_WATCH_UNKNOWN_WORDING  one phrasing per null reason, each an absence
                                 in the record rather than a fact about the world
```

`FORBIDDEN_CHALLENGE_WATCH_WORDINGS` lists the sentences that turn a fact about
search effort into a fact about the world — "no lawsuit was filed", "was never
challenged", "unchallenged", and their neighbours —
`findForbiddenChallengeWatchWording` locates them, and
`assertNoForbiddenChallengeWatchWording` refuses them.
`renderChallengeWatchValue` runs that assertion over **its own output** before
returning, so a future edit to a wording constant cannot quietly reintroduce
the sentence.

## Five fields, never one number

The case outcome keeps filing, procedure, merits, remedy and relief apart:

| Field | Question it answers |
| --- | --- |
| `procedural_survival` | did the petition get past standing, timeliness, ripeness and necessary-party objections? |
| `durable_petitioner_relief` | what did the petitioner actually get — and keep? |
| `remedy_exposure` | what was the approved project exposed to as a result? |

Each is independently nullable, and null means "this decision does not say" —
a different fact from every value in every enum, and notably from
`procedural_survival: "not_reached"`, which means the decision considered the
question and declined to reach it. Relief and remedy come apart constantly: a
remand that leaves every permit in force is real relief and near-zero exposure,
and a stay entered without any merits ruling is exposure without relief.

There is no fourth field and no code path that reduces these to one.
`findCombinedOutcomeScoreFields` and `assertNoCombinedOutcomeScore` are the
callable form of that rule, and the record validators report a combined-score
field as a rule violation rather than merely as an unrecognized key — a reader
of the output should be told which rule was broken, not only that a key was
not on a list.

The scan matches whole terms rather than substrings, for the reason
SEQRA-09's forbidden-estimate scan already records: a substring rule flags
innocent names and misses camel-cased offenders in the same pass. One
domain-specific exception is carried explicitly. A bare `index` term is
**not** on the list, because in a court-records vocabulary the index number is
the identifier of a proceeding and a rule that rejected `index_number` would
reject the one field a case cannot be stored without; `outcome_index` is on the
list in its place, and every other composite name carries a second flagged
term anyway.

## Supersession is structural, not chronological

`applyDecisionSupersession(decisions, supersessions)` resolves, per case, the
decision that no edge supersedes. A decision is superseded exactly when some
edge names it as superseded — never because a later decision exists.

A case with two unsuperseded decisions is reported `unresolved` with the reason,
rather than silently resolved to the later date. A store that guesses there is
a store that will eventually report a reversed trial win as a durable one,
which is the failure the edge type exists to prevent. Cycles and forked
supersessions are likewise reported rather than resolved.

`affirmed` is recorded as an edge like the rest, for one reason: it keeps every
case's decision graph a single chain with exactly one head, so "the effective
decision" is a structural fact rather than a date comparison. It is also the
one disposition that leaves the earlier decision's relief standing, which
`dispositionDisturbsRelief` states rather than leaving to a reader.

The trial decision is never overwritten. It stays in the store with the relief
it granted; what changes is which decision the case outcome is read from. That
is what makes `durable_petitioner_relief` durable rather than merely granted.

## The backtest

```bash
npm run warehouse:article78:backtest                  # the gate
node tools/backtest_article78_ontology.mjs --write    # regenerate expected
```

The gate loads the committed fixture at
`warehouse/fixtures/article78/litigation_backtest_fixture.v1.json`, validates
the whole record set, runs both derivations, and compares the result against
`litigation_backtest_expected.v1.json` committed next to it. Any mismatch is a
non-zero exit and a named first difference. The receipt carries the fixture's
own content hash, so editing the fixture without regenerating the expectation
fails here rather than quietly changing what the gate asserts.

Six scenarios pin the five ways a challenge-watch value can come out and the
one way a decision can be undone:

| Scenario | Expected |
| --- | --- |
| `located_challenge` | `1`, attributed to the search that located it |
| `adequate_search_zero_challenges` | `0`, naming the search that found nothing |
| `nonfinal_determination` | `null` — the window has not opened |
| `inadequate_coverage` | `null` — one county, and a window five weeks short |
| `open_limitations_window` | `null` — adequate in scope, premature in time |
| `trial_decision_reversed` | the appellate reversal is effective; the annulment is not durable relief |

Every record in the fixture is synthetic. The court names are real
institutions; every index number, caption, party, date and outcome is invented,
and the fixture says so in its own `note` field. Nothing is fetched, and
nothing there is a claim about a real proceeding.

## The historical QA fixture

A separate, larger fixture of thirteen documented environmental-review
projects exists purely to catch behavioral regressions in the two derivations
above, and is walled off from ever training anything. See
`docs/article78-historical-fixture-v1.md`.

## Coverage grading

`search_coverage` records what one bounded search covered; A78-03 grades how
well a determination was searched across its receipts, and admits only
adequately searched negatives into a denominator. The receipt carries three
additive fields for it — `systems_searched`, `variants_tried` and
`docket_details_unavailable` — and `challengeWatchValue` takes an optional
`coverageGrade`, names it under `basis.coverage_grade`, and refuses to produce
a number under a grade outside its countable set. See
`docs/article78-search-coverage-v1.md`.

## The forward-looking companion

`challengeWatchValue` counts challenges a recorded search located after the
fact. A78-04 adds the forward-looking half: a **challenge watch** over one
determination, derived as of an explicit cutoff from evidence public by that
date, which may reach its top level only on a specific preserved issue or a
named participant and never on document class alone. The two share the
coverage grade and nothing else, and carry deliberately separate schemas so a
consumer cannot mistake one for the other. See
`docs/article78-challenge-watch-v1.md`.
