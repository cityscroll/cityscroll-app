# Civic Action Paths

Action Path v0 is a derived product projection, not a universal graph noun. It
composes an already grounded civic subject, an already validated action from
`site/action_registry.js`, grounded identifiers and edges for the action target,
an optional replayable continuation subject or scope, and provenance explaining
why the path is shown. It does not create `action_opportunity`,
`resident_action`, `intervention`, or a second action registry.

This document is the architecture receipt after the Community Board proving
slice and grounded-coverage measurement. It records the contract, continuation
safety, Community Board evidence policy, current domain coverage, remaining
gaps, and how to add a future adapter without turning unknown into zero or a
broad fallback.

Current-main characterization of rails, calendar, Following, Council joins,
and board surfaces lives in
[`docs/evidence/civic-action-paths/before/characterization-receipt.md`](evidence/civic-action-paths/before/characterization-receipt.md).
The machine generalization audit is
[`docs/evidence/civic-action-paths/generalization-audit.json`](evidence/civic-action-paths/generalization-audit.json).
Grounded coverage ratios and diagnostic classes are
[`docs/evidence/civic-action-paths/action-path-coverage.json`](evidence/civic-action-paths/action-path-coverage.json).
The closing documentation receipt is
[`docs/evidence/civic-action-paths/documentation-receipt.json`](evidence/civic-action-paths/documentation-receipt.json).

## Action Path v0 contract

The shared capability is `site/action_path_v0.mjs`
(`cityscroll.civic_action_path.v0`). It is a pure descriptor and validator:

- no publisher fetch
- no watch mutation
- no DOM rendering
- no actor, account, session, or behavioral fields

The existing action object remains authoritative. `validateAction` still
requires a visible HTTPS destination for official handoffs and rejects a
destination on an unavailable action. An Action Path wraps that validated
action; it does not replace it.

A published path carries:

| Field | Meaning |
| --- | --- |
| `subject_ref` | The civic object the resident is looking at |
| `target_ref` | The grounded object the action affects |
| `action` | The validated registry action (`attend`, `comment`, `document`, `watch`, …) |
| `process_ref` | Optional process identity when one exact continuation is known |
| `continuation` | Optional exact subject or replayable scope, or a choice list |
| `evidence` / `provenance` | Source refs, URLs, or receipts that explain why the path is shown |
| `availability` | `available`, `unavailable`, or `unknown` |
| `ambiguity` | `none`, `multiple`, or `unknown` |

A continuation may be absent. An otherwise valid Attend or Comment action
remains usable when CityScroll cannot ground what should be followed afterward.
Ontology registration is the kinetic capability `action_path_v0` in
`ontology/registry.v0.json`. There is no `action_path` semantic object type.

Copy should name the machine part that moves next: “Follow what happens next,”
“Apply to serve on this committee,” “Applications close Feb 14.” Current
time-sensitive actions come first, direct participation second, durable
follow/continuation third, and informational source links last. Calendar
handoffs and official destinations are not completed participation.

## Continuation safety

Exact continuation replay is `worker/src/lib/continuation_replay.mjs`. A
serializable Following wire is not replay capability. The current exact
relation family is bounded `rules.request_ids` membership
(`exact_notice_membership`). Matter, board-committee, land-project, procurement,
exam, and disposition subject families remain `not-established` for exact
replay.

Safety rules:

1. **No lossy continuation.** If CityScroll cannot replay the exact
   continuation scope through `scope_v0`, Following, SODA `compileSub()`, and
   the D1 mirror, return no continuation rather than a broader watch.
2. **No arbitrary choice.** Multiple exact matters stay a choice. The
   projector never silently selects one.
3. **No fuzzy public relation becomes actionable.** Continuations require the
   same accepted/exact relation standards as other published edges.
4. **Following is explicit.** Add to calendar, Attend, Comment, and other
   official handoffs never mint a watch.
5. **No inferred participation.** Opening a testimony URL does not mean the
   user testified. Adding a meeting to a calendar does not mean the user
   attended.
6. **No actor tracking.** Civic Action Paths do not expand the privacy-safe
   action log into a behavioral dossier.
7. **Resident reads stay materialization-only.** Derivation does not perform
   request-time publisher acquisition.

Unsupported, unavailable, unknown, and lossy continuation candidates suppress
the continuation CTA. They do not become an agency-wide or all-hearings watch.

## Council hearing continuation

`site/council_hearing_matter_continuation.mjs` projects only the materialized
`exact_date_body_tokens` City Record → Council join.
`site/council_hearing_action_path.mjs` composes that projection through Action
Path v0.

| Fixture | City Record | Result |
| --- | --- | --- |
| One exact matter | `20260707022` | `matter:79200` / LU 0114-2026 with “Follow what happens next.” The retained outcome is **Laid Over by Subcommittee** after **Hearing Held by Committee**. |
| Multiple exact matters | `20260707021` | Matters `79201`, `79203`, `79202`, `79204`, `79205` remain individually selectable. There is no single continuation CTA. |
| No grounded matter | `20260728026` | Unmatched Buildings hearing. No matter continuation is shown. |

The canonical meeting document keeps calendar UIDs on
`UID:<meeting_id>@cityscroll.org`. The Follow control is a separate explicit
path. A later standalone `/matters/79200/` document is not in the current
legislative-matter materialization; the hearing page is the retained later
matter-state evidence.

## DOT City-Owned Bicycle Racks

The required Rules canary is the real DOT City-Owned Bicycle Racks rulemaking,
not a hypothetical fixture:

| Snapshot | Event | Retained notice |
| --- | --- | --- |
| T1, before Apr 24 | March 25, 2026 proposal; hearing and comment open; next event is the April 24 public hearing | `notice:20260317026` |
| T2, after Jul 14 | July 14, 2026 Notice of Adoption | `notice:20260706041` |
| T3, after Aug 13 | August 13, 2026 effective date | same adoption notice; state `effective` |

All three snapshots stay on `rulemaking:dot:bicycle-owned-racks`. A T1 follow
must still target that rulemaking at T2 and T3. Later snapshots may drop the
comment CTA. They must not become a follow-all-DOT-rules or
follow-all-DOT-hearings watch. Unchanged refreshes stay silent.

CityScroll reports what happened to the rulemaking. It never attributes adoption or effectiveness to a resident comment.

Outcome projection is `site/civic_outcome_transition.mjs`. Exact replay proof
for the two retained notices is
`worker/test/continuation_replay.test.mjs`.

## Community Board evidence policy

`site/community_board_participation.mjs` projects retained board-local
governance rules and explicitly scoped application sources. CAP-6 composes the
selected-board Ways to participate section from that projection.

Policy:

- Board identity, source/version, eligibility, appointing authority, and
  clocked application status stay independent fields.
- `unknown` is `source_does_not_establish`. It is not a citywide default and
  it is never filled from another board.
- `cross_board_inference` remains false.
- A closed, stale, or unknown application window never produces “Apply now.”
- Follow and Calendar reuse existing board-identity routes. A handoff or
  follow action is not completed participation.
- Employee rows, per-person application files, and actor dossiers stay out of
  this surface.

Positive proving board: Manhattan Community Board 2
(`community-board:manhattan-cb-02`) — retained upcoming meeting plus closed
full-board application evidence. Negative proving board: Bronx Community Board
2 (`community-board:bronx-cb-02`) — omits unsupported speaking and public
committee application paths while keeping records and board-local closed
membership evidence.

CAP-0's before-state characterization used Manhattan CB6 for source-backed
public committee-member semantics and Manhattan CB2 for unknown bylaw
participation. Those captures remain the before pair. The after pair uses the
CAP-6 Ways to participate fixtures above. The IDs are canonical board
identities, not display-name matches.

## Domain coverage

CAP-7 records whether an action exists, whether a natural continuation is
grounded, whether that continuation is exactly replayable, and whether a
follow-on card is warranted. CAP-8 measures those distinctions as ratios over
retained Council, DOT rulemaking, and Community Board evidence, including
legitimate no-action and stale-opportunity cases. Exact replay in force is the
CAP-2 `rules.request_ids` family. A document hash, a compiler field, or a count
of rail buttons is not exact replay and is not a coverage target.

Diagnostic classes: `no_action`, `action_only`, `target_unknown`,
`continuation_unknown`, `continuation_not_replayable`, `grounded_path`, and
`stale_opportunity`. Legitimate absence stays valid. Unknown never becomes zero. A stale source never becomes a current opportunity.

| Domain | Grounded now? | Exactly replayable now? | Follow-on |
| --- | --- | --- | --- |
| Meetings | Exact Council matter joins on retained fixtures | Matter `{legistar_id}` replay is not-established | Exact compiler family for matter continuation |
| Rules | DOT City-Owned Bicycle Racks T1/T2/T3 | `rules.request_ids` membership of the two retained notices | None for this canary |
| Land | Strict notice-land project join exists | Land-project continuation family is not-established | Exact land-project compiler |
| Money | Procurement identity exists in the compiler | Procurement Action Path replay is not-established | Exact procurement continuation family |
| Staffing | Exam identity exists for apply-window actions | Exam-number Action Path replay is not-established | Exact exam continuation family |
| Community Boards | Board-local participation and board follow | Committee-identity replay is not-established | Exact committee replay without board fallback |
| Property | Disposition spines join on exact BBL or borough + block/lot | Disposition-subject replay is not-established | Exact process-subject family |

Substantial new ingestion or a new exact-relation compiler is ranked
follow-on work. This card adds no unbounded routes and no low-risk adapter
that would pretend those compilers already exist.

## Remaining gaps

- Matter continuation is published as an explicit Follow path, but
  `matter:{legistar_id}` is not an exact compiler family.
- Community Board committee follow is omitted when committee identity cannot
  be replayed exactly.
- Land, Money, Staffing, and Property have existing action rails and some
  grounded identities, but no shipped Action Path continuation adapter.
- 311, FOIL, and Participatory Budgeting are architectural beneficiaries, not
  this workstream.
- A later Council matter document for LU 0114-2026 is not in the current
  legislative-matter lookup.

Do not fill those gaps with generic buttons, citywide board policy, or
“follow this agency” fallbacks.

## Future adapter guidance

A future domain adapter should:

1. Reuse `buildActionPath` over a validated registry action.
2. Ground the target with an accepted exact relation and provenance-bearing
   evidence.
3. Emit a continuation only after `continuationReplayForSubject` (or a new
   reviewed exact-relation family with the same SODA/D1/Following round-trip)
   proves lossless replay.
4. Preserve zero, one, and many continuation candidates. Never pick a winner.
5. Keep `unknown` and legitimate `no_action` distinct from empty coverage.
6. Leave Following explicit and calendar UIDs unchanged.
7. Stay actorless and materialization-only.
8. Record source vintage, fixture identity, and a coverage class rather than
   a button count.

311 would look like `place/problem → submit service request → responsible
agency → status → resolution → possible next action`. That shape is allowed
only as a later adapter with its own source contract. It is not implied by
this receipt.

## Visual evidence

Before-state captures (CAP-0) are listed in
[`docs/evidence/civic-action-paths/before/capture-manifest.json`](evidence/civic-action-paths/before/capture-manifest.json).
They cover a one-matter Council hearing, a multi-matter hearing, an unmatched
hearing, Community Board source-backed and unknown boards, the board source
map, and the DOT bicycle-racks rules list plus adoption notice, at 1440px and
390px.

After-state captures (CAP-6 / CAP-9) are listed in
[`docs/evidence/civic-action-paths/after/capture-manifest.json`](evidence/civic-action-paths/after/capture-manifest.json).
They cover the grounded Council hearing with “Follow what happens next” and
the later laid-over matter state, the unmatched hearing with no continuation,
Manhattan CB2 Ways to participate, Bronx CB2 negative evidence, and DOT T2/T3
outcome copy without causal claims.

Screenshots are owner-proof evidence, not a substitute for fixtures. Each
capture names the source-backed fixture, viewport, observed commit, and what
the image proves. Calendar clicks and official handoffs remain visibly
distinct from explicit Following.

## Verification

Refresh:

```text
node tools/build_action_path_generalization_audit.mjs
node tools/build_action_path_generalization_audit.mjs --check
node tools/build_action_path_coverage.mjs
node tools/build_action_path_coverage.mjs --check
node tools/build_civic_action_paths_documentation.mjs
node tools/build_civic_action_paths_documentation.mjs --check
python3 tools/capture_civic_action_paths_after.py --check
node --test test/action_path_generalization_audit.test.mjs \
  test/action_path_coverage.test.mjs \
  test/action_path_v0.test.mjs \
  test/council_hearing_matter_continuation.test.mjs \
  test/civic_outcome_transition.test.mjs \
  test/community_board_participation.test.mjs \
  test/civic_action_paths_documentation.test.mjs
```

Worker replay proof remains `cd worker && node --test test/continuation_replay.test.mjs`.
Regenerate after-state captures with
`python3 tools/capture_civic_action_paths_after.py`.
