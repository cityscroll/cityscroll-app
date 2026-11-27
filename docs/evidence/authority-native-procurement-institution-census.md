# Next-institution procurement source census

This is a backstage evidence deliverable for the School Construction Authority (SCA), the Port Authority of New York and New Jersey (PA), and the Department of Education (DOE) missing-record control. It does not add a source adapter, change a production read model, or create a public coverage promise.

The machine-checkable evidence is [institution_source_census.v1.json](../../warehouse/fixtures/authority-native-procurement/institution_source_census.v1.json). Run `node tools/check_institution_source_census.mjs --check` from the repository root to verify its frozen snapshot fingerprints, fixture stages, and DOE counts.

Overlap is exact-only: frozen solicitation, bid, request, and PIN identifiers were compared with the committed served artifacts; the City Record control uses an exact `request_id`/PIN query. Names, titles, amounts, and fuzzy identifier similarity do not count as overlap. The JSON also records successful-fetch SHA-256 receipts for the two Port Authority model endpoints, both linked PDFs, and the City Record control query. SCA's server-rendered report is mutable and did not expose a byte-stable export, so its fixture is frozen at field level and carries that limitation rather than an invented response hash.

## Finding

PA has two demonstrated public, identifier-bearing corpora: the official AEM opportunity tables and the official preliminary bid-result tables/PDFs. They are bounded to the currently published tables; the census does not claim historical completeness. The opportunity and result fixtures are intentionally separate, and the preliminary result is not an award.

SCA exposes official RFP and advertised-bid views, but the observed public surfaces are mutable and do not provide a stable public historical/result corpus. City Record remains the measurable official overlap/control source for SCA. The native SCA opportunity fixture and City Record intent-to-award control fixture are retained without claiming that the latter identifies a winning vendor.

The reviewed November 27 snapshot serves 4,679 DOE canonical rows through City Record, PASSPort, and Checkbook. The census found zero records demonstrating a distinct missing DOE corpus.

## Source register

“Production-usable” means that a public, identifier-bearing source surface was demonstrated for a bounded future adapter review. It does not authorize an adapter in this change. “Validation-only” means useful for corroboration or discovery but not a demonstrated production corpus. “Authenticated-only” means an official workflow requires a vendor account or authenticated access. “Rejected” means the surface is not the procurement observation type required here.

| Institution / source | Publication stages | Endpoint and identifier | Access | Cadence / historical depth | Measured overlap | Disposition | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SCA RFP reports | opportunity, anticipated opportunity | SCA Reports; SCA solicitation number, title, later contract number | Public mutable list; RFP document requested by email | Data-as-of page, no fixed interval; current list, no archive observed | City Record exact-agency rows: 2,350, 2003-01-10–2026-08-06; local served exact-agency rows: 0 | validation-only | No stable public historical/result corpus demonstrated |
| SCA advertised bids | opportunity, bid opening | Advertised-bids page; SCA solicitation/docs locator | Public interactive Blazor/Telerik table | Live page; current view, no archive observed | City Record 2,350; local served 0; captured server table said no records available | validation-only | No stable export or award-result linkage demonstrated |
| SCA BidSet/VAS | opportunity, bid opening | Construction-process workflow; SCA solicitation/bidset identifier | Vendor workflow; credentials or registration may be required | Per solicitation; history unknown | City Record 2,350; local served 0 | authenticated-only | Official vendor workflow, not a public corpus |
| SCA contract payment report | payment | Contract Payment Report; SCA contract number | Public contract-keyed lookup | Schedule and depth unknown | City Record 2,350; local served 0 | rejected | Payment lookup cannot establish opportunity, bid result, or award |
| City Record SCA control | solicitation, intent to award, notice and other City Record stages | Public Socrata API; `request_id`, PIN | Public API | City Record publication cadence; 2003-01-10–2026-08-06 for exact SCA label | 2,350 raw rows; local served exact-agency rows: 0 | production-usable | Existing official source family; retained as overlap/control, not a second adapter |
| PA AEM opportunities | solicitation, opportunity | Public `solicitations-advertisements.model.json`; bid/RFP/solicitation number and linked PDF | Public JSON, HTML tables, and official PDFs; submission may route elsewhere | Current mutable tables, observed 2026-08-28; no complete archive demonstrated | City Record exact-agency rows: 460, 2003-01-07–2005-06-09; local served 0; frozen IDs absent from City Record/PASSPort/Checkbook | production-usable | Structured public endpoint with exact IDs and official documents |
| PA AEM preliminary results | bid-opening result | Public `preliminary-bid-results.model.json`; bid number and result PDF | Public JSON and PDFs | Posted after due dates; current result pages, no complete archive demonstrated | City Record 460; local served 0; frozen ID absent from existing sources | production-usable | Public result evidence; award remains unknown until separately established |
| PA Bonfire | solicitation document, submission | Official procurement portal guidance; Bonfire project ID | Vendor account/login for documents/submission when routed there | Per solicitation; history unknown | City Record 460; local served 0 | authenticated-only | Submission/document workflow, not unauthenticated corpus |
| PA Procure | vendor registration | Official procurement portal guidance; vendor profile ID | Vendor registration/profile | Vendor lifecycle; not a publication cadence | City Record 460; local served 0 | authenticated-only | Registration is not an opportunity or result source |
| NYS Contract Reporter PA control | solicitation | State publication; NYSCR ad ID | Public secondary publication | Publisher schedule; PA cadence/depth not measured | City Record 460; local served 0 | validation-only | Secondary ad cannot establish PA-native completeness or award status |
| PA diversity/certification directory | vendor certification | Official procurement portal guidance; vendor/certification ID | Vendor-facing workflow | Vendor lifecycle | City Record 460; local served 0 | rejected | Certification directory is not a procurement opportunity or result corpus |

## Frozen fixtures

The JSON fixture file stores four exact records and their source provenance:

- SCA native opportunity `26-00107R`: Contingent & Temporary Staffing, five contracts, not-to-exceed $6,000,000, due 2026-08-28.
- Official City Record SCA control `request_id=20260414001`, PIN `26-00080R`: Intent to Award. The vendor is explicitly null because this record does not establish the winning vendor.
- PA opportunity `6000003451`: Cover Stock and Specialty Paper, three-year requirements contract, due 2026-09-08. The linked official PDF is hash-frozen.
- PA preliminary bid result `6000003424`: four bidder totals. Its stage is `bid_opening_result`, and `award_status` is `not_established`.

The PA official [solicitation and advertisement tables](https://www.panynj.gov/port-authority/en/business-opportunities/solicitations-advertisements.html), [preliminary bid results](https://www.panynj.gov/port-authority/en/business-opportunities/preliminary-bid-results.html), and linked PDFs are the publisher evidence. The SCA [RFP reports](https://www.nycsca.org/Doing-Business/Contracting-with-Us/Reports), [contracting page](https://www.nycsca.org/Doing-Business/Contracting-with-Us), and [construction process](https://www.nycsca.org/Vendor/Construction-Process) are the publisher evidence for SCA. The SCA control fixture uses the official [City Record API](https://data.cityofnewyork.us/resource/dg92-zbpx.json).

## DOE missing-record census

The census counts served canonical rows in the committed `procurement_browse_rows.json` snapshot whose `agency_name` matches `/department of education|^education$|education admin|^doe$/i`. The snapshot generated at 2026-11-27T13:09:25.421Z contains 4,679 DOE rows. City Record appears on 431 rows, PASSPort on 438, and Checkbook on 4,241. Source memberships can overlap.

| Existing source combination | Rows | Interpretation |
| --- | ---: | --- |
| City Record + PASSPort | 431 | Existing cross-source coverage |
| PASSPort only | 7 | Already served by PASSPort |
| City Record + PASSPort + Checkbook | 0 | Existing three-source coverage |
| Checkbook only | 4,241 | Already served by Checkbook |
| Demonstrated missing rows | 0 | No DOE production card |

The checker fails if source artifact fingerprints or these combinations drift. A fingerprint refresh rewrites the mechanical snapshot only when the served DOE canonical row count still equals the reviewed `doe_canonical_rows`. A different count is refused until a person updates the count fields.

`doe_missing_record_census.re_review` records delegated approval of 4,679 DOE rows as a verified routine refresh under the site owner's standing direction. The prior review recorded 4,628 rows on November 25, 2026.

The Checkbook registered expense contract collections for FY2025–FY2027 completed at 2026-11-25T10:20:15.926Z and 2026-11-27T13:09:25.421Z. The review found 71 newly observed Checkbook-only contracts with start dates eligible in both 365-day windows. Eight contracts starting November 25, 2025 and twelve starting November 26, 2025 expired when the lower cutoff advanced to November 27, 2025. The [91-contract evidence CSV](authority-native-procurement/doe-census-2026-11-27/contracts.csv) records the contract IDs, start and registration dates, and admission result for each change.

## Boundary

No production adapter, public route, public UI copy, source admission, or production card is included. Any later PA adapter proposal must preserve opportunity, bid-opening result, award, contract, amendment, and payment as distinct observation types; it must not turn a preliminary result into an award or treat the bounded current tables as a historical inventory.
