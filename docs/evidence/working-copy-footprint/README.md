# Working-copy footprint and provisioning time

Measured evidence for why a fresh CityScroll working copy is large and slow to
provision, at pinned revision `f095d4b8d844d1a969c70e4909dc0f65960f1a7d` on
`main`.

**This is a measurement record only.** It implements no reduction, changes no
application behaviour, no package version, no dependency semantics, no CI
coverage, no generated application payload, and no part of the shared
dependency-store contract. It adds three measurement scripts and this evidence
directory, nothing else.

Every table below is regenerated from the raw receipts in `raw/` by:

```bash
python3 tools/summarize_working_copy_evidence.py
```

Exact commands for each receipt are in [`commands.md`](commands.md).

---

## 1. What the measurement found, in one paragraph

A fresh, fully provisioned working copy is roughly **1.4–1.6 GiB**. Two
categories account for about two thirds of it: **Git repository metadata
(481–560 MiB)** and **the tracked `site/data` payload (445 MiB)**. Neither is
generated output. The categories the card expected to dominate —
generated site output and warehouse fixtures or artifacts — measure
**effectively nothing** in a fresh checkout: 0 bytes of generated site output
and 288 bytes of generated warehouse bulk, because neither is materialised until
someone explicitly runs the deploy build or the opt-in warehouse ingest. The
site build does eventually produce 665.3 MiB, but it takes a 10.5-minute median
and no provisioning path runs it. The post-CI-07 dependency view reports 196–315 MiB but costs about **2 MiB** of real
disk, because pnpm imports through APFS copy-on-write clones. Provisioning time
is dominated by one phase: **fetching objects from the remote (43.0 s median),
which is 90% of a 47.7 s remote provision**; checkout is 3.3 s and the warm
store-backed install is 3.9 s.

---

## 2. Category mapping — where the card's assumptions did not survive contact

The card named `site/` as "generated site output" and `warehouse/` as "fixtures
and artifacts". Inspecting the actual repository layout before assigning
categories showed both need correcting. The measurement reports the corrected
mapping rather than forcing the expected categories.

| Path named in the card | Expected | **Measured reality** |
| --- | --- | --- |
| `site/` | generated site output | **Predominantly tracked source.** 2,179 of the repository's tracked files live under `site/`, including all 688 files of `site/data` (445.5 MiB). Only a narrow set is generated: `_site/`, `site/browse/`, `site/now/`, `site/data/procurement_browse_*`, and the per-agency and per-community-board `index.html` documents. All of those are gitignored. |
| generated site output | a footprint category | **Zero bytes in a fresh checkout.** None of those paths exist until `node tools/build_cloudflare_pages.mjs` runs, which takes a 10.5-minute median and then produces 665.3 MiB. They are a build/deploy artifact, not a checkout cost. |
| `warehouse/` fixtures and artifacts | bulk payload | **259 tracked files, 36.2 MiB**, all code, schemas and fixtures. The bulk subtrees `warehouse/raw`, `warehouse/parquet` and `warehouse/duckdb` contain only a tracked `.gitkeep` in a fresh checkout — **288 bytes of generated warehouse data, which is three empty directory inodes.** Materialising them is an explicit opt-in local workflow documented in `warehouse/README.md`; it is not part of provisioning and no CI job performs it. |

The consequence is that **the bulky payload in this repository is tracked
source, not generated output.** Any reduction aimed at generated payloads is
aimed at bytes that are not there.

---

## 3. Method note

### Trials and isolation

Two genuinely fresh, isolated checkouts were created at the same pinned
revision, from two different source types, and both were confirmed clean and at
the pinned revision before measurement:

- **Checkout A** — `git clone` from the remote origin over HTTPS.
- **Checkout B** — `git clone --no-hardlinks` from a local object source, so
  objects are genuinely copied rather than shared.

Both were then provisioned with the CI-07 shared-store install. Neither is the
checkout this evidence was authored in.

### The no-double-counting rule

`tools/measure_working_copy_footprint.py` walks every entry beneath a checkout
root and assigns it to **exactly one** category using an ordered, exhaustive
path partition — first rule wins. Per-category sums therefore equal the
directory total by construction, and the declared total is the sum of the rows.
Additionally:

- Hard-linked content is counted **once per device/inode** within a run, so a
  dependency view that hard-links into the store cannot inflate the checkout
  total with bytes the store already owns.
- The **shared dependency store lives outside every checkout** and is reported
  once, in its own row. It is never added into a checkout total.
- For a linked working tree, a shared Git object directory outside the checkout is
  likewise reported separately rather than folded in. Checkouts A and B are
  standalone clones, so each owns its metadata privately.

### Logical versus allocated bytes

Both are reported. **Logical** is `st_size`; **allocated** is `st_blocks * 512`.
The measured filesystem is APFS, which supports both.

**A limitation that materially changes the reading of this table:** APFS
supports copy-on-write file clones, and `st_blocks` reports every clone at full
size. Allocated bytes therefore **cannot see copy-on-write sharing**, and
overstate the real cost of any payload created by cloning. The only way to
observe the true incremental cost is a free-space delta, recorded in
`raw/copy-on-write-experiments.json`:

| Operation | `du` reports | **True incremental disk** |
| --- | ---: | ---: |
| Fresh local clone + checkout | 1,325 MiB | **1,340 MiB** — genuine |
| Warm store-backed dependency install | 317 MiB | **2 MiB** |

pnpm imports packages with clone-or-copy, which resolves to an APFS `clonefile`.
The second and later dependency views on this filesystem class are therefore
**effectively free**, and `node_modules` is not a meaningful footprint-reduction
target here. This result is filesystem-class specific: on a filesystem with
neither reflink nor hard-link support the same install would copy in full. It is
not a general claim.

### Cold and warm, local and remote

These are never blended into one row.

- **cold** — no pre-existing store objects and no pre-existing local Git objects
  for the measured source.
- **warm** — a populated shared store, installed with `--offline`, so a warm row
  cannot silently include a network fetch.
- The operating-system page cache is **deliberately not purged**, because
  purging is a whole-machine operation on a shared host. Cold and warm here
  describe **tool-level caches only**. This is a stated limitation, not an
  omission.

### Host conditions

The measurement host is a shared 4-core workstation, so timings carry
contention noise. Every trial records its own 1-minute load average, and those
values are preserved in the raw receipts so a reviewer can see the conditions
each number was taken under. Byte figures are unaffected by load. Free-space
delta is used only where the signal exceeds the noise by two orders of
magnitude, and never as the source of a headline byte total.

### Statistics policy

Median is reported for every group. **p95 is reported only where a group has at
least five trials**; smaller groups print `n/a` and report their observed
maximum instead, so a three-run group cannot masquerade as a distribution. This
threshold is enforced in the summarizer, not applied by hand.

---

## 4. Environment

Recorded in full in [`raw/environment.json`](raw/environment.json).

| Field | Value |
| --- | --- |
| Revision | `f095d4b8d844d1a969c70e4909dc0f65960f1a7d` (`main`) |
| Operating system | macOS 26.5.2 (build 25F84), arm64, 4 cores |
| Filesystem class | APFS — hard links and copy-on-write clones both supported |
| Git | 2.54.0 |
| Node | v24.16.0 |
| pnpm | 10.15.1, pinned via `worker/package.json` `packageManager` and resolved through corepack 0.35.0 |
| Python | 3.14.6 |
| Size tool | BSD `du`; `-A` reports apparent size, default reports allocated blocks |

---

## 5. Measured breakdown — bytes

Generated from `raw/footprint-checkout-a.json`, `raw/footprint-checkout-b.json`
and `raw/footprint-shared-store.json`.

### Checkout A — remote origin clone, dependencies installed

| Category | Classification | Logical MiB | % of total | Allocated MiB | % of total | Entries |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Git objects and repository metadata | metadata | 481.0 | 33.37% | 482.6 | 32.88% | 44 |
| Tracked `site/data` payload (source, not generated) | tracked | 445.5 | 30.91% | 446.8 | 30.45% | 688 |
| Tracked payload elsewhere (tests, tools, docs, artifacts) | tracked | 206.1 | 14.30% | 212.7 | 14.49% | 3121 |
| Dependency view (`worker/node_modules`) after store install | installed | 196.1 | 13.61% | 209.7 | 14.29% | 6567 |
| Tracked `site/` payload outside `site/data` (source) | tracked | 76.1 | 5.28% | 79.1 | 5.39% | 1491 |
| Tracked warehouse code, schemas and fixtures | tracked | 36.2 | 2.51% | 36.7 | 2.50% | 259 |
| Generated site output (`_site`, `site/browse`, `site/now`) | generated | **0.0** | 0.00% | **0.0** | 0.00% | 0 |
| Generated warehouse bulk (`raw`, `parquet`, `duckdb`) | generated | **0.0003** | 0.00% | **0.0** | 0.00% | 3 |
| Other overhead (untracked, directory inodes) | untracked | 0.3 | 0.02% | 0.0 | 0.00% | 1377 |
| **Declared total** | | **1,441.2** | **100.00%** | **1,467.6** | **100.00%** | |

### Checkout B — local object source clone, dependencies installed

| Category | Classification | Logical MiB | % of total | Allocated MiB | % of total | Entries |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Git objects and repository metadata | metadata | 559.7 | 34.15% | 560.7 | 33.68% | 616 |
| Tracked `site/data` payload (source, not generated) | tracked | 445.5 | 27.18% | 446.8 | 26.84% | 688 |
| Dependency view (`worker/node_modules`) after store install | installed | 315.2 | 19.23% | 328.7 | 19.75% | 6563 |
| Tracked payload elsewhere (tests, tools, docs, artifacts) | tracked | 206.1 | 12.58% | 212.7 | 12.78% | 3121 |
| Tracked `site/` payload outside `site/data` (source) | tracked | 76.1 | 4.64% | 79.1 | 4.75% | 1491 |
| Tracked warehouse code, schemas and fixtures | tracked | 36.2 | 2.21% | 36.7 | 2.21% | 259 |
| Generated site output (`_site`, `site/browse`, `site/now`) | generated | **0.0** | 0.00% | **0.0** | 0.00% | 0 |
| Generated warehouse bulk (`raw`, `parquet`, `duckdb`) | generated | **0.0003** | 0.00% | **0.0** | 0.00% | 3 |
| Other overhead (untracked, directory inodes) | untracked | 0.3 | 0.02% | 0.0 | 0.00% | 1377 |
| **Declared total** | | **1,639.0** | **100.00%** | **1,664.8** | **100.00%** | |

### Shared dependency store — counted once, outside every checkout

| Field | Value |
| --- | ---: |
| Logical | 195.8 MiB |
| Allocated | 207.9 MiB |
| Entries | 5,171 |

The store is **excluded from both totals above** and is amortised across every
checkout on the host. Its incremental cost is paid once.

### Reading the two checkouts against each other

The two totals differ by 197.8 MiB, in exactly two rows, for two understood
reasons:

- **Git metadata (481.0 vs 559.7 MiB).** A clone from the remote receives a
  server-side repack; a clone from a local object source inherits that source's
  looser object layout. The remote figure is the one a new contributor pays.
- **Dependency view (196.1 vs 315.2 MiB).** The same asymmetry the CI-07 receipt
  already records for its two dependency views (219.9 MiB and 344.7 MiB
  allocated). Checkout A's view contains hard-linked duplicates that the
  inode-dedup counts once; Checkout B's are copy-on-write clones with a link
  count of one, which dedup cannot collapse. **Both cost about 2 MiB of real
  disk**, per the free-space-delta experiment above. This row is the clearest
  case in the table where reported bytes and real bytes diverge, and it is the
  reason the dependency view is not ranked as a reduction target.

Tracked payload rows are **byte-identical across both checkouts**, as they must
be at a pinned revision. That agreement is the cross-check that the partition is
measuring the repository rather than the host.

### Checkout A after the generated site build

Reported separately, never merged with the fresh-checkout tables, because a
post-build tree is a different thing being measured. This is the table where the
generated-output category is genuinely non-zero.

| Category | Classification | Logical MiB | % of total | Entries |
| --- | --- | ---: | ---: | ---: |
| Generated site output (`_site`, `site/browse`, `site/now`, per-agency documents) | generated | **665.3** | **31.03%** | 3,523 |
| Git objects and repository metadata | metadata | 481.0 | 22.44% | 44 |
| Tracked `site/data` payload | tracked | 463.1 | 21.60% | 688 |
| Tracked payload elsewhere | tracked | 206.1 | 9.62% | 3,121 |
| Dependency view (`worker/node_modules`) | installed | 196.1 | 9.15% | 6,567 |
| Tracked `site/` payload outside `site/data` | tracked | 77.3 | 3.61% | 1,491 |
| Tracked warehouse code, schemas and fixtures | tracked | 36.2 | 1.69% | 259 |
| Other overhead | untracked | 18.7 | 0.87% | 1,444 |
| Generated warehouse bulk | generated | **0.0003** | 0.00% | 3 |
| **Declared total** | | **2,143.8** | **100.00%** | |

Building the site adds **702.5 MiB** to the working copy (1,441.2 → 2,143.8
MiB), of which 665.3 MiB is new generated output. The tracked rows also grow
slightly (`site/data` 445.5 → 463.1 MiB) because the build rewrites tracked
projections in place, as noted in the timing section.

Generated warehouse bulk remains **288 bytes even after a full site build**,
confirming it is not produced by any build step and is only materialised by the
opt-in warehouse workflow.

---

## 6. Measured breakdown — provisioning time

Generated from `raw/provisioning-timings.jsonl`, `raw/install-timings.jsonl` and
`raw/pages-timings.jsonl`. Source class and cache/network condition are kept
distinct; unlike runs are never combined.

| Trial group | Source | Cache / network | n | Phase | Median ms | p95 ms | Min ms | Max ms |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| Linked working tree | linked-working-tree | no network | 5 | prepare | 24 | 29 | 24 | 30 |
| Linked working tree | linked-working-tree | no network | 5 | checkout | 1,799 | 1,836 | 1,779 | 1,839 |
| Linked working tree | linked-working-tree | no network | 5 | **total** | **1,829** | 1,860 | 1,804 | 1,863 |
| Local object copy | local-copy | no network | 5 | prepare | 476 | 588 | 442 | 611 |
| Local object copy | local-copy | no network | 5 | checkout | 1,972 | 2,726 | 1,859 | 2,772 |
| Local object copy | local-copy | no network | 5 | **total** | **2,470** | 3,200 | 2,388 | 3,246 |
| Remote clone | remote | online | 5 | prepare | 43,004 | 46,880 | 35,759 | 47,796 |
| Remote clone | remote | online | 5 | checkout | 3,271 | 5,957 | 2,557 | 6,280 |
| Remote clone | remote | online | 5 | **total** | **47,667** | 50,182 | 38,954 | 50,353 |
| Store install, cold | checkout | online, empty store | 1 | install | 7,614 | n/a | 7,614 | 7,614 |
| Store install, warm | checkout | offline, populated store | 5 | install | **3,876** | 4,241 | 3,413 | 4,279 |

`prepare` is object transfer and repository preparation (`clone --no-checkout`
or `git worktree add --no-checkout`); `checkout` is materialising the tracked
working tree at the pinned revision.

### Where provisioning time actually goes

- **Remote object transfer is 90% of a remote provision** (43.0 s of 47.7 s).
  Every other phase together is under 5 s.
- **Checkout is nearly constant at 1.8–3.3 s** regardless of source. It is the
  cost of writing ~803 MiB of tracked files and is not where the problem is.
- **The cold install is a one-off 7.6 s** (n=1, so no distribution is claimed);
  warm store-backed installs run at a 3.9 s median. CI-07 already removed this
  phase as a concern.
- **A linked working tree provisions in 1.8 s** because `prepare` collapses to 24 ms
  — it shares the object directory instead of copying it. This is the fastest
  measured path to a fresh checkout by a wide margin.

### Generated site build

Timed separately because it is a **deploy-time build, not part of provisioning**.
No CI provisioning step and no card workflow runs it to obtain a working copy; it
is the Cloudflare Pages build command recorded in
`docs/release/cloudflare-native-builds.json`.

| Trial group | n | Phase | Median ms | p95 | Min ms | Max ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| Generated site build | 2 | pages | **630,877** | n/a | 521,262 | 740,492 |

Both trials exited 0 and produced **byte-identical output**, so the spread is
host contention, not build variance (the slower trial ran at load 13.75, the
faster at 7.91). At n=2 no p95 is claimed.

At a **10.5-minute median this is by far the most expensive single step measured
here — roughly 13× a full remote clone.** It is nonetheless out of scope as a
provisioning cost, because provisioning a working copy does not run it.

Output produced, all of it gitignored:

| Generated path | Logical bytes |
| --- | ---: |
| `_site/` | 642.2 MB |
| `site/agencies/*/index.html` (within a 32.0 MB directory) | see below |
| `site/browse/` | 5.1 MB |
| `site/now/` | 0.3 MB |

**The build also rewrites tracked files.** After a build, `git status` reports
modifications to tracked projections such as
`site/agencies/*/relationships.json`, `site/agencies/*/relationships-data.json`
and `docs/evidence/geography-subjects/located-in-audit.json`. This is recorded
as a measurement observation, not a defect claim; it is noted because it means a
post-build checkout is **not** byte-comparable to a fresh one, and the two are
reported as separate tables below rather than merged.

---

## 7. Which gate classes require a full checkout

Established by **running real gates against reduced checkouts**, not by
reasoning about them. Full receipts in `raw/gate-compatibility.json`.

| Probe | Checkout | Gate | Result |
| --- | --- | --- | --- |
| Worker unit family | cone `worker tools .github test` | `node --test` in `worker/` | **FAILS** |
| Worker unit family | non-cone derived profile, extended by iterating against the gate | `node --test` in `worker/` | **STILL FAILS after 3 rounds** |
| Static-standards contract | cone `worker tools .github test` | `build_capability_topology.mjs --check` | **FAILS** |
| Static-standards contract | full checkout (same clone, sparse disabled) | `build_capability_topology.mjs --check` | **PASSES** (control) |

The last row is the control: it is the same clone with sparse checkout disabled,
so the failures above are attributable to the reduced checkout rather than to
the clone or the environment.

**Why the worker cone fails.** `worker/src` reaches across the package boundary
into `site/`. Measured: **124 static cross-boundary import specifiers** from
`worker/` into `site/`, of which **22 target `site/data` JSON files** totalling
45.1 MiB — **10.12% of `site/data`'s 445.5 MiB**. The first failure is
`worker/src/lib/confirm_email.mjs` importing `site/community_board_watch.mjs`.

**Why a derived cone did not converge.** Extending the profile with the
statically-discovered set still failed, because further paths are read at
runtime through the filesystem rather than named in an import specifier — for
example `site/data/legal_code/manifest.json`,
`site/data/land_procedure_profiles.json`,
`site/data/abo_award_residual_lookup.json` and `site/data/source_contracts.json`.
No import-specifier scan can see these. The iteration was stopped after three
rounds without converging; **the unconverged state is itself the finding** and
is reported rather than tuned away.

**Shallow clone against CI as configured.** Three checkout steps in
`.github/workflows/ci.yml` pin `fetch-depth: 0`. The legacy repository-name
guard resolves a merge-base against `main`, which a depth-1 clone cannot supply.
Two other workflows (`merge-pipeline-guard`, `cold-build-canary`) already run at
`fetch-depth: 1` and are unaffected.

**Gate classes that require the full tracked payload:** the static-standards
family (141 tools reference `site/data`), the accessibility and browser families
(they serve the built site), and the generated site build itself.

---

## 8. Ranked reduction register

Ranked by **measured** byte and time delta against the baseline a new
contributor actually pays: a full remote clone (481.0 MiB of metadata, 43.0 s
median object transfer). The order below follows the measurements; it was not
chosen first and justified afterwards.

### Raw candidate measurements

Shallow and partial clone variants, three trials each from the remote origin
(p95 suppressed at n=3 per the statistics policy). Git directory sizes were
identical across all reps.

| Clone variant | n | Median prepare ms | p95 | Git dir MiB | Working-tree files |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline, full clone | 5 | 43,004 | 46,880 | 481.0 | 5,559 |
| `--depth=1` | 3 | 15,892 | n/a | 135.7 | 5,559 |
| `--filter=tree:0` | 3 | 17,994 | n/a | 138.1 | 5,559 |
| `--filter=blob:none` | 3 | 20,913 | n/a | 141.4 | 5,559 |
| `--depth=1 --filter=blob:none` | 3 | 29,487 | n/a | 135.8 | 5,559 |

Sparse-checkout profiles, three trials each:

| Sparse profile | n | Median checkout ms | Working-tree MiB | Files | Cone |
| --- | ---: | ---: | ---: | ---: | --- |
| `worker-card` | 3 | 543 | 79.5 | 2,241 | `worker tools .github test` |
| `site-shell` | 3 | 422 | 29.8 | 2,107 | `site/app site/i18n tools test` |
| `full-cone` | 3 | 3,440 | 765.7 | 5,529 | all top-level tracked directories |

---

### Rank 1 — Shallow or partial clone for scratch checkouts · **CONFIRM (scoped)**

| Field | Measurement |
| --- | --- |
| Byte delta | Git metadata **481.0 → 135.7 MiB**, −345.3 MiB (−71.8% of metadata, −24.0% of the 1,441 MiB total) |
| Time delta | Object transfer **43.0 s → 15.9 s**, −27.1 s (−63%) |
| Best variant | `--depth=1` alone. Combining it with `--filter=blob:none` made it **worse** (29.5 s), so the combination is not recommended |
| Confidence | **High.** Git directory sizes were byte-identical across all three reps of every variant; the time delta is far larger than the observed spread |
| Requires a full checkout anywhere? | **Yes** — the three `fetch-depth: 0` steps in `ci.yml` |
| Gate compatibility | **Incompatible with the CI runner checkout as configured.** The legacy repository-name guard needs a merge-base with `main`. Fully compatible with local scratch checkouts, which do not run that guard |
| **Decision** | **CONFIRM for local scratch checkouts. KILL for the CI runner checkout** — adopting it there would weaken a required guard, which CI-08 explicitly forbids |

This is the only candidate whose measured saving is both large and unblocked in
some real scope.

**Measured alternative worth noting alongside it:** a **linked working tree**
provisions in **1.8 s** with a 24 ms prepare, versus 15.9 s for the best shallow
clone and 47.7 s for a full remote clone, and adds no new object copy at all. On
this host it beats every clone variant measured. It is recorded here as evidence,
not proposed as a CI-09 change.

---

### Rank 2 — Sparse-checkout profiles for narrow card work · **KILL for CI-09 scope**

| Field | Measurement |
| --- | --- |
| Byte delta (apparent) | Working tree **765.7 → 79.5 MiB**, −686.2 MiB (−90%) |
| Time delta (apparent) | Checkout **3,440 → 543 ms**, −2.9 s (−84%) |
| Confidence in the headroom | **High** — the reduced trees were measured directly |
| Confidence it is realisable as specified | **Low** |
| Requires a full checkout anywhere? | **Yes** — static-standards, accessibility and browser families, and the site build |
| Gate compatibility | **The naive profile breaks a required gate.** The `worker-card` cone fails the Worker unit family outright. A profile derived by static analysis also failed, and had not converged after three rounds of extension |
| **Decision** | **KILL as specified.** The saving is real but not safely reachable by "a sparse profile per card". It would require a maintained, gate-verified path manifest that does not exist, and building one is a larger change than the reduction it enables |

The headroom is recorded so a future card can propose the manifest mechanism on
its own merits. It must not be smuggled into CI-09 as a checkout tweak: the
measured failure mode is a **silently under-included path breaking a required
gate**, which is exactly the class of change CI-08 exists to prevent.

---

### Rank 3 — Lazy materialisation or LFS-style fetch-on-need for generated or warehouse payloads · **KILL (premise not supported by the data)**

| Field | Measurement |
| --- | --- |
| Generated site output in a fresh checkout | **0 bytes** (665.3 MiB only after an explicit 10.5-minute deploy build, which no provisioning path runs) |
| Generated warehouse bulk in a fresh checkout | **288 bytes** — three empty directory inodes; `raw`, `parquet` and `duckdb` hold only a tracked `.gitkeep` |
| Byte delta available | **None.** The payloads this candidate targets do not exist in a fresh working copy |
| Confidence | **High.** Measured independently in both checkouts, and consistent with `.gitignore` and with the absence of any warehouse materialisation step in CI |
| **Decision** | **KILL.** The candidate targets bytes that are not there. Adopting it would add fetch-on-need machinery for zero measured saving |

**This candidate was killed by the data, and the redirect is worth recording.**
The bulky payload in this repository is **tracked `site/data` (445.5 MiB,
30.91% of the total)** — application source, served by the site and read by 141
tools. Its bytes are highly concentrated: the **top 10 files hold 35.8%** and the
**top 50 hold 78.9%** of `site/data`. That concentration is what would make
fetch-on-need attractive, but it would apply to *tracked source*, changing how
the site is served and how gates read data. That is a materially different and
much larger proposal than the one this card named, and it is **not** ranked or
endorsed here. It needs its own card and its own evidence.

---

### Not a candidate, but it reframes the ranking

The post-CI-07 dependency view **reports** 196–315 MiB but **costs about 2 MiB**
of real disk on this filesystem class, because pnpm imports through
copy-on-write clones. Any future proposal that ranks `node_modules` as a
footprint target on a reflink- or hard-link-capable filesystem is optimising a
number that `du` reports and the disk does not charge. CI-07 already solved this
category.

---

## 9. Boundary statements

- **CI-08 is measurement-only.** No reduction from the register is implemented
  here. No required check is removed, weakened, or made optional.
- **The full existing contract remains intact** — CI, deployment, test,
  accessibility, artifact and release. This change adds three measurement
  scripts and this evidence directory. It touches no application code, no
  workflow, no package version, no dependency semantics, no generated
  application payload, and no part of the shared dependency-store contract.
- **No destructive cleanup and no history rewriting** were used. Every
  measurement ran in throwaway checkouts outside the repository, which were
  removed afterwards.
- **Host-specific details are sanitised.** No absolute local path, user name,
  host name or credential appears in this directory; the raw receipts are
  checked for that on write.
- **CI-09 remains blocked** until these numbers are landed and accepted. When it
  proceeds, it may implement **only** what this evidence supports: Rank 1,
  scoped to local scratch checkouts and never to the CI runner checkout. Ranks 2
  and 3 are killed here and must not be carried into CI-09 without new evidence.
- **The under-400 MB target belongs to CI-09 and is not claimed here.** For the
  record, the measurements do not obviously support it: tracked payload alone is
  ~803 MiB at this revision, and no candidate in this register reduces tracked
  source bytes.

## 10. Prerequisite status and scope notes

**The shared dependency store is present on `main`.** `tools/install_worker_dependencies.sh`,
`tools/verify_shared_dependency_store.mjs` and
`docs/evidence/shared-dependency-store/receipt.json` are all on the measured
revision, and the pull request that introduced them is merged. This measurement
was taken against that implementation and uses it directly — the warm install
figures come from running that script.

Two bookkeeping discrepancies are recorded rather than resolved here, because
resolving either is outside a measurement card:

- The store receipt pins revision `5f3cdd34…`, which is **not an ancestor of the
  measured `main`**. That revision is a pre-merge branch commit that did not
  survive the squash. The receipt's *content* is consistent with what this
  measurement observed — its two dependency-view figures (219.9 MiB and 344.7
  MiB allocated) reproduce here as 209.7 MiB and 328.7 MiB, the same asymmetry
  from the same cause.
- The card register still lists the store card as proposed although its
  implementation is merged.

Neither affects the numbers above. **The scope of this card stays explicitly
limited to measurement**; it does not close, re-open or re-status the
prerequisite card.

**Architecture evidence.** This change introduces no architecture-observed
surface: no runtime module, no site projection, no data contract, no capability.
It adds measurement instruments and this evidence directory only. **No
architecture-evidence entry is required**, and none was added. The applicable
checks were run and pass on the change:

| Check | Result |
| --- | --- |
| `node tools/architecture_evidence_shards.mjs --check` | pass |
| `node tools/reconcile_architecture.mjs --check` | pass |
| `node tools/card_reconciliation_guard.mjs` | pass |
| `bash tools/internal-path-guard.sh` over the added paths | pass |

`node tools/check_card_reconciliation.mjs` exits non-zero, but it does so
**identically on an unmodified checkout of the same revision** — it requires the
generated aggregate inventories, which are gitignored and derived at build time.
That control run is why it is reported as pre-existing rather than introduced
here. It is not referenced by any workflow under `.github/workflows/`.

---

## 11. Files in this directory

| Path | Contents |
| --- | --- |
| `README.md` | This method note, tables and ranked register |
| `commands.md` | Exact commands to reproduce every receipt |
| `raw/environment.json` | Revision, OS, filesystem class, tool versions, cold/warm definitions |
| `raw/footprint-checkout-a.json` | Byte partition for the remote-sourced checkout |
| `raw/footprint-checkout-b.json` | Byte partition for the locally-sourced checkout |
| `raw/footprint-checkout-a-after-site-build.json` | Byte partition after the generated site build |
| `raw/footprint-shared-store.json` | Shared dependency store, counted once |
| `raw/provisioning-timings.jsonl` | Per-trial clone, linked-working-tree and checkout timings |
| `raw/install-timings.jsonl` | Per-trial cold and warm store-backed install timings |
| `raw/pages-timings.jsonl` | Generated site build timings and output sizes |
| `raw/reduction-candidates.jsonl` | Per-trial shallow and partial clone measurements |
| `raw/sparse-profiles.jsonl` | Per-trial sparse-checkout profile measurements |
| `raw/gate-compatibility.json` | Gate probes against reduced checkouts, with findings |
| `raw/gate-compatibility-probes.jsonl` | Per-probe exit codes for the same gate runs |
| `raw/copy-on-write-experiments.json` | Free-space-delta experiments |
