# A78-06: the internal challenge-watch card

A78-01 (`docs/article78-litigation-ontology-v1.md`) made the bounded court
search and the case outcome stored records, and refused a combined outcome
score. A78-02 (`docs/article78-historical-fixture-v1.md`) added thirteen
documented projects as a QA-only regression fixture. A78-03
(`docs/article78-search-coverage-v1.md`) graded how well each determination was
actually searched. A78-04 (`docs/article78-challenge-watch-v1.md`) derived a
cutoff-aware challenge watch whose features each carry their own evidence and
public date. A78-05 (`docs/article78-litigation-backtest-v1.md`) scored filing
and durable relief as two heads that never meet.

Until this card there was no surface for any of it. That is not a cosmetic gap:
separation that exists only inside modules is separation that ends at the first
person who reads them. Nine separated components summarized into one impression
by whoever opens the page is exactly the outcome five cards were spent
refusing, and the summarizing needs no field, no number and nobody's intent.

A78-06 is therefore a **display contract**, not a derivation. It adds no record
shape, fetches nothing and reads no clock.
`warehouse/lib/article78_challenge_watch_card.mjs` builds the model,
`renderChallengeWatchCard` renders it, and the existing
`npm run warehouse:article78:backtest` command writes and checks the rendered
cards under `warehouse/reports/challenge-watch-cards/` rather than a second tool
doing it.

## Nine rows, and no tenth

| row | what it reports | rests on |
| --- | --- | --- |
| `named_opponent_or_coalition` | organizations named on the public record in opposition, and the captions of cases naming this determination | A78-04 named-participation features |
| `preserved_issue` | issues named and reaffirmed on the public record | A78-04 preserved-issue feature |
| `limitations_clock` | when the window to commence a proceeding closes | the CPLR 217(1) deadline rule |
| `service_clock` | by when service must follow the expiry of that window | the CPLR 306-b deadline rule |
| `theory_fit` | claim theories recorded against this determination, in A78-01's closed categories | A78-01 `claim_theory` records |
| `procedural_exposure` | what the effective decision recorded about threshold objections | A78-01 `procedural_survival` |
| `merits_indicators` | what the petitioner obtained, and whether it survived supersession | A78-01 `durable_petitioner_relief` |
| `remedy_exposure` | what the approved action was exposed to | A78-01 `remedy_exposure` |
| `court_search_coverage` | how well the court record behind this determination was searched | A78-03 `gradeCoverage` |

`rests_on` is a field on every row, and `assertChallengeWatchCard` refuses two
rows that name the same source: two rows over one fact is one fact reported
twice, and one of them would be summarizing the other. The three outcome rows
are the direct consequence — A78-01 records procedure, merits and remedy as
three separate fields precisely because they come apart, so they are three
rows here and no row reads another's value.

Each row also carries `never_says`, the conclusion the row is regularly
mistaken for, rendered beside the row rather than filed in a document nobody
opens.

## No level, no score, no verdict

The card does **not** reproduce A78-04's watch level, and that is deliberate. A
single level printed above nine separated components is read as their summary
whatever the surrounding words say, which is the collapse this card exists to
prevent. Where the watch is not established, the two watch-derived rows report
`not_established` individually, carrying A78-04's own null wording and reason.

`assertChallengeWatchCard` enforces the absence rather than documenting it. It
runs A78-01's `assertNoCombinedOutcomeScore` over every object key in the card,
and adds `FORBIDDEN_CARD_FIELD_TERMS` — `level`, `verdict`, `likelihood`,
`probability`, `odds`, `prediction`, `forecast`, `confidence`, `rank`,
`ranking`, `total`, `aggregate` — over the same keys. There is no field a
future edit could add to this card that would collapse it without failing here.

## Every component shows the grade it rests on

The A78-03 coverage grade travels on every row (`coverage_grade`), not once at
the top where a reader stops seeing it by the third row. A component derived
from a determination nobody could adequately search is not a weaker component:
it is a component nobody can check. Where the grade is below the countable
grades, each row additionally carries `coverage_admissibility_note` saying so in
its own place, and the two watch-derived rows report `not_established`.

## The clocks

Both clocks come from `ARTICLE78_DEADLINE_RULES`, which states the statutory
provision, the triggering event and the period as data. There is no date in
that object: a hard-coded deadline silently stops matching the determination it
was written for, and a period with no citation is a number nobody can check.

| clock | rule | trigger | period |
| --- | --- | --- | --- |
| limitations | CPLR 217(1) | the determination became final and binding upon the petitioner | four months |
| service | CPLR 306-b | the applicable limitations period expired | fifteen days |

The limitations rule is the one this repository already models
(`ARTICLE78_LIMITATIONS_MONTHS`, `limitationsWindow`), named here rather than
reimplemented, including its documented override: a determination context may
carry its own `limitations_window_closes_on`, and the clock then reports the
stated date, says it used it, and still shows what the rule alone would have
produced.

The service rule is added by this card because no upstream module models it.
CPLR 306-b's general period is one hundred twenty days after commencement, with
a separate branch for a proceeding whose applicable limitations period is four
months or less — which is the Article 78 case under CPLR 217(1). That branch is
what governs here, and it runs from the expiry of the limitations period rather
than from any filing date, so a determination with its own shorter stated
closing date moves the service deadline with it.

Every clock row shows the whole computation, not the answer: the triggering
event, its date, the rule applied, the computed deadline, the deadline's source,
and the state at the cutoff. The state is one of three:

- `open` — the cutoff is on or before the deadline.
- `expired` — the cutoff is after the deadline.
- `unknown` — the trigger is not established, and no deadline is computed.
  `ARTICLE78_DEADLINE_CLOCK_UNKNOWN_REASONS` names why: finality unknown, the
  determination not final, no final-and-binding date recorded, a recorded
  trigger dated after the cutoff, or an upstream clock that is itself unknown.

Unknown stays unknown. `assertChallengeWatchCard` refuses a clock that reports a
deadline while unknown, or that is unknown while reporting one.

## The cutoff

Every card carries an `as_of`, and refuses a watch derived at a different one: a
card whose clocks and features disagree about the cutoff cannot be read. Each
record channel is filtered at that cutoff through A78-04's own
`partitionByCutoff`, and every exclusion is reported on the row that would have
read it rather than dropped.

The rendered fixture cards are built at the close of each project's recorded
observation window — `latestRecordedObservation`, the last day anything about
the project was observed. That is a display choice, not a scoring one: nothing
recorded is hidden behind it and nothing after it is invented. A78-05's
`resolveBacktestCutoff` still owns the cutoff policies the backtest scores at,
and each card prints the cutoff it was built at so the two are never confused.

## Audience boundary

The card is internal. `audience: "internal"` and `no_resident_conclusion: true`
are fields on the model, the rendered page declares both as data attributes, and
the page header reads `challenge watch, internal, diagnostic only` — built from
A78-04's `CHALLENGE_WATCH_LABEL`, so the surface cannot be renamed here without
renaming the signal there.

The boundary is checked, not asserted in prose:

- Cards are written only under `warehouse/reports/challenge-watch-cards/`, never
  under `site/`, and the builder refuses any other path.
- A rendered card carries **no anchor at all** and names no resident route. A
  page with no link cannot link into one, and `assertRenderedCard` checks for
  `<a `, `href=`, `site/` and route prefixes rather than trusting that nobody
  adds one later.
- `test/warehouse_article78_challenge_watch_card.test.mjs` greps the tracked
  `site/` and `worker/` trees for the card directory, so no resident route or
  Worker read can reach a card from the other direction.
- Every rendered card, this document and the module are scanned for both
  forbidden registers — A78-01's (a search miss reported as a fact about the
  world) and A78-04's (a watch reported as a forecast about a court).

## Verifying

```
npm run warehouse:article78:backtest
node --test test/warehouse_article78_challenge_watch_card.test.mjs
```

The command renders all thirteen cards and fails if a committed card does not
reproduce byte for byte. Regenerate deliberately with
`node tools/backtest_article78_ontology.mjs --write`; edit the builder, never
the output.
