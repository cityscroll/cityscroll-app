# p10 scout: full NYC contract-file detail

**Observed:** 2026-08-23  
**Question:** Do scope, line-item pricing, deliverables, and performance location exist anywhere publicly obtainable for NYC contracts, and could CityScroll ingest them?  
**Product code:** unchanged.

## Verdict

**Partly.**

| Ask | Public status |
|---|---|
| Executed / registered **contract file** (signed SOW, awarded pricing schedule, deliverables, place of performance) | **Records-request-only.** Lives in authenticated PASSPort (Vault + contract Documents tab) and the Comptroller registration package. No citywide public dump, API, or document browser. |
| **Solicitation bid books** on released PASSPort RFx pages (specifications, itemized bid pages, addenda) | **Publicly downloadable PDFs**, but **not structured** and **not in the summary dump CityScroll already reads.** HTML scrape of Ivalua RFx pages; login is required to *respond*, not to *download* listed public documents. These are pre-award packages, not the registered file. |
| Structured tables (PASSPort Public, Checkbook, OCP/City Record, LL63 plans, capital projects, historical bid tabulations) | **Thin proxies only** (title, ~45-character FMS purpose, notice paragraph, planned one-liner, capital-project borough). None of the four asked-for fields as a citywide structured feed. |

**Recommended next step:** Do **not** ingest executed contract files. Do **not** treat Checkbook purpose or City Record notice prose as the contract file. If product still wants more than title, open a **separate** bounded recon card for released-RFx `public_document` PDFs (solicitation packages only): usefulness, closed-RFx survival, bot-block, and a hard rule that bid-book line items are not awarded prices. p10's awarded-file ask stays FOIL / Comptroller / agency.

---

## What CityScroll already has

PASSPort Public machine path is the static S3 dumps:

- `https://a0333-passportpublic.nyc.gov/dataJs/contractData.js` (`public_ctr_data`)
- `https://a0333-passportpublic.nyc.gov/dataJs/rfxData.js` (`public_rfx_data`)
- plus `chartData.js` and `vendorData.js`

Contract columns in `contracts.js` / `worker/src/lib/passport_parse.mjs`:

CTR-ID, EPIN, Contract ID, Contract Title, Agency, Vendor, Program, Procurement Method, Contract Type, Status, Award Amount, Current Contract Amount, Total Encumbered Amount, Total Paid Amount, Start, End, Registration Date, Industry, OLD Certification Type, Ethnicity, Certification Type, Corporate Structure.

That is the full public contracts table. `site/passport_public_fields.mjs` already refuses to invent scope, line-item pricing, deliverables, or place of performance because those columns are not in the dump.

The 2026-07-30 RFx recon (`site/data/passport_sources/verification_receipts/passport_rfx_documents_2026-07-30.json`) measured **0% document-URL join on the dump**. That measurement remains true for `public_rfx_data`. This scout adds: the **HTML** RFx detail page can list documents the dump omits.

---

## Source-by-source

### 1. PASSPort Public portal (summary site)

| Probe | Result (2026-08-23) |
|---|---|
| `contracts.html` | DataTables UI over `contractData.js`. No per-row document link, no detail route. |
| Extra dumps (`dataJs/contractDocs.js`, `documents.js`, `attachments.js`, `items.js`, `lineItems.js`, `locations.js`, `contractDetail.js`) | **HTTP 403** (do not exist). |
| `vendorData.js` | Exists (vendor enrollment / reports). Performance-evaluation Excel has a short “contract purpose,” not a file. |
| `contractData.js` sample | Range-read first 120 KB: **315 rows × 22 columns**, **0 URL-bearing cells**. Longest cells are titles / program names (~60 chars). Last-Modified `Sun, 23 Aug 2026 05:37:12 GMT`. |

**Ingest path:** already in production. Cannot grow the four fields from this feed.

### 2. PASSPort Ivalua (Procurement Navigator)

Public RFx browse (`https://passport.cityofnewyork.us/page.aspx/en/rfp/request_browse_public`) is reachable without login.

Unauthenticated **RFx detail** (`/page.aspx/en/bpm/process_manage_extranet/{rfp_id}`) can render a “Documents” table. Participate still requires login.

Field case **EPIN `07126B0002`** (DHS On-Call Travel Reservation, rfp_id `38077`):

- Page lists Bid Book I–VII, specifications, itemized bid page, addenda.
- Download URLs: `https://webserver-mocs-prd.lfr.cloud/c/public_document/download?documentId={id}`
- Unauthenticated GET of `documentId=246365969` → **HTTP 200 PDF** `Bid Book II - Bid Documents.pdf` (252,375 bytes).
- Unauthenticated GET of `documentId=250122875` → **HTTP 200 PDF** `Addendum 3 On Call Travel Reservation.pdf` (1,430,789 bytes).

Second case **rfp_id `37965`** (DDC Wakefield Library special inspections): **15** distinct `public_document` URLs on the same host.

**Contract** Ivalua paths (`/page.aspx/en/ctr/contract_browse_public`, `/ctr/contract_manage_extranet/{id}`) **302 to login**. There is no public awarded-contract document browser analogous to RFx.

PASSPort Vault and contract Documents tab (authoring documents, vendor documents, contract documents, sourcing project documents) are documented by MOCS as vendor/agency workflows. Default Vault visibility is the organization, not the public.

**Ingest path if product later wants solicitation packages:** per-RFx HTML parse → `public_document` PDFs. Not a bulk JSON dump. Fragile Ivalua DOM; likely needs a polite host collector, usefulness/precision gates, and closed-RFx survival measurement. **Not** the executed contract file.

### 3. MOCS / OCP Open Data

| Dataset | What it actually is | Four fields |
|---|---|---|
| Recent Contract Awards `qyyg-4tf5` | City Record award **notices** | `short_title` + optional `additional_description_1` HTML (sampled 8 recent awards: 0–604 characters of prose; sometimes an address in the sentence; often empty). No pricing schedule, no deliverables list, no structured place of performance. |
| Current Solicitations `3khw-qi8f` | Same notice family | Modern `document_links` already measured **0/1550** for 2025+. |
| City Record Online `dg92-zbpx` | Same | Historical GetFile attachments exist pre-2025; modern window empty (existing receipt). |
| Doing Business `72mk-a8z7` | Vendor identity | Four columns. No contract file. |
| LL63 procurement plans | Planned purchases | One-line `description`. Not awarded scope. CityScroll already threads identifier-bearing plans. |
| Bid Tabulations Historical `9k82-ys7w` | CSB **bidder** line prices | Real line items, but openings **2016-01-05 through 2021-03-24**, no PIN/EPIN, **0%** join on modern Procurement+PIN. Source contract is disabled. |
| Capital Projects Dashboard `fb86-vt7u` | FMS capital **projects** | Borough / community board of a capital project, not contract place of performance. Identifier join already below usefulness for notices. |
| Catalog search (`contract documents`, `line item pricing`, `passport contracts`) | No citywide contract-PDF dataset | Hits are notices, Palantir one-off list, SCA change orders, COVID spend, vendor enrollment. |

**Ingest path:** already using awards / plans / (disabled) bid tabs. Nothing new for the executed file.

### 4. Checkbook NYC

Live Contracts XML (`type_of_data=Contracts`, registered expense, FY2026), 25-row sample:

- Tags include `prime_contract_purpose`, amounts, PIN, agency, vendor, dates, industry, award method. **No document URL, no SOW, no line-item schedule, no performance location.**
- `prime_contract_purpose` length **min 18 / max 60 / mean 45.7**. **8/25** are `See PSR Attachment` or truncated “See attached PSR…”.
- `prime_contract_expense_category` on the sampled master-agreement row was **empty**. Spending `expense_category` is FMS object class (e.g. Payroll Summary, CONSTRUCTION-BUILDINGS), not contract line items.

Checkbook HTML contract-detail was Incapsula-blocked from this host; the XML API is the machine path CityScroll already uses.

PSR = pre-solicitation / procurement summary **attachment** inside the registration package. The API explicitly points at a file it does not publish.

**Ingest path:** optional densify of `prime_contract_purpose` as a labeled one-line FMS field. Must not be sold as scope. Already have PASSPort title.

### 5. Public contract-document repositories

No citywide repository of executed contract PDFs was found.

Agency-specific fragments exist (SCA change-order tables, occasional capital-project trackers, Human Services concept papers on some RFx pages). They are not a joinable contract-file census.

Admin Code § 6-116.2 requires a public **database** of contracts (vendor, dollars, type of goods/services, term, agency, registration number). That is Checkbook / FMS summary, not the file.

FOIL: Comptroller [FOIL instructions](https://comptroller.nyc.gov/services/for-the-public/freedom-of-information-law-foil-requests/) and citywide OpenRecords. Comptroller BCA receives the PASSPort-transmitted registration package. The Comptroller’s 2026 FOIL operations report describes releasing **hundreds of contracts** (e.g. H+H HERRC) **via FOIL**, which is evidence the files exist and are not bulk-published.

### 6. Records-request path

| Holder | What they have | How the public gets it |
|---|---|---|
| Contracting agency | Agency contract file (SOW, budget, deliverables, location) | FOIL / OpenRecords to that agency |
| MOCS / PASSPort | Vault + contract Documents (login) | Not public; vendor/agency users |
| Comptroller BCA | Registration package used to register | FOIL to Comptroller (`foil@comptroller.nyc.gov` or Comptroller online form) |
| City Record GetFile | Historical notice attachments | Already empty for modern solicitations |

There is no bulk FOIL dump.

---

## How the four fields map

| Field | Structured public | Unstructured public | Records-request |
|---|---|---|---|
| **Scope** | Title + short FMS purpose + notice paragraph | Released-RFx bid-book specifications PDFs | Executed SOW in registration package |
| **Line-item pricing** | Historical CSB bidder prices only (frozen 2021, unjoinable) | RFx “Itemized Bid Page” (solicitation form, not awarded schedule) | Awarded pricing exhibit |
| **Deliverables** | Not published as a table | Sometimes inside spec PDFs | Contract exhibits |
| **Performance location** | Not a contract field. Capital-project borough ≠ performance. Contract *response* addresses are logistics (already separated in CityScroll). Notice prose sometimes names a shelter/school. | Spec PDFs may name sites | Contract place-of-performance clause |

---

## What CityScroll should not do

- Do not parse PASSPort `contractData.js` for documents. There are none.
- Do not treat Checkbook `prime_contract_purpose` or City Record `additional_description_1` as the contract file.
- Do not scrape authenticated PASSPort / Vault.
- Do not re-enable historical bid tabulations as modern line-item pricing.
- Do not merge contract-response geography into performance place.

## Follow-on (only if product wants solicitation packages)

A **new** card, not a silent reopen of `procurement-solicitation-documents` from the dump:

1. Bounded sample of released RFx HTML → `public_document` PDF hit rate.
2. Closed / awarded RFx: do documents remain public?
3. Coverage vs micropurchase / negotiated / emergency (many PASSPort Public contract rows will never have an RFx bid book).
4. Bot-block / ToS / polite collector.
5. Keep PDFs as official-source handoffs first; structured extraction of SOW/pricing from PDFs is a later, fail-closed decision.

Until that recon clears usefulness **and** precision gates, keep the existing dump stop rule.

---

## Evidence index

| Item | Where |
|---|---|
| Contract dump columns | `worker/src/lib/passport_parse.mjs` `CONTRACT_COLUMNS`; live `contracts.js` title strings |
| RFx dump document-URL kill | `site/data/passport_sources/verification_receipts/passport_rfx_documents_2026-07-30.json` |
| Extra dump 403s | Live HEAD 2026-08-23 |
| RFx HTML + PDF downloads | `passport.cityofnewyork.us/page.aspx/en/bpm/process_manage_extranet/38077` and `37965`; `webserver-mocs-prd.lfr.cloud/c/public_document/download` |
| Contract Ivalua login wall | `/page.aspx/en/ctr/contract_browse_public` → `/usr/login` |
| Checkbook purpose sample | POST `https://www.checkbooknyc.com/api` Contracts registered expense FY2026, 25 rows |
| OCP award notice prose | SODA `qyyg-4tf5` 2026-08-23 |
| Bid tabulations freeze | `site/data/bid_tabulation_sources/README.md` |
