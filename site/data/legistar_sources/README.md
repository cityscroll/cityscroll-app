# Legistar depth recon (Council meeting outcomes)

Measured join coverage for NYC Council agenda/vote materialization depth.

| Surface | URL |
|---|---|
| Legistar API docs (token form) | https://council.nyc.gov/legislation/api/ |
| Legistar Web API (client `nyc`) | https://webapi.legistar.com/v1/nyc/ |
| City Council Meetings Open Data | https://data.cityofnewyork.us/d/m48u-yjt8 |

## Access (re-measured 2026-07-30 with `LEGISTAR_API_TOKEN`)

| Path | Unauthenticated | Authenticated (`token=` query) |
|---|---|---|
| `Events`, `Bodies`, `Matters` | HTTP **403** | HTTP **200** |
| Top-level `EventItems` / `Votes` | 404 | 404 (use nested routes) |
| Nested `Events/{id}/EventItems` | n/a | HTTP **200** |
| Nested `EventItems/{id}/Votes` | n/a | HTTP **200** when votes exist |
| Nested `EventItems/{id}/Attachments` | n/a | HTTP **200** |

**Token hygiene:** use the full multi-segment key from the Legislative API Key email
(first segment alone → HTTP 403 Invalid Token). Configure as environment /
Worker secret `LEGISTAR_API_TOKEN`. Never commit the value.

Open Data `m48u-yjt8` remains a free event-identity freeze through **2024-12-19**
(no vote/agenda-item columns). Live Web API is the path for modern depth.

## Product decision (authenticated)

Strict notice → Legistar event joins (`exact_date_body_tokens` on `EventBodyName`):

| Universe | Joined | Total | Rate |
|---|---:|---:|---:|
| City Council Public Hearings, `start_date` ≥ 2025-01-01 | 59 | 59 | **100%** |
| Same, `start_date` in [2019-01-01, 2025-01-01) | 127 | 173 | **73.41%** |
| Same, `start_date` in [2023-01-01, 2025-01-01) | 56 | 59 | 94.92% |

Depth among **joined modern** notices (59/59 events):

| Layer | Fraction of joined events |
|---|---:|
| EventItems present | **100%** |
| At least one matter-linked item | **98.3%** |
| At least one non-empty Votes sample (≤8 matter items probed) | **10.2%** |

**Usefulness:** modern event join **clears ~30%**. Agenda/matter trees are nearly
universal on joined Council hearing notices; roll-call votes are sparse on
subcommittee hearings (expected) but available when taken.

**Follow-up ingest scope (recommended, not in this recon PR):**

1. Daily edge materialization from `webapi.legistar.com/v1/nyc` with Worker secret
   `LEGISTAR_API_TOKEN` (GitHub Actions / Wrangler secret — not set here).
2. Window: Events with `EventDate` lookback matching City Record hearings (~180d).
3. Per event: `Events/{id}/EventItems` → matters; `EventItems/{id}/Votes` +
   `Attachments` when present.
4. Join: strict `exact_date_body_tokens` (same day + unique body named in title).
5. Two-register gap copy remains for unmatched / pre-vote slots.

Receipt: `verification_receipts/legistar_depth_2026-07-30.json`.

## Join strategies

**Accepted:** `exact_date_body_tokens` (same calendar day + unique body/committee
named in the notice title).

**Rejected:** date-only same-day matches, loose partial title token overlap,
multi-match ambiguity.

## Demo-frame candidate (backstage tour)

| Field | Value |
|---|---|
| City Record `request_id` | `20260706036` |
| Deep link | https://cityscroll.org/#notice/20260706036 |
| Legistar `EventId` | `22526` |
| Body | Subcommittee on Landmarks, Public Sitings, Resiliency and Dispositions |
| Meeting date | 2026-07-14 |
| Depth sample | 16 EventItems · 14 matter-linked · 7 votes (sampled) |
| Title | Correction: 7-14-26 Subcommittee on Landmarks, Public Sitings, Resiliency, and Dispositions meeting |

This modern arc shows a strict event join **plus** agenda matters and at least one
vote row under authentication — the capability demo for authenticated depth.
