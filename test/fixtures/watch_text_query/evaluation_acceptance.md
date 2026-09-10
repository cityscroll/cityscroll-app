# Precise procurement evaluation — acceptance receipt

Textual proof that procurement watch evaluation uses one v1 decision contract across notice-backed D1 rows and CROL-negative procurement objects, and that the predicate runs before the displayed or delivered limit. Grounded at repository revision `55c269544345a6471363005f713c81cebbbca624`. Fixture counts describe the retained snapshot, not a live production census.

Evaluated field contract:

- Notice-backed rows: `short_title` (title) and cleaned `additional_description_1` / `description`. Agency, vendor, and identifiers stay structured facets.
- Procurement objects without a City Record notice: published title, agency, vendor, and identifiers as separate fields; identity remains `procurement_id`.

Scheduled digest evaluation uses `buildNoticesQuery` (LIKE paging), not `searchNotices` / FTS. The scheduled SODA keyword fallback remains a legacy-only path for watches without `text_query`; v1 evaluation does not call it and does not fetch a publisher at preview or digest time.

Verify:

```
node --test worker/test/watch_text_query_procurement.test.mjs worker/test/compile_d1.test.mjs worker/test/procurement_digest_parity.test.mjs
```

| Item | Delivered path | Evidence |
| --- | --- | --- |
| A1 E2 / E3 / E4 on the frozen award-title projection | `evaluateMoneyTextQueryWatch` over D1 notices seeded from `procurement_titles_snapshot.json` | E2: `20260709018`, `20260713010`, `20260713036`. E3 adds `20260713024`. E4 is empty. |
| A2 request_id vs procurement_id; no exclusion bypass; no duplicate | `matchProcurementDigestRows`; golden-cohort extension in `procurement_digest_parity.test.mjs` | CROL-negative `procurement:contract:CT101520271400806` keeps `procurement_id` and no notice link. An exact-id watch with an exclusion of `services` is empty. Agency union lists that contract once. |
| A3 E10 filter-before-limit | `evaluateD1NoticeTextQuery` paging `buildNoticesQuery` | 69 whole-token `services` candidates; filtering the first 25 leaves 22; evaluating before the limit returns 25 and recovers `20260724019`, `20260724020`, `20260722008`. |
| A4 exhaustion, resume, missing materialization, FTS-absent | `evaluateD1NoticeTextQuery`, `evaluateMoneyTextQueryWatch` | Scan-budget exhaustion is `incomplete` with a continuation and does not list unseen ids as seen. Missing D1 and snapshot is `unavailable`. Digest retrieval is `legacy_like` without an FTS table. |
| A5 E5 and E8 field evidence | `evaluateNoticeRecords` / D1 adapter | Phrase `construction management` is the five title ids. Construction-only and management-only titles miss. Broad `maintenance` exclusion removes East Side Greenway `20250305016` with the Parks maintenance-vehicles passage; phrase `maintenance services` keeps all four. Phrases do not span title and description. |
| A6 single-watch and rollup handlers; scheduled source fallback | `processOneSub`, `processAccountRollup`, `compileSub` | Handler path sends E2 ids and never fetches SODA. `compileSub` for v1 has `url: null` and `soda: false`. Legacy keyword money watches still emit the SODA `$q` descriptor. |
