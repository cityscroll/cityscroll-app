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

The read-only production instrument observes the served origin and retains its
receipt under `production_measurement` in the manifest:

```sh
python3 tools/capture_connected_history_coverage.py \
  --production --landed-commit <40-hex-landed-commit> --write-manifest
```

It reads the served revision from the Pages artifact manifest before and after
the census and refuses a change between the two. It refuses a pin that is not
on the default branch, a served revision that does not contain the named
commit, a missing census (including an HTML answer for an absent path),
incomplete enumeration of the 59 canonical boards, a zero-denominator score
presented as estimable, and any served request without its own edge ray,
timestamp and date. The retained receipt records the served census digest
beside the repository digest at the served revision, and lists what the served
census does not supply: unavailable strata, stages it cannot report, and
boards measured at zero. `node --test test/connected_history_coverage.test.mjs`
exercises each refusal as its own case against the real guards.
