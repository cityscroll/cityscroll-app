## Ready-to-card bodies

### RC-1 — Materialize MOCS procurement plans with a measured bridge

**Infrastructure:** build a polite, checkpointed collector for the official FY2027 LL63 and LL1 agency indexes and their XLSX plan files, normalize agency, description, procurement method, industry, term, quarter, and any published identifiers, and separately ingest the Capital Projects Dashboard `fb86-vt7u` through Socrata/OData. Measure each candidate bridge to PASSPort/City Record on a fixed modern sample; accept only deterministic IDs or precision-reviewed agency+title+time matches, publish a receipt with numerator/denominator/false-positive review, and stop each source path below the repository’s 30% usefulness threshold. **Dependent surface:** when a plan row lands with sufficient confidence, automatically open the Money planning phase and vendor forecast card showing purpose, expected quarter, method, and budget provenance; unmatched notices and plans remain separate and no budget is inferred from an agency total.

**Result (2026-08-04 exact/fixed-sorted; 2026-08-11 prefix re-measure):** the full 101-workbook pass materialized 11,566 MOCS rows plus 50,000 Capital Projects rows. The original fixed-sorted 100-row samples joined 0/100 on exact `identifier_key` equality and stopped every path. Re-measurement on the **identifier-bearing** plan denominator with product passport prefix joins (`pin_prefix_of_epin` / `epin_prefix_of_pin`) cleared the gates: MOCS LL63→PASSPort **92/121 (76.0%)** and LL1→PASSPort **1/3 (33.3%)**, both at **precision 1.0**, shipping **146** receipt-backed plan↔contract edges into the Money planning thread lookup ([receipt](../site/data/procurement_plan_sources/verification_receipts/procurement_plans_2026-08-11.json)). City Record and capital-dashboard paths remain stopped. Source-null plan fields stay null.

### RC-2 — Establish a durable NYCIDA/Build NYC project-document feed

**Infrastructure:** collect the official NYCEDC annual project spreadsheets, project-document indexes, and NYCIDA/Build NYC meeting minutes from a host-side job with politeness, checkpoints, content hashes, and document-level provenance; extract project name, company, address, assistance/cost fields, meeting date, explicit board outcome, and closing/compliance milestones. Measure request ID where present, then normalized name+address+date joins against the current subsidy notice corpus with a precision-reviewed kill sample; never treat a scheduled hearing as approval. **Dependent surface:** as soon as a high-confidence project row lands, automatically fire the subsidy project summary and lifecycle stages on Money/notice detail, then add outcome, company, place, and money fields only when the source explicitly supplies them.

**Result (2026-08-04 join; 2026-08-11 dependent fields):** host-side collector + warehouse feed landed. Fixed kill sample joined **5/12 (41.67%)** name+address+date edges with **0 false positives** and 0 unreviewed candidates, clearing the 30% usefulness and 95% precision gates ([join receipt](../site/data/nycedc_sources/verification_receipts/nycedc_project_documents_2026-08-04.json)). The receipt-backed lookup ships on notice detail for three matched notices. Dependent coverage on that accepted corpus: company/address 100%, any money 60%, board decision date+outcome 100%, later stages honest-absent ([field receipt](../site/data/nycedc_sources/verification_receipts/rc2_dependent_field_coverage_2026-08-11.json)). Source-null money and stage slots stay omitted; no class-(b) “city does not publish” mask on hearing or receipt-backed paths. Some EDC index URLs still return 403 to unattended collectors — residual unmatched hearings remain unmatched.

### RC-3 — Build a non-Council minutes and vote source registry

**Infrastructure:** inventory official outcome/minutes/vote pages for all 59 community boards and five borough presidents, recording URL, format, update cadence, archive depth, and whether full-board votes are present; run a representative borough-stratified kill sample before building adapters. For sources above threshold, collect HTML/PDF metadata and text politely, join by board/body plus meeting date and publisher ULURP matter identifiers only, retain page/document provenance, and report board-level coverage rather than presenting a partial network as citywide. **Dependent surface:** when a matched outcome lands, automatically replace the compact non-publication note in Meetings/Land with the explicit action, vote tally or roll call when published, approved minutes link, and source date; boards without a reliable source keep the honest pointer.

**Result (2026-08-04 initial; 2026-08-11 re-measure):** source registry covers all 59 boards and five borough presidents. Collectable minutes indexes expanded from **8 → 17** after polite homepage/index probes (Bronx CB2–6/12, Brooklyn CB13, Manhattan CB2, Queens CB3, plus the original eight). Host-side collector, warehouse tables, and empty outcome lookup landed. Fixed borough-stratified kill sample re-measured at **0/10 (0%)** exact body+date+publisher-ULURP joins ([receipt](../site/data/non_council_outcome_sources/verification_receipts/non_council_minutes_votes_2026-08-11.json)). Notable near-miss: Queens CB8 published same-date minutes without a notice ULURP token; Bronx CB6 became collectable but still lacked a same-date full-board PDF for its ULURP hearing. Usefulness stays below 30%, so `join_bridge_enabled` remains false and no reader outcome edge ships. Residual work is denser same-date PDF coverage and notices that publish ULURP tokens, not a looser join.

### RC-4 — Measure and tighten the residual ABO award join

**Infrastructure:** take the already-live ABO local-authority procurement tables and construct a labeled residual set for notices that currently return no external award; compare authority normalization, vendor identity, award-date windows, and amount agreement, requiring exact identifiers when available and a precision floor before any fuzzy edge ships. Record joined/total, ambiguity, false-positive review, and per-authority coverage, and stop if gains are only broad name similarity. **Dependent surface:** accepted matches automatically add the external-award result to the notice, Money lens, agency profile, and vendor profile with amount/date/source provenance; unresolved rows retain the verified-absent state without a speculative vendor.

**Result (2026-08-04):** the checkpointed collector, five warehouse tables,
labeled sample, receipt, and site/Worker payload contract landed. The bridge
joined 1/50 notices (2%) and measured 50% fuzzy precision, so it stopped below
both gates. The payload contains no matches and the dependent reader surface
does not fire.

## Person / official identity hub (2026-08-11)

**Gap:** official constellation beyond vote retention — district/term identity, lobby targets, and campaign-finance recipients bound to the same `official:{person_id}` family as Legistar roll-call votes.

| Source | Dataset | Kill-sample measurement | Gate | Disposition |
|---|---|---|---|---|
| Council Members | `uvw5-9znb` | `council_member_id` = Legistar PersonId; vote corpus **19/19 (100%)**; demos 7801 Marte / 7785 Louis | Exact ID | **Shipped** person hub (`site/data/person_hub_lookup.json`) — 215 people, 558 term rows |
| eLobbyist | `fmf3-knd8` | Person-shaped targets **64,116 / 66,669 (96.17%)**; reviewed precision **100%** (exact unique name keys) | ≥30% / ≥95% | **Shipped** lobby edges (`site/data/official_lobby_influence_lookup.json`) — Org→Lobbyist→Official |
| CFB contributions | `rjkp-yttg` | Distinct City Council recipients **53 / 108 (49.07%)**; reviewed precision **100%** | ≥30% / ≥95% | **Shipped** recipient/donor sample edges (`site/data/official_cfb_influence_lookup.json`) |

Receipt: [`site/data/person_hub_sources/verification_receipts/person_hub_influence_2026-08-11.json`](../site/data/person_hub_sources/verification_receipts/person_hub_influence_2026-08-11.json). Methods port the free-text target parser and conservative org consolidate used in the public influence-graph research prototype; public edges stay exact unique name keys only. The independent official **decision-constellation** promotion bar (≥30 distinct roll-call events at ≥95% person-id retention) is unchanged — the committed people densify remains below that event count, so reader copy stays “published roll calls in this corpus” while hub identity and influence panels still render when gated edges exist.

Rebuild: `node tools/build_person_hub.mjs` then `node tools/build_official_influence.mjs`.

### Source-records dual-write (crank 5, 2026-08-11)

**Gap:** product joins shipped, but the three person-hub streams were still `source-records-not-declared` in the coverage matrix (flywheel ranks 1–3).

**Result:** host retention + fail-soft dual-write adapter under `PERSON_HUB_SOURCE_RECORD_DUAL_WRITE` (default off in beta; on in production vars). Stable keys: `council-member:<id>:<term_start>`, `lobby-reg:<registration>:<client>:<lobbyist>:<year>:<targets_hash>`, `cfb-contrib:<recipid>:<donor>:<election>:<amount>:<office>`. Fixture kill sample (committed person-hub fixtures) retained **208** rows and cleared gates:

| Stream | Usefulness | Precision | Retained |
|---|---:|---:|---:|
| Council Members | **40/40 (100%)** exact PersonId | **100%** | 40 |
| eLobbyist | **39/44 (88.64%)** person-shaped mentions | **100%** | 51 |
| CFB contributions | **31/59 (52.54%)** distinct recipients | **100%** | 117 |

Receipt: [`site/data/person_hub_sources/verification_receipts/person_hub_source_records_2026-08-11.json`](../site/data/person_hub_sources/verification_receipts/person_hub_source_records_2026-08-11.json). Matrix: `entity_resolution/source_coverage.json` now **10/16 complete**. Rebuild/retain: `node tools/retain_person_hub_source_records.mjs --from-fixture --publish` (or live without `--from-fixture`); verify `--check`. Public person hub and influence lookups remain the reader path; dual-write is shadow-only.

**Next joinable cards after this crank (post-emit rank order):** `zap-projects` source-records dual-write (coverage #1); residual dual-write gaps (doing-business, NYCIDA, ABO, NYCHA); undersampled not-published claims (money-location residual, planning budget, subcontract goal); civic-graph grounding gaps.

## Agency rename / successor densify (OTI former names)

**Gap:** agency dual names and successors (DoITT→OTI, DCA→DCWP, Art Commission→PDC, and related renames) break entity resolution when legacy and current surfaces mint different canonical ids. The existing crosswalk already joined City Record strings to OTI roster cards (`t3jq-9nkf`); residual work is densifying the roster's published `alternate_or_former_names` / `alternate_or_former_acronyms` into the shared resolve path rather than inventing a second agency ER subsystem.

**Result (2026-08-11):** fixture-backed densify of the OTI former-name slice (53 of 306 roster rows) extracted 76 publisher-backed edges. A dated kill sample of 10 known renames + 5 hard negatives measured **precision 100%** (floor 95%), **0 false merges**, and product resolve covers **10/10** positives (gold `gv0-026` remains joined). Materialized into `worker/src/data/agency_crosswalk.json` (`former_names` / `former_acronyms` stamps). Residual route-id densify lives in `site/agency_identity.mjs` `AGENCY_GROUPS` only — a bulk browser alias module was rejected for the home.cold wireBytes budget. Rebuild: `node tools/build_agency_successors.mjs --fixture` (or live SODA without `--fixture`); gate: `--check`. Receipt: [`site/data/agency_sources/verification_receipts/agency_successors_2026-08-11.json`](../site/data/agency_sources/verification_receipts/agency_successors_2026-08-11.json).

### ULURP Borough President recommendations — re-gated on recommendation rows

**Prior false gate (2026-07-30):** usefulness was computed on the whole ZAP
ulurp-numbered universe (152/27,971 = 0.54%) and the sources were disabled.

**Correct gate (2026-08-11):** recommendation-row hit rate **80/91 (87.91%)**
and PDF-row hit rate **73/88 (82.95%)**, precision 1.0 by strict ULURP-token
intersection ([receipt](../site/data/ulurp_recommendation_sources/verification_receipts/ulurp_recommendations_2026-08-11.json)).
Sparse Land panel ships from `site/data/ulurp_recommendations_lookup.json` via
`site/ulurp_recommendation_panel.mjs` only on token hits. Property Disposition
remains the wrong universe. ZAP-universe catalog coverage stays contrast-only.

The existing PDF feed is also retained as immutable source observations: 86
identity-bearing rows from the 88-row publisher table, with publisher nulls
preserved. The 2026-08-12 exact-token kill sample measured 73/88 (82.95%)
usefulness and 100% reviewed precision, clearing the 30% / 95% materialization
bars. Receipt: [`ulurp_recommendation_pdfs_source_records_2026-08-12.json`](../site/data/ulurp_recommendation_sources/verification_receipts/ulurp_recommendation_pdfs_source_records_2026-08-12.json).

The companion recommendation table is retained as immutable source observations:
91 publisher rows with an 80/91 (87.91%) exact-token usefulness rate and 100%
reviewed precision in the 2026-08-12 kill sample. Receipt:
[`ulurp_recommendations_source_records_2026-08-12.json`](../site/data/ulurp_recommendation_sources/verification_receipts/ulurp_recommendations_source_records_2026-08-12.json).

### Meeting person-vote materialization (flywheel crank, 2026-08-11)

The data-integrity red flag `meeting-person-votes` claimed ~100% empty `by_person` on matched Council hearings after an earlier VotePerson* field-mapping miss. Live re-measure against the matched meeting-outcomes materialization:

| Metric | Value | Gate |
|---|---:|---|
| Matched Council hearings with non-empty `by_person` | **6 / 16 (37.5%)** | ≥30% usefulness |
| Reviewed person-row precision (`person_id` + name + bucket + official bind) | **388 / 388 (100%)** | ≥95% precision |
| Stratified credibility sample empty rate | **9 / 15 (60%)** | below 85% suspicious / 95% red-flag |

**Disposition:** keep the edge live; mark the flywheel card fixed; residual empties stay honest voice/action-only slots (do not invent roll call). Receipt: [`site/data/legistar_sources/verification_receipts/meeting_person_votes_materialization_2026-08-11.json`](../site/data/legistar_sources/verification_receipts/meeting_person_votes_materialization_2026-08-11.json). Demo: `#notice/20260706036` → event `22526` (Christopher Marte and peers).

## Inventory additions and maintenance actions

The three census-derived gaps should be added to the executable inventory on the next taxonomy update:

- `money-location-residual`: source-present but field-poor; the honest performance state is an unlocated bag. Response addresses may appear only as a separately named logistics basis, never as inferred contract performance.
- `meetings-location-residual`: source-present with a smaller extractor/source tail; retain matter geography over venue and agency headquarters.
- `property-parcel-key-residual`: nearly complete (138/139 observations already have a BBL), but worth recording so the final source-present miss is measurable rather than repeated as generic copy.

Separately, several existing rows should be reconciled with shipped infrastructure so the wishlist remains a forward-looking queue: `city-record-attachment-export-cliff`, the three Checkbook lifecycle rows, `procurement-ocp-recent-awards`, all three Council Legistar rows, `rules-event-spine-unmatched`, both actionable staffing rows, and `land-outcome-detail`. Reconciliation means stamping current coverage and narrowing or retiring the row; it does not mean deleting evidence of the original gap.

The August census also found repeated source-unreachable copy, loading remnants, and duplicated gap prose. Those are product reliability or presentation defects, not new data sources, so they are intentionally excluded from this collection ranking.
