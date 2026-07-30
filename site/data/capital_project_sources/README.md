# Capital Projects recon

NYC Open Data dataset [`n7gv-k5yt`](https://data.cityofnewyork.us/d/n7gv-k5yt)
(Capital Projects: major infrastructure and IT projects with a budget of $25M+).

## Join keys

The table has **no PIN or EPIN column**. Available join surface is agency +
project name only (`managing_agency`, `client_agency`, `project_name`, internal
`pid`).

## Measurement (2026-07-30)

On 100 recent City Record Procurement notices (`start_date` ≥ 2025-01-01):

| Strategy | Join rate |
|---|---:|
| Unique `project_name` substring in notice title | **0%** |
| Unique token Jaccard ≥ 0.35 with margin | **1%** |

Both rates are below the ~30% usefulness threshold. Receipt:
`verification_receipts/capital_projects_2026-07-30.json`.

## Product decision

- **No edge materialization** on a fuzzy name join.
- Gap `procurement-planning-budget` stays **not_published** with a pointer that
  names Capital Projects and the deep link
  `https://data.cityofnewyork.us/d/n7gv-k5yt` — budget figures would appear
  there if released with a PIN/EPIN that can join to City Record notices.

Helpers (recon only): `worker/src/lib/capital_projects_join.mjs`.
