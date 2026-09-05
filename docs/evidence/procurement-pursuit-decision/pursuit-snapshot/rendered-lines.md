# Card 3 rendered evidence: the pursuit snapshot on procurement detail

Textual evidence to accompany `capture-manifest.json`. Each block below is the
exact fact-row text `renderPursuitSnapshotHtml()` produces for the named
case, extracted from the same HTML the screenshot manifest captured.
Screenshot binaries are held outside this repository per the evidence rule;
this file is the reproducible textual record of what they show.

## Complete (Fixture A — Parks, Playground reconstruction)

- Case id: `pursuit-snapshot-complete`

| Fact | Value | Status |
| --- | --- | --- |
| Title | Playground reconstruction solicitation | Published |
| Agency | Department of Parks and Recreation | Published |
| EPIN / PIN | EPIN-2026-07 | Published |
| Source status | Released | Published |
| Amount | No published amount | Not observed |
| Method | No published method | Not observed |
| M/WBE | No published M/WBE marker | Not observed |
| Response / notice-to-due window | Published response window: 35 calendar days | Published |
| Pre-bid / pre-proposal conference | Jul 22 | Published |
| Questions deadline | Jul 29 | Published |
| Due date | Aug 5 | Published |
| Published contact | None published | Not observed |

Official action: PASSPort solicitation → `https://passport.cityofnewyork.us/page.aspx/en/bpm/process_manage_extranet/1001`

## Partial (Fixture B — CAMA, Finance)

- Case id: `pursuit-snapshot-partial`

| Fact | Value | Status |
| --- | --- | --- |
| Title | Computer-Assisted Mass Appraisal (CAMA) Modern Solution | Published |
| Agency | Finance | Published |
| EPIN / PIN | None published | Not observed |
| Source status | Solicitation | Published |
| Amount | No published amount | Not observed |
| Method | No published method | Not observed |
| M/WBE | No published M/WBE marker | Not observed |
| Response / notice-to-due window | Window unavailable | Unavailable |
| Pre-bid / pre-proposal conference | None published | Not observed |
| Questions deadline | None published | Not observed |
| Due date | Aug 17 | Published |
| Published contact | None published | Not observed |

Official action: Official notice → `https://a856-cityrecord.nyc.gov/RequestDetail/REQ-CAMA-1`

Confirms acceptance criterion 3's requirement for Fixture B directly: amount,
M/WBE, and package eligibility (in the constant "cannot verify" disclosure)
are explicit unknowns, never absent-looking negatives, and no `$0` appears.

## Sparse (Fixture D — MTA CBTC solicitation, S48020)

- Case id: `pursuit-snapshot-sparse`

| Fact | Value | Status |
| --- | --- | --- |
| Title | CBTC for 6th Ave Line, 63rd St Line and DeKalb Interlocking | Published |
| Agency | MTA Construction & Development | Published |
| EPIN / PIN | None published | Not observed |
| Source status | Current opportunity | Published |
| Amount | No published amount | Not observed |
| Method | No published method | Not observed |
| M/WBE | No published M/WBE marker | Not observed |
| Response / notice-to-due window | Window unavailable | Unavailable |
| Pre-bid / pre-proposal conference | None published | Not observed |
| Questions deadline | None published | Not observed |
| Due date | No published due date | Not observed |
| Published contact | None published | Not observed |

Official action: MTA official record → `https://www.mta.info/agency/construction-and-development/contracting/current-opportunities`

The page's existing "Contract facts" section still shows the raw `$100M+`
free-text amount and the `10/16/2026` bid-opening date verbatim (unchanged,
pre-existing behavior); the pursuit snapshot itself never treats either as an
observed pursuit-decision amount or due date, and never invents a due date.

## Cancelled (Fixture B's identity, type changed to Cancellation)

- Case id: `pursuit-snapshot-cancelled`
- No pursuit snapshot renders. The page continues to render normally (its
  existing "Paper trail" section is unaffected) with no response CTA.

## Superseded (Fixture A's canonical procurement, a later PASSPort round)

- Case id: `pursuit-snapshot-superseded`

| Fact | Value | Status |
| --- | --- | --- |
| Response / notice-to-due window | Published response window: 76 calendar days | Published |
| Due date | Sep 15 | Published |

The earlier round's `Aug 5` due date and 35-day window do not appear
anywhere on the page; the snapshot reflects only the current published
round's facts.

## Award control (Fixture E as a canonical contract/award object)

- Case id: `pursuit-snapshot-award-control`
- No pursuit snapshot renders. The page remains an award/contract-history
  page with its existing "Official records" section intact.
