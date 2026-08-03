# Civic lifecycle coverage

Last verified: 2026-08-03 against `main` at `3b077fe5` and the deployed site.

CityScroll reconstructs civic processes as source-backed timelines. A process counts as
covered when the product presents its real stages in order, identifies the current and next
action where the source supports one, and labels unavailable stages honestly. Coverage does
not imply that every public body publishes every outcome as machine-readable data.

## Current coverage

| Civic process | Verdict | Product behavior | Evidence |
|---|---|---|---|
| Property disposition | Covered | Exact BBL or borough + block/lot joins group same-agency notices into hearing → auction/RFP → award/conveyance. The Property lens aggregates repeated notices by disposition matter. | [Builder](../worker/src/lib/property_disposition_spine.mjs), [phase view](../site/property_phase_spine.mjs), [characterization](../test/property_disposition_spine.test.mjs), [live example](https://cityscroll.org/#notice/20220504006), [delivery PR](https://github.com/cityscroll/crol-list/pull/305), [Property-lens upgrade](https://github.com/cityscroll/crol-list/pull/370) |
| Civil-service exam to appointment | Covered | One exam-number spine presents application → eligible list → certification → appointment, with source-named empty stages and the published list-establishment cohort statistic. | [Builder](../worker/src/lib/exam_process_spine.mjs), [phase view](../site/exam_phase_spine.mjs), [characterization](../test/exam_process_spine.test.mjs), [live example](https://cityscroll.org/#exam/7016), [delivery PR](https://github.com/cityscroll/crol-list/pull/311), [phase upgrade](https://github.com/cityscroll/crol-list/pull/357) |
| Procurement intermediate stages | Covered | Intent to Negotiate, Vendor List, and Intent to Award appear in the Selection phase between solicitation and award. PIN siblings are deduplicated and the action rail prevents closed selection stages from being presented as open bids. | [Lifecycle assembly](../worker/src/lib/checkbook_lifecycle.mjs), [phase view](../site/procurement_phase_spine.mjs), [characterization](../test/procurement_phase_spine.test.mjs), [live example](https://cityscroll.org/#notice/20260618041), [delivery PR](https://github.com/cityscroll/crol-list/pull/318) |
| Franchise and concession review | Covered | Related City Record notices form a solicitation → public hearing → committee meeting → award spine using exact counterparty, plan-year, or rules-subject keys. Stage-tied actions use published response, participation, and contact details. | [Builder](../worker/src/lib/franchise_concession_spine.mjs), [phase view](../site/franchise_phase_spine.mjs), [characterization](../test/franchise_concession_spine.test.mjs), [live example](https://cityscroll.org/#notice/20251007003), [delivery PR](https://github.com/cityscroll/crol-list/pull/314), [phase upgrade](https://github.com/cityscroll/crol-list/pull/354) |
| Non-Council hearing outcomes | Covered with structural publication limits | The spine presents notice published → hearing → outcome/votes → minutes. City Record fills the first two stages; outcome and minutes remain explicit “not published” stages with real borough-president and community-board landing links. No vote or result is inferred. | [Builder](../worker/src/lib/non_council_hearing_spine.mjs), [characterization](../test/non_council_hearing_spine.test.mjs), [live example](https://cityscroll.org/#notice/20251110015), [delivery PR](https://github.com/cityscroll/crol-list/pull/316), [Meetings-lens upgrade](https://github.com/cityscroll/crol-list/pull/378) |

## Presentation contract

These timelines use the same product conventions:

- real domain stages rather than generic chronology;
- one coherent matter or subject per timeline, with duplicate notices aggregated;
- provenance links on matched stages;
- a current-stage lead and next action only when published evidence supports it;
- compact future-stage chips and source-specific gap language instead of invented events;
- precomputed or edge-materialized read models for default delivery, with live upstream calls
  reserved for parameterized or fallback paths.

The characterization tests linked above are the regression boundary for the five process
families. Broader timeline conventions are documented in the
[civic-time event contract](adr/civic-time-event-contract.md) and the
[gap taxonomy](gap-taxonomy.md).
