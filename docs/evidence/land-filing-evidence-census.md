# LDP-22 filing-evidence census

Host-side census over the ZAP land-use population and its filing-document coverage, ahead of any RER ontology, document collector, field extraction, or resident-facing change. It changes no resident output, no ZAP/CEQR materialization, and dispatches no downstream card.

## Bottom line

- **Population:** 32,964 discoverable ZAP projects (exact `count(*)` over Open Data `hgx4-8ukb`). 5,000 fall in a documented *proxy* operative-period window (`app_filed_date >= 2021-01-01`, the year Local Law 78 of 2021 was enacted) — the exact statutory effective date is an explicit unknown; see "Statute access" below.
- **Sample:** 151 projects (149 systematically drawn from the operative-period proxy frame + the 2 pinned specimens), 100% ZAP API fetch success.
- **RER applicability: no publisher field exists.** `dcp-applicability` reads `"Yes"` on both a project with an observed RER document and one with none. No milestone, action, disposition, or package field names Racial Equity or RER anywhere in the sampled responses. The only observable RER signal is a title-token match on an artifact group's `dcp-name` (e.g. containing "Racial Equity Report") — a document-observation signal, never a publisher applicability assertion.
- **Document truncation is real and large:** untruncated per-project document counts range up to 245 (p50 = 32, p90 = 80, p99 = 205); **60 of 151 sampled projects (39.7%) exceed the production parser's 40-document cutoff.**
- **Same-name/different-source-id collisions are common:** 35.9% of distinct document names in the sample span more than one distinct source id — the production parser's name-only dedupe silently collapses these.
- **Filed LU Package versioning is well-typed:** an explicit publisher relationship type with an explicit version number, submission date, and per-version document list.

## GO / stop decisions

| Candidate | Result | Why |
| --- | --- | --- |
| RER document observation (title-token discovery) | **GO** | Reliable, hashable, no auth required. |
| RER applicability-state derivation | **STOP** | No ZAP field encodes it; a public required/not_required state cannot be derived from ZAP alone without reconstructing statutory criteria inputs ZAP does not carry. |
| Filed LU Package version history | **GO** | Explicit publisher relationship type, version number, submission date. |
| Notice of Receipt / Notice of Certification-or-Referral | **NARROW** | Same title-token method as RER (tier 2, not tier 1) — proceed, but at the same lower evidentiary tier. |
| CEQR-document overlap | **STOP** | SEQRA-04 (CEQR Access document acquisition) does not exist yet; nothing to overlap against. |
| WRP / other report candidates | **STOP** | Out of the commission's own scope until this census establishes coverage; none observed regardless. |

## Required measures

See the full receipt at [`warehouse/receipts/proof/land_filing_evidence_census_latest.json`](../../warehouse/receipts/proof/land_filing_evidence_census_latest.json) for every commissioned measure with its denominator, method, and source vintage. Highlights:

| Measure | Value |
| --- | ---: |
| Total discoverable projects | 32,964 |
| Operative-period projects (proxy, exact boundary unknown) | 5,000 |
| Sample size | 151 |
| ZAP API fetch success rate | 151 / 151 (100%) |
| Projects with a publisher-explicit required/not-required/tardy assertion | 0 (no such field exists) |
| Projects exceeding 40 documents | 60 / 151 |
| Same-name/different-source-id rate | 1,179 / 3,282 distinct names (35.9%) |
| Same-name/different-hash rate (bounded deep-dive subset only) | 0 / 6 name-groups (all were identical-hash duplicates) |

## Specimens

- `2025Q0247` (pinned, positive gold): carries an RER artifact group and PDF, doubles as the >40-document specimen (61 documents), and contains a naturally-occurring same-name/different-source-id/**identical-hash** duplicate (the RER PDF is filed twice, once under its own artifact group and once bundled into the Notice of Certification group, byte-identical both times).
- `2026K0123` (pinned, active/noticed): no RER artifact observed yet; recorded as an explicit `unknown` applicability state, never as "not filed."
- `not_required`: reconstructed candidate `2026M0432` (action codes fall entirely outside DCP's RER criteria-chart action list). Explicitly labeled `reconstructed_candidate`, not a publisher assertion.
- `missing_or_tardy`: **measured absence** — no publisher field or title token for this state was found across the sample.
- `same_name_version`: `2025Q0247`'s `1.-69-67-108-ST.--LLC-Authorization-Letter.pdf` recurs across three Filed LU Package versions.
- `scanned_ocr`: a `2025Q0247` Filed LU Package document (`Producer: KONICA MINOLTA bizhub C4050i`, 1 page, 1 extracted text byte) — a genuine scanned image PDF with no text layer.

## Statute access

NYC Administrative Code section 25-118's primary text is blocked from this host by a Cloudflare bot challenge (HTTP 403). DCP's RER criteria chart (fetched successfully) names the governing law as Local Law 78 of 2021 but does not itself state an effective date in-document. The operative-period figure above is therefore a documented superset proxy, not the exact statutory denominator — recorded as an explicit unknown rather than a fabricated date.

## Reproduce

```sh
npm run warehouse:land:filing-census            # rebuild the receipt from the retained observation
node tools/build_land_filing_evidence_census.mjs --check   # verify it is current
node tools/build_land_filing_evidence_census.mjs --refresh # re-run the live host-side measurement pass
```
