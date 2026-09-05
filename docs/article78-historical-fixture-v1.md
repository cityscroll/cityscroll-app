# A78-02: the historical QA fixture, and why it can never train anything

A78-01 (`docs/article78-litigation-ontology-v1.md`) gave the environmental
review foundation's litigation layer its record contracts and its two
derivations: a challenge-watch value that resolves to the search behind it,
and an effective decision that follows explicit supersession edges rather
than the most recent date. A78-02 adds no new record shape. It adds thirteen
documented environmental-review projects and their thirty-six litigation
events, kept as a fixture whose only job is to catch a behavioral regression
in those two derivations — and a set of guards that keep it from ever being
anything else.

## Why a fixture this specific has to be walled off

The thirteen projects were selected for being interesting. That is exactly
what makes them unsuitable to learn from: fitting anything to a hand-picked
sample of newsworthy litigation would report the selection itself as filing
prevalence, not a fact about how often land-use approvals get challenged.
Three things make the exclusion real rather than a comment next to the data:

- **Every row is tagged.** Every record under
  `warehouse/fixtures/article78/historical/` carries
  `fixture_role: "qa_historical"`, so a consumer can filter it out by a field
  rather than by a naming convention it has to remember.
- **The exclusion is asserted at construction time.** `assertFixtureExcluded`
  (`warehouse/lib/article78_historical_fixture.mjs`) is wired into
  `buildBaselineCorpus` — the corpus entry point every training fold in this
  repository is built from — and throws, naming the offending row, if any
  fixture id or record fingerprint appears in a fold or training partition.
  There is no separate corpus or fold builder for Article 78 litigation
  records yet, so this is where the assertion lives; if one is added later,
  it inherits the same call.
- **Every derived number says what it is.** `diagnosticMetric` is the only
  exported way a value computed over this fixture may leave the module, and
  it always returns `{ name, value, scope: "fixture", diagnostic_only: true }`.
  `assertAllMetricsDiagnostic` refuses a metric list carrying anything else.

## What the fixture is

`loadHistoricalFixture()` reads thirteen projects and their determinations,
search coverage, judicial cases, filings, claim theories and decision
supersessions from `warehouse/fixtures/article78/historical/`, strips the two
loader-owned decorations (`fixture_role`, `project_id`) and the optional
`synthetic` flag, and validates every remaining record with A78-01's own
validators. A historical fixture that does not validate against the same
rules as production data cannot honestly stand in for a regression test, so
loading throws rather than warns.

Every specific detail in the fixture — index numbers, captions, dates,
outcomes — is a synthetic placeholder. The court names are real institutions
and the project selection and documented behavioral expectations are real;
no specific court filing detail here is drawn from a record already cited in
this repository's docs, and nothing was fetched to produce one. Where an
event needed a concrete shape the record says so with `synthetic: true`
rather than inventing a real-looking fact.

`index.json` lists all thirteen projects with their documented expectation
keys. Seven carry a named behavioral test in
`test/warehouse_article78_historical_fixture.test.mjs`; all thirteen carry at
least one machine-checked expectation that runs through A78-01's own
derivations, via `evaluateHistoricalFixtureExpectations`.

## The seven named behaviors

| Project | What it proves |
| --- | --- |
| Gowanus Neighborhood Rezoning | Filing watch stays high across both petitions even though one was dismissed for a service-of-process failure — a procedural fact, kept separate from the merits, from durable relief, and from remedy |
| City Point | Filing watch stays high while a wage-only theory pleaded as SEQRA review stays weak on the merits, and the underlying labor claim is never recorded as misconduct |
| 200 Amsterdam Avenue | A prior administrative challenge, carried into Article 78 review, counts toward the watch value; construction being restrained is recorded as remedy, kept separate from relief |
| Mott Haven Educational Campus | A missing, ungraded monitoring search yields `null`, not zero, and supports an elevated diagnostic-only durable-relief signal |
| Innovation QNS | A deliberate false positive is retained in the search coverage's own record and explained in its note, rather than quietly dropped, and it does not inflate the watch count |
| Bronx Metro-North Station Area Plan | An environmental impact statement covering multiple bundled actions does not substitute for an adequate recorded court search; the watch value is still `null` |
| Haven Green / Elizabeth Street Garden | A trial-level win reversed on appeal does not remain a durable win — the same rule A78-01 proves generically, pinned again on a documented case |

## Running it

```bash
npm run warehouse:article78:backtest
node --test test/warehouse_article78_historical_fixture.test.mjs test/warehouse_article78_litigation.test.mjs
```

The backtest gate prints the historical fixture's expectations under a
`diagnostic_only` section and exits non-zero on any expectation failure, in
the same run that checks A78-01's six-scenario backtest.
