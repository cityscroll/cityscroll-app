# Formula: award → registration dwell (Human Services)

**Status:** shipped (batch precompute)  
**Model:** `award_registration_dwell` `1.0.0`  
**Population:** City Record Online Procurement notices with
`type_of_notice_description = Award` and
`category_description = Human Services/Client Services`

## What it measures

For each Human Services award notice, the number of calendar days from the
City Record **award publication** day (`start_date`) to a joined **registration**
day when one can be identified.

Registration is taken from PASSPort Public `public_ctr_data` via the existing
strict PIN ↔ EPIN join (`worker/src/lib/passport_join.mjs`). A Checkbook-shaped
side-car (`pin` + `registration_date`) is accepted for fixtures and future bulk
packs.

Award rows come from the City Record Online corpus (`dg92-zbpx`) filtered to
Procurement / Award / Human Services/Client Services — the same population as
the warehouse bulk City Record pack when DuckDB is registered, otherwise SODA
pagination at build time.

## Honesty rules

| Case | `registration_status` | `dwell_days` |
|---|---|---|
| Registration date joins | `found` | signed integer days (0 allowed for same-day) |
| No join, or join without a registration date | `unknown` | **null** (never 0) |
| Registration day before award publication | `found` | **negative** (not coerced to 0; City Record can lag) |

Unknown must never render as instant registration. Distribution stats report
non-negative dwells and “registration prior” absolute lags separately.

## Distribution

Nearest-rank empirical quantiles over non-negative found dwells: min, p10, p25,
p50, p75, p90, max, mean. Join rate = found / awards.

## Rebuild

```bash
# Offline fixture (CI-safe)
node tools/build_award_registration_dwell.mjs --fixture

# Live City Record Human Services awards + PASSPort Public contracts
node tools/build_award_registration_dwell.mjs --fetch-awards --fetch-passport

node tools/build_award_registration_dwell.mjs --check
node --test test/award_registration_dwell.test.mjs
```

## Artifacts

- `site/data/award_registration_dwell.json` — summary + distribution
- `site/data/award_registration_dwell_observations.json` — per-award rows
- `docs/evidence/award-registration-dwell/summary.json`
- `warehouse/receipts/proof/award_registration_dwell_latest.json`

## Out of scope

Notice-strip UI for these numbers is a separate gated card. This materialization
is build-time only.
