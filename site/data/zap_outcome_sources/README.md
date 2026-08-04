# ZAP land outcomes materialization

Machine path for Zoning Application Portal **decision documents and outcomes**
beyond the status fields on NYC Open Data.

| Surface | URL |
|---|---|
| Public portal | https://zap.planning.nyc.gov/ |
| Project API | https://zap-api-production.herokuapp.com/projects/{project_id} |
| Document proxy | https://zap-api-production.herokuapp.com/document/{kind}/{id} |
| Open Data projects | https://data.cityofnewyork.us/d/hgx4-8ukb (`hgx4-8ukb`) |
| Open Data tax lots | https://data.cityofnewyork.us/d/2iga-a6mk (`2iga-a6mk`) |
| DOB NOW filings | https://data.cityofnewyork.us/d/w9ak-ipjd (`w9ak-ipjd`) |

Open Data publishes project status, milestones, and applicants. Final action
statuses, disposition votes/recommendations, and public PDFs are on the Planning
Labs ZAP API (the same feed the portal uses). Document links use the public
document proxy (`/document/disposition|artifact|package|projectaction/…`).

## Product path

1. Browser land detail calls only `GET /zap-outcomes?id={project_id}` (no live ZAP API).
2. Worker fetches Open Data row + ZAP API project detail, parses documents/actions/dispositions,
   optionally joins DOB NOW filings on exact BBL from `zap-bbl`, and caches in KV (~1 day).
3. **Daily write-ahead prewarm** (`refreshZapOutcomes` on the digest cron, and
   `POST /admin/zap-outcomes-refresh`) materializes sell-facing project ids first
   (In Public Review → Noticed → Active → Filed, capped, plus demo `2022M0258`).
   Cold multi-source builds take ~12s; warm KV reads are sub-second. Unlisted ids
   still compute-on-miss. The land list also session-prefetches the first screenful
   of project ids after paint.
4. Unmatched or empty outcome slots use the class-(a) register: name the public source.

Individual-project hearing logistics reuse the disposition fields already carried
by this read model. Projects with qualifying evidence receive the shared
`hearing_logistics` array; projects without it keep `hearing_logistics: null`.
Review-session milestones do not become venue or livestream evidence.

## Hearing-logistics coverage

The fixed 50-project sell-facing sample measured on 2026-08-04 populated exact
disposition hearing logistics for 41/50 projects (82%): 38/50 had a parsed venue,
12/50 a livestream, and 39/50 either. Nine projects honestly remained null. No
sampled disposition date was still upcoming on the observation date, so this is
detail-record coverage, not evidence that the upcoming-hearings calendar is full.
The recorded persona field case moved from 0/1 populated to 1/1. These are
fixed-sample results only; they do not state citywide coverage.

Reproduce against the same project IDs:

```bash
node tools/measure_zap_hearing_logistics.mjs --live --limit 50 \
  --sample site/data/zap_outcome_sources/verification_receipts/zap_hearing_logistics_2026-08-04.json
```

Receipt:
`verification_receipts/zap_hearing_logistics_2026-08-04.json`.

## Join

See `worker/src/lib/zap_outcomes.mjs` and measured rates in
`site/data/source_contracts.json` (`join_measurement` on `zap-api-outcomes`) and
`verification_receipts/zap_api_outcomes_2026-07-30.json`.

**Demo-frame candidate:** project `2022M0258` (Timbale Terrace) — `#land/2022M0258`.
