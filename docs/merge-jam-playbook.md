# Merge-jam diagnosis and repair playbook

Use the merge-group result as the first observation. A red pull-request check
does not establish that the pull request caused the jam: first compare the same
check across the group, then establish whether the shared baseline is broken.
Only after those questions are answered should a PR-local check drive repair.

## Decision tree

1. Record the merge-group log, failed signature, passed shards, and source
   receipt.
2. Compare the same test across the affected pull requests. Timeline removals
   are measured service loss, not proof of check-specific causation.
3. Classify the shared baseline. A source-backed clock or timezone regression is
   `shared-gate-rot`; a repeated browser signature that clears on a later
   attempt is `flaky-shard-ejection`.
4. Read `mergeStateStatus` before choosing a branch operation:

   | State | Meaning | Safe next move |
   | --- | --- | --- |
   | `CLEAN` | Mergeable subject to requirements | Inspect required checks and reviews |
   | `BLOCKED` | A protection requirement blocks merging | Fix the named requirement |
   | `BEHIND` | Branch is behind its base | Use guarded update-branch when GitHub says it is safe |
   | `DIRTY`, `CONFLICTING` | Branch needs conflict repair | Resolve and rebase, then obtain a new receipt |
   | `UNKNOWN` | GitHub has not settled or cannot report | Wait through the settling window |
   | `UNSTABLE` | Mergeability is changing | Wait; never arm while unstable |

5. Verify the queue branch with `git ls-remote <remote> <ref>`. The remote
   object ID is ground truth. A mismatch or unavailable receipt is a reason to
   verify, not permission to arm.
   A matching branch receipt does not override an unsafe merge state.
6. Arm only after a settled `CLEAN` state, an exact queue-branch receipt, and
   successful required checks. For `BEHIND`, use update-branch when GitHub
   reports the guarded update is safe; for `DIRTY` or `CONFLICTING`, resolve
   the branch and rebase. Either operation requires a fresh receipt before
   arming. Do not use rebase merely to refresh a safely updateable branch.
7. Do not repeat re-arm or branch-lock transitions against the same receipt.
   A new transition requires a new source receipt.
8. Close the incident as classify → detector receipt → fix card → measured
   delta. The delta must preserve its denominators and label unlike windows as
   directional rather than causal.

The executable controlled replay is:

```text
node tools/merge_jam_playbook.mjs --fixture test/fixtures/merge-throughput --check
```

The replay proves the required checks, `ALLGREEN` composition, five-entry
queue ceiling, and the existing elder anti-starvation policy remain unchanged.
It also carries the source-linked clock-gate repair and the observed queue
baseline, including the 544 successful post-merge dequeues and 136 ejections.
