# Connected-history coverage evidence

This directory retains the browser measurement manifest for the authenticated
Desk coverage view. Screenshot binaries stay outside Git; the manifest records
their hashes, the exact named viewports, the capture revision, the retained
input hashes, the data vintages, and the runtime assertions.

The committed census is
[`site/data/connected_history_coverage.json`](../../../site/data/connected_history_coverage.json).
It derives two snapshots from already-retained materializations:

- the frozen pre-tuning population and source judgments;
- the current retained acquisition, extraction, admission, and discoverability
  projection.

Each snapshot enumerates all 59 canonical boards. A multiboard subject appears
in every relevant local scope and once in citywide unique totals. `unknown`,
`partial`, and `measured_zero` are separate states; none describes how much
civic activity occurred in a neighborhood.

Reproduce the artifact and browser measurement with:

```sh
node tools/build_connected_history_coverage.mjs --check
python3 tools/capture_connected_history_coverage.py
node --test test/connected_history_coverage.test.mjs
```

After the delivery commit lands and is deployed, the read-only production
instrument can retain an in-run served-data receipt:

```sh
python3 tools/capture_connected_history_coverage.py \
  --production --landed-commit <40-hex-landed-commit>
```

The production read refuses a served revision that does not contain the named
commit, a missing census, incomplete board enumeration, or a zero-denominator
score presented as estimable.
