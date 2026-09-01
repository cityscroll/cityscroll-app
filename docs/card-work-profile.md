# Reduced provisioning profile for focused work

A fresh full working copy costs about 1.4-1.6 GiB and spends most of its
provisioning time transferring Git objects. Two thirds of the bytes are Git
repository metadata and the tracked `site/data` payload; the measurements are in
[`docs/evidence/ci-08-working-copy-footprint/`](evidence/ci-08-working-copy-footprint/).

The **card-work profile** is a supported smaller checkout for focused work. It is
a development convenience only: it changes no product behaviour, no served
output, no Worker bundle and no deployment path, and CI continues to use the
full checkout.

## Provisioning

```bash
# Reduced card-work profile
tools/provision_card_profile.sh provision --dest ../cityscroll-card --profile card

# Full-checkout control, the same thing CI provisions
tools/provision_card_profile.sh provision --dest ../cityscroll-full --profile full
```

Both accept `--rev`, `--source`, `--store`, `--no-install`, and `--timing-out`
for a JSON timing record. `--profile card --depth 1` is available and **not
recommended**: it was measured slower overall, and it removes the history a
merge-base guard needs until `tools/provision_card_profile.sh unshallow` runs.

`tools/provision_card_profile.sh status` reports which profile a checkout is.

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
hand-edit the generated outputs.

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
Pages build and release-surface families all require the full checkout.

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
