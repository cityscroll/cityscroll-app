# PASSPort Public source materialization

Machine path for NYC PASSPort Public contracts and solicitations (RFx).

| Surface | URL |
|---|---|
| Contracts portal | https://a0333-passportpublic.nyc.gov/contracts.html |
| RFx portal | https://a0333-passportpublic.nyc.gov/rfx.html |
| Contracts dump | https://a0333-passportpublic.nyc.gov/dataJs/contractData.js (`public_ctr_data`) |
| RFx dump | https://a0333-passportpublic.nyc.gov/dataJs/rfxData.js (`public_rfx_data`) |

There is no dedicated Socrata dataset for these tables. The static `dataJs` dumps are the stable machine-readable path.

## Product path

1. Daily worker cron: `ingestPassportPublic` → D1 `passport_contracts` / `passport_rfx`
   (and dual-write `source_records` when `PASSPORT_SOURCE_RECORD_DUAL_WRITE` is on)
2. Lifecycle compute: Checkbook first, then `enrichLifecycleWithPassport` via strict EPIN↔PIN join
3. Browser: only `GET /contract-lifecycle` (precompute-first; no live PASSPort fetch)

Failed cron attempts leave `passport_ingest_meta.last_error` / `last_attempt_at` without
clearing the last good `ingested_at`. Operator rebuild: `POST /admin/passport-ingest`.
Host-side reseed: `node tools/passport_remote_reseed.mjs`.

## Join

See `worker/src/lib/passport_join.mjs` and measured rates in
`site/data/source_contracts.json` (`join_measurement`) and
`verification_receipts/passport_public_2026-07-30.json`.

## Commodity category (L3)

The RFx `main_commodity` column carries the City's own L3 category label from the NYC
Commodity Classification Directory. Every published RFx read (`slimRfx` in
`worker/src/lib/passport_lifecycle.mjs`, so `GET /contract-lifecycle` `rfx_detail` and the
solicitation stage) carries `main_commodity_category`: `matched` with the L3 `code`, `label`,
`parents` `[L1, L2]` and `catalog_version`; `unmatched` with the publisher's `raw_label`; or
`no_label`. Matching is exact after NFKC, whitespace collapse, trim and lower-case against
`site/data/procurement_codes/nyc-commodity-categories.json` (the Worker bundles its L3
projection, `worker/src/data/nyc_commodity_l3_categories.json`). No fuzzy match, no guess.

Coverage: each ingest writes `passport_ingest_meta.rfx_category_coverage` (total, matched,
unmatched, no_label, by RFx status, unmatched labels). Measured 2026-11-12 on the public dump
(sha256 `9b7558ce…`): 12,533 of 12,585 parsed rows matched (99.59%); Released 252/252,
Planned 844/845; 8 legacy labels over 52 rows stay unmatched. The dump had 12,609 row lines;
the engine parser reads 12,589 (20 rows carry a raw tab in the title) and keeps 12,585 with an
EPIN. Receipt: `verification_receipts/passport_rfx_commodity_categories_2026-11-12.json`
(`node tools/measure_passport_rfx_commodity_categories.mjs --check <receipt>`).

## Package documents (measured stop)

The public RFx dump has **no document URL columns** (schema is EPIN, title, agency,
status, dates, method, commodity only). Kill-criterion recon on 2026-07-30:

| Universe | EPIN join | Document URL join |
|---|---:|---:|
| 50 Solicitation+PIN notices (most recent ≥ 2025-01-01) | 38% (19/50) | **0%** (0/50) |
| All Solicitation+PIN since 2025-01-01 | 44.4% (653/1470) | **0%** (0/1470) |

Companion fills for modern package docs are also empty: OCP `3khw-qi8f`
`document_links` 0/1550 and City Record Online solicitation `document_links` 0/1550
for `start_date ≥ 2025-01-01`. Historical pre-2025 rows still carry City Record
`GetFile` attachments.

**Stop rule:** do not edge-materialize package documents from RFx. Gap
`procurement-solicitation-documents` is class (b) **not_published**, pointing at
City Record `https://a856-cityrecord.nyc.gov/Search/GetFile` as the logical home
if attachments are released again. RFx **metadata** materialization is unchanged.

Receipt: `verification_receipts/passport_rfx_documents_2026-07-30.json`.
Pure helpers: `worker/src/lib/rfx_documents_join.mjs`.
