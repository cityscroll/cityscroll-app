# Connected-histories production censuses

This directory retains production census observations declared for the
discover-journey and geographic-discoverability measurement gates.

Screenshot binaries are never committed. Each observation records the served
revision, an observation timestamp, request receipts, and counted denominators
so a measured zero stays distinct from an absent measurement. Observations do
not carry a self-asserted pass verdict.

## Discover journeys

[`discover-journeys-readback.json`](discover-journeys-readback.json) uses schema
`cityscroll.connected_histories_discover_journeys.v1`. It counts journeys
attempted and journeys satisfied across the fixed six-case dossier at three
named profiles (desktop keyboard, narrow touch, and no-JavaScript).

Reproduce:

```sh
python3 tools/capture_connected_histories_discover_journeys_production_read.py \
  --production --landed-commit <40-hex-landed-commit> --write
python3 tools/capture_connected_histories_discover_journeys_production_read.py --check
node --test test/connected_histories_discover_journeys_production_read.test.mjs
```

The runner refuses a non-main pin, a served revision that does not contain the
landed commit, absent served history materializations, an incomplete journey
census, a served revision change during the read, and missing or repeated edge
receipts.

## Geographic discoverability

[`geographic-discoverability-readback.json`](geographic-discoverability-readback.json) uses schema
`cityscroll.connected_histories_geographic_discoverability.v1`. It counts areas
attempted and areas discoverable across all 59 community boards from the served
coverage `post_change` snapshot.

Reproduce:

```sh
python3 tools/capture_connected_histories_geographic_discoverability_production_read.py \
  --production --landed-commit <40-hex-landed-commit> --write
python3 tools/capture_connected_histories_geographic_discoverability_production_read.py --check
node --test test/connected_histories_geographic_discoverability_production_read.test.mjs
```

The runner refuses a non-main pin, a served revision that does not contain the
landed commit, absent or non-JSON served coverage, an incomplete 59-board
enumeration, a served revision change during the read, and missing or repeated
edge receipts.
