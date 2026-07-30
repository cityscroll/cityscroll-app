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
