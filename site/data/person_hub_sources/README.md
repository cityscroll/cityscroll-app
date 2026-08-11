# Person hub sources

Official identity hub and influence-edge measurements for CityScroll.

| Source | Dataset | Artifact |
|---|---|---|
| NYC Council Members | `uvw5-9znb` | `../person_hub_lookup.json` |
| City Clerk eLobbyist | `fmf3-knd8` | `../official_lobby_influence_lookup.json` |
| CFB Campaign Contributions | `rjkp-yttg` | `../official_cfb_influence_lookup.json` |

## Rebuild

```bash
node tools/build_person_hub.mjs
node tools/build_official_influence.mjs
node tools/build_person_hub.mjs --check
node tools/build_official_influence.mjs --check
# Immutable source_records-shaped retention (shadow dual-write)
node tools/retain_person_hub_source_records.mjs --from-fixture --publish
node tools/retain_person_hub_source_records.mjs --check
```

## Gates

Influence edges materialize only when a dated kill sample clears:

- usefulness ≥ 30%
- reviewed precision ≥ 95%

Receipts live in `verification_receipts/`. Exact unique person-name keys only;
source-null stays null. The independent official decision-constellation bar
(≥30 roll-call events) is measured separately on `person_votes_lookup.json`.

Source-records retention (2026-08-11) re-measures the same hub joins on retained
publisher rows and declares the three streams complete in
`entity_resolution/source_coverage.json` under `PERSON_HUB_SOURCE_RECORD_DUAL_WRITE`.
Public pages do not read those observation rows.
