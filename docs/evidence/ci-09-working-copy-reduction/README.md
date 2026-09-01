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

A fresh reduced profile provisions in **7.9 s** and charges **205.2 MB** of
disk, against **41.4 s** and **1,353.6 MB** for the full-checkout control at the
same revision: **5.2x faster and 6.6x smaller**. Both dominants moved. Git
repository metadata went from **486.8 to 38.8 MiB** (-92.0%), and the tracked
`site/data` payload went from **445.5 to 60.9 MiB** (-86.3%), 28 of 689 files.
The saving is not bought by weakening anything: complete commit history survives
in full (1,584 commits reachable in both profiles), the Worker unit family runs
**1,755 tests with 1,754 passing and 1 skipped in both profiles** — identical
counts, which is what rules out a pass by omission — and every gate class
exercised here passes in whichever profile it belongs to. The nine
full-checkout-only classes are refused before they run, not silently degraded.

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

| Field | Value |
| --- | --- |
| Revision | `89533982f9afc6969c8a6c976071b9de488e1d8f` |
| Operating system | Darwin 25.5.0 (arm64) |
| Cores | 10 |
| Filesystem class | APFS - hard links and copy-on-write file clones both supported |
| Git | git version 2.54.0 |
| Node | v24.16.0 |
| pnpm, pinned by `worker/package.json` | pnpm@10.15.1 |
| pnpm, corepack default on this host | 11.24.0 |
| Python | Python 3.14.6 |
| Trials per profile | 3 |
| Dependency store | warm - the host shared pnpm store is already populated, and the install runs against it |
| Page cache | not purged - purging is a whole-machine operation on a shared host, so cold and warm describe tool-level caches only |
| Git objects | cold per trial - every trial clones into a fresh directory with no pre-existing objects |

The measurement revision is the commit that carries the complete
implementation. The commit that adds this directory's receipts and generated
tables follows it and changes nothing the measurement observed.

Full detail, including the definition of each byte measure, is in
[`raw/environment.json`](raw/environment.json).

---

## 4. The profile closure

### Profile closure

| Set | Files | Logical MiB | Share of tracked payload |
| --- | ---: | ---: | ---: |
| Materialised by the profile | 3,765 | 141.30 | 18.3% |
| Not materialised by the profile | 1,901 | 628.87 | 81.7% |
| — of those, named in the deferred hydration set | 310 | 230.05 | 29.9% |
| **Tracked payload at this revision** | **5,666** | **770.17** | 100.0% |
| — of which tracked `site/data` | 689 | 445.53 | 57.8% |
| — of which `site/data` in the profile | 28 | 60.85 | 13.7% of tracked `site/data` |

The first two rows partition the tracked payload and sum to 100%. The deferred hydration set is a named subset of what the profile does not materialise: those paths are the ones a scanned source references, so they are the ones most likely to be wanted, and they are one documented command away.

### Where the closure comes from

| Closure source | What it contributes | Paths |
| --- | --- | ---: |
| observed | Repository paths recorded by tools/card_profile_sentinel.cjs while each supported gate class ran on a full checkout. | 2,397 |
| static | Repository paths named by an import specifier or a path-shaped string literal in worker/, site/, tools/ and test/ sources. | 1,857 |
| declared | Structural trees a card-work checkout holds regardless of gate reads, minus the byte-heavy excluded trees. | 3,568 |

---

## 5. Measured result

### Provisioned footprint by category

| Category | Reduced card-work profile (MiB) | Card-work profile, opt-in `--depth 1` (MiB) | Full-checkout control (MiB) |
| --- | ---: | ---: | ---: |
| Git objects and repository metadata | 38.79 | 37.50 | 486.79 |
| Tracked `site/data` payload | 60.85 | 60.85 | 445.53 |
| Tracked `site/` payload outside `site/data` | 17.13 | 17.13 | 76.11 |
| Tracked payload elsewhere (tests, tools, docs, artifacts) | 62.23 | 62.23 | 212.12 |
| Tracked warehouse code, schemas and fixtures | 1.09 | 1.09 | 36.40 |
| Dependency view (`worker/node_modules`) after store install | 315.18 | 315.18 | 315.18 |
| Generated site output | 0.00 | 0.00 | 0.00 |
| Generated warehouse bulk | 0.00 | 0.00 | 0.00 |
| Other overhead (untracked, directory inodes) | 0.18 | 0.18 | 0.30 |
| **Declared total, logical** | **495.44** | **494.15** | **1,572.43** |
| Declared total, allocated | 517.69 | 515.51 | 1,609.35 |

### Charged disk — the free-space delta of one provisioning run

| Provisioned profile | n | Median charged MB | Observed min | Observed max | Allocated minus the shared dependency view, MB | Under 400 MB |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Reduced card-work profile | 3 | **205.2** | 200.3 | 222.8 | 198.1 | yes |
| Card-work profile, opt-in `--depth 1` | 3 | **200.6** | 199.3 | 203.8 | 195.8 | yes |
| Full-checkout control | 3 | **1,353.6** | 1,347.2 | 1,370.5 | 1,342.8 | no |

A free-space delta measures the whole volume, so on a shared host a concurrent writer moves an individual trial in either direction; the observed minimum and maximum are printed as evidence of that noise, not as a range claim. The median is the reported figure. The last column is an independent, deterministic cross-check: allocated bytes with the copy-on-write dependency view removed, which is what the disk is charged for everything the checkout does not share with the store.

### Provisioning time by phase

| Provisioned profile | n | Phase | Median ms | p95 ms | Min ms | Max ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| Reduced card-work profile | 3 | prepare | 831 | n/a | 817 | 918 |
| Reduced card-work profile | 3 | sparse | 249 | n/a | 237 | 277 |
| Reduced card-work profile | 3 | checkout | 3,843 | n/a | 3,406 | 4,521 |
| Reduced card-work profile | 3 | install | 2,879 | n/a | 2,610 | 2,926 |
| Reduced card-work profile | 3 | **total** | **7,877** | n/a | 7,171 | 8,466 |
| Card-work profile, opt-in `--depth 1` | 3 | prepare | 448 | n/a | 407 | 466 |
| Card-work profile, opt-in `--depth 1` | 3 | sparse | 1,088 | n/a | 1,059 | 1,107 |
| Card-work profile, opt-in `--depth 1` | 3 | checkout | 8,297 | n/a | 8,197 | 8,464 |
| Card-work profile, opt-in `--depth 1` | 3 | install | 3,510 | n/a | 2,561 | 3,964 |
| Card-work profile, opt-in `--depth 1` | 3 | **total** | **13,528** | n/a | 12,324 | 13,716 |
| Full-checkout control | 3 | prepare | 36,494 | n/a | 32,731 | 39,664 |
| Full-checkout control | 3 | checkout | 2,184 | n/a | 1,934 | 3,987 |
| Full-checkout control | 3 | install | 2,777 | n/a | 2,673 | 2,972 |
| Full-checkout control | 3 | **total** | **41,351** | n/a | 39,690 | 44,375 |

---

## 6. Gate compatibility and missing-path behaviour

### Gate compatibility

| Gate class | Reduced card-work profile | Full-checkout control | Observed test counts |
| --- | --- | --- | --- |
| `worker-unit` | pass | pass | tests 1755 pass 1754 fail 0 skipped 1 |
| `architecture-evidence-shards` | pass | pass |  |
| `architecture-reconcile` | pass | pass |  |
| `architecture-canaries` | pass | pass |  |
| `card-reconciliation` | pass | pass |  |
| `agents-router` | pass | pass |  |
| `card-profile-contract` | pass | pass |  |
| `card-profile-tests` | pass | pass | tests 13 pass 13 fail 0 skipped 0 |
| `evidence-placement` | not run — full-checkout only | pass |  |
| `site-unit` | not run — full-checkout only | pass | tests 181 pass 181 fail 0 skipped 0 |
| `generated-source-docs` | not run — full-checkout only | pass |  |
| `site-standards` | not run — full-checkout only | pass |  |

### Missing-path and fallback behaviour

| Probe | Profile | Exit | What it shows |
| --- | --- | ---: | --- |
| `missing-path-named` | card-work | 1 | A direct read of a tracked path the profile defers is reported as a named profile failure carrying the hydrate command, not as a bare missing file. |
| `control-path-present` | full-checkout | 0 | The same path is present in the full-checkout control, so the reduced-profile failure is attributable to the profile and not to the revision. |
| `swallowed-miss-bare` | card-work | 0 | A check that swallows the missing input and asserts nothing exits 0 on its own. This is the pass-by-omission the profile has to prevent. |
| `swallowed-miss-gated` | card-work | 4 | Run through the gate front door the same check fails, because the sentinel recorded a missing tracked path and the front door fails the run whatever the check returned. |
| `refused-evidence-placement` | card-work | 3 | The full-checkout-only gate class "evidence-placement" is refused before it runs, with the reason and the command that provisions the control. |
| `refused-site-unit` | card-work | 3 | The full-checkout-only gate class "site-unit" is refused before it runs, with the reason and the command that provisions the control. |
| `refused-generated-source-docs` | card-work | 3 | The full-checkout-only gate class "generated-source-docs" is refused before it runs, with the reason and the command that provisions the control. |
| `refused-site-standards` | card-work | 3 | The full-checkout-only gate class "site-standards" is refused before it runs, with the reason and the command that provisions the control. |
| `refused-reading-level` | card-work | 3 | The full-checkout-only gate class "reading-level" is refused before it runs, with the reason and the command that provisions the control. |
| `refused-pages-build` | card-work | 3 | The full-checkout-only gate class "pages-build" is refused before it runs, with the reason and the command that provisions the control. |
| `refused-release-surface` | card-work | 3 | The full-checkout-only gate class "release-surface" is refused before it runs, with the reason and the command that provisions the control. |
| `refused-full-history-guards` | card-work | 3 | The full-checkout-only gate class "full-history-guards" is refused before it runs, with the reason and the command that provisions the control. |
| `refused-accessibility-browser` | card-work | 3 | The full-checkout-only gate class "accessibility-browser" is refused before it runs, with the reason and the command that provisions the control. |
| `hydrate-documented-route` | card-work | 0 | The documented hydrate command materialises the deferred path, fetching its blob from the promisor remote, after which the read succeeds. |
| `history-card-profile` | card-work | 0 | The default card profile keeps complete commit history, so a guard that resolves a merge base against the default branch still works in it without any fallback. |
| `history-depth-variant` | card-work-depth1 | 128 | The opt-in depth variant carries one commit per branch tip, so anything that needs an ancestor beyond the shallow boundary cannot resolve. That is why it is not the default and why the fallback is documented. |
| `unshallow-fallback` | card-work-depth1 | 0 | The documented full-history fallback restores complete history in place, after which the same ancestor resolves. |

---

## 7. Git object behaviour, integrity and the history fallback

The reduced profile reports 1,900 unmaterialised paths rather than the
manifest's 1,901 because this integrity snapshot is taken after the hydration
probe in §6, which materialised one path on purpose.

### Git object behaviour and integrity

| Field | Reduced card-work profile | Full-checkout control |
| --- | --- | --- |
| Commits reachable from HEAD | 1584 | 1584 |
| Shallow repository | False | False |
| Promisor remote configured | True | False |
| Partial clone filter | blob:none | None |
| Packs | 83 | 1 |
| Pack size (KiB) | 39720 | 497545 |
| Loose objects | 0 | 0 |
| Tracked paths not materialised | 1900 | 0 |
| Working tree clean at the pinned revision | True | True |
| `git fsck --connectivity-only` | exit 0 | exit 0 |

---

## 8. Rejected and killed candidates

Recorded so the choices are reviewable, and so a candidate that was tried and
did not earn its place is not quietly dropped.

| Candidate | Measured here | Decision |
| --- | --- | --- |
| **Partial clone, `--filter=blob:none`** | Git metadata 486.8 to 38.8 MiB; object transfer 39.7 s to 0.8 s; complete history preserved, 1,584 commits reachable in both profiles | **Adopted as the default.** It is the only variant that takes the metadata cost down without taking history with it |
| **Shallow clone, `--depth 1`** | Metadata 37.5 MiB, barely below the partial clone's 38.8 MiB, and total provisioning is markedly slower: 13.4 s against 7.9 s, because a shallow partial clone hydrates blobs in far smaller batches. It also cannot resolve an ancestor beyond the shallow boundary until unshallowed | **Kept as an opt-in, rejected as the default.** CI-08 ranked shallow first on its own numbers; combined with a sparse profile it loses to the partial clone on both axes |
| **Durable shared-object alternate** | Not adopted | **Rejected.** An alternate binds a checkout to another object store's lifetime. A partial clone reaches the same metadata reduction while depending only on the durable remote, and CI-08's boundary forbids leaving a checkout dependent on a disposable object source |
| **Naive sparse cone, CI-08's `worker tools .github test`** | Working tree 79.5 MiB, but the Worker unit family fails outright | **Rejected, as CI-08 recorded.** It is the failure this change had to solve, not a profile to adopt |
| **Sparse cone extended by static analysis** | Did not converge after three rounds in CI-08 | **Rejected.** Extending a cone by specifier scanning cannot see a path assembled at runtime. The observed-read closure sees it because it watches the gate run |
| **Materialising the full statically-referenced `site/data` set** | Would have put 197 files and 240.1 MiB in the working tree instead of 28 files and 60.9 MiB | **Rejected.** Those references reach `site/data` through browser modules that only full-checkout-only gates load. They became the deferred hydration set instead: named, one command away, and loud if a supported gate touches one |
| **Recording metadata probes as closure members** | An early iteration recorded every `stat` as well as every read, which grew the closure to the entire tracked tree, 5,633 paths and 769.5 MiB | **Rejected.** The sentinel still escalates on every entry point that can hit an absent path; only content reads feed the recorder |
| **Reducing the dependency view** | 315.2 MiB reported, about 2 MiB charged, identical across all three profiles | **Not a target,** as CI-08 established. CI-07 already solved this category on a filesystem class that can share |
| **Lazy generated site or warehouse output** | 0 bytes and 288 bytes respectively in a fresh checkout | **Not a target,** as CI-08 established. The payload is tracked source, not build output |

---

## 9. Product surface, unchanged

### Product surface, unchanged

| Surface | Files | Digest at merge base | Digest at measured revision | Identical |
| --- | ---: | --- | --- | --- |
| `artifacts/` | 72 | `2829dadde6a4` | `2829dadde6a4` | yes |
| `capabilities/` | 13 | `2a3285607450` | `2a3285607450` | yes |
| `data/` | 18 | `b80c5fabad8d` | `b80c5fabad8d` | yes |
| `entity_resolution/` | 130 | `ef32968a0b2e` | `ef32968a0b2e` | yes |
| `ontology/` | 58 | `f351e3186458` | `f351e3186458` | yes |
| `site/` | 2185 | `75db8753ee81` | `75db8753ee81` | yes |
| `warehouse/` | 265 | `4000a34a52f3` | `4000a34a52f3` | yes |
| `worker/` | 570 | `10438dce1ef7` | `10438dce1ef7` | yes |

---

## 10. Limits and what stays full-checkout only

**What stays full-checkout only.** Nine gate classes are declared
full-checkout-only in `tools/card-profile/closure.v1.json`, each with its
reason, and each was probed to confirm it is refused rather than degraded: the
site standards family, the site and contract unit suites, the generated-document
and source-contract checks, the evidence-placement receipt (measured at 2,571
tracked paths and 601.8 MiB, close to the whole tree), the reading-level
ratchet, the accessibility and browser families, the generated Pages build, the
release-surface and deployment checks, and any guard needing an ancestor beyond
a shallow boundary. Four of them were also run green against the control here.
**CI is unchanged and continues to use the full checkout.**

**The under-400-MB claim is filesystem-class specific, and here is the
condition.** The dependency view reports 315.2 MiB and charges about 2 MiB
because pnpm imports through copy-on-write clones on APFS. On a filesystem with
neither reflink nor hard-link support the same install would copy in full, and
the profile would charge roughly 495 MB rather than 205 MB, over the target. The
reduction this change implements is unaffected either way, because it reduces
Git metadata and tracked payload; but the headline figure would not survive that
filesystem class, and saying so is part of the measurement.

**The free-space delta is noisy on a shared host,** because it measures the whole
volume. The median across three trials is the reported figure, and the
deterministic allocated-minus-dependency-view cross-check agrees with it to
within 3.5%, which is why the claim does not rest on a single trial.

**The closure is derived from one recorded run per gate class.** A branch that no
recorded run exercised, and that no scanned source names, is not in the closure.
That is a real limit, and it is the one the sentinel exists for: such a path
fails closed with the hydrate command rather than being skipped. Re-record with
`node tools/verify_card_profile.mjs --record <class> -- <command>` when a gate
class grows a new input.

**Hydration needs the network.** A deferred blob is served by the promisor
remote. An offline reduced checkout can still run every supported gate class,
because their inputs are already materialised, but it cannot hydrate.

**A partial clone accumulates packs.** The reduced profile finishes with 83 packs
against the control's 1, because each lazy fetch lands its own. Total pack size
is 39.7 MiB against 497.5 MiB, so this costs bytes only in inodes, but a
long-lived reduced checkout will want an occasional `git gc`.

**Timing carries host contention.** Every trial records its own load average in
`raw/provisioning-timings.jsonl`. Byte figures are unaffected.

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
