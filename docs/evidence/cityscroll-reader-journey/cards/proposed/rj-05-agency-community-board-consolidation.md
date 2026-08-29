---
card_standard: kraken-v1
richness_profile: standard
group: must-have
id: cityscroll-reader-journey/rj-05
title: "RJ-05 · Consolidate agency and Community Board dossiers"
status: proposed
wave: cityscroll-reader-journey-agency-community-board
spec: "../../README.md#card-map"
builds_on:
  - cityscroll-reader-journey/rj-04
blocked_by:
  - cityscroll-reader-journey/rj-04
predecessors:
  - cityscroll-reader-journey/rj-04
related:
  - cityscroll-civic-institutions/ci-k1-compatibility-uncertainty-navigation
  - cityscroll-civic-action-paths/cap-6
  - cityscroll-cb-money/cb-money-04
  - cityscroll-cb-money/cb-money-05
context:
  - ../../README.md#reader-hierarchy
  - ../../README.md#consolidation-targets
  - ../../README.md#acceptance-criteria
  - site/agency_connections.mjs
  - site/agency_constellation.mjs
  - site/agency_constellation_model.mjs
  - site/agency_constellation_sections/
  - site/community_board_constellation.mjs
  - site/community_board_scorecard.mjs
  - site/agency_fiscal_context.mjs
verify: "test -s docs/evidence/cityscroll-reader-journey/README.md && test -s docs/evidence/cityscroll-reader-journey/cards/proposed/rj-05-agency-community-board-consolidation.md"
needs_james: false
effort: L
risk: high
target: crol-list
autodispatch: false
goal: "Make agency and Community Board dossiers easier to enter and scan while preserving their distinct identities, evidence, and useful connected-record capabilities."
---
## Story

As a resident opening an agency or Community Board dossier, I need orientation, a useful summary, and a clear next action before long historical or methodological material so that the dossier remains a doorway into civic machinery rather than a stack of independently correct modules.

## Goal

Demonstrate A6 with at least one representative agency and one representative Community Board at desktop and mobile widths. The result must reduce or maintain the number of equally weighted default sections. Wrapping every existing section in its own disclosure is not consolidation.

The two objects remain different:

* an agency is a civic institution with source-qualified roles, procurement relationships, fiscal context, and exact record links;
* a Community Board is an institution associated with a district, not merely a geographic district and not a generic agency child.

## Representative specimens

Select and freeze specimens from the current source-qualified read models during dispatch:

* **Agency:** a real agency with useful contracts, top-vendor or largest-contract evidence, and observed public payments. The specimen must demonstrate historical/current measure separation and exact drill-through.
* **Community Board:** a real board with at least one useful populated capability among meetings, people, committees, money, governance, or participation, plus an empty/unknown category that tests compact absence behavior. The specimen must retain its board identity and district relationship.

The existing source fixtures and committed artifacts may supply the candidates, but the final receipt must name the selected identity, source vintages, positive evidence, and empty/partial state. A specimen with no useful positive answer is not a reason to add UI.

## Consolidated hierarchy

### Agency dossier

1. Orientation: agency name, source identity, institution state, and what the agency is represented as doing.
2. Useful summary: compact route to top vendors, largest contracts, observed payments, and current procurement activity where evidence exists.
3. Exploration: exact connected-record links for contracts, vendors, rules, mandates, meetings, staffing, and other supported relationships.
4. Evidence: source records, source labels, as-of values, and unresolved/unknown states at the destination.
5. Methodology and coverage: IBO fiscal history, source identity notes, coverage, and measure definitions after the reader has a reason to inspect them.

Keep IBO expenditure/staffing history, registered contract value, and actual payments as separate measures. Do not put non-overlapping historical and current measures into a visually undifferentiated table.

### Community Board dossier

1. Orientation: board identity, borough/district relationship, and source freshness.
2. Useful summary/action: one compact set of useful records and supported ways to enter the institution.
3. Exploration: meetings, people, committees, money, governance, participation, maps, and source-backed links.
4. Evidence: exact board-local source joins, eligibility, dates, and record/document destinations.
5. Methodology and coverage: one compact statement for repeated empty or unknown categories, without a parade of empty modules.

Keep the board as an institution distinct from its district geography. Keep populated modules useful; consolidate their order and weighting rather than removing their evidence.

## Change

**Before:** Agency and Community Board dossiers expose many valid relationships and source states, but each arriving workstream can add another default section. Readers must scan equal-weight modules to find identity, summary, or action, while empty categories can repeat the same absence.

**After (intended):** Representative dossiers lead with orientation and a compact summary/action structure, route into exact connected records, and place long historical or methodological material after the reader's useful question. Empty, unknown, and partial states remain honest and compact.

**Theory / mechanism:** Consolidation is a hierarchy decision over existing projections. The identity and source contracts remain the narrow waist; the work changes what is first, what is disclosed, and what is linked, not what the data means.

### Gap → fix

| ID | Gap | Fix | Acceptance |
| --- | --- | --- | --- |
| G1 | Valid agency modules compete with the agency's identity and procurement journey. | Lead with orientation and compact procurement summary, then exact connected-record routes. | A6 |
| G2 | Current and historical agency measures can read as one table. | Separate IBO history, registered value, and payments by measure and source. | A6 |
| G3 | Community Board modules can accumulate as independent page furniture. | Compose summary/action and exploration without changing board identity or evidence. | A6 |
| G4 | Repeated empty categories consume hierarchy. | Suppress repetition and use one compact, scoped coverage statement. | A6 |
| G5 | Disclosure can preserve clutter without reducing equal weight. | Require measured first-load order and section weighting; reject disclosure-only wrapping. | A6, stop conditions |

## Evidence and compatibility contract

The implementation must reuse `site/agency_connections.mjs`, `site/agency_constellation.mjs`, the agency constellation model/sections, and `site/community_board_constellation.mjs` owners. It must preserve:

* `agency:id:*` and Community Board `body_id` identity keys;
* exact agency, vendor, contract, meeting, people, committee, money, governance, and participation destinations;
* source labels, data-as-of values, matched/empty/unknown/blocked states, and board-versus-district semantics;
* IBO historical measure semantics and independent payment/registered-contract populations;
* deferred or route-lazy loading that protects first paint where it already exists.

No new aggregation or identity path is permitted merely to support the composition.

## Acceptance

- [ ] A1 [outcome] A representative agency and a representative Community Board demonstrate orientation → summary/action → exploration → evidence → methodology at 390px and 1440px.
- [ ] A2 [outcome] Each representative dossier reduces or maintains the number of equally weighted default sections; disclosure-only wrapping of every old section does not count.
- [ ] A3 [boundary] Agency identity, Community Board institution identity, district geography, exact routes, source labels, as-of values, and unresolved states remain distinct and source-complete.
- [ ] A4 [outcome] The agency provides a compact route to top vendors, largest contracts, and observed payments where the chosen specimen has those facts, with exact contributing-record drill-through.
- [ ] A5 [boundary] IBO fiscal history, registered contract value, and actual payments remain separately labeled and are not visually blended into a single current/historical measure.
- [ ] A6 [outcome] The Community Board preserves useful money, governance, meeting, people, committee, and participation capabilities while composing them into a coherent summary/action structure.
- [ ] A7 [negative] Repeated empty categories become one compact scoped coverage statement or remain suppressed; no empty module claims a meaningful capability.
- [ ] A8 [verification] Positive, empty, partial, and unresolved specimen tests and desktop/mobile captures prove that every retained destination remains reachable from the normal dossier entry.

## Non-goals

Do not rename agency or board identities, make Community Boards generic agency children, delete source evidence, build a new dashboard, or preserve clutter by putting every existing module behind a separate disclosure.

**Grounding:** partial — current agency and Community Board constellation/read-model owners already expose the relevant capabilities and state distinctions; the consolidated hierarchy and representative width evidence remain the RJ-05 delivery.
