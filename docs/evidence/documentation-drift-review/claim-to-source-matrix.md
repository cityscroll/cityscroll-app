# Documentation drift: audited counterexamples, and what each one is checked against

This is the register behind the frozen documentation backtest. It records, for each
audited counterexample, the claim as it stood at the pinned revision, the committed
owner whose value contradicts it, the corrected wording that is now a positive
control, and the finding the observer raises when the old wording returns.

The change is a checker, its registry, its frozen replay, and its evidence. No
document prose, workflow trigger, cron schedule, binding, retention period,
published metric, debt entry, expiry, or architecture watermark was modified.

## Revisions

| Role | Revision | Note |
|---|---|---|
| Pinned audit revision | `3173824eed3f503858b01ae3cd6a0c7e1a705a16` | The revision the original read-only audits inspected, and the revision the frozen counterexamples are quoted from. |
| Implementation head | `b4f074d940c139d3c83263a7daa859d957eff44a` | The revision this backtest was written and verified against. No audited path moved between the previous default-branch tip and this one. |

## Revalidation at the implementation head

Every audited fact was re-derived at the implementation head before this backtest
was written. Four of the audited configuration files still carry the identical
blob at both revisions:

| Audited path | Blob at both revisions |
|---|---|
| `.github/workflows/deploy-worker.yml` | `f5cb8ea914a198ac8a047837bb3b3b99a428e5f7` |
| `worker/wrangler.toml` | `b61a049a8b3a355b8341dfee5544d2635baa49a3` |
| `site/clarity.js` | `840d895a9bf45f2b7045c27a438043652edfd11b` |
| `architecture/resident-read-policy.json` | `8750a97930babedc5234f66488da9ceee0653252` |

Four moved, and each was re-read to confirm the audited value is unchanged:

| Audited path | Pinned → head | What moved, and why the audited value is unaffected |
|---|---|---|
| `worker/src/lib/public_search_usage.mjs` | `b05db04ea` → `7ebe16cb3` | The projection now folds one receipt scan and publishes a dated lineage alongside the windowed reading. `PUBLIC_SEARCH_USAGE_METRICS` is still exactly `searches_run` and `searches_returning_records`. |
| `worker/src/lib/search_usage.mjs` | `032439379` → `ef626ee58` | Execution deduplication was factored out and exported. `SEARCH_USAGE_WINDOW_DAYS` is still `[7, 30]`. |
| `architecture/no-live-external-debt.json` | `bcc23475b` → `766cc21a3` | Ten `line` fields moved as their surrounding source shifted. The manifest still carries 21 entries over the same seven routes, `/notice` among them; no entry was added, removed, re-owned, or expired. |
| `docs/release/cloudflare-native-builds.json` | `93eb7d7a2` → `b79d40be6` | The previous reconciliation in this series replaced `manual_fallback_workflow` with the automatic-deploy keys. That correction *is* one of the audited findings being closed, and it is the source of the positive control below. |

The three documents the counterexamples are quoted from — `ARCHITECTURE.md`
(`0c1f36f7a`), `docs/architecture.md` (`b29aacce6`) and
`docs/release/cloudflare-native-builds.md` (`f779d50c2`) — have since been
corrected by the earlier reconciliations, which is exactly why their current
wording serves as the positive control.

`test/documentation_drift_review.test.mjs` asserts this revalidation
mechanically: the frozen facts in the backtest case are compared against the
facts derived from the working tree on every run, so a configuration change that
retires a counterexample fails the test rather than leaving a stale fixture.

## Excerpting

The frozen case quotes the audited statements rather than freezing whole
documents. Two excerpts are shortened to the audited sentence because the
surrounding sentence named a retired product hostname that is pinned
byte-for-byte elsewhere in the repository; the audited claim text itself is not
altered. Each excerpt's document and line at the pinned revision are recorded in
the case's `audited_statements` block, and a test asserts every raised finding is
registered there.

## Matrix

### D1 — A manual-only classification against a configured push trigger

| | |
|---|---|
| **Audited claim** | `docs/architecture.md:212`: "`.github/workflows/deploy-worker.yml` remains a manual, non-required fallback." `docs/release/cloudflare-native-builds.md:7`: "Workers Builds remains the canonical release path for the Worker." `docs/release/cloudflare-native-builds.json:39`: `"manual_fallback_workflow"`. |
| **Committed owner** | `.github/workflows/deploy-worker.yml` `on.push.branches` — derived by `tools/release_infrastructure_facts.mjs` as `pipelines.cloudflare-worker.manual_only: false`. |
| **Finding** | `contradicted_claim` on `worker-release-classification`, one per document, each with its line and matched text. |
| **Positive control** | The corrected reference, which classifies the pipeline as `push` to `main` plus `workflow_dispatch`, raises nothing. |
| **Consequence if unchecked** | An operator reads a missing Worker refresh after a merge as an unremarkable unused fallback rather than a failed automatic pipeline. |

### D2 — A one- or two-cron claim against three configured schedules

| | |
|---|---|
| **Audited claim** | `ARCHITECTURE.md:23`: "the routes, domains, and two daily cron triggers". `docs/architecture.md:256`: "1 daily cron". |
| **Committed owner** | `worker/wrangler.toml` `[triggers] crons` — three schedules, derived as `release_infrastructure.crons`. |
| **Finding** | `miscounted_claim` on `worker-cron-count`, carrying the declared quantity and the derived one. |
| **Positive control** | `worker/README.md`'s "next daily cron" is not a quantity and raises nothing; the corrected "three daily cron triggers" matches the derived count. |
| **Consequence if unchecked** | An entire unattended job is invisible to anyone reasoning about what runs on a schedule. |

### D3 — A diagram naming one schedule as the whole schedule set

| | |
|---|---|
| **Audited claim** | `docs/architecture.md:170`, inside the fenced system map: "Cron (daily 13:00 UTC)". |
| **Committed owner** | The same `[triggers] crons` table. |
| **Finding** | `contradicted_claim` on `worker-cron-diagram-sole-schedule`. |
| **Why it is separate** | The reconciler strips fenced blocks, so this claim was structurally unreachable to the existing check. A system map is read as the complete picture, which is what makes a single labelled cron box an assertion rather than an abbreviation. |
| **Positive control** | The corrected diagram box, which names three schedules, raises nothing. |

### D4 — Active object-storage custody against a disabled binding

| | |
|---|---|
| **Audited claim** | `docs/architecture.md:181`, inside the fenced system map: "R2: SOURCE_VAULT — content-addressed custody for approved public documents". The same sentence at `:199`, and "+ 1 R2 source vault" in the summary at `:256`. |
| **Committed owner** | `worker/wrangler.toml` — the `[[r2_buckets]]` table and its `binding` line are commented out, and `[vars] SOURCE_VAULT_ENABLED = "false"`. Derived as `release_infrastructure.binding_active.SOURCE_VAULT: false`. |
| **Finding** | `contradicted_claim` on `r2-source-vault-custody`. |
| **Positive control** | The corrected sentence, which calls the same thing a custody *design* and states it is not an active store, raises nothing. The qualifier is checked inside the same statement, so a disclaimer three paragraphs away does not excuse the claim. |
| **Consequence if unchecked** | A retention claim: a reader is told source documents are held somewhere they are not. |

### D5 — A no-third-party claim against a configured loader

| | |
|---|---|
| **Audited claim** | `docs/architecture.md:256`: "no third-party trackers". |
| **Committed owner** | `site/clarity.js` `CONFIGURED_PROJECT_ID` — derived as `collection_boundary.third_party_loader.configured: true`. |
| **Finding** | `contradicted_claim` on `third-party-loader-absence`. |
| **Positive control** | The corrected summary keeps the three claims the code supports, drops the fourth, and routes to the owned reference; it raises nothing. |
| **Relationship to the existing check** | `tools/collection_boundary_facts.mjs` already retires this phrase across four documents unconditionally. This lane adds the two release documents and the fenced surfaces, and makes the finding conditional on the loader still being configured, so retiring the loader retires the finding too. |

### D6 — A no-product-use claim against the published search counts

| | |
|---|---|
| **Audited claim** | `docs/architecture.md:199`: "public `/stats` never reads or returns product-use telemetry". |
| **Committed owner** | `worker/src/lib/public_search_usage.mjs` `PUBLIC_SEARCH_USAGE_METRICS` — two published metric ids, derived as `collection_boundary.public_search_usage.metric_ids`. |
| **Finding** | `contradicted_claim` on `public-stats-product-use`. |
| **Positive control** | The corrected sentence, which says the route reads nothing from the analytics dataset and names the two period-bounded counts it does publish, raises nothing. |
| **Consequence if unchecked** | A maintainer treats a reviewed, allowlisted projection as a leak. |

### D7 — A completed-materialization claim hiding the recorded departures

| | |
|---|---|
| **Audited claim** | `docs/architecture.md:3` (frontmatter summary): "CityScroll-owned materialized read models are the exclusive delivery path for resident and required-CI reads." `ARCHITECTURE.md:47`: "does not trigger a request-time publisher lookup." |
| **Committed owner** | `architecture/no-live-external-debt.json`, whose open entries still include the `/notice` route declared in `architecture/resident-read-policy.json` `first_party_routes.temporary_debt` and gated by `tools/no_live_external_reads.mjs`. |
| **Finding** | `contradicted_claim` on `materialization-completed`. |
| **Positive control** | The corrected documents state the same rule as the standing target and say plainly that it is not a finished migration. That wording is registered as an explicit control and must stay clean. |

### D8 — An exception list closed without naming the recorded departures

| | |
|---|---|
| **Audited claim** | `ARCHITECTURE.md:13`: "None permits request-time publisher-data retrieval for a resident read." — as a complete statement, with no reference to the departures. |
| **Committed owner** | The same debt manifest and policy. |
| **Finding** | `unqualified_claim` on `materialization-exception-closure`. |
| **Positive control** | Two of them. The corrected `ARCHITECTURE.md` bullet closes the same list and continues "and none covers the migration departures recorded below". `docs/architecture.md`'s exception paragraph, which was **already** honest at the pinned revision because it names the debt manifest in the same paragraph, raises nothing at either revision — the frozen audited fixture carries that paragraph verbatim to prove the rule is not firing on the shape of the sentence. |
| **Why the qualifier is scoped to the statement** | An absolute and its qualifier have to be readable together. A qualifier elsewhere in the document does not reach the reader who stops at the absolute. |

### D9 — An invariant stated with no pointer to the recorded departures

| | |
|---|---|
| **Audited claim** | `ARCHITECTURE.md:12` states the materialization-only invariant, and the document names the debt manifest nowhere. |
| **Committed owner** | The same debt manifest and policy. |
| **Finding** | `missing_exception_reference` on `materialization-exception-reference`, raised once per document. |
| **Positive control** | `docs/architecture.md` at the pinned revision already referenced the manifest, and raises nothing. The corrected `ARCHITECTURE.md` links it twice. |

## The control that separates this from a wording lint

The frozen case carries a fourth control,
`same-wording-true-under-different-configuration`: the audited wording of D2, D3,
D4, D5 and D1, replayed against derived facts under which one cron is configured,
the R2 binding is active, no loader is configured, no public metric is published,
no departure is open, and the Worker workflow really is manual-only. Nothing
fires. The identical documents against the audited facts do fire. A guard that
merely disliked these phrases could not produce both results.

## Blocking and non-blocking outcomes

`contradicted_claim`, `miscounted_claim`, `unqualified_claim` and
`missing_exception_reference` fail `--check`. `review_needed` does not, and is
printed on every run including a clean one, so a passing check cannot be read as a
completed semantic review. The observation status is `review` rather than
`healthy` whenever an unsettled claim is outstanding, and the frozen case asserts
that status for the working tree rather than accepting a green.

The current review obligations are the unverified native-builds connection, what
the configured third-party loader actually does at a reader's browser, and whether
the materialization target is still the accepted direction of travel. Each names
its adjudicator; none carries a review date.
