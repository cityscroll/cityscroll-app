# Making the reduced profile the supported default

CI-09 built and measured a reduced working copy: **202.4 MB charged and 7.8 s**
against **1,348.4 MB and 41.4 s** for the full-checkout control. What it did not
leave behind was a contract saying who gets one. An engineer had to know the
flag, nothing recorded why a given checkout was the shape it was, and nothing
stopped a reduced checkout being pointed at a gate that needs complete history or
source closure.

This directory records what happened when provisioning became a policy router.

The implementation is a development-provisioning change only. No application
source, served output, Worker bundle, public data semantic or deployment path is
touched; §10 proves it and §9 shows the full-checkout controls unmoved.

Every table below is regenerated from the raw receipts by:

```bash
python3 tools/summarize_card_profile_routing_evidence.py
```

Exact commands for every receipt are in [`commands.md`](commands.md).

---

## 1. What the change did, in one paragraph

Provisioning now takes a **work surface**, not a profile flag. Focused card work
is routed to `focused-reduced` without being asked for it, and provisions in
**7.3 s** charging **200.7 MB**, against **39.5 s** and **1,349.3 MB** for the
full control at the same revision: **5.4x faster and 6.7x smaller**, which
reproduces CI-09's result to within 1% on bytes. Every other declared surface —
CI, unit, accessibility, artifact, deployment, release-surface, architecture,
repository-control-plane, evidence and complete-history — selects the control,
with the rule and reason recorded. A request the router cannot classify is an
error, not a default: an undeclared surface and an unclassified gate class both
fail closed at exit 2, and the terminal rule in the ordered list is the control,
so a routing gap cannot produce a smaller checkout. The profile is bound to what
it was derived from, and a checkout whose recorded manifest digest no longer
matches this revision's inputs routes to the control. Seventeen probes each
declared the exit they expected and every one was met. The Worker unit family
ran **1,755 tests with 1,754 passing and 1 skipped in both profiles** — identical
counts, which is what rules out a pass reached by skipping work whose input was
never materialised.

Running the contract also **found a real misclassification in CI-09**, described
in §11.

---

## 2. Method note

### What a routing contract has to prove that a smaller checkout does not

CI-09's question was "can this checkout run this gate". This card's question is
"which checkout should this work get", and it has three failure modes of its own:

| Failure mode | What closes it |
| --- | --- |
| A surface nobody classified quietly inherits the reduced profile | The rule list is ordered and terminal. An undeclared surface is an error; the last rule is the control. Nothing reaches `focused-reduced` except the one surface declared eligible for it |
| The profile drifts from the revision or closure it was measured against | `manifest_digest` covers the routing manifest, the profile config, the generated pattern list and closure, the dependency lock and the toolchain pin. Provisioning records it in the checkout; a mismatch is stale, and stale routes to the control |
| A caller cannot tell which profile it actually received | The provisioning receipt, whose deterministic block re-derives from the checkout alone |

### Two digests, because they answer different questions

`manifest_digest` covers the profile's inputs and is deliberately **not** bound
to the revision, so an unrelated commit does not make every provisioned checkout
stale. `provision_identity` binds the revision on top, so a receipt names the
exact instance. Each identity input is hashed as a Git blob from the working tree
when the path is materialised and from the index otherwise, so a reduced checkout
that defers one still computes the digest the full control computes.

### Why the receipt is in three blocks

The first version of the receipt digested everything, including the routing
decision the caller passed in. `--check` then only reproduced when the caller
replayed the same arguments, which is not a reproduction test. The receipt now
separates what the tool **observes** about the checkout, what the caller
**supplied**, and what a second run may legitimately **move**, and digests the
first alone.

### Why every probe declares its expected exit

The first version of the missing-blob probes recorded exit 0 under descriptions
asserting failure, and nothing noticed: asking a partial clone whether an object
is present is itself a request to go and fetch it. Those probes now run under
`GIT_NO_LAZY_FETCH=1`, and **every** probe declares the exit it expects; the run
fails when one deviates. The same rule now applies to gate classes — a class
declared profile-supported must actually pass in a provisioned reduced checkout,
which is what surfaced §11.

### Byte policy, trials and host

Unchanged from CI-08 and CI-09, and restated so the figures are not read loosely.
**logical** is `st_size`. **allocated** is `st_blocks * 512`, which on APFS counts
every copy-on-write clone at full size and therefore cannot see sharing.
**charged** is the free-space delta across one provisioning run, the only one of
the three that observes what the disk is actually asked for; the under-400-MB
claim is made on charged bytes, with MB meaning 10<sup>6</sup> bytes. The
no-double-counting rule is CI-08's: an ordered exhaustive path partition where
the first rule wins, hard-linked content counted once per device/inode within a
run, and the shared dependency store measured separately and never folded into a
checkout total.

Five trials of each routed variant, each into a fresh directory with no
pre-existing Git objects, cloned from the remote origin. The dependency store is
warm and shared, which is the CI-07 contract and the state a returning engineer
is in. The page cache is deliberately not purged, because purging is a
whole-machine operation on a shared host. Timings carry contention noise; every
trial records its own load average in `raw/provisioning-timings.jsonl`, and byte
figures are unaffected by load.

---

## 3. Environment

| Field | Value |
| --- | --- |
| Revision | `8d4ae48de83dcd5f14286dc0579d715b25dfdc20` |
| Routing manifest version | 1 |
| Routing manifest digest | `1aefe6db83d05317e2dc176eca8ff358d36bbdc246d1b998abab869b8ae0de1f` |
| Operating system | Darwin 25.5.0 (arm64) |
| Cores | 10 |
| Filesystem class | APFS - hard links and copy-on-write file clones both supported |
| Git | git version 2.54.0 |
| Node | v24.16.0 |
| pnpm, pinned by `worker/package.json` | pnpm@10.15.1 |
| pnpm, corepack default on this host | 11.24.0 |
| Python | Python 3.14.6 |
| Trials per routed variant | 5 |
| Dependency store | warm - the host shared pnpm store is already populated, and the install runs against it |
| Page cache | not purged - purging is a whole-machine operation on a shared host, so cold and warm describe tool-level caches only |
| Git objects | cold per trial - every trial clones into a fresh directory with no pre-existing objects |

The measurement revision is the commit that carries the complete implementation.
The commit that adds this directory's receipts and generated tables follows it.
Adding evidence files moves no identity input, so `manifest_digest` is the same
at both revisions and the receipts here describe the profile the merged branch
provisions.

Full detail is in [`raw/environment.json`](raw/environment.json).

---

## 4. The routing contract

### Where each work surface is routed

| Work surface | Selected profile | Rule | Exit |
| --- | --- | --- | ---: |
| `focused-card-work` | `focused-reduced` | `focused-card-work-verified` (order 9) | 0 |
| `ci` | `full` | `full-only-surface` (order 3) | 0 |
| `unit` | `full` | `full-only-surface` (order 3) | 0 |
| `accessibility` | `full` | `full-only-surface` (order 3) | 0 |
| `artifact` | `full` | `full-only-surface` (order 3) | 0 |
| `deployment` | `full` | `full-only-surface` (order 3) | 0 |
| `release-surface` | `full` | `full-only-surface` (order 3) | 0 |
| `architecture` | `full` | `full-only-surface` (order 3) | 0 |
| `repository-control-plane` | `full` | `full-only-surface` (order 3) | 0 |
| `evidence` | `full` | `full-only-surface` (order 3) | 0 |
| `complete-history` | `full` | `full-only-surface` (order 3) | 0 |

Only `focused-card-work` is declared eligible for the reduced profile, and the
routing check fails if that ever stops being true.

### Where each gate class routes focused card work

| Gate class requested by focused card work | Selected profile | Rule |
| --- | --- | --- |
| `worker-unit` | `focused-reduced` | `focused-card-work-verified` |
| `architecture-evidence-shards` | `focused-reduced` | `focused-card-work-verified` |
| `architecture-reconcile` | `focused-reduced` | `focused-card-work-verified` |
| `architecture-canaries` | `focused-reduced` | `focused-card-work-verified` |
| `card-reconciliation` | `focused-reduced` | `focused-card-work-verified` |
| `agents-router` | `focused-reduced` | `focused-card-work-verified` |
| `card-profile-contract` | `focused-reduced` | `focused-card-work-verified` |
| `site-standards` | `full` | `full-only-gate-class` |
| `site-unit` | `full` | `full-only-gate-class` |
| `generated-source-docs` | `full` | `full-only-gate-class` |
| `evidence-placement` | `full` | `full-only-gate-class` |
| `reading-level` | `full` | `full-only-gate-class` |
| `accessibility-browser` | `full` | `full-only-gate-class` |
| `pages-build` | `full` | `full-only-gate-class` |
| `release-surface` | `full` | `full-only-gate-class` |
| `full-history-guards` | `full` | `full-only-gate-class` |
| `cutover-receipt` | `full` | `full-only-gate-class` |

### Boundary requests

| Request | Selected profile | Rule | Exit |
| --- | --- | --- | ---: |
| `declared-complete-history` | `full` | `complete-history-required` | 0 |
| `deferred-path-requested` | `full` | `path-outside-closure` | 0 |
| `in-closure-path-requested` | `focused-reduced` | `focused-card-work-verified` | 0 |
| `stale-recorded-digest` | `full` | `stale-profile` | 0 |
| `undeclared-surface` | **failed closed** | `unknown-surface` | 2 |
| `undeclared-gate-class` | **failed closed** | `unknown-gate-class` | 2 |

The two `failed closed` rows are the point of the ordered rule list. Neither is
a refusal to work: both are refusals to guess.

---

## 5. Profile identity and receipt reproduction

| Provisioned profile | Manifest digest | Provision identity | Receipt deterministic digest | Reproduces |
| --- | --- | --- | --- | --- |
| Routed focused card work (`focused-reduced`) | `1aefe6db83d05317` | `d41084a2631e02c7` | `1c4a11f81806b456` | yes |
| Routed CI surface (`full` control) | `1aefe6db83d05317` | `d41084a2631e02c7` | `d678cf136b33debf` | yes |

Both profiles share a manifest digest and a provision identity, because both were
provisioned from the same inputs at the same revision; what differs is the
checkout each produced, which is why the receipt digests differ. Each receipt was
re-derived from its own checkout with `--check` and reproduced.

The routed reduced checkout recorded **0 hydrated paths**: it holds exactly what
the committed pattern list names, with nothing added by hand.

---

## 6. Measured result

### Provisioned footprint by category

| Category | Routed focused card work (`focused-reduced`) (MiB) | Routed CI surface (`full` control) (MiB) |
| --- | ---: | ---: |
| Git objects and repository metadata | 38.92 | 488.97 |
| Tracked `site/data` payload | 60.85 | 445.53 |
| Tracked `site/` payload outside `site/data` | 17.15 | 76.13 |
| Tracked payload elsewhere (tests, tools, docs, artifacts) | 62.54 | 212.96 |
| Tracked warehouse code, schemas and fixtures | 1.09 | 36.40 |
| Dependency view (`worker/node_modules`) after store install | 315.17 | 315.17 |
| Generated site output | 0.00 | 0.00 |
| Generated warehouse bulk | 0.00 | 0.00 |
| Other overhead (untracked, directory inodes) | 0.18 | 0.30 |
| **Declared total, logical** | **495.90** | **1,575.47** |
| Declared total, allocated | 517.68 | 1,610.38 |

### Charged disk — the free-space delta of one provisioning run

| Provisioned profile | n | Median charged MB | Observed min | Observed max | Allocated minus the shared dependency view, MB | Under 400 MB |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Routed focused card work (`focused-reduced`) | 5 | **200.7** | 200.1 | 203.6 | 198.1 | yes |
| Routed CI surface (`full` control) | 5 | **1,349.3** | 1,347.4 | 1,362.8 | 1,343.9 | no |

The last column is an independent, deterministic cross-check: allocated bytes with
the copy-on-write dependency view removed, which is what the disk is charged for
everything the checkout does not share with the store. It agrees with the median
charged figure to within 1.3%.

### Provisioning time by phase

| Provisioned profile | n | Phase | Median ms | p95 ms | Min ms | Max ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| Routed focused card work (`focused-reduced`) | 5 | prepare | 814 | 896 | 726 | 864 |
| Routed focused card work (`focused-reduced`) | 5 | sparse | 235 | 279 | 231 | 261 |
| Routed focused card work (`focused-reduced`) | 5 | checkout | 3,792 | 5,228 | 3,620 | 4,772 |
| Routed focused card work (`focused-reduced`) | 5 | install | 2,462 | 2,544 | 2,430 | 2,524 |
| Routed focused card work (`focused-reduced`) | 5 | **total** | **7,326** | 8,853 | 7,180 | 8,299 |
| Routed CI surface (`full` control) | 5 | prepare | 35,176 | 42,901 | 32,112 | 40,540 |
| Routed CI surface (`full` control) | 5 | checkout | 1,755 | 2,046 | 1,739 | 1,940 |
| Routed CI surface (`full` control) | 5 | install | 2,579 | 2,657 | 2,515 | 2,637 |
| Routed CI surface (`full` control) | 5 | **total** | **39,544** | 47,334 | 36,382 | 44,916 |

---

## 7. Fail-closed and fallback behaviour

| Probe | Expected | Exit | Met | What it shows |
| --- | --- | ---: | --- | --- |
| `routed-status` | `zero` | 0 | yes | The provisioned checkout reports itself as the reduced profile and its recorded identity matches this revision's inputs. |
| `undeclared-surface-fails-closed` | `2` | 2 | yes | A work surface the manifest does not declare is refused before anything is provisioned, rather than defaulting to the reduced profile. |
| `undeclared-gate-fails-closed` | `2` | 2 | yes | A gate class classified neither way is refused, because nothing is known about what it reads. |
| `full-only-surface-takes-control` | `5` | 5 | yes | A full-checkout-only surface selects the control explicitly; exit 5 records that the reduced profile was required and refused. |
| `stale-profile-takes-control` | `5` | 5 | yes | A recorded manifest digest that does not match this revision's inputs routes to the control instead of trusting the closure. |
| `deferred-path-takes-control` | `5` | 5 | yes | Work naming a path the profile defers routes to the control rather than being handed a checkout that lacks it. |
| `missing-path-named` | `non-zero` | 1 | yes | A direct read of a deferred tracked path raises the named profile failure carrying the hydrate command, not a bare missing file. |
| `swallowed-miss-bare` | `zero` | 0 | yes | A check that swallows the missing input and asserts nothing exits 0 on its own. This is the pass-by-omission the contract has to prevent. |
| `swallowed-miss-gated` | `4` | 4 | yes | The same check through the gate front door fails, because the sentinel recorded a missing tracked path whatever the check returned. |
| `gate-refused-evidence-placement` | `3` | 3 | yes | A full-checkout-only gate class is refused by the front door before it runs, carrying the routing rule that refused it. |
| `gate-refused-cutover-receipt` | `3` | 3 | yes | The control-plane cutover receipt is refused too. CI-09 declared it profile-supported on a recorded read set; it asserts that retained evidence projections resolve with an existence check, which that recording could not see, so this card reclassified it. |
| `merge-base-resolves` | `zero` | 0 | yes | The routed reduced profile keeps complete commit history, so a guard that resolves a merge base against the default branch still works in it. |
| `missing-blob-absent-locally` | `non-zero` | 1 | yes | With lazy fetching disabled, the blob behind a deferred path is genuinely absent from the local object store, so the reduction is real rather than a working-tree trick. |
| `missing-blob-unreachable-promisor` | `non-zero` | 128 | yes | With the promisor remote unreachable, reading a deferred blob fails loudly instead of yielding an empty or truncated object. |
| `missing-blob-hydration-refused` | `non-zero` | 128 | yes | The documented hydrate route fails the same way rather than reporting success over an object it could not fetch. |
| `missing-blob-path-still-absent` | `non-zero` | 1 | yes | After the refused hydration the path is still absent, so a failed fetch never leaves a partial input behind that a later check could read as present. |
| `missing-blob-hydration-succeeds-when-reachable` | `zero` | 0 | yes | With the promisor remote restored the same hydration succeeds, so the failure above was the unreachable remote and not a broken profile. |
| `missing-blob-present-after-hydration` | `zero` | 0 | yes | And the path is present afterwards, which is what makes the deferred set one documented command away rather than lost. |

---

## 8. Git object behaviour, integrity and history

| Field | Routed focused card work (`focused-reduced`) | Routed CI surface (`full` control) |
| --- | --- | --- |
| Commits reachable from HEAD | 1590 | 1590 |
| Shallow repository | False | False |
| Promisor remote configured | True | False |
| Partial clone filter | blob:none | None |
| Packs | 3 | 1 |
| Pack size (KiB) | 38502 | 499766 |
| Loose objects | 0 | 0 |
| Tracked paths not materialised | 1907 | 0 |
| Working tree clean at the pinned revision | True | True |
| `git fsck --connectivity-only` exit | 0 | 0 |
| `git merge-base HEAD origin/main` exit | 0 | 0 |

---

## 9. Gate classes and full-checkout controls

### Gate classes run in both provisioned profiles

| Gate class | Routed focused card work (`focused-reduced`) | Routed CI surface (`full` control) | Observed test counts |
| --- | --- | --- | --- |
| `card-profile-contract` | pass | pass |  |
| `architecture-evidence-shards` | pass | pass |  |
| `architecture-reconcile` | pass | pass |  |
| `architecture-canaries` | pass | pass |  |
| `card-reconciliation` | pass | pass |  |
| `agents-router` | pass | pass |  |
| `worker-unit` | pass | pass | fail 0 pass 1754 skipped 1 tests 1755 |

### Full-checkout controls

| Gate class | Result | Observed test counts |
| --- | --- | --- |
| `worker-unit` | pass | fail 0 pass 1754 skipped 1 tests 1755 |
| `site-unit` | pass | fail 0 pass 5183 skipped 1 tests 5184 |
| `contract-unit` | pass | fail 0 pass 181 skipped 0 tests 181 |
| `architecture-evidence-shards` | pass |  |
| `architecture-reconcile` | pass |  |
| `architecture-canaries` | pass |  |
| `card-reconciliation` | pass |  |
| `card-projection` | pass |  |
| `evidence-placement` | pass |  |
| `cutover-receipt` | pass |  |
| `agents-router` | pass |  |
| `legacy-name-guard` | pass |  |
| `source-contracts` | pass |  |
| `card-profile-contract` | pass |  |
| `card-profile-derivation` | pass |  |
| `card-profile-routing` | pass |  |

These run in the clean full checkout the router provisioned for the `ci` surface,
not in the working copy the harness was launched from.

---

## 10. Product surface, unchanged

| Surface | Files | Digest at merge base | Digest at measured revision | Identical |
| --- | ---: | --- | --- | --- |
| `artifacts/` | 72 | `587d8d622e8a` | `587d8d622e8a` | yes |
| `capabilities/` | 13 | `6ade326942c8` | `6ade326942c8` | yes |
| `data/` | 18 | `33d67d5ce9da` | `33d67d5ce9da` | yes |
| `entity_resolution/` | 130 | `f21961e54f3c` | `f21961e54f3c` | yes |
| `ontology/` | 58 | `b0693914e6af` | `b0693914e6af` | yes |
| `site/` | 2,187 | `275907225881` | `275907225881` | yes |
| `warehouse/` | 265 | `905e3f9fd791` | `905e3f9fd791` | yes |
| `worker/` | 570 | `dc9a4dee5861` | `dc9a4dee5861` | yes |

---

## 11. What this card found in CI-09

Running every declared profile-supported gate class in a provisioned reduced
checkout — rather than recording its exit status and moving on — found one that
does not pass there.

`tools/rcp05_cutover_receipt.mjs` asserts that every retained evidence projection
resolves on disk, and it does so with an **existence check** rather than a content
read. CI-09's recorder captures only content reads, by design: an earlier
iteration that recorded metadata probes grew the closure to the entire tracked
tree. The gate's true closure was therefore never observed, and the classification
became wrong once the retained set grew projections under `site/data`,
`warehouse/` and `docs/screenshots`.

The gate still **failed closed**, naming each unresolved projection rather than
passing over them, so no check was ever silently weakened. What was wrong was the
classification. It moves to `full_checkout_only` with that reason recorded, the
closure is regenerated from it, and `gate-refused-cutover-receipt` in §7 now
proves the front door refuses it.

This is the gap the card named as G2, observed rather than argued.

---

## 12. Limits

**The under-400-MB claim is filesystem-class specific.** The dependency view
reports 315.2 MiB and charges about 2 MiB because pnpm imports through
copy-on-write clones on APFS. On a filesystem with neither reflink nor hard-link
support the same install would copy in full and the profile would charge roughly
496 MB rather than 201 MB, over the target. The routing contract is unaffected
either way; the headline figure would not survive that filesystem class, and
saying so is part of the measurement.

**Staleness is judged on declared inputs, not on behaviour.** A change that
alters what a supported gate class reads without touching the profile config,
pattern list, closure, lockfile or toolchain pin does not move `manifest_digest`.
That is the same limit CI-09 recorded for its closure, and the same mechanism
answers it: such a read fails closed through the sentinel with the hydrate
command, and the gate class is re-recorded.

**A surface has to be declared to be routed.** That is deliberate — an
unclassified surface failing closed is the property this card exists for — but it
means adding a new class of work is a manifest edit, not a free action.

**Hydration needs the network.** A deferred blob is served by the promisor
remote. §7 shows what happens when it is unreachable: the read fails loudly, the
hydrate command fails with it, and the path is still absent afterwards, so a
failed fetch never leaves a partial input behind.

**Timing carries host contention.** Five trials per variant, medians reported,
p95 printed because each group has five. Byte figures are unaffected.

---

## 13. Files in this directory

| Path | Contents |
| --- | --- |
| `README.md` | This method note and the generated tables |
| `commands.md` | Exact commands to reproduce every receipt |
| `raw/environment.json` | Revision, manifest identity, host and filesystem class, tool versions, cache conditions, measurement method definitions |
| `raw/routing-decisions.jsonl` | Every surface, gate class and boundary request put to the router, with the rule that fired |
| `raw/provisioning-timings.jsonl` | Per-trial provisioning phase timings for each routed variant |
| `raw/charged-disk.jsonl` | Per-trial free-space deltas |
| `raw/footprint-routed-focused.json` | Byte partition of the routed reduced profile |
| `raw/footprint-routed-ci.json` | Byte partition of the routed full-checkout control |
| `raw/footprint-shared-store.json` | Shared dependency store, counted once, outside every checkout |
| `raw/receipt-routed-focused.json` | Provisioning receipt for the routed reduced profile |
| `raw/receipt-routed-ci.json` | Provisioning receipt for the routed control |
| `raw/receipt-*.reproduction.txt` | Output of re-deriving each receipt from its own checkout |
| `raw/recorded-identity-*.json` | The identity each provisioned checkout carries in its Git directory |
| `raw/fail-closed-probes.jsonl` | Every probe with its expected exit, observed exit and whether the expectation was met |
| `raw/gate-probes.jsonl` | Every profile-supported gate class run in both profiles, with test counts |
| `raw/full-checkout-controls.jsonl` | The full-checkout control set, with test counts |
| `raw/object-integrity.json` | Object counts, pack behaviour, promisor configuration, connectivity and merge-base resolution in both profiles |
| `raw/product-surface.json` | Per-surface tracked-tree digests at the merge base and at the measured revision |
