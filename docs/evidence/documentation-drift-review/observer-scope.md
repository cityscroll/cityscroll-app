# Documentation claim observer: what it covers, and what it does not

This records the bounded scope of the documentation-claim observer honestly, so a
passing check is read for what it is rather than as a general guarantee that the
architecture documentation is correct.

The observer is `tools/documentation_claim_observer.mjs`. It is applied by
`tools/documentation_drift_review.mjs`, replayed by
`tools/backtest_architecture_canaries.mjs --check`, and asserted by
`test/documentation_drift_review.test.mjs`.

## Covered documents

| Document | Why it is covered |
|---|---|
| `ARCHITECTURE.md` | The narrative entry point, including its goals, building blocks, runtime scenarios and decisions |
| `docs/architecture.md` | The canonical architecture document, including its frontmatter summary, its fenced system map, and its one-paragraph summary |
| `worker/README.md` | The server-boundary overview, including its fenced request-flow diagram |
| `docs/release/cloudflare-native-builds.md` | The owned release and infrastructure reference |
| `docs/release/cloudflare-native-builds.json` | The machine-readable release contract |

The set is declared in `architecture/documentation-claims.json` and is generated
into the check at run time. A claim may only name a document the registry
declares, so widening coverage is a reviewed registry edit rather than something a
new file acquires by existing. No repository-wide inventory of documents is
committed for this lane.

## What is read

Unlike `tools/reconcile_architecture.mjs`, which strips fenced blocks before
reading prose, this observer reads them. Inside a fence each non-empty line is
judged on its own, because a diagram is a set of independent assertions rather
than one flowing paragraph. Outside a fence, each markdown list item is its own
claim, so a qualifier added to a later bullet cannot silently excuse an absolute
in an earlier one. YAML frontmatter and JSON are read line by line.

Markdown emphasis, code ticks and link syntax are normalized away before
matching, so a claim cannot be hidden from the observer by adding backticks.

## What produces a finding

Every blocking finding is conditional on a fact derived from a committed owner.
Wording alone never produces one: if the configuration changes so that a sentence
becomes true, the same sentence stops being reported. The frozen backtest carries
a positive control that replays the audited wording against a configuration under
which each claim is true, and expects silence.

| Finding | Meaning |
|---|---|
| `contradicted_claim` | The document asserts something a derived fact contradicts |
| `miscounted_claim` | The document states a quantity that differs from the derived one |
| `unqualified_claim` | The document states an absolute whose honest form requires a qualifier that is absent from the same statement |
| `missing_exception_reference` | The document states the invariant while open departures exist, and points at none of them |
| `review_needed` | The claim cannot be settled from committed files; it carries the owner who can settle it |

## What is not covered

- **Anything outside the five declared documents.** ADRs, guide articles, the
  public site copy, in-code comments and every other document in the repository
  are out of scope for this lane.
- **Any claim not in the registry.** The registry is bounded and hand-owned. A
  true statement about something nobody registered is not checked, and the
  observer does not claim otherwise.
- **Provider-account state.** Nothing here reads a Cloudflare dashboard, a
  provider retention setting, or whether a third-party tag ever loaded in a
  reader's browser. Those stay `review_needed` with a named adjudicator and are
  printed on every run, including a run with no contradiction.
- **Whether a recorded departure is still acceptable.** The observer reads the
  debt manifest to know that departures exist. It does not decide whether their
  expiry is close enough to matter; that is an architecture-review decision, and a
  build timestamp is not a review date.
- **Editorial quality.** Nothing here scores prose, enforces a preferred phrasing,
  or proposes replacement wording. It reports a claim, its locator, and the
  committed owner that contradicts it.

## Determinism

The observer reads no clock, no network, and no publisher. `--check` takes no
date. `--report` and `--rehearse-lineage` require an explicit `--checked-at`.
Re-running unchanged inputs produces an identical observation, and the review
content hash excludes line numbers, so inserting an unrelated paragraph above a
standing finding does not present it as new. The hash does include the registry
digest and the values of every fact the registry reads, so a changed claim owner
or a changed source fact does invalidate the review.

## Relationship to the existing reconciler

`tools/reconcile_architecture.mjs` owns prose that *grants* a request-time
publisher read, checked against `architecture/resident-read-policy.json`. This
observer reads prose that *denies* the recorded departures exist. The two are
complementary. Nothing here weakens the resident-read invariant, edits the debt
manifest, removes an exception, advances a watermark, or introduces a suppressing
allowlist: the registry has no exemption field, and the only way to stop a finding
is to correct the document or change the configuration it misdescribes.
