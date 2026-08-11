## Ready-to-card bodies

### RC-1 — Materialize MOCS procurement plans with a measured bridge

**Infrastructure:** build a polite, checkpointed collector for the official FY2027 LL63 and LL1 agency indexes and their XLSX plan files, normalize agency, description, procurement method, industry, term, quarter, and any published identifiers, and separately ingest the Capital Projects Dashboard `fb86-vt7u` through Socrata/OData. Measure each candidate bridge to PASSPort/City Record on a fixed modern sample; accept only deterministic IDs or precision-reviewed agency+title+time matches, publish a receipt with numerator/denominator/false-positive review, and stop each source path below the repository’s 30% usefulness threshold. **Dependent surface:** when a plan row lands with sufficient confidence, automatically open the Money planning phase and vendor forecast card showing purpose, expected quarter, method, and budget provenance; unmatched notices and plans remain separate and no budget is inferred from an agency total.

**Result (2026-08-04):** the full 101-workbook pass materialized 11,566 MOCS rows plus 50,000 Capital Projects rows. All six independent 100-row City Record/PASSPort bridge paths joined 0/100, so every path stopped below 30%, no edge materialized, and the dependent planning phase remains inert.

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

## Agency rename / successor densify (OTI former names)

**Gap:** agency dual names and successors (DoITT→OTI, DCA→DCWP, Art Commission→PDC, and related renames) break entity resolution when legacy and current surfaces mint different canonical ids. The existing crosswalk already joined City Record strings to OTI roster cards (`t3jq-9nkf`); residual work is densifying the roster's published `alternate_or_former_names` / `alternate_or_former_acronyms` into the shared resolve path rather than inventing a second agency ER subsystem.

**Result (2026-08-11):** fixture-backed densify of the OTI former-name slice (53 of 306 roster rows) extracted 76 publisher-backed edges. A dated kill sample of 10 known renames + 5 hard negatives measured **precision 100%** (floor 95%), **0 false merges**, and product resolve covers **10/10** positives (gold `gv0-026` remains joined). Materialized into `worker/src/data/agency_crosswalk.json` (`former_names` / `former_acronyms` stamps). Residual route-id densify lives in `site/agency_identity.mjs` `AGENCY_GROUPS` only — a bulk browser alias module was rejected for the home.cold wireBytes budget. Rebuild: `node tools/build_agency_successors.mjs --fixture` (or live SODA without `--fixture`); gate: `--check`. Receipt: [`site/data/agency_sources/verification_receipts/agency_successors_2026-08-11.json`](../site/data/agency_sources/verification_receipts/agency_successors_2026-08-11.json).

## Inventory additions and maintenance actions

The three census-derived gaps should be added to the executable inventory on the next taxonomy update:

- `money-location-residual`: source-present but field-poor; the honest performance state is an unlocated bag. Response addresses may appear only as a separately named logistics basis, never as inferred contract performance.
- `meetings-location-residual`: source-present with a smaller extractor/source tail; retain matter geography over venue and agency headquarters.
- `property-parcel-key-residual`: nearly complete (138/139 observations already have a BBL), but worth recording so the final source-present miss is measurable rather than repeated as generic copy.

Separately, several existing rows should be reconciled with shipped infrastructure so the wishlist remains a forward-looking queue: `city-record-attachment-export-cliff`, the three Checkbook lifecycle rows, `procurement-ocp-recent-awards`, all three Council Legistar rows, `rules-event-spine-unmatched`, both actionable staffing rows, and `land-outcome-detail`. Reconciliation means stamping current coverage and narrowing or retiring the row; it does not mean deleting evidence of the original gap.

The August census also found repeated source-unreachable copy, loading remnants, and duplicated gap prose. Those are product reliability or presentation defects, not new data sources, so they are intentionally excluded from this collection ranking.
