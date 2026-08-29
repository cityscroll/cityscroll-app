# CityScroll Reader Journey & Surface Coherence

**Stable ID:** `cityscroll-reader-journey`<br>
**Card standard:** `kraken-v1`<br>
**Status:** proposed<br>
**Release checkpoint:** RJ-07

## Objective

Preserve CityScroll's forward-looking focus while making its historical and analytical capabilities discoverable through coherent reader journeys.

This is a portfolio-level workstream over existing reader-facing work. It is not a request to add another dashboard, tab, card, disclosure, or explanatory layer.

The workstream may recommend and execute changes to the current queue when needed: pause, amend, reorder, merge, split, supersede, or replace proposed and in-progress cards whose local acceptance criteria would degrade the surrounding reader experience. Prefer changing queued work before paying for implementation and later cleanup.

Do not disturb sound ingestion, ontology, identity, provenance, API, or machine-consumer work merely because its current UI projection needs reconsideration. The target is the organization of reader-facing capabilities, not the underlying evidence model.

## Problem statement

CityScroll's workstreams are producing individually correct capabilities that compete for finite page hierarchy.

Recent examples show a recurring pattern:

1. A workstream identifies a real information gap.
2. Its card commissions an additive reader-facing projection.
3. Acceptance proves that the new module is accurate, accessible, source-backed, and locally understandable.
4. The surrounding page is treated as immutable.
5. Later cards inherit the same surface and add another section, selector, matrix, strip, or disclosure.
6. Cleanup PRs then consolidate empty states, split incompatible tables, correct navigation semantics, or hide controls that should not have been prominent.

This is feature accretion under local acceptance criteria: every card passes while the total reader journey deteriorates.

### Accretion lineage

The clearest lineage is:

* `cityscroll-procurement-analytical-projection/ap-04-reader-facing-analytical-projection`
* `cityscroll-procurement-analytical-projection/ap-06-city-record-match-coverage`
* `cityscroll-procurement-analytical-projection/ap-09-add-payments-as-second-fact`
* `cityscroll-procurement-analytical-projection/ap-10-performance-evidence-gap`
* `cityscroll-procurement-analytical-projection/ap-12-agency-procurement-fiscal-context`
* `cityscroll-cb-money/cb-money-04`
* `cityscroll-cb-money/cb-money-05`

Relevant merged PRs include #1254, #1265, #1291, #1318, #1330, #1339, #1364, #1368, #1374, #1375, and #1377.

The existing Contracts path already exposes actual payments, but the information scent is weak: a reader must enter the forward-looking Recent Awards surface and discover the analytical Fact selector. Meanwhile, the always-visible City Record coverage matrix is much more prominent than the historical contract-to-payment capability that a journalist or procurement researcher is more likely to seek.

## Authority and sequencing

Treat this as a meta-workstream with authority to change the delivery sequence of neighboring workstreams where reader-facing surface coherence is implicated.

Work in this order:

1. Reconcile current GitHub implementation with live Kraken state.
2. Stop the bleeding by inspecting and amending queued reader-facing cards before they execute.
3. Audit recently shipped surface changes and identify a small number of consolidating changes.
4. Implement the highest-value reader journey, beginning with historical Contracts exploration.
5. Install a durable reader-journey gate for future work.

RJ-01 through RJ-07 make that order executable: reconciliation, queue triage, shipped-surface audit, Contracts journey, agency and Community Board consolidation, permanent gate, and portfolio evidence. A later phase may not declare a preceding phase complete merely because its code exists; it must consume the preceding phase's recorded evidence and truthful status.

This workstream may hold, amend, reorder, merge, split, supersede, or pause neighboring reader-facing cards. It does not have authority to erase source observations, change canonical identities, weaken provenance, or turn an unknown into an outcome. The authoring change itself performs none of those queue or product mutations; RJ-01 dispatches separately after this specification is merged.

Do not preserve the current queue merely because cards already exist. A proposed card is a hypothesis, not an entitlement to screen real estate.

Do not automatically cancel a valuable capability. It may instead become:

* part of an existing summary;
* a step in a coherent journey;
* a contextual state shown only when relevant;
* a secondary analytical view;
* a dedicated route;
* a disclosure beneath a concrete fact;
* a machine/API capability without a default reader projection;
* or a replacement for older, weaker furniture.

### Concurrent neighboring workstream

The `procurement-lifecycle-actions` workstream is being authored concurrently in a separate task. Its `PLA-02` procurement journey timeline and `PLA-03` lifecycle browse/search/watch actions create reader-facing surfaces. Once RJ-06 lands, both cards fall under the permanent reader-journey gate. RJ-02's triage scope therefore extends to newly authored reader-facing cards, including PLA-02 and PLA-03, and is not limited to the five named cards below. No conclusion about those cards is made by this authoring PR; the disposition belongs in the later triage evidence.

## Reader hierarchy

Apply this progressive-disclosure order:

1. **Orientation:** What is this object or population, and why might I care?
2. **Useful summary:** What is the most decision-relevant fact or next action?
3. **Exploration:** What agencies, vendors, contracts, payments, meetings, or other objects contribute?
4. **Evidence:** Which exact records support the claim?
5. **Methodology and coverage:** How was it joined, what is missing, and what cannot be inferred?

Source honesty remains mandatory, but methodology must not routinely outrank the fact it qualifies.

A zero-signal analytical population must not produce a large default matrix merely because the matrix is technically correct.

## First consolidating reader journey: historical Contracts

Preserve the current forward-looking Contracts default. Add a clearly scented secondary path such as “Explore contract history” or an equivalent label consistent with existing CityScroll language.

The target journey is:

`Contracts → historical exploration → agency → top vendors / largest contracts → contract → observed payments`

The reader should not need to understand CityScroll query parameters, know a contract identifier, or discover that “Actual payments” is hidden inside a Fact selector.

Use one real agency and one real contract with public Checkbook payments as canaries.

The workstream may decide whether the best historical entry is a dedicated route, a secondary mode, an agency-first directory, or another structure supported by the current application. Do not assume the answer is another tab.

## Consolidation targets

### Contracts

* Keep upcoming and newly published procurement prominent.
* Make historical agency/vendor/contract exploration deliberately discoverable.
* Present registered value separately from observed public payments.
* Make contract-level payment history reachable from aggregate payment views.
* Move City Record match coverage and performance-evidence coverage into a secondary Data coverage, Methodology, or research-oriented analytical location.
* When no performance evidence has been located, prefer a compact scoped statement over a full zero-information matrix.

### Agency dossiers

* Give readers a compact route to top vendors, largest contracts, and observed payments.
* Preserve exact drill-through to contributing records.
* Keep IBO fiscal history available without letting long historical tables dominate the default agency identity and procurement journey.
* Never combine non-overlapping historical and current measures in a visually undifferentiated table.

### Community Board dossiers

* Preserve the distinction between the board as an institution and the district as geography.
* Retain useful money, governance, meeting, people, committee, and participation capabilities.
* Consolidate them into a coherent summary and action structure rather than granting each workstream another always-visible section.
* Keep repeated empty categories suppressed.
* Prefer one compact coverage statement over a parade of empty modules.

## Acceptance criteria

### A1 — Kraken/GitHub reconciliation

Every reader-facing PR from #1254 through #1385 maps to its stable Kraken card or is explicitly recorded as uncommissioned work.

For each mapped card, record:

* merged PR;
* realized outcome;
* current acceptance state;
* remaining gap;
* truthful lifecycle status;
* and whether follow-on work is still warranted.

No downstream card may proceed from a dependency whose Kraken state materially contradicts current GitHub without first reconciling that state.

### A2 — Queue triage

Each identified high-risk proposed or in-progress card receives an explicit disposition: retain, amend, resequence, merge, split, supersede, or pause.

Every retained reader-facing card must state:

* the reader question;
* the ordinary entry path;
* the exact destination surface;
* its default or disclosed state;
* what existing element it replaces, consolidates, or subordinates;
* behavior for empty, partial, unresolved, or zero-signal data;
* one meaningful positive fixture;
* and the expected full-page effect.

### A3 — Historical discovery

Starting from the ordinary Contracts entry, a reader reaches a historical agency comparison through one clearly labeled action and reaches a contributing vendor or contract within two additional purposeful interactions.

The journey works without text search, prior contract knowledge, or manual URL editing.

### A4 — Contract payments

A real registered contract with public Checkbook spending displays:

* registered contract value;
* cumulative observed public payments;
* first observed payment date;
* most recent observed payment date;
* payment transaction count;
* and exact transaction/document drill-through.

Absence is phrased as “No public payment observed” or equivalent and never as “unpaid.”

### A5 — Default hierarchy

The ordinary Contracts default no longer places a full City Record agency-coverage matrix ahead of historical contract/payment exploration.

Performance-evidence coverage with zero located evidence does not render a full default table.

Coverage and methodology remain reachable and source-complete through a deliberate secondary path.

### A6 — Agency and Community Board consolidation

At least one representative agency and one representative Community Board demonstrate the consolidated hierarchy at desktop and mobile widths.

The result must reduce or maintain the number of equally weighted default sections. Merely wrapping every existing section in its own disclosure does not count as consolidation.

### A7 — Permanent reader-journey gate

Any future PR adding a reader-facing section, panel, tab, selector, timeline strip, matrix, card family, or persistent disclosure must provide:

* the stable Kraken card;
* the reader journey and entry point;
* full-page before/after captures at 390px and 1440px;
* default-versus-disclosed behavior;
* the consolidation or displacement decision;
* a meaningful positive fixture;
* empty/partial behavior;
* and a test showing that the destination remains reachable from its normal entry surface.

A new always-visible top-level section that replaces or consolidates nothing requires explicit surface-owner approval.

### A8 — Portfolio result

The final evidence must show not only that the new workstream shipped something, but that CityScroll now presents fewer competing default choices while preserving or improving access to the underlying capabilities and evidence.

## Stop conditions

Stop and reconsider if the workstream:

* becomes another general dashboard;
* adds a “Reader journey” panel instead of repairing journeys;
* treats disclosure as a license to preserve unlimited clutter;
* removes evidence or machine capabilities merely to simplify presentation;
* hides a meaningful unresolved state that changes interpretation;
* creates a second aggregation or identity path;
* commissions UI for a population with no useful positive specimen;
* or leaves queued cards unchanged while adding compensating navigation around them.

The desired outcome is not “all existing work remains visible somewhere on the same page.” It is that CityScroll's substantial underlying capabilities become easier to discover because the product has made decisions about sequence, priority, and place.

## Design notes and validation

The seed's product rule, hierarchy, acceptance semantics, authority framing, and stop conditions remain normative. The following notes record what was verified in the repository and the adaptations needed to make the specification fit the actual checkout.

### Verified source facts

| Seed claim | Repository evidence | Design consequence |
| --- | --- | --- |
| Actual payments are discoverable only after entering Recent Awards and finding a fact selector. | `site/index.html` defines `#contracts-analytics` with `hidden` by default. The `#analytics-fact` selector has `Registered contracts` and `Actual payments`; `site/app/money-list.mjs` only opens the analytics panel when `mode === "award"` and switches on `ap_fact=payment`. | RJ-04 must improve information scent from the ordinary Contracts entry without collapsing registered value and payments. The target is not a new payment fact or a second aggregation. |
| The City Record coverage matrix is prominent. | The `#contracts-analytics-coverage` section in `site/index.html` is not initially marked `hidden`, while concentration, timing, and performance-evidence sections are hidden. `site/app/money-list.mjs` explicitly unhides coverage for registered-contract overview/timing and hides it for the performance-evidence view. | The seed's “always-visible” wording is precise at the registered-contract analytics layer, not a claim that the matrix is on every ordinary Contracts list render. RJ-03/RJ-04 must record this scope and move the matrix to a deliberate secondary location rather than silently deleting it. |
| ANP-04 is a negative-rule precedent. | Live card `cityscroll-authority-native-procurement/anp-04` has A10 preserving existing empty-section suppression and A11 rejecting an authority explainer, coverage matrix, warning banner, or generic provenance lecture. | The reader-journey cards carry this as a boundary: empty states remain compact and context-sensitive, and a correct capability does not earn default prominence merely by being implemented. |
| FS-11 is a journey precedent. | Live card `cityscroll-frictionless-subscribe/fs-11-following-create-journey` accepts fewer visible decisions, one canonical Following route, carried scope, progressive refinement, and no subscription before explicit email submission. The repository tests in `test/following_static.test.mjs`, `test/following_suggestions.test.mjs`, and `site/following_view.mjs` exercise that shape. | RJ-04 and RJ-06 use the same journey vocabulary: ordinary entry, purposeful handoffs, preserved state, visible boundaries, and a final action. A screenshot alone cannot prove the journey. |
| The requested agency/board consolidation has real existing seams. | Agency connections and category states are owned by `site/agency_connections.mjs`, `site/agency_constellation.mjs`, `site/agency_constellation_model.mjs`, and `site/agency_constellation_sections/`. Community Board composition is owned by `site/community_board_constellation.mjs`; its source coverage note and category rendering already preserve empty/unknown distinctions. | RJ-05 must consolidate existing projections and preserve their identity, source, and empty-state contracts. It must not create a second agency or board aggregation. |

### Technical adaptations

1. **App-native evidence location.** The repository has no top-level workstream registry, `service.json`, `waves.html`, or card index. Existing `kraken-v1` workstream specifications live under `docs/evidence/<workstream>/` with cards under `cards/proposed/`. This workstream follows that convention; no separate registry/index update is required.
2. **Live queue versus committed specification.** ANP-04, FS-11, and the five triage candidates are maintained in the live queue rather than as local source files in this checkout. The cards identify their stable IDs and the RJ-01/RJ-02 dispatches must read the live records again. This authoring PR does not mutate queue status, acceptance boxes, or dispositions.
3. **Reconciliation helper availability.** The prescribed repository-reconcile helper was not present at its documented checkout path during authoring. RJ-01 therefore makes the fallback explicit: re-read live queue records, inspect GitHub PR state and commits, inspect the current source/tests, and record receipts before any lifecycle update. A future implementation may use the canonical helper when available; the evidence contract does not change.
4. **Capture implementation.** The repository already uses headless capture scripts with 390px and 1440px viewports, including `tools/capture_lifecycle_coherence.py`, `tools/capture_passport_lifecycle.py`, and related evidence manifests. RJ-06 requires that established capture pattern and committed, reviewable paths; it does not permit local-only screenshots or a prose substitute.
5. **Current versus historical measures.** The existing agency fiscal context deliberately separates IBO expenditures/staffing from registered contract value and actual payments. RJ-05 preserves those source labels and non-overlapping measure tables while changing hierarchy and entry paths only where the evidence supports it.

## Dispatch order and dependencies

| Card | Scope | Depends on | Outcome |
| --- | --- | --- | --- |
| RJ-01 | Reconcile GitHub implementation with live Kraken state | Current source, GitHub, and live queue | A1 evidence matrix, including stale metadata, partial acceptance, and real-gap classifications. |
| RJ-02 | Triage queued reader-facing work | RJ-01 | A2 disposition record for the five named cards plus newly authored reader-facing cards, with retained-card contracts. |
| RJ-03 | Audit shipped surfaces and select consolidation | RJ-02 | A bounded before/after surface inventory and a small, prioritized consolidation set. |
| RJ-04 | Implement the historical Contracts journey | RJ-03 | A3–A5 journey, hierarchy, and evidence behavior using real agency and contract canaries. |
| RJ-05 | Consolidate agency and Community Board dossiers | RJ-04 | A6 desktop/mobile representative surfaces with fewer or equally weighted default sections. |
| RJ-06 | Install the permanent reader-journey gate | RJ-05 | A7 durable PR-gate convention covering journey, hierarchy, captures, fixtures, empty states, and reachability. |
| RJ-07 | Assemble portfolio evidence | RJ-06 | A8 evidence showing fewer competing default choices with capability and evidence access preserved. |

The `procurement-lifecycle-actions/PLA-02` and `PLA-03` cards are related reader-facing work, not dependencies of this authoring PR. They must enter RJ-02's expanded triage scope and satisfy RJ-06 after the gate is installed.

## Card map

* [RJ-01 — Reconcile GitHub implementation with live Kraken state](cards/proposed/rj-01-kraken-github-reconciliation.md)
* [RJ-02 — Triage queued reader-facing work](cards/proposed/rj-02-stop-the-bleeding-queue-triage.md)
* [RJ-03 — Audit shipped surfaces and choose consolidations](cards/proposed/rj-03-shipped-surface-audit.md)
* [RJ-04 — Make historical Contracts exploration discoverable](cards/proposed/rj-04-historical-contracts-journey.md)
* [RJ-05 — Consolidate agency and Community Board dossiers](cards/proposed/rj-05-agency-community-board-consolidation.md)
* [RJ-06 — Install the permanent reader-journey gate](cards/proposed/rj-06-permanent-reader-journey-gate.md)
* [RJ-07 — Prove the portfolio result](cards/proposed/rj-07-portfolio-evidence.md)
