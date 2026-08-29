---
card_standard: kraken-v1
richness_profile: standard
group: enforced
id: cityscroll-reader-journey/rj-01
title: "RJ-01 · Reconcile Kraken/GitHub implementation state"
status: proposed
wave: cityscroll-reader-journey-reconcile
spec: "../../README.md#card-map"
builds_on: []
blocked_by: []
predecessors: []
related:
  - cityscroll-procurement-analytical-projection/ap-06-city-record-match-coverage
  - cityscroll-procurement-analytical-projection/ap-10-performance-evidence-gap
  - cityscroll-procurement-analytical-projection/ap-12-agency-procurement-fiscal-context
  - cityscroll-cb-money/cb-money-04
  - cityscroll-cb-money/cb-money-05
context:
  - ../../README.md#acceptance-criteria
  - ../../README.md#design-notes-and-validation
  - data/kraken-full-reconcile/undelivered.md
  - site/app/money-list.mjs
  - site/agency_constellation.mjs
  - site/community_board_constellation.mjs
verify: "test -s docs/evidence/cityscroll-reader-journey/README.md && test -s docs/evidence/cityscroll-reader-journey/cards/proposed/rj-01-kraken-github-reconciliation.md"
needs_james: false
effort: L
risk: high
target: crol-list
autodispatch: false
goal: "Reconcile every reader-facing PR in the requested range with its stable queue card and current source behavior before any downstream reader-facing card proceeds."
---
## Story

As a workstream owner responsible for reader-facing coherence, I need one evidence-backed view of what GitHub shipped, what the live Kraken card says, and what the current application actually does so that stale metadata, partial acceptance, and real gaps are not confused.

## Goal

Complete A1 for every reader-facing PR from #1254 through #1385. Map each PR to its stable Kraken card or explicitly record it as uncommissioned work. The result is a reconciliation matrix, not a bulk status promotion.

The five named stale-status candidates are mandatory rows:

| Candidate | Live card | GitHub evidence to inspect | Required classification |
| --- | --- | --- | --- |
| AP-10 | `cityscroll-procurement-analytical-projection/ap-10-performance-evidence-gap` | PR #1318, current performance-evidence read model, tests, and captures | Exactly one primary classification: stale metadata, partial acceptance, or real gap; record the reason and any secondary observation. |
| AP-12 | `cityscroll-procurement-analytical-projection/ap-12-agency-procurement-fiscal-context` | PRs #1330, #1339, and #1375, agency fiscal-context renderer/read model, tests, and captures | Exactly one primary classification: stale metadata, partial acceptance, or real gap; do not treat the three merged PRs as proof that every acceptance box is complete. |
| CB-MONEY-05 | `cityscroll-cb-money/cb-money-05` | PR #1374, 59-board comparison artifact, board browse/map/table behavior, tests, and captures | Exactly one primary classification: stale metadata, partial acceptance, or real gap; preserve any remaining scope or evidence gap. |
| AP-06 | `cityscroll-procurement-analytical-projection/ap-06-city-record-match-coverage` | PR #1265, live card acceptance boxes, exact-PIN coverage projection, and current renderer | Exactly one primary classification: stale metadata, partial acceptance, or real gap; unresolved acceptance boxes must remain visible. |
| CB-MONEY-04 | `cityscroll-cb-money/cb-money-04` | PR #1364, live `in-progress` state, Board budget & spending module, and its positive/partial evidence | Exactly one primary classification: stale metadata, partial acceptance, or real gap; a merged PR does not erase a live realization gap. |

The table names the observed conflict and the required output; it intentionally does not pre-fill the final classification. RJ-01 must decide each row from current evidence and preserve an explicit “not yet established” note while an evidence source is missing.

## Reconciliation method

1. Read the live queue records for the complete reader-facing population, including stable IDs, parent workstreams, dependencies, statuses, acceptance text, linked PRs, outcomes, and queue position.
2. Enumerate GitHub PRs #1254–#1385 and identify which are reader-facing by changed surfaces, PR summary, screenshots, and acceptance language. Include a row for every included PR and an explicit “uncommissioned work” row for any included change without a stable card.
3. For each mapped row, inspect the merged PR and current default-branch source, tests, generated artifacts, and committed evidence. A PR title or merge state is not realization proof.
4. Compare each acceptance item to observed behavior. Use `realized`, `partial`, `unverified`, `not applicable with reason`, and `not realized` as evidence states before assigning a lifecycle status.
5. Record whether the live queue status is truthful, what gap remains, and whether follow-on work is warranted. Do not mark a card implemented solely because a related PR merged.
6. Re-read the live records immediately before any lifecycle update in a later dispatch. This card's authoring PR performs no queue mutation.

## Change

**Before:** GitHub contains merged reader-facing work while live queue records can remain proposed or in-progress, and acceptance boxes can remain unresolved. A downstream card can therefore plan around a status that no longer describes the application.

**After (intended):** One bounded matrix reconciles the PR range, stable cards, current implementation, acceptance state, remaining gap, truthful status, and follow-on decision. Known stale-status candidates are classified individually; none is silently marked complete.

**Theory / mechanism:** A reconciliation matrix is the narrow waist between delivery history and queue authority. It makes lifecycle state evidence-bearing without treating Git history as a substitute for product acceptance.

### Gap → fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | Merged PRs and live queue statuses can disagree. | Reconcile both authorities against current source and acceptance. | A1, A2 |
| G2 | A merged PR can satisfy only part of a card. | Record item-level acceptance states and residual gaps. | A1 |
| G3 | Reader-facing work can ship without a stable queue card. | Record it explicitly as uncommissioned rather than inventing a retroactive completion. | A1 |
| G4 | Downstream work can inherit an untruthful dependency. | Block downstream dispatch until material contradictions are recorded and resolved. | A1 |

## Reconciliation receipt

The committed evidence must include, for every included PR:

* PR number, title, merge state, merge commit, and relevant changed paths;
* the exact stable Kraken card or an explicit `uncommissioned` classification with rationale;
* the live card status, acceptance text, dependencies, linked PRs, and outcome as read at the reconciliation time;
* current-source evidence for the realized outcome, including a test, artifact, route, or capture where applicable;
* one state for each acceptance item: realized, partial, unverified, not applicable with reason, or not realized;
* remaining gap and whether follow-on work is warranted;
* one truthful lifecycle recommendation, with no implicit promotion from merged to implemented;
* read timestamps or commit SHAs sufficient to explain which GitHub and live-queue snapshots were compared.

For the five mandatory candidates, add a short classification note choosing exactly one of `stale metadata`, `partial acceptance`, or `real gap`. If the evidence cannot distinguish the choices, the row remains unresolved and the card cannot pass; uncertainty is not permission to choose “stale metadata.”

## Acceptance

- [ ] A1 [outcome] Every reader-facing PR from #1254 through #1385 appears in the matrix, mapped to its stable Kraken card or explicitly recorded as uncommissioned work.
- [ ] A2 [verification] Each mapped row records merged PR, realized outcome, current acceptance state, remaining gap, truthful lifecycle status, and whether follow-on work remains warranted.
- [ ] A3 [boundary] AP-10, AP-12, CB-MONEY-05, AP-06, and CB-MONEY-04 each have exactly one evidence-backed primary classification: stale metadata, partial acceptance, or real gap.
- [ ] A4 [negative] No card is marked complete because a related PR merged; unresolved acceptance boxes, missing evidence, and real gaps remain explicit.
- [ ] A5 [dependency] Any materially contradictory dependency is recorded as reconciled before RJ-02 or another downstream reader-facing card proceeds.
- [ ] A6 [verification] The matrix can be re-read against the current source and live records without relying on hidden local state or manual URL edits.

## Non-goals

Do not alter queue records, amend neighboring cards, change UI behavior, rewrite source observations, or declare the reader-journey result. Those belong to later cards and dispatches.

**Grounding:** required — current GitHub history, current source, and live queue records have been inspected as inputs; the reconciliation matrix and lifecycle changes remain the RJ-01 delivery.
