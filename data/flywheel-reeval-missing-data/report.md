# Missing-data workstream re-evaluation

**Measured:** 2026-08-03 (cache-busted against committed corpora + rebuild of `district_activity` / location-resolution inventory in this session).  
**Baseline A (pre human-derivation):** `docs/evidence/map-lens-location-gap/district_activity_before.json` (`built_at` 2026-08-03T13:03:41Z).  
**Baseline B (post human-derivation PR):** `docs/evidence/map-lens-location-human-derivation/located_rates.json` after stamp (`built_at` 2026-08-03T16:37:08Z).  
**Doctrine:** shipped ≠ working — every “covered” claim below is a live file/receipt check, not a backlog card.

Raw numbers: `data/flywheel-reeval-missing-data/measured_snapshot.json` (pre-fix snapshot) + post-fix rebuild of `site/data/district_activity.json`.

---

## 1. Map location coverage (primary missing-data surface)

| Lens | Baseline A located/count | Baseline B located/count | Live pre-fix | **Live post-fix (this PR)** | `no_place_signal` post-fix |
|------|--------------------------|--------------------------|----------------|------------------------------|------------------------------|
| land | 236/236 (100%) | 236/236 | 236/236 | **236/236 (100%)** | 0 |
| property | 133/133 (100%) | 133/133 | 133/133 | **133/133 (100%)** | 0 |
| meetings | 0/119 (0%) | 81/119 (68%) | 85/119 (71%) | **95/119 (80%)** | **24** |
| rules | 0/100 (0%) | 100/100 (100%) | 100/100 | **100/100 (100%)** | 0 |
| money | 0/8 (0%) | 2/8 (25%) | 2/8 (25%) | **2/3 (67%)** | **1** |

Notes:

- Meetings virtual bag is honest: **3** virtual-only (not folded into silent unlocated).
- Meetings citywide bag rose **3 → 13** after Agency Rules default (see §3).
- Money **counted 8 → 3**: five synthetic `FIX*` warehouse sample rows no longer pollute map density (they remain available for OCP lookup / ER fixtures).

### Location-resolution inventory (flywheel input)

| Check | Pre-session | Post-fix |
|-------|-------------|-----------|
| `measured_at` | hard-coded `2026-08-02` | **dynamic UTC day** (`2026-08-03`) |
| map money located | **0** (stale vs live) | **2** (mirrors live) |
| map meetings located | **14** (stale) | **95** |
| mirrors `unlocated_reasons` | no | **yes** |
| `node tools/build_location_resolution_inventory.mjs --check` | **FAIL (stale)** | **OK** |

**Finding (shipped ≠ working):** the location-resolution inventory claimed map money `located=0` and meetings `located=14` while live `district_activity` already had money=2 / meetings=85. Cards that only read the inventory would under-report progress and miss residual `no_place_signal` tails.

---

## 2. Source completeness vs live product surfaces

| Source | Warehouse / bulk (live receipt) | Product surface (committed) | Gap |
|--------|----------------------------------|-----------------------------|-----|
| City Record bulk `dg92-zbpx` | **1,098,698** rows; snapshot `2026-08-03`; sections: Personnel 961,586 · Procurement 105,119 · Hearings 8,936 · Agency Rules 3,061 · Property Disposition **243** · … | Daily Worker ingest + capped domain observations (meetings 119 / rules 100 / property 133) | Bulk is full-history; map/EI slices are intentional windows — not a miss. Personnel dominates row count and is correctly out of map lenses. |
| OCP awards `qyyg-4tf5` | Bulk **53,216** rows (`observed_at` 2026-08-02) | Map lookup **fixture_warehouse**, **8** rows (3 product seed + 5 `FIX*`); `materialized_at` 2026-08-02 | **Major:** warehouse bulk not serving map money density. Product demos only. |
| ZAP projects | Lookup mode **bulk_warehouse**, **231** rows | Land map 236 counted (incl. multi-CD expansion) | Healthy for sell-facing slice. |
| ZAP BBL | Lookup mode **fixture_warehouse**, **11** projects / 89 BBL rows | Cross-domain `sited_on_parcel` limited | **Fixture vs bulk gap** for parcel joins. |
| Attachment T0 | Receipt mode **fixture**; 2 attachments | Public lookup **1** notice, tier labeled `t1_inline_text` | Host-side collector exists; public corpus thin. |
| Attachment T1 text | Receipt mode **fixture**; 1 doc extracted | UI progressive disclosure wired | **T2 structured / T3 embeddings still pending** (`later_tiers` on T1 receipt). |
| Legistar roll-call | `person_votes_lookup`: **15** persons / **194** vote rows | `#official/{id}` precompute-first | Coverage is densify-window limited, not a false “covered everywhere”. |
| Staffing / NOE | `staffing_exams.json`: **228** exams; OASys map + densify paths | Apply deep links when mapped | Fee/salary NOE densify measured separately; class-(a) gaps remain for schedule-only exams. |
| Disabled sources | bid-tabulations, ULURP recommendations, capital projects, NYCHA Checkbook, … | Correctly **disabled** after usefulness measurement | Do not re-enable without new join evidence. |

### Fields extracted-but-unrendered (sample audit)

| Field family | Extracted? | Rendered? | Notes |
|--------------|------------|-----------|-------|
| Attachment `extracted_text` / `text_preview` | yes (T1 path) | yes (collapsed `.attachment-extract`) | Working when metadata present; public inventory still 1 notice. |
| `structured_facts` (PIN/EPIN, deadlines, parties) | yes on ingest | partial (alert / lifecycle fill only) | Full structured_facts blob not a public detail panel. |
| Money OCP `vendor_address` | present on bulk schema | map only when stamped/gazetteered | Product seed demos locate; bulk map corpus missing. |
| Meeting densify stamps without body | place stamps only | map uses stamps | Residual no_place rows lack body on domain snapshot — re-densify needs live SODA. |

---

## 3. Gaps implemented this round

### G1 — Synthetic money FIX* rows polluted map `no_place_signal`

**Measured:** 5 of 8 money map rows were `FIX001`…`FIX005` (offline warehouse sample). They contributed 5 of 6 `no_place_signal` counts — the “money no-signal tail” was mostly fixture pollution, not city data.

**Fix:** `isSyntheticWarehouseFixtureRow` skips `FIX*` / `FIXTURE VENDOR` / `PIN-FIXTURE-*` in `buildDistrictActivity` money loop.  
**Detector:** residual `map-high-no-place-signal-*` cards now fire when real share is still high (see G3).  
**Result:** money **2/3 located (67%)**, `no_place_signal` **1** (real award `20260724010` Samuel17 without address).

### G2 — Agency Rules meetings left unlocated while rules lens is citywide-default

**Measured:** 8–10 of the meetings residual were `section_name=Agency Rules` with stamped `no_place_signal`, while the rules lens already defaults those to citywide.

**Fix:** `meetingPlacementsFromRow` applies `rule_default_citywide` when the row is Agency Rules and still unplaced (honors existing densify stamps without inventing a borough).  
**Result:** meetings located **85 → 95** (80%); citywide meetings **3 → 13**; residual `no_place_signal` **34 → 24**.

### G3 — Stale location-resolution inventory + missing residual detector

**Measured:** inventory `map_aggregates` lagged live district_activity; no card for high `no_place_signal` share once located≥1.

**Fix:**

- Rebuild inventory from live district_activity; mirror `unlocated` / `unlocated_reasons` / `citywide` / `virtual`.
- Dynamic `measured_at` (UTC day).
- New wackness class `map-high-no-place-signal` (≥25% share or ≥8 absolute `no_place_signal` on counted≥3).

**Verify:**

```bash
node tools/build_district_activity.mjs --check
node tools/build_location_resolution_inventory.mjs --check
node --test test/location_derivation.test.mjs test/multi_flywheel_dimensions.test.mjs test/map_surface.test.mjs test/map_exploration.test.mjs
```

---

## 4. Ranked draft cards (not implemented)

| Rank | Draft card | Evidence (measured) | Why not this PR |
|------|------------|---------------------|-----------------|
| 1 | **Serve OCP bulk (or a place-stamped sell-facing slice) into map money** | Warehouse 53,216 rows vs map 3 real awards; money density still demo-thin | Needs DuckDB catalog on build agents + place densify pass; larger than serial map fix |
| 2 | **Meetings residual 24 `no_place_signal`** (Board Meetings calendars, RGB, Charter Revision, NYCHA, etc.) | 24/119 still no place after Agency Rules default | Needs body re-densify (`build_rules_meetings_domain_observations` live SODA) or venue/agency HQ expansion with honesty review |
| 3 | **ZAP BBL fixture → bulk materialization** | mode `fixture_warehouse`, 11 projects | WH-06 bulk path exists; headroom + rebuild receipt |
| 4 | **Attachment T0/T1 host corpus expansion + public lookup densify** | public lookup 1 notice; receipts still fixture mode | Polite portal scrape ops + D1 upload; not pure offline |
| 5 | **Attachment T2 structured tables / T3 embeddings** | T1 receipt `later_tiers` only | New tier design; deferred by AGENTS.md |
| 6 | **Money award `20260724010` place** (Samuel17) | sole remaining real no_place on map money | Need vendor_address or performance place from publisher — do not invent |
| 7 | **Person roll-call densify window expansion** | 15 persons / 194 votes | Legistar materialization window / dual-write ops |
| 8 | **structured_facts public detail panel** | extracted on ingest, not first-class UI | Product choice (surface load / cognitive load) |

---

## 5. Delta summary

| Metric | Baseline A | Baseline B | After this PR |
|--------|------------|------------|---------------|
| Meetings located rate | 0% | 68% | **80%** |
| Meetings `no_place_signal` | n/a (no reasons) | 35 | **24** |
| Money located rate (map corpus) | 0% | 25% (2/8) | **67% (2/3 real)** |
| Money `no_place_signal` | 8 unlocated | 6 | **1** (fixture pollution removed) |
| Rules / land / property | 0 / 100 / 100 | 100 / 100 / 100 | **unchanged healthy** |
| Inventory mirrors live map residuals | no | partial / stale | **yes** |
| Flywheel residual detector | zero-located only | zero-located only | **+ high no_place_signal** |

City Record bulk **1.098M** rows and OCP bulk **53k** remain **warehouse-covered**; the open missing-data front is **product materialization width** (map money, ZAP BBL, attachments, roll-call window), not absence of source ingest for the primary City Record / OCP packs.

---

## 6. Rebase onto main after #432 / #433 (2026-08-04)

Serial line landed property date-chip (#438), money densify (#432), and map drill scope (#433) before this PR. Rebuilt `district_activity` + location inventory on that tip:

| Lens | After #432–#433 + this PR rebuild |
|------|-----------------------------------|
| land | 236/236 (100%) |
| property | 133/133 (100%) |
| meetings | **95/119 (80%)**, `no_place_signal` **24**, citywide **13**, virtual **3** |
| rules | 100/100 (100%) |
| money | **128/340 (38%)** located + **42** citywide; **`no_place_signal` 212** |

**Money 212-no-signal tail (named residual):** PR #432 densified map money from the 8-row fixture to `money_domain_observations` (340 awards). Live residual is **212** rows with `no_place_signal` (62% of corpus) — the flywheel `map-high-no-place-signal-money` detector now ranks that debt. This PR’s FIX* skip still keeps synthetic warehouse samples out of the fallback path; it does not shrink the densified 212-tail (needs more place densify, not fixture filtering).

Artifact: rebuild timestamps on `site/data/district_activity.json` / `worker/src/data/district_activity.json` and refreshed `ontology/fixtures/dimensions/location_resolution.json`.
