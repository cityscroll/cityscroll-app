# Reproducing every CI-09 receipt

Run from a full checkout with network access. The reduced profile is provisioned
by cloning a published revision, so the revision under measurement must exist on
the remote.

## The whole receipt set in one command

```bash
tools/measure_card_profile_evidence.sh \
  --scratch "$(mktemp -d)" \
  --out docs/evidence/ci-09-working-copy-reduction/raw \
  --rev <revision> \
  --trials 3
```

That writes every file under `raw/` except `raw/closure/`, which is produced by
the closure recorder below. It provisions throwaway checkouts under the scratch
directory and removes them afterwards; pass `--keep` to inspect them.

Regenerate the tables in `README.md` from those receipts:

```bash
python3 tools/summarize_card_profile_evidence.py
```

## The individual steps

### Provision either profile

```bash
tools/provision_card_profile.sh provision --dest <dir> --profile card --rev <revision>
tools/provision_card_profile.sh provision --dest <dir> --profile full --rev <revision>
tools/provision_card_profile.sh provision --dest <dir> --profile card --depth 1 --rev <revision>
```

Add `--timing-out <file.jsonl>` for a per-phase timing record and `--store <dir>`
to pin the shared dependency store.

### Measure bytes

```bash
python3 tools/measure_working_copy_footprint.py <dir> --label card
python3 tools/measure_working_copy_footprint.py "$(cd worker && corepack pnpm store path --silent)" \
  --store-only --label shared-dependency-store
```

The byte partition, the hard-link dedup rule and the no-double-counting rule are
the ones CI-08 established; this card reuses the same instrument so the two sets
of numbers are comparable.

### Measure charged disk

Allocated bytes cannot see copy-on-write sharing on APFS, so the charged figure
is a free-space delta around one provisioning run:

```bash
before=$(df -k <scratch> | awk 'NR==2{print $4}')
tools/provision_card_profile.sh provision --dest <scratch>/probe --profile card --rev <revision>
after=$(df -k <scratch> | awk 'NR==2{print $4}')
echo $(( (before - after) * 1024 )) bytes
```

### Record a gate class into the closure

From a full checkout:

```bash
node tools/verify_card_profile.mjs --record worker-unit -- bash -c 'cd worker && node --test'
node tools/derive_card_profile.mjs
```

`--record` runs the gate with the read recorder loaded, writes the observation
receipt under `raw/closure/`, and the deriver folds it into the pattern list and
the closure manifest.

### Run a gate class in a reduced profile

```bash
node tools/verify_card_profile.mjs --gate worker-unit -- bash -c 'cd worker && node --test'
node tools/verify_card_profile.mjs --gate evidence-placement          # refused, exit 3
```

### Force a missing path

```bash
# named failure carrying the hydrate command, not a bare missing file
node --require ./tools/card_profile_sentinel.cjs \
  -e "require('node:fs').readFileSync('site/data/analytics_registered_contracts.json','utf8')"

# a check that swallows the miss: exit 0 bare, exit 4 through the gate front door
node test/fixtures/card-profile/swallowed-missing-input.mjs
node tools/verify_card_profile.mjs --gate worker-unit -- \
  node test/fixtures/card-profile/swallowed-missing-input.mjs

# the documented hydration route
tools/provision_card_profile.sh hydrate site/data/analytics_registered_contracts.json
```

### Prove the history fallback

```bash
git merge-base HEAD origin/main            # resolves in the default card profile
tools/provision_card_profile.sh unshallow  # needed only for the opt-in --depth variant
```

### Check integrity in a partial clone

```bash
git fsck --connectivity-only
git count-objects -v
git config --get remote.origin.partialclonefilter
```

`--connectivity-only` is the meaningful integrity check in a partial clone: it
verifies the object graph without demanding blobs the profile deliberately did
not fetch.
