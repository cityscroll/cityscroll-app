# Doing Business Search — Entities (`72mk-a8z7`)

NYC Open Data listing of organizations that file under the city's Doing Business
Accountability rules. Used as **vendor identity enrichment** on CityScroll vendor
profiles (listing status, ownership structure, organization phone, start date).

| Surface | URL |
|---|---|
| Catalog | https://data.cityofnewyork.us/d/72mk-a8z7 |
| Resource API | https://data.cityofnewyork.us/resource/72mk-a8z7.json |

## Scope

- **Rows:** 10,787 organizations (recon 2026-07-30).
- **Columns:** `organization_name`, `ownership_structure_code`, `organization_phone`,
  `doing_business_start_date` only — no EIN, BIN, PIN, or EPIN.
- **Publisher last-modified (resource):** 2025-11-21.
- **Join key:** product `vendorStem()` on `organization_name` ↔ City Record
  `vendor_name` (same stem rules as name-variant resolution).

## Product decision (measured)

Strict stem joins clear the ~30% usefulness threshold for edge materialization:

| Universe | Joined | Total | Rate |
|---|---:|---:|---:|
| Procurement Award notices with vendor, `start_date` ≥ 2025-01-01 (notice-level) | 3,643 | 5,173 | **70.42%** |
| Distinct vendors in that modern award set (stem) | 1,567 | 2,543 | **61.62%** |
| Distinct modern award vendors (exact uppercase name) | 769 | 2,543 | 30.24% |
| Historical awards 2016–2024 (notice-level stem) | 13,507 | 22,593 | 59.78% |

Receipts: `verification_receipts/doing_business_entities_2026-07-30.json` and the
`join_measurement` block on source contract `doing-business-entities`.

**Ship rule applied:** materialize onto daily vendor-profile rebuilds
(`worker/src/vendor_profile.mjs` → `doingBusiness` field). Do not invent legal
registration claims for unmatched stems — show the card only when the stem joins.

## Join strategies

**Accepted:** `vendor_stem` (product `vendorStem` on both sides).

**Rejected:** substring / token-overlap name matches; phone-only joins (shared
phones across related orgs).

## Date quirk

Publisher `doing_business_start_date` values often use a truncated year form
`00YY-MM-DD` (for example `0009-05-16` for 2009-05-16). Product normalize maps
`00YY` → `20YY` before display.
