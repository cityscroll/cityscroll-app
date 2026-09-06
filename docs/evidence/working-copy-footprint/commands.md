# Exact commands

Every table in `README.md` is regenerated from the receipts in `raw/` by:

```bash
python3 tools/summarize_working_copy_evidence.py
```

The receipts themselves were produced by the commands below. Substitute your
own scratch directory for `$SCRATCH`, your own clone of the repository for
`$LOCAL_OBJECT_SOURCE`, and keep every checkout outside the repository under
measurement. `$REV` is the pinned revision recorded in `raw/environment.json`.

```bash
REV=f095d4b8d844d1a969c70e4909dc0f65960f1a7d
URL=https://github.com/cityscroll/cityscroll-app.git
```

## 1. Two fresh isolated checkouts at the pinned revision

```bash
# Checkout A — remote source
git clone "$URL" "$SCRATCH/wc/A"
git -C "$SCRATCH/wc/A" checkout --detach "$REV"

# Checkout B — local object source, full object copy rather than hard links
git clone --no-hardlinks "$LOCAL_OBJECT_SOURCE" "$SCRATCH/wc/B"
git -C "$SCRATCH/wc/B" checkout --detach "$REV"
```

Both were confirmed clean (`git status --porcelain` empty) and at the same
revision before any measurement ran.

## 2. Store-backed dependency install

```bash
# Cold: empty store, network available
rm -rf "$SCRATCH/pnpm-store" && mkdir -p "$SCRATCH/pnpm-store"
CITYSCROLL_PNPM_STORE_DIR="$SCRATCH/pnpm-store" \
  "$SCRATCH/wc/A/tools/install_worker_dependencies.sh"

# Warm: populated store, network disabled so the row cannot hide a fetch
rm -rf "$SCRATCH/wc/B/worker/node_modules"
CITYSCROLL_PNPM_STORE_DIR="$SCRATCH/pnpm-store" \
  "$SCRATCH/wc/B/tools/install_worker_dependencies.sh" --offline
```

## 3. Byte breakdown

```bash
python3 tools/measure_working_copy_footprint.py "$SCRATCH/wc/A" --label checkout-A \
  > raw/footprint-checkout-a.json
python3 tools/measure_working_copy_footprint.py "$SCRATCH/wc/B" --label checkout-B \
  > raw/footprint-checkout-b.json
python3 tools/measure_working_copy_footprint.py "$SCRATCH/pnpm-store" --store-only \
  --label shared-store > raw/footprint-shared-store.json
```

## 4. Provisioning time by phase

```bash
tools/measure_provisioning_time.sh --source local-copy --rev "$REV" \
  --origin "$LOCAL_OBJECT_SOURCE" --scratch "$SCRATCH/trial" \
  --out raw/provisioning-timings.jsonl --label "local-copy-t1" \
  --phases prepare,checkout --network none

tools/measure_provisioning_time.sh --source linked-working-tree --rev "$REV" ...
tools/measure_provisioning_time.sh --source remote     --rev "$REV" --origin "$URL" \
  --network online ...
```

Five trials per source class. The scratch checkout is removed between trials so
no trial reuses a previous trial's objects.

## 5. Reduction candidate — shallow and partial clone

Three trials per variant, each from the remote origin with the scratch checkout
removed in between:

```bash
git clone --depth=1 --branch main "$URL" "$SCRATCH/cand"
git clone --filter=blob:none "$URL" "$SCRATCH/cand"
git clone --filter=tree:0 "$URL" "$SCRATCH/cand"
git clone --depth=1 --branch main --filter=blob:none "$URL" "$SCRATCH/cand"
```

Git directory size and working-tree file count were read with `du -skA` and
`find ... -type f` after each clone.

## 6. Reduction candidate — sparse-checkout profiles

Three trials per profile:

```bash
git clone --no-hardlinks --no-checkout "$LOCAL_OBJECT_SOURCE" "$SCRATCH/sp"
git -C "$SCRATCH/sp" sparse-checkout init --cone
git -C "$SCRATCH/sp" sparse-checkout set worker tools .github test   # worker-card
git -C "$SCRATCH/sp" checkout --detach "$REV"
```

## 7. Generated site build

```bash
rm -rf _site site/browse site/now
node tools/build_cloudflare_pages.mjs --site-dir _site
```

This is the deploy-time build command recorded in
`docs/release/cloudflare-native-builds.json`.

## 8. Copy-on-write experiments

```bash
sync; df -k / | tail -1 | awk '{print $4}'   # free space before
<operation>
sync; df -k / | tail -1 | awk '{print $4}'   # free space after
```

Free-space delta is the only way to observe copy-on-write sharing on APFS,
because `st_blocks` reports every clone at full size.

## 9. Gate-compatibility probes

Run each gate inside a reduced checkout, then re-run it in the same clone with
the reduction removed as a control:

```bash
git -C "$SCRATCH/gp" sparse-checkout init --cone
git -C "$SCRATCH/gp" sparse-checkout set worker tools .github test
git -C "$SCRATCH/gp" checkout --detach "$REV"

( cd "$SCRATCH/gp/worker" && node --test )                    # Worker unit family
( cd "$SCRATCH/gp" && node tools/build_capability_topology.mjs --check )

git -C "$SCRATCH/gp" sparse-checkout disable                  # control
( cd "$SCRATCH/gp" && node tools/build_capability_topology.mjs --check )
```

## 10. Post-build footprint

Measured on the same checkout after the site build, so the generated-output
category is non-zero:

```bash
python3 tools/measure_working_copy_footprint.py "$SCRATCH/wc/A" \
  --label checkout-A-after-site-build \
  > raw/footprint-checkout-a-after-site-build.json
```
