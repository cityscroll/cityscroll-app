<!-- Companion report for site/data/gap_taxonomy.json (source-contract registry convention). -->

# Lifecycle gap taxonomy

When a lifecycle slot is empty, the reader must see **which kind of gap** it is.

| Class | Register | Meaning |
|---|---|---|
| **not_yet_ingested** (a) | “Not yet shown here — … live in *source*.” | A public source publishes this field. Empty means incomplete join or missing adapter. |
| **not_published** (b) | “The city does not publish this — it would appear in *where* if released.” | No public, joinable release is known. Name the logical home when one exists. |

Operational messages (source unreachable, ambiguous multi-match) stay outside this taxonomy.

The executable inventory is [`site/data/gap_taxonomy.json`](../site/data/gap_taxonomy.json). Every gap the lifecycle views can render is listed there with evidence, access mode, cadence, and join keys.

## Inventory summary

| Gap | Class | Public home or “would appear in” |
|---|---|---|
| Pending contract empty | a | Checkbook NYC Contracts; also PASSPort Public contracts |
| Registered contract empty | a | Checkbook NYC Contracts; also PASSPort Public |
| Payments empty | a | Checkbook NYC Spending |
| Notice has no PIN | b | Checkbook NYC if released with a PIN |
| Solicitation documents / bid counts | a | PASSPort RFx; Open Data `3khw-qi8f`; Bid Tabulations `9k82-ys7w` |
| Procurement planning budget/rationale | b | Agency plans / MOCS if stable machine data returns |
| Subsidy stage empty | a | Build NYC / NYCIDA public documents |
| Subsidy outcome empty | b | Build NYC project documents if outcome fields are released |
| Subsidy project unmatched | b | NYCIDA/Build NYC document page if a project is released |
| Subsidy company / place / money blank | b | Linked Build NYC record if fields are filled |
| Council event unmatched | a | NYC Council Legistar |
| Council votes / matters empty | a | Legistar vote and agenda endpoints |
| Community-board votes | b | Board open data if released |
| Exam aggregate outcomes not on cards | a | DCAS annual outcomes (artifact already built) |
| Individual exam results | b | Not public open data |
| Exam fee/salary null | b | Notice of Examination if stated |
| Authority awards verified absent | b | ABO or Checkbook if that agency released open awards |
| ABO fuzzy no-match | a | NYS ABO procurement datasets |
| Land decision detail beyond status | a | ZAP + DOB NOW (already contracted; stitch incomplete) |

## Ranked class-(a) ingest list

Ordered for dispatch. Full rows (effort, join risk, value) live in `site/data/gap_taxonomy.json` → `ranked_ingest_list`.

1. **PASSPort Public contracts + solicitations** — pending/pre-registration and RFx detail citywide; high effort; high join risk (EPIN↔PIN).
2. **DCAS exam outcomes on exam cards** — data already built; low effort; medium join risk on `exam_number`.
3. **Open Data Current Solicitations `3khw-qi8f`** — low effort Socrata enrichment for OCP.
4. **Open Data Recent Contract Awards `qyyg-4tf5`** — low effort OCP award side-car.
5. **Bid Tabulations Historical `9k82-ys7w`** — bid counts for contestability; high join risk.
6. **Legistar materialization depth** — improve Council vote/matter match rate on existing contract.
7. **ZAP decision docs + DOB NOW stitch** — land outcome detail beyond status.
8. **Doing Business Search Entities `72mk-a8z7`** — vendor identity enrichment (secondary).

## Verification notes (2026-07-30)

- Open Data views `3khw-qi8f`, `qyyg-4tf5`, `9k82-ys7w`, `72mk-a8z7` returned live metadata.
- PASSPort Public `/contracts.html` and `/rfx.html` returned HTTP 200.
- City Record type counts since 2025-01-01: Award ~5,173; Solicitation ~1,550; Public Hearings ~1,679; Intent to Award ~703.
- EDC document portal may block unattended fetch; it remains the named HTML source for subsidy projects.

## UI copy keys (two registers)

Class **a** keys use the “Not yet shown here” register with per-slot specificity (pending vs registered vs payments vs votes vs subsidy stages).

Class **b** keys use the “The city does not publish this” register with a concrete “would appear in …” pointer.

Operational keys unchanged: `lifecycle_unknown_html`, `lifecycle_ambiguous_html`, `subsidy_source_unavailable_html`.
