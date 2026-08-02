# ADR: Subject registry (typed subject_ref links)

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-01 |
| Scope | Shared subject_ref vocabulary + typed links on lifecycle and civic-time fixtures |
| Supersedes | — |
| Blocks | Optional later graph/UI walks that consume `subject_links` |

## Context

Civic-time envelopes, entity-resolution source records, ops action-log objects, and the
claim layer each name real-world objects. Money award chains historically used **split**
`subject_ref` values (`notice:…` for publication and `contract:…` for registration) with
**no edge** connecting them. That made cross-spine investigation walks impossible even when
Checkbook lifecycle already joined the same PIN/CT chain.

Rewriting every event onto one subject would destroy publisher provenance (a notice is not a
contract). The product needs **link-not-merge** for subjects the same way ER uses
link-not-merge for entities.

## Decision

Adopt a **subject registry** pure library (`worker/src/lib/subject_registry.mjs`):

1. **Closed kinds** for `subject_ref` (`notice`, `contract`, `project`, `pin`, `vendor`,
   `agency`, `legistar-event`, `rules`, `entity-pair`, `entity`).
2. **Parse/format only** — unknown kinds fail closed; ids are never rewritten across kinds.
3. **Typed links** (`registered_as`, `references_contract`, `shares_authority_key`, …)
   connect distinct subjects. Link types align with the public relationship graph where
   names already exist (`references_contract`).
4. **Product surface:** `assembleLifecycle` stamps `subject_refs` + `subject_links` when a
   confident registered (or pending) contract id is joined. Ambiguous multi-id registration
   does not invent a contract subject. Rules materialization and meeting-outcomes stamp
   `subject_refs` + `about_notice` links for matched notice↔`rules` and
   notice↔`legistar-event` joins only (`linksFromRuleRecord` / `linksFromMeetingRecord`).
5. **Civic-time fixtures** may declare `subject_links` beside assertions without changing
   envelope identity fields.
6. **Claim layer / action log** accept optional registry refs so multi-source claims and
   desk pair objects share the same vocabulary.

### Metric

`cross_subject_link_rate` on modern PIN-bearing award field cases:

```
linked_cases / eligible_cases
```

where a case is eligible when it has notice + contract + pin, and linked when the product
surface link set connects `notice:…` to `contract:…`. The registry does **not** invent
edges for the rate numerator.

Field cases live in `worker/test/fixtures/subject-registry/pin_bearing_awards.json`.

## Non-goals

- No production event store or new public HTTP route in this card
- No silent collapse of notice subjects into contract subjects
- No desk disposition → `entity_link` write (separate enrichment card)

## Verify

```bash
node --test worker/test/subject_registry.test.mjs
node --test worker/test/checkbook_lifecycle.test.mjs
node --test worker/test/civic_time_contract.test.mjs
node worker/scripts/civic-time-diff.mjs --fixtures worker/test/fixtures/civic-time --check
```

## Rollback

Remove `subject_registry.mjs`, its tests/fixtures, lifecycle/claim/action-log stamps, the
money fixture `subject_links` block, and this ADR. Cached lifecycles without the new fields
remain valid JSON for older readers.
