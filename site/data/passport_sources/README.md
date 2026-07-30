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
2. Lifecycle compute: Checkbook first, then `enrichLifecycleWithPassport` via strict EPIN↔PIN join
3. Browser: only `GET /contract-lifecycle` (precompute-first; no live PASSPort fetch)

## Join

See `worker/src/lib/passport_join.mjs` and measured rates in
`site/data/source_contracts.json` (`join_measurement`) and
`verification_receipts/passport_public_2026-07-30.json`.

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
