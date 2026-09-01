# Acting on the measured working-copy costs

CI-08 measured a fresh, fully provisioned working copy at 1.4-1.6 GiB and named
the two dominants: **Git repository metadata (481-560 MiB)** and the **tracked
`site/data` payload (445 MiB)**. It also measured that 90% of a 47.7 s remote
provision is object transfer, that the post-CI-07 dependency view reports
196-315 MiB but charges about 2 MiB of real disk on this filesystem class, and
that a hand-chosen sparse profile **breaks the Worker unit family** because
Worker sources reach across the package boundary into `site/` and further paths
are assembled at runtime rather than named in an import specifier.

This directory records what happened when both dominants were acted on.

The implementation is a development-provisioning change only. No application
source, served output, Worker bundle, public data semantic or deployment path is
touched; §9 proves it.

Every table below is regenerated from the raw receipts by:

```bash
python3 tools/summarize_card_profile_evidence.py
```

Exact commands for every receipt are in [`commands.md`](commands.md).

---

## 1. What the change did, in one paragraph

<!-- HEADLINE -->

---

## 2. Method note

### The two levers, and why these two

Git object transfer and tracked source selection are separate cost centres, so
each is reduced by its own mechanism and each is measured against the same
pinned revision.

**Git metadata — a partial clone, not a shallow one.** `--filter=blob:none`
fetches every commit and every tree but only the blobs the profile materialises.
Complete commit history therefore survives, which matters more than the extra
bytes a shallow clone would save: a guard that resolves a merge base against the
default branch still works in the reduced profile, so nothing about the profile
weakens a full-history check. The promisor remote that serves deferred blobs is
the durable origin. A partial clone is used **only when the source is a remote**:
against a local source it would make a scratch checkout the promisor, which is
exactly the disposable-object-source trap, and a local clone shares objects
anyway so it would save nothing. `--depth 1` remains available as an opt-in and
is **not** the default; §7 records why.

**Tracked `site/data` — a derived closure, not a hand-chosen cone.** CI-08's
naive cone failed, and a cone extended by static analysis had not converged after
three rounds. Guessing does not work here, so the closure is not guessed. It is
the union of three sources:

| Source | What it sees | Why it is needed |
| --- | --- | --- |
| observed | Every repository path a supported gate class actually read, recorded by `tools/card_profile_sentinel.cjs` while that gate ran on a full checkout | This is what sees paths assembled at runtime. CI-08 named four of them, and no import-specifier scan can find any of them |
| static | Every path named by a specifier or a path-shaped string literal, seeded from the Worker package and followed across the boundary | This is what sees references on code paths a single run did not exercise, including the cross-boundary reaches CI-08 counted |
| declared | The structural trees a card-work checkout needs regardless of gate reads, minus the byte-heavy trees the profile exists to leave out | Provisioning has to produce a working checkout, not only a gate runner |

### The part that makes a reduced checkout safe to trust

A smaller checkout is dangerous in one specific way: a check can pass while
silently skipping work whose input was not materialised. Sparse checkout on its
own reports a plain missing file, which a caller can swallow.

Three mechanisms close that:

1. **A tracked path the profile does not hold is marked skip-worktree**, so it is
   distinguishable from a path that genuinely does not exist at this revision.
2. **`tools/card_profile_sentinel.cjs` escalates a missing-file error on such a
   path** into `CardProfileMissingPath`, naming the exact hydrate command, and
   records it.
3. **`node tools/verify_card_profile.mjs --gate <class> -- <command>` fails the
   run when the sentinel recorded a violation, whatever the command returned.**

§6 forces that case with a deliberately badly written check that swallows the
error and exits 0. Bare, it passes. Through the front door, it fails.

The sentinel escalates on every filesystem entry point that can hit an absent
path, but only *content* reads feed the recorder. A stat or an access check does
not mean a gate needs the bytes, and recording those widened the closure to the
whole tree in an earlier iteration.

### Byte policy — three measures, never conflated

- **logical** is `st_size`.
- **allocated** is `st_blocks * 512`. On APFS this counts every copy-on-write
  clone at full size, so it **cannot see sharing** and overstates any payload
  created by cloning. CI-08 established this and it has not changed.
- **charged** is the free-space delta across one provisioning run. It is the only
  one of the three that observes what the disk is actually asked for.

**The under-400-MB claim is made on charged bytes**, with MB meaning 10<sup>6</sup>
bytes, and every category is reported in all applicable measures so the figure is
not reached by omitting one. §4 states plainly what the number would be on a
filesystem class where the dependency view cannot share.

The no-double-counting rule is CI-08's, unchanged: an ordered exhaustive path
partition where the first rule wins, hard-linked content counted once per
device/inode within a run, and the shared dependency store measured separately
and never folded into a checkout total.

### Trials, cache condition and host

Three trials of each of the three provisioned profiles, each into a fresh
directory with no pre-existing Git objects, from the remote origin. The
dependency store is warm and shared, which is the CI-07 contract and the state a
returning engineer is in; the cold-store figure is CI-07's and is not restated
here. The operating-system page cache is deliberately not purged, because
purging is a whole-machine operation on a shared host — cold and warm here
describe tool-level caches only, as they did in CI-08.

The host is a shared workstation, so timings carry contention noise. Every trial
records its own load average and those values are preserved in the raw receipts.
Byte figures are unaffected by load. The median is reported for every group; p95
is reported only where a group has at least five trials, and smaller groups print
`n/a` and report their observed maximum instead.

---

## 3. Environment

<!-- ENVIRONMENT -->

---

## 4. The profile closure

<!-- CLOSURE -->

---

## 5. Measured result

<!-- FOOTPRINT -->

<!-- CHARGED -->

<!-- TIMING -->

---

## 6. Gate compatibility and missing-path behaviour

<!-- GATES -->

<!-- BEHAVIOUR -->

---

## 7. Git object behaviour, integrity and the history fallback

<!-- INTEGRITY -->

---

## 8. Rejected and killed candidates

<!-- REJECTED -->

---

## 9. Product surface, unchanged

<!-- SURFACE -->

---

## 10. Limits and what stays full-checkout only

<!-- LIMITS -->

---

## 11. Files in this directory

| Path | Contents |
| --- | --- |
| `README.md` | This method note and the generated tables |
| `commands.md` | Exact commands to reproduce every receipt |
| `raw/environment.json` | Revision, OS, filesystem class, tool versions, cache conditions, measurement method definitions |
| `raw/provisioning-timings.jsonl` | Per-trial provisioning phase timings for each profile |
| `raw/charged-disk.jsonl` | Per-trial free-space deltas |
| `raw/footprint-card.json` | Byte partition of the reduced card-work profile |
| `raw/footprint-card-depth1.json` | Byte partition of the opt-in depth variant |
| `raw/footprint-full.json` | Byte partition of the full-checkout control |
| `raw/footprint-shared-store.json` | Shared dependency store, counted once, outside every checkout |
| `raw/gate-probes.jsonl` | Every gate class run in both profiles, with exit status and test counts |
| `raw/behaviour-probes.jsonl` | Forced missing-path, swallowed-miss, hydration, refusal and history-fallback probes |
| `raw/object-integrity.json` | Object counts, pack behaviour, promisor configuration and connectivity check for both profiles |
| `raw/product-surface.json` | Per-surface tracked-tree digests at the merge base and at the measured revision |
| `raw/closure/*.json` | Per-gate-class observation receipts: every tracked path that gate read |
