# Reproducing every CI-10 receipt

Run from a full checkout with network access. The reduced profile is provisioned
by cloning a published revision, so the revision under measurement must exist on
the remote.

## The whole receipt set in one command

```bash
tools/measure_card_profile_routing_evidence.sh \
  --scratch "$(mktemp -d)" \
  --out docs/evidence/ci-10-default-reduced-profile/raw \
  --rev <revision> \
  --trials 5
```

It provisions throwaway checkouts under the scratch directory and removes them
afterwards; pass `--keep` to inspect them. The run **fails** if any probe misses
the exit it declared, if any profile-supported gate class does not pass in a
provisioned reduced checkout, or if any full-checkout control fails.

Regenerate the tables in `README.md` from those receipts:

```bash
python3 tools/summarize_card_profile_routing_evidence.py
```

## The individual steps

### Ask the router without provisioning anything

```bash
tools/provision_card_profile.sh decide --surface focused-card-work
tools/provision_card_profile.sh decide --surface ci
node tools/card_profile_router.mjs --decide --surface focused-card-work --gate worker-unit --json
node tools/card_profile_router.mjs --table          # the decision table in the guide
node tools/card_profile_router.mjs --check          # manifest self-consistency
```

Exit 2 is a request that failed closed. Exit 5 means a decision was reached but
did not match the profile `--require` asked for.

### Provision by naming the work

```bash
tools/provision_card_profile.sh provision --dest <dir> --rev <revision>
tools/provision_card_profile.sh provision --dest <dir> --rev <revision> --surface ci
```

Add `--gate <class>` to declare which gate classes the work will run,
`--require-complete-history` when it needs history beyond its own checkout,
`--timing-out <file.jsonl>` for a per-phase timing record, `--store <dir>` to pin
the shared dependency store, and `--receipt-out <file.json>` for a provisioning
receipt. `--profile focused-reduced|full` overrides the routing decision and the
override is recorded rather than hidden.

### Report and reproduce a receipt

```bash
tools/provision_card_profile.sh status              # profile, identity, staleness
node tools/card_profile_router.mjs --identity --json
node tools/card_profile_receipt.mjs --out <receipt.json>
node tools/card_profile_receipt.mjs --check <receipt.json>
```

`--check` re-derives the deterministic block from the checkout alone, with no
arguments to replay. That is what makes it a reproduction test rather than a
restatement.

### Measure bytes

```bash
python3 tools/measure_working_copy_footprint.py <dir> --label routed-focused
python3 tools/measure_working_copy_footprint.py "$(cd worker && corepack pnpm store path --silent)" \
  --store-only --label shared-dependency-store
```

The byte partition, the hard-link dedup rule and the no-double-counting rule are
CI-08's, reused unchanged so the three sets of numbers are comparable.

### Force the missing-blob case

A partial clone answers "is this object present?" by going and fetching it, so
the absence probe has to disable lazy fetching or it measures nothing:

```bash
blob="$(git rev-parse "HEAD:$deferred_path")"
GIT_NO_LAZY_FETCH=1 git cat-file -e "$blob"          # non-zero: genuinely absent

git remote set-url origin file:///nonexistent
git cat-file blob "$blob"                            # non-zero: fails loudly
tools/provision_card_profile.sh hydrate "$deferred_path"   # non-zero: refused
test -f "$deferred_path"                             # non-zero: nothing partial left behind

git remote set-url origin <real-origin>
tools/provision_card_profile.sh hydrate "$deferred_path"   # zero: succeeds again
```

### Force the missing-path case

```bash
node --require ./tools/card_profile_sentinel.cjs \
  -e "require('node:fs').readFileSync('<deferred-path>','utf8')"

node test/fixtures/card-profile/swallowed-missing-input.mjs                    # exit 0 bare
node tools/verify_card_profile.mjs --gate worker-unit -- \
  node test/fixtures/card-profile/swallowed-missing-input.mjs                  # exit 4 gated
```

### Run a gate class in a reduced profile

```bash
node tools/verify_card_profile.mjs --gate worker-unit -- bash -c 'cd worker && node --test'
node tools/verify_card_profile.mjs --gate cutover-receipt        # refused, exit 3
```

### Check integrity and history in a partial clone

```bash
git fsck --connectivity-only
git count-objects -v
git merge-base HEAD origin/main
git config --get remote.origin.partialclonefilter
```

`--connectivity-only` is the meaningful integrity check in a partial clone: it
verifies the object graph without demanding blobs the profile deliberately did
not fetch.
