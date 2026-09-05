# Multi-target baselines and the internal review card (SEQRA-09)

This is the ninth card of the New York SEQRA/CEQR predictive-foundation
workstream. It is the first one that fits anything. SEQRA-08 built the
labelled corpus -- as-of feature snapshots, process-path and supplemental-
review labels with right-censoring, project-family-grouped rolling-origin
folds, and the leakage and denominator receipts a reported metric depends
on. This card fits an interpretable baseline for each of the workstream's
targets over that corpus, measures every one of them out of time against a
documented naive comparator, reports whether document and institutional
enrichment buys anything over structured sources alone, and renders the
internal surface where a review's predicted state can be read against its
recorded state.

It adds no ontology entity, no resident-facing route, and no combined
project score.

## Baselines first, and why the ordering is enforceable rather than polite

The workstream spec puts regularized linear models, a discrete-time survival
model and an ordinal model ahead of anything more elaborate. Before this card
that ordering was a sentence in a document. After it, it is a receipt: until
a fitted baseline has been measured out of time against a named heuristic, a
more complex model has nothing to beat, and there is no way to say whether the
document pipeline (SEQRA-04/05) or the institutional-signal adapters
(SEQRA-07) earned their place in the feature set or merely occupy space in it.

Five target families are fitted, each separately and each with its own
comparator:

| Target | Model | Naive comparator | Primary metric |
| --- | --- | --- | --- |
| `review_path` | five-class regularized multinomial logistic | training-fold class prevalence | log loss |
| `supplemental_review:<horizon>` (four horizons) | regularized binary logistic | training-fold class prevalence | log loss |
| `next_milestone_type` | regularized multinomial logistic | training-fold class prevalence | log loss |
| `next_milestone_duration` | discrete-time survival with a smooth baseline hazard | training-fold Kaplan-Meier median | concordance |
| `technical_issue_state` | proportional-odds ordinal logistic | training-fold level prevalence | expected absolute ordinal error |

They are never combined. There is no code path in
`warehouse/lib/seqra_baselines.mjs` that produces a single number for a
project, and the receipt attests to that rather than only the prose.

## Where the label comes from, and why the cutoff sits before the milestone

SEQRA-08 records the review-path label **as of the cutoff**, which is the
right thing for a corpus and the wrong thing for a prediction target: a cutoff
placed after the classifying milestone makes the label a feature, and a model
fitted on that reports an accuracy that belongs to the corpus construction.

So this card reads the review-path label from the review's state at the
**observation horizon** and takes its features from the as-of snapshot at an
earlier cutoff, and every cutoff in its fixture corpus sits before that
review's classification. SEQRA-08's `auditFeatureLeakage` still runs per
snapshot and is re-rolled into the receipt: 2,249 records audited across 220
reviews, zero temporal-leakage violations.

## The naive comparators are chosen to be fair bars, not easy ones

Class prevalence predicted from the training fold is the honest floor for a
classification target -- it is what "we learned nothing" looks like when the
classes are unbalanced.

For duration the comparator is the **Kaplan-Meier median** of the training
fold, not the mean of the observed durations. The mean is biased downward by
exactly the censoring this corpus carries, so it would have been a bar the
baseline could clear without doing anything.

The same reasoning decides the duration target's primary metric. Absolute
error can only be computed on rows whose milestone was actually observed, so
it conditions on the outcome: it quietly rewards a predictor that says "soon"
about everything, because the reviews that would prove it wrong are the ones
it cannot score. Concordance is defined over every comparable pair, including
censored ones, so that is what the pass/fail comparison is made on. Mean and
median absolute error, interquartile interval coverage and the censoring
counts are all still reported beside it.

## Calibration and error, out of time, with denominators

Every estimate carries a measured report, per fold and pooled:

* reliability bins over ten equal-width probability bands, with counts;
* expected and maximum calibration error on the top-label confidence, and
  one-versus-rest calibration error and Brier score per class;
* log loss, multiclass Brier score, overall error rate and per-class error;
* for the duration target, concordance, mean and median absolute error in
  days, and how often the observed milestone landed inside the quoted
  interquartile range;
* the fold denominators and censoring counts, taken from SEQRA-08's own
  `summarizeTargetFoldPopulation` rather than recounted here.

Pooled figures are the concatenation of each fold's own out-of-time test
predictions, never a refit over the whole corpus. Pooled **concordance** is
the pair-weighted mean of the per-fold values rather than a recomputation over
the concatenation: pairs drawn from two different folds came from two
different models, and pooling them would hand the constant-median comparator a
ranking ability it does not have.

## The source-tier ablation

Each baseline is fitted three times over nested feature sets -- structured
sources only, plus document-derived features, plus institutional signals --
and the receipt reports both the step between tiers and each tier's own
comparison to the naive comparator.

Making that measurement real required one correction. The structured tier's
milestone count originally counted every review event, including topic
assessments and recorded positions, which meant the "structured only" fit was
quietly reading the two later tiers. The structured tier now counts structural
milestones only, and the tiers are strictly nested, which is asserted rather
than assumed.

On the committed fixture corpus, at the full source stack, all eight targets
beat their naive comparator. The document tier adds value on seven of eight
and the institutional tier on seven of eight; structured sources **alone**
lose to prevalence on five of eight, which is the finding this card exists to
be able to state.

## The internal review card

`warehouse/lib/seqra_review_card.mjs` renders one review for a reviewer inside
the project. It shows the observed review state, the likely next milestone,
the estimated timing range, unresolved technical topics, mitigation and
monitoring, supplementation indicators, institutional participation, and
source freshness with missing-data warnings.

Three fact classes, three visibly different treatments, never interchangeable:

| Class | Meaning | Treatment |
| --- | --- | --- |
| `observed-fact` | a record says so | solid rule, plain weight, no hedge |
| `estimate` | a fitted baseline says so | dashed rule, tinted panel, an explicit tag, and the measured out-of-time calibration printed immediately beside the number |
| `missing-data` | nobody says so | hatched rule, muted, phrased as an absence in the record |

The renderer refuses an estimate that arrives without its calibration, and
`auditFactClasses` is the callable form of the rule so that "an estimate is
never rendered as an observed fact" is a test rather than an intention.

Cards are built only from a fold's **held-out** rows -- `buildReviewEstimates`
refuses a review the fold trained on -- so the calibration printed beside an
estimate describes the same quantity the estimate is.

The card is internal. It is written under `warehouse/reports/seqra-review-cards/`,
adds no route, is not served by the site, and states no legal conclusion. No
estimate anywhere in this card's output is named or framed as a probability of
anyone being sued; `assertNoForbiddenEstimate` enforces that on field names,
rendered labels and the serialized artifacts, matching on whole tokens rather
than substrings so that it neither flags `technical_issue_state` nor misses a
camel-cased offender.

## Determinism

The receipt has to be byte-identical in CI and on a contributor's laptop, so
the models cannot be built on an unpinned primitive. IEEE-754 pins `+ - * /`
and `sqrt` exactly; it does not pin `Math.exp` or `Math.log`, whose last bits
are free to differ between platforms and engine versions. This card therefore
computes both itself, by argument reduction plus a fixed-length series, from
exact arithmetic only. Fitting is likewise fixed: a fixed number of steps from
an all-zero start, over rows in a sorted order, with no early stopping and no
convergence test whose trip point could differ between platforms.

The binary logistic fits (including the survival model's hazard) use
ridge-penalised IRLS rather than gradient descent. That is not a preference:
the hazard model's design matrix mixes standardized features with a baseline-
hazard basis, which makes the Hessian badly conditioned, and a first-order
method reported "the documents tier does not help" when what had actually
happened was that its coefficients had not moved yet.

Two related choices came from the same debugging. The baseline hazard is three
smooth terms in normalized time rather than one free parameter per bin --
forty free intercepts against a fold holding sixty-nine reviews, all shrunk
toward zero by the feature ridge, and a bin coefficient shrunk toward zero is
not a neutral prior but a prior that the milestone is as likely to arrive in
that bin as not. And the feature set carries no calendar-year term: in a
rolling-origin design a fitted time trend always extrapolates past its
training range, and it did.

## Command surface

```bash
node tools/build_seqra_baselines.mjs            # fit, score, write the receipt and the cards
npm run warehouse:seqra:backtest                # the same thing in --check mode
```

`--check` recomputes everything and fails if the committed receipt
(`warehouse/receipts/proof/seqra_baselines_latest.json`) or any committed card
does not reproduce byte for byte. There is no network access and no clock:
every input is the committed synthetic fixture at
`warehouse/fixtures/seqra-baselines/`, which is generated through SEQRA-02's
event-log builders and consumed through SEQRA-08's own corpus primitives
rather than a parallel implementation.

The fixture is larger than SEQRA-08's deliberately. Six reviews chosen to
exercise one invariant each are exactly right for proving a corpus builder and
say nothing at all about whether a fitted baseline beats a heuristic. This
card's corpus is 220 synthetic reviews across 202 project families and five
rolling-origin folds, generated by a fixed-seed integer sequence so that it is
byte-identical everywhere, and its generating process gives the three source
tiers deliberately different amounts of signal -- a fixture in which every tier
were equally informative could never show the ablation working.
