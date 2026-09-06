# ADR: Source-qualified person identity seam

| Field | Value |
| --- | --- |
| Status | Proposed |
| Date | 2026-08-29 |
| Scope | Natural-person representations and the minimum future identity architecture |
| Supersedes | — |
| Related | `docs/adr/ontology-registry-v0.md` §1c, `docs/adr/link-not-merge.md`, `docs/adr/entity-resolution-taxonomy.md`, `docs/evidence/person-representation-inventory.md`, `ontology/person.mjs`, `ontology/person_identity_link_ledger.mjs` |
| Non-goals | No identity migration, no new public person object, no name-only merge |

## Context

CityScroll already has several person-like records: Council `official:{PersonId}`,
the Council Members person hub, agency `person-leader` heads, People +
organizations rows whose machine kind is `exact-person-appointment`, City Record
staffing notices, payroll **board** bindings, and Community Board
`community-board-person` roster identities. Those records are easy to mistake
for one generic human. Community Board work must not inherit Council votes,
finance, lobbying, or `/officials/{id}/` by display name, and it must not
name-match roster members into payroll employees.

CBO-4 already shipped board-local people and temporal roles. Registry v0.7.0
already registers an additive `cityscroll.person.v1` envelope and
`person_identity_link.v1`. This ADR does not replace those contracts. It records
the minimum seam so a later implementation card can consume them without a
second generic person object.

The inventory of current representations is
`docs/evidence/person-representation-inventory.md`.

## Decision

Keep institutional meaning on **source-qualified identities**. Resolve to a
canonical person only through **exact or reviewed** proof. Attach
role/tenure/membership to the source identity (and, after acceptance, optionally
to the canonical person) rather than collapsing bodies into one person record.

```
source-person identity
  → (exact / reviewed resolution)
  → canonical person          # optional; null until accepted
  → role / tenure / membership
  → organization / body
```

### Layer 1 — Source-person identity (required, already shipping)

Each publisher family keeps its native id and must remain addressable after any
later link:

| Family | Source identity | Native key | Notes |
| --- | --- | --- | --- |
| Council official / hub | `official:{PersonId}` | Legistar / `uvw5-9znb` `council_member_id` | Sole owner of Council profile capabilities |
| Community Board roster | `community-board-person:{board}:{publisher_or_reviewed_key}` | Board-local | Distinct even when the local key equals a PersonId |
| Agency head | `person-leader:{agency_id}:{id\|name}` | Crosswalk head row | Agency-scoped; not a general employee |
| Staffing hire | `hire:{request_id}` / notice `request_id` | City Record | `person_id` stays null |
| Payroll | `payroll_number` → `community-board:{id}` | OPA agency code | Organization identity; employee rows unpublished |

Display name is never an identity token (`ontology/person.mjs:98`,
`ontology/registry.v0.json` `display_name_never_identity`).

### Layer 2 — Exact / reviewed resolution (ledger shipped)

Wrap a source identity in `cityscroll.person.v1` without rewriting it:

- Council alias: `person:legistar:{PersonId}` with `source_alias.identity = official:{PersonId}` (`ontology/person.mjs:203-224`).
- Board alias: `person:community-board:{board}:{key}` with `source_alias.identity = community-board-person:…` (`ontology/person.mjs:226-249`).
- `canonical_person_ref` on the projection is always null at wrap time (`ontology/person.mjs:193`).

`person_identity_link.v1` is the only same-person mechanism (`ontology/person.mjs:272-307`):

- endpoints must be generic `person:…` identities, not display names;
- method is fixed `explicit_reviewed_assertion`;
- evidence must include a source locator;
- statuses: `candidate` / `accepted` / `rejected`;
- only `accepted` may populate `canonical_person_ref`.

The production review ledger is `ontology/person_identity_links.jsonl`, an
append-only JSON Lines file written by `ontology/person_identity_link_ledger.mjs`.
Line 1 is the ledger header, which states the ledger's own rules in-band; every
later line is one reviewed decision. Appending is the only write: a reviewer who
changes their mind appends a new record for the same pair, and the superseded
record stays on disk and stays inspectable.

Materialization is accepted-only. `canonical_person_ref` is populated for a pair
whose most recent stored record is `accepted`; a candidate, a rejected record,
and a superseded accepted record all materialize nothing. Candidate and rejected
records are kept as non-linking evidence in the diagnostics listing
(`node tools/check_person_identity_link_ledger.mjs --diagnostics`) rather than
being dropped, so they are never read as accepted identity.

The gate is `node tools/check_person_identity_link_ledger.mjs --check`, wired
into the static-standards contract checks in CI and into
`tools/preflight-required-checks.sh`. It prints one line per violation and exits
non-zero when a stored link's method is not `explicit_reviewed_assertion`, its
evidence carries no source locator, or an endpoint is a display name or a
non-generic id (`official:…`, `community-board-person:…`).

The ledger currently holds no reviewed assertion. That is an unreviewed state,
not an inferred empty-negative (“nobody is the same person”).

Name-only, unique-name, or payroll-name resemblance must not create a link.
Lobby/CFB unique name keys bind **targets onto an already exact hub person**;
they are not a general resolver (`site/official_influence.mjs:4-6`).

### Layer 3 — Canonical person (optional, not a route)

A canonical `person:{namespace}:{key}` reference may be recorded on an accepted
link. It does not replace source ids, does not mint `/people/{id}/` or
`/officials/{id}/`, and does not grant Council capabilities
(`ontology/person.mjs:326-351`; `ontology/registry.v0.json` `public_route: null`).

Do **not** create a second generic person object. The envelope already exists.

### Layer 4 — Role / tenure / membership (source-qualified)

Roles stay on typed edges, not on the person id:

- Council: hub `terms[]`; `member_of` committee; `votes_on`.
- Community Board: closed roles and `member_of` / `chairs` / `staffed_by` /
  `works_for` (`site/community_board_relations.mjs:17-29,321-391`).
- Agency head: current `head_title` only.
- Staffing hire: notice fields only.
- Payroll: board-level ACTIVE counts, never person roles.

Unknown tenure stays unknown. Historical Council resolution must use `terms[]`,
not `current_term`.

### Layer 5 — Organization / body

Bodies remain distinct institutions: City Council, Community Board,
`community-board-committee`, agency. A later accepted same-person link does not
merge those bodies or copy Council UI onto a board person.

## Consequences

- The reviewed ledger and its check-mode gate ship with this seam. Future
  implementation cards add consumers for accepted `person_identity_link.v1`
  records, additional grounded board rosters, or search-token alignment. They do
  not migrate `official:` or `community-board-person:` ids.
- `/browse/people/` may keep machine kind `exact-person-appointment` until a
  separate rename; reader copy is already “City Council term”.
- Staffing names stay notice-scoped. Payroll employee rows stay unpublished.
- Capability allowlists remain the Council isolation gate.

## Alternatives considered

1. **Mint a new generic person object now.** Rejected: `cityscroll.person.v1` is
   already registered; a second object would split the seam this inventory is
   meant to preserve.
2. **Unify by display name.** Rejected: false same-human merges across Council,
   boards, payroll, and hires. Tests already forbid it.
3. **Migrate all families onto `official:{PersonId}`.** Rejected: Council
   surfaces and routes are PersonId-specific; board people must not inherit them.
4. **Treat payroll_number as a person key.** Rejected: it identifies a Community
   Board employer unit; serving employee rows is a hard product rule.

## Follow-on work (not this ADR)

Awaiting implementation, explicitly:

- Consumers that read accepted ledger records onto a public surface.
- Optional alignment of People search `object_ref` `person:{id}` with
  `person:legistar:{id}` without changing `/officials/{id}/`.
- Additional board roster grounding beyond Manhattan CB6.
- Optional rename of machine kind `exact-person-appointment` after reader copy
  (already “City Council term”).
