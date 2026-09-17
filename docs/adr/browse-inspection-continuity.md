# ADR: Browse inspection continuity

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-09-16 |
| Scope | Resident collection browsing: calendars, lists, search results, spatial results, and board positions |
| Supersedes | — |
| Related | `docs/architecture.md`, `docs/design-principles-contextual-ux.md`, `site/affordance_grammar.mjs`, `site/browse_inspection_contract.mjs`, `site/browse_return_context.mjs`, `site/calendar_event_preview.mjs`, `test/standards/resident_surface_catalog.py` |

## Context

Resident collections already share affordance roles (`inspect`, `navigate`,
`handoff`), calendar preview dialogs, and browse-return restoration. Those
pieces coexist with sibling Preview controls beside title anchors, direct
result links that leave a collection, and row-selection rules that change by
record shape. A contributor copying nearby code therefore inherits conflicting
interaction hierarchies.

General contextual-UX guidance and structural copy checks are not enough to
make the default discoverable and enforceable. Ordinary site navigation,
directories whose sole purpose is navigation, downloads, and explicitly named
actions must remain direct; the contract is a default for collection browsing,
not a requirement that every link open a modal.

## Decision

Make browsing continuity an architecture contract with one maintained inventory:

1. **Overview first.** A collection row or calendar occurrence shows enough to
   scan: faithful title, kind, agency or board when relevant, honest date or
   time precision, and distinguishing status or place when available.
2. **Useful inspection.** The enhanced primary control inspects in place and
   adds decision-relevant facts already present in CityScroll read models. A
   title-and-date-only preview is acceptable only when those are genuinely all
   available facts.
3. **Explicit navigation and actions.** Full-record destinations and
   consequential actions stay separately named controls with native link
   behavior (modified click, context menu, no-JavaScript). Inspection never
   submits, saves, subscribes, or opens a publisher as a side effect.
4. **Coherent restoration.** Dismiss and Back restore applicable scope, query,
   view, selection, and useful focus through existing route and history owners.
5. **Identity.** Domain adapters keep canonical IDs, provenance, and distinct
   absent, failed, and negative states. No invented joins, times, or approvals.
6. **Failure.** Failed detail keeps the last coherent summary and the explicit
   record link, announces failure plainly, and allows recovery without exposing
   diagnostic fields.
7. **Accessibility.** Modal hosts name themselves, inert the background, support
   keyboard reachability and Escape, offer a visible Close, and return focus.
   Nonmodal panels do not claim modality or trap focus.

Every audited browsing family and every shared compact-calendar host declares
primary intent, domain adapter, canonical destination policy, detail host,
restoration adapter, and journey ownership in
`site/browse_inspection_contract.mjs`. Ordinary navigation is a documented
semantic classification (`directory_navigation`) with a positive fixture, not a
silent exception. Legacy violations enter a fingerprinted baseline that can only
shrink. New or changed browsing surfaces must declare themselves and may not
grow that baseline.

Resident reads remain materialization-only. Private workstream identifiers and
mutable delivery plans stay outside public architecture documents.

## Alternatives

- Treat contextual-UX prose and copy gates as sufficient without an inventory.
- Require every link on a collection surface to open a modal.
- Encode private delivery sequencing inside public architecture docs.

## Rationale

An authoritative contract owned by existing architecture and validation surfaces
makes the default checkable without duplicating routing, persistence, or private
planning records. Reusing affordance roles, calendar preview, and browse-return
keeps one interaction grammar across appropriate hosts (modal, day agenda, or
nonmodal selection panel) instead of inventing a second system.

## Consequences

- New browsing implementations declare intent, adapters, hosts, restoration, and
  journey proof before they ship.
- An undeclared browsing surface fails validation.
- Baseline growth fails validation; fixes remove baseline entries.
- Directory-style navigation remains valid when it carries a semantic reason and
  a positive fixture.
- Surface migrations that change primary click meaning proceed as separate
  delivery work against this contract.

## Evidence

- `site/browse_inspection_contract.mjs` — maintained inventory, principles,
  shrinking baseline, and validation.
- `test/browse_inspection_contract.test.mjs` — positive and negative fixtures,
  including undeclared-surface rejection, baseline-growth rejection, and an
  accepted directory-navigation fixture.
- `test/standards/browse_inspection_catalog.json` — catalog projection consumed
  with the resident-surface catalog rules.
- `docs/evidence/browse-inspection-contract/acceptance-manifest.json` —
  revision, route, viewport, fixture vintage, and assertions for the applicable
  enforcement journey.
