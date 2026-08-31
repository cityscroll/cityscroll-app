# Civic Action Paths

This is the coverage boundary after the Community Board proving slice. The
shared contract remains a derived product projection over existing actions;
it is not a second action registry and it is not a mandate to rebuild every
domain.

Current-main characterization of rails, calendar, Following, Council joins,
and board surfaces lives in
[`docs/evidence/civic-action-paths/before/characterization-receipt.md`](evidence/civic-action-paths/before/characterization-receipt.md).
The machine generalization audit is
[`docs/evidence/civic-action-paths/generalization-audit.json`](evidence/civic-action-paths/generalization-audit.json).

## Current coverage boundary

CAP-7 records whether an action exists, whether a natural continuation is
grounded, whether that continuation is exactly replayable, and whether a
follow-on card is warranted. Exact replay in force is the CAP-2
`rules.request_ids` family. A document hash, a compiler field, or a count of
rail buttons is not exact replay.

The required Rules canary is the real DOT City-Owned Bicycle Racks
rulemaking: notice `20260317026` (proposal / T1 hearing and comment-open)
and notice `20260706041` (adoption / T2), with effectiveness after 2026-08-13
(T3). A T1 follow must remain on `rulemaking:dot:bicycle-owned-racks`. Later
snapshots may drop the comment CTA; they must not become “follow all DOT
rules” or “follow all DOT hearings.”

Refresh:

```text
node tools/build_action_path_generalization_audit.mjs
node tools/build_action_path_generalization_audit.mjs --check
node --test test/action_path_generalization_audit.test.mjs \
  test/action_path_v0.test.mjs \
  test/council_hearing_matter_continuation.test.mjs \
  test/community_board_participation.test.mjs
```

Worker replay proof remains `cd worker && node --test test/continuation_replay.test.mjs`.

Substantial new ingestion or a new exact-relation compiler is ranked
follow-on work. This card adds no unbounded routes and no low-risk adapter
that would pretend those compilers already exist.
