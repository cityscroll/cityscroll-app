# ADR: Discoverable Community Board watches

| Field | Value |
| --- | --- |
| Status | Accepted |
| Date | 2026-08-24 |
| Scope | `/following` watch creation flow |
| Supersedes | — |
| Related | `site/following_view.mjs`, `worker/src/following.mjs`, `site/app/following.mjs` |

## Context

Community Board watches already compile correctly from the `boardBorough` and
`boardNumber` controls. Those controls are shown only for the meetings lens,
while a user arriving at `/following?lens=district` sees the related City
Council District control first. The existing copy distinguishes the two
geographies but did not provide a path to the Community Board picker.

## Decision

Keep the existing Community Board picker and make the district disambiguation
copy actionable. The link opens the meetings watch lens, where the existing
refinement panel is open and the borough plus board-number controls are visible.
The district hint remains intact, and the district lens continues to compile as
before. The worker continues to use the shared document renderer; no duplicate
Worker or client-side picker is introduced.

## Consequences

- A user can move from the district entry point to Community Board watch setup
  without knowing that the picker lives under the meetings lens.
- Meetings-lens entry points expose the existing picker immediately.
- Community Board identity, filtering, and delivery behavior remain owned by
  `site/community_board_watch.mjs` and the existing following form.

## Evidence

- `test/following_route.test.mjs` covers the actionable district link and the
  visible meetings-lens picker.
- `docs/screenshots/following-community-board-discoverability/` contains the
  headless before/after capture pair.
