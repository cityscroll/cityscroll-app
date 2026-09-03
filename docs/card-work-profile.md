# Provisioning profiles for focused work

A fresh full working copy costs about 1.4-1.6 GiB and spends most of its
provisioning time transferring Git objects. Two thirds of the bytes are Git
repository metadata and the tracked `site/data` payload; the measurements are in
[`docs/evidence/ci-08-working-copy-footprint/`](evidence/ci-08-working-copy-footprint/).

There are two profiles, and **`focused-reduced` is the supported default for
focused card work**. Everything else — CI, deployment, release, architecture and
control-plane runs, evidence production, and anything declaring that it needs
complete history — is provisioned as the `full` checkout control. Which one a
request gets is a routing decision, not a flag the caller has to remember.

This is a development-provisioning contract only: it changes no product
behaviour, no served output, no Worker bundle and no deployment path, and CI
continues to use the full checkout.

## Provisioning

```bash
# Routed. Focused card work gets the reduced profile; the router says so out loud.
tools/provision_card_profile.sh provision --dest ../cityscroll-card

# Any other work surface routes to the full control.
tools/provision_card_profile.sh provision --dest ../cityscroll-ci --surface ci

# Ask without provisioning anything.
tools/provision_card_profile.sh decide --surface focused-card-work --gate worker-unit
```

`--profile focused-reduced|full` overrides the routing decision. The override is
recorded in the receipt rather than hidden, because a checkout that was not
routed to its profile is a thing a reviewer should be able to see.

All forms accept `--rev`, `--source`, `--store`, `--no-install`, `--timing-out`
for a JSON timing record and `--receipt-out` for a provisioning receipt.
`--depth 1` is available on the reduced profile and **not recommended**: it was
measured slower overall, and it removes the history a merge-base guard needs
until `tools/provision_card_profile.sh unshallow` runs.

`tools/provision_card_profile.sh status` reports which profile a checkout is,
its recorded profile identity, and whether that identity has gone stale.

## The routing decision

A request names a **work surface**. The router turns it into exactly one
profile, records which rule fired, and never selects the reduced profile by
omission: an undeclared surface or an unclassified gate class is an error, and
the last rule in the list is the control.

<!-- generated: card-profile-decision-table -->
| Work surface | Provisioned profile | Why |
| --- | --- | --- |
| `focused-card-work` | `focused-reduced` | Implementing one card against a bounded set of profile-supported gate classes. This is the surface the reduced profile was measured for, and the only one it may be handed to. |
| `ci` | `full` | CI runs the whole required gate set, including the site standards, site and contract unit, generated-document and reading-level families that read across the excluded byte-heavy trees. CI is unchanged by this card and continues to provision the full checkout. |
| `unit` | `full` | test/*.test.mjs and test/contract/*.test.mjs read tracked builder inputs across site/data, data/ and entity_resolution/, which the reduced profile deliberately defers. |
| `accessibility` | `full` | They serve the built site, which requires the generated Pages build over the complete tracked payload. |
| `artifact` | `full` | The Pages build and the served-artifact checks read the complete tracked site payload and the tracked artifacts/ tree. |
| `deployment` | `full` | A deployment publishes the built site and the Worker bundle. Provisioning a deployment from anything but the full control would make the published artifact depend on a development convenience. |
| `release-surface` | `full` | Release evidence is derived from the full tracked tree and from generated build output. |
| `architecture` | `full` | The reconciliation run projects and publishes evidence over the whole declared architecture surface, not one --check invocation, and its output is an artifact other work is judged against. |
| `repository-control-plane` | `full` | The RCP-03 evidence-placement receipt was measured reading 3,535 tracked paths totalling 615.4 MiB, close to the whole tracked tree, and the per-tree inputs it derives from span every documentation tree. |
| `evidence` | `full` | Producing or placing evidence reads and writes across documentation trees the reduced profile defers, and an evidence receipt taken in a partial working copy would record an incomplete tree as if it were the tree. |
| `complete-history` | `full` | Declared explicitly by a caller that needs history beyond what its checkout carries. The default reduced profile keeps complete history, so this normally costs nothing extra; it is declared full because a caller that says it needs complete history must not be handed a checkout whose history depends on a profile option. |

| Order | Rule | When | Outcome |
| ---: | --- | --- | --- |
| 1 | `unknown-surface` | the requested work surface is not declared in this manifest | `error` |
| 2 | `unknown-gate-class` | a requested gate class is declared neither profile-supported nor full-checkout-only | `error` |
| 3 | `full-only-surface` | the requested surface is declared full_only | `full` |
| 4 | `complete-history-required` | the caller declares that the work needs complete commit history | `full` |
| 5 | `full-only-gate-class` | a requested gate class is full-checkout-only, or is not declared profile-supported | `full` |
| 6 | `path-outside-closure` | a requested path is in the deferred hydration set, or is not materialised by the committed pattern list | `full` |
| 7 | `stale-profile` | a recorded manifest digest is present and does not equal the computed one | `full` |
| 8 | `closure-unverified` | the closure manifest is not current, or a requested gate class has no non-empty observation receipt | `full` |
| 9 | `focused-card-work-verified` | the surface is focused-card-work and every precondition above is satisfied | `focused-reduced` |
| 10 | `default-full` | no rule above matched | `full` |
<!-- /generated: card-profile-decision-table -->

Regenerate that table with `node tools/card_profile_router.mjs --table`; a test
fails if it drifts from the manifest.

Two surfaces need a word of explanation. `architecture` and
`repository-control-plane` are full-checkout-only as **run surfaces** — the runs
that produce and publish evidence over a whole declared surface — while several
of their individual `--check` commands are profile-supported gate classes that do
run in a reduced checkout through the gate front door. The manifest records that
distinction against each surface.

## Profile identity, and when a profile goes stale

The reduced profile is bound to what it was derived from. `manifest_digest`
covers the routing manifest, the profile config, the generated pattern list and
closure, the dependency lock and the toolchain pin; `provision_identity`
additionally binds the revision.

```bash
node tools/card_profile_router.mjs --identity --json
```

Provisioning records the digest in the new checkout's Git directory. When a
later request computes a different one, the checkout was provisioned from a
profile that no longer describes this revision's inputs, so routing selects the
control until it is reprovisioned. `status` reports this as `STALE`.

## Proving which profile you got

```bash
tools/provision_card_profile.sh provision --dest <dir> --receipt-out <receipt.json>
node tools/card_profile_receipt.mjs --out <receipt.json>        # from inside a checkout
node tools/card_profile_receipt.mjs --check <receipt.json>      # does it still reproduce?
```

The receipt carries profile identity, revision, Git object mode, the closure it
was provisioned against, any explicitly hydrated paths, integrity checks, the
recorded-versus-computed identity, the routing decision, byte accounting and
provisioning timing. It is in three blocks:

| Block | Holds | Digested |
| --- | --- | --- |
| `deterministic` | What the tool observes about the checkout: identity, object mode, closure, hydration, integrity, recorded identity | yes |
| `context` | What the caller supplied: the routing decision and any fallback reason | no |
| `measurement` | Figures a second run may move: byte accounting, provisioning timing, pack counts | no |

`deterministic_digest` covers the first block only, which is what makes
`--check` a real reproduction test: it re-derives the digest from the checkout
alone, with no arguments to replay. Byte accounting is refused unless its
categories partition the total, and a receipt that would carry an absolute path,
a user name or a host name fails closed rather than being quietly trimmed.

## What the two levers do

**Git metadata** is reduced by a partial clone (`--filter=blob:none`) against the
durable origin. Every commit and tree is present, so history is complete and a
merge-base guard still resolves; only blobs are fetched lazily, and the promisor
remote that serves them is the real origin, never a scratch checkout. A partial
clone is used only when the source is a remote: a local source would make a
disposable checkout the promisor, and a local clone shares objects anyway.

**Tracked `site/data`** is reduced by a sparse checkout over a derived closure.
The closure is not hand-written. `tools/derive_card_profile.mjs` unions three
sources — the paths each supported gate class was observed to read, a transitive
static reference scan seeded from the Worker package, and declared structural
trees — and emits `tools/card-profile/card-work.sparse` and
`tools/card-profile/closure.v1.json`. Edit
`tools/card-profile/profile.config.v1.json` and re-run the deriver; never
hand-edit the generated outputs. A tracked file added inside the declared
coverage — a root document, an always-include path, or anything under an include
tree no exclude tree defers — must be followed by that re-run: the site unit
suite fails on a pattern list that does not materialise it, so the omission is
caught at review time rather than in the next reduced checkout that needs it.

## Which gates run in it

```bash
node tools/verify_card_profile.mjs --gate worker-unit -- bash -c 'cd worker && node --test'
```

`--gate` is the front door. It refuses a gate class the profile does not
support, runs a supported one with the sentinel loaded, and **fails the run when
the sentinel recorded a missing tracked path, whatever the gate itself
returned** — so a check that swallows an absent input cannot pass by omission.

The supported and full-checkout-only gate classes, each with its reason, are
listed in `tools/card-profile/closure.v1.json`. The site standards, site unit,
generated-document, evidence-placement, reading-level, accessibility, browser,
Pages build, release-surface and control-plane cutover-receipt families all
require the full checkout.

## Functional tests, and the corpus they need

Browser and accessibility families are full-checkout-only and stay that way. The
step that prepares the site they are served from is not: it runs a read-model
builder over tracked inputs the profile used to defer, and it does so on the way
into every functional run, reduced or not.

That combination used to fail badly. The builder died on a bare `ENOENT`, and the
copy step after it **cannot** fail on an absent input — it copies whatever the
working tree holds — so a partially materialised checkout served a smaller site
and the browser check timed out on a row that was never going to render. A
provisioning gap looked like an empty Browse result.

So the corpus is declared, and it is asserted before the work starts:

```bash
node tools/verify_functional_corpus.mjs --check                       # ready, or blocked with reasons
node tools/verify_functional_corpus.mjs --check --receipt-out <path>  # and a receipt
```

`tools/prepare_functional_site.sh` runs that check as its first statement, so a
missing input is reported as a missing input. The corpus itself lives in the
`functional_corpus` block of `tools/card-profile/closure.v1.json` and is derived,
never hand-written: the deriver unions the `functional-site` gate-class
observation with a scan of the declared functional harness sources — the Python
files that read a tracked read model directly, which no Node sentinel can see —
and keeps the part that falls inside a deferred tree. It is materialised by the
reduced profile, so a fresh reduced checkout is ready without hydrating anything.

A blocked result names the missing paths, the builder that wants them, the
remediation, and — the part that matters — that **no functional coverage was
obtained**. It is a statement about inputs, never about the product:

```
functional corpus BLOCKED - the functional suite was not run and no coverage was obtained.
  missing-corpus: 20 declared functional corpus path(s) are not materialised ...
  builder that needs them: tools/build_primary_documents.mjs
  remediation: tools/provision_card_profile.sh hydrate site/data/...
```

The check runs *before* the functional command and never wraps it, so a real
functional failure keeps its own exit status and its own message. There is no
skip branch, and no exit path on which a missing corpus reports success.

Two bounds are worth stating plainly. The reduced profile still serves a smaller
site than the control, so the corpus makes the *measured* functional tests
correct rather than the whole site complete; `measured_functional_tests` in the
closure records which those are. And the harness scan is a scan: a harness that
starts reading another tracked read model is caught by regenerating the profile,
which a test enforces. The measurements are in
[`docs/evidence/ci-11-functional-test-safe-reduced-profile/`](evidence/ci-11-functional-test-safe-reduced-profile/).

## When a path is missing

A tracked path the profile does not hold is marked skip-worktree. Reading one
raises `CardProfileMissingPath` naming the exact command instead of a bare
missing-file error:

```bash
tools/provision_card_profile.sh hydrate site/data/analytics_registered_contracts.json
tools/provision_card_profile.sh hydrate --full      # become the full-checkout control
tools/provision_card_profile.sh unshallow           # restore complete history
```

Hydration fetches any missing blob from the promisor remote, so it needs network
access. If a supported gate class needs a path routinely, record it into the
closure with `node tools/verify_card_profile.mjs --record <gate> -- <command>`
followed by `node tools/derive_card_profile.mjs`, run from a full checkout.

## Reproducing the measurements

```bash
tools/measure_card_profile_evidence.sh --scratch <scratch-dir> --out <raw-dir>
python3 tools/summarize_card_profile_evidence.py
```

The committed receipts and the before/after tables are in
[`docs/evidence/ci-09-working-copy-reduction/`](evidence/ci-09-working-copy-reduction/).
