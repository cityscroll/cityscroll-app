# CEQR Access document pipeline (SEQRA-04)

This is the fourth card of the New York SEQRA/CEQR predictive-foundation
workstream. It builds on SEQRA-02's process ontology and stable keys. It
gives the workstream its first review-document pipeline: a discovery receipt
for CEQR Access's search and document-link behavior, a per-review document
manifest, a hash-preserving fetcher, per-page text/OCR extraction with a
measured quality score, a document-type and supersession classifier, and
explicit missing-material statements. It does not ingest a structured
source (SEQRA-03), extract technical-topic facts from a document's contents
(SEQRA-05), or enable resident ingestion.

## Why a discovery receipt comes first

CEQR Access (`a002-ceqraccess.nyc.gov`) has no documented API. Building a
scraper against an assumption about how its search works would violate the
commission's constraint directly. `warehouse/lib/seqra_ceqr_access_discovery.mjs`
and `tools/build_seqra_ceqr_access_discovery.mjs` instead perform a small,
bounded, polite sequence of real HTTP probes -- a robots.txt check, the home
page, the discovered search page, a blank-criteria search submission, and one
single-attempt wide-criteria ("bulk-shaped") search submission that is never
retried on failure -- and record only what those probes actually returned.

The committed receipt (`warehouse/receipts/proof/seqra_ceqr_access_discovery_latest.json`)
reflects a real discovery pass against the live site: CEQR Access is a
stateful ASP.NET WebForms application whose search page requires
`__VIEWSTATE`/`__EVENTVALIDATION` postback tokens minted per request, not a
stable, cacheable query-string or JSON API. A blank-criteria search returns
the same search-page shell rather than an enumerable listing, and a single
borough-wide (the most bulk-shaped request the public UI itself offers) POST
did not complete within the bounded timeout and was abandoned rather than
retried -- further evidence against treating wide enumeration as a supported
access pattern. `document_link_pattern` is honestly reported
`not_yet_observed`: this pass reached the search interface but did not
capture a real result or detail page carrying document links, so the
document-link URL shape is unknown, not assumed. `bulk_api_documented` is
hard-coded `false` on every receipt this module can build.

## Document manifest and hash-preserving fetch

`warehouse/lib/seqra_document_manifest.mjs` mints a manifest entry
(`discovered_not_yet_fetched`) the moment a document link is observed, before
any fetch is attempted, and advances it to `fetched` (carrying a real
`document_key`, built from `warehouse/lib/seqra_stable_keys.mjs#buildReviewDocumentKey`)
only once the hash-preserving fetcher has actually retrieved and hashed
bytes -- or to `fetch_failed`, so a candidate the pipeline could not retrieve
stays listed rather than silently disappearing.

`warehouse/lib/seqra_document_fetcher.mjs#fetchAndStoreDocument` stores every
retrieved document content-addressed under
`warehouse/raw/seqra-ceqr-access/documents/<sha256-hex>.<ext>` (gitignored
bulk, same convention as every other warehouse collector) and returns a fetch
receipt carrying the commission's full fifteen-field SOURCE RECEIPTS contract
(`warehouse/lib/seqra_fetch_receipt.mjs`, shared with the discovery probe so
the two can never drift apart on shape). A document fetched twice with
identical bytes resolves to the same path -- deduplicated, never duplicated
under two names. Every per-page processing record
(`warehouse/lib/seqra_document_processing_record.mjs`) carries the exact
`fetch_id` and `content_hash` of the document it was extracted from, and the
builder throws if a page's own fetch reference does not match its parent
document's -- a parsed page cannot exist in this pipeline without a path back
to the immutable bytes and the receipt that produced them (card acceptance
A2).

## Extraction and OCR quality

`warehouse/lib/seqra_document_page_extract.py` is a sibling of
`warehouse/lib/attachment_text_extract.py`, not a fork of it: that module
flattens a PDF's text into one blob for the T1 attachment-search tier and
explicitly puts OCR out of scope. This card needs per-page text, because a
citation has to point at one page, so this module keeps the same
pypdf-when-available / honest-skip convention but preserves page boundaries.
No OCR engine (tesseract or otherwise) exists anywhere in this repository's
dependency set; a page with no PDF text layer is reported
`ocr_required: true, ocr_attempted: false`, and
`warehouse/lib/seqra_document_extraction.mjs#assessPageQuality` reports
`measured: false` with an explicit reason rather than fabricating a quality
score for a page nothing has actually read (card acceptance A3).

For a page that does have text -- from a real text layer today, or from OCR
once a later card wires an engine -- `measureExtractionQuality` scores it on
alphabetic-character ratio, common-word hit rate, garble-character presence,
and token-length plausibility, bucketed into the same `high`/`medium`/`low`/
`unknown`/`not_applicable` vocabulary LDP-23's `land_use_filing_document`
entity already uses for its own `ocr_quality`/`layout_quality` fields
(`ontology/land_use_filing.mjs#FILING_QUALITY_STATES`), reused here rather
than declared a second time. `summarizeDocumentExtractionQuality` rolls
per-page results up to a document level and names low-quality pages by their
real page number, never a positional index.

## Document-type and supersession classification

`warehouse/lib/seqra_document_classifier.mjs#classifyDocumentType` matches a
document's title and text sample against `SEQRA_REVIEW_DOCUMENT_TYPES`
(reused verbatim from `warehouse/lib/seqra_ontology_spec.mjs`, never
re-declared) with ordered, specificity-first patterns -- conditioned negative
declaration is tested before the more general negative declaration pattern,
for example. An unmatched document returns `document_type: null` and
`confidence: "unknown"` rather than a guess.

Supersession is deliberately conservative, matching the negative rule
`ontology/land_use_filing.mjs` already states for its own supersession
relation: never inferred from filename or date proximity alone.
`classifySupersession` links a final document to a draft only when the
final's own text explicitly names the draft it supersedes
(`basis: "explicit_text_reference"`, high confidence) or, failing that, when
it is the most recent unsuperseded draft of the paired type in the same
review (`basis: "stage_type_pairing"`, medium confidence). The pairing itself
is an explicit map (`deis`→`feis`, `draft_scope`→`final_scope`), because the
commissioned vocabulary encodes draft/final into the type name for some pairs
rather than carrying one type with a stage flag -- a `feis` and the `deis` it
supersedes never share a `document_type` string, so "same type" is the wrong
test. Both documents remain present afterward, linked by
`supersedes_document_key`, never overwritten (card acceptance A5).

## Missing older material, stated explicitly

`warehouse/lib/seqra_document_coverage_gaps.mjs` is the one place this
pipeline is allowed to say "we found nothing here," and it is built so that
statement can never be misread as "nothing happened here." Both builders
(`buildCoverageGapStatement` for a review/period with zero documents found,
`summarizeMissingOlderMaterial` for comparing the earliest document found
against a review's earliest known milestone) assert their own output never
matches a small set of forbidden absence-of-activity phrasings, and every
statement names the search limitation as the reason rather than the review's
history (card acceptance A4).

## Negative rule: no lawsuit score from raw pages

`warehouse/lib/seqra_document_processing_record.mjs#assertNoLawsuitScoreField`
recursively checks a built record for any litigation-outcome-flavored field
name (`lawsuit`, `litigation`, `legal_risk`, `article_78_risk`,
`challenge_probability`, `case_outcome`, and near variants) -- deliberately
narrow to that vocabulary, not to the word "score" in general, because this
record legitimately carries an extraction *quality* score (A3). The card
gate additionally scans every pipeline source file for a small set of
forbidden field-name literals. Neither this module nor any other in SEQRA-04
computes, stores, or exposes a litigation-risk number of any kind; document
models here extract structured facts (type, stage, supersession, quality)
and stop there.

## Command

```sh
npm run warehouse:seqra:documents                              # this card's gate (deterministic, no network)
node tools/check_seqra_document_pipeline.mjs --check            # rebuild and diff against the committed receipt
node tools/build_seqra_ceqr_access_discovery.mjs --discover     # re-run the live, bounded discovery probe
node tools/build_seqra_ceqr_access_discovery.mjs --check        # rebuild and diff the discovery receipt
```

`npm run warehouse:seqra:documents` is this card's gate, named to match the
`verify` field the SEQRA-04 card carries. It performs no network access; it
validates the pipeline's own contracts (A1-A5 above) against the previously
committed, live-probed discovery receipt and a set of synthetic fixture
documents (`warehouse/fixtures/seqra-ceqr-access/sample_review_documents.mjs`
-- shape examples, like SEQRA-02's ontology fixtures, never a claim about a
real review). `--discover` is the only command in this card that touches the
network, and it is bounded, polite, and never retried on failure.

## Shared-document processing: what this card owns

`ontology/land_use_filing.mjs` (LDP-23) already names this card explicitly:
its `land_use_filing_document` entity carries a `ceqr_document_link`
document type gated `FILING_DOCUMENT_TYPES_BLOCKED_UNTIL_SEQRA04`. This card
owns, for CEQR Access specifically: discovery of what the search interface
actually does, hash-preserving fetch and immutable content-addressed storage,
per-page text/OCR extraction with a measured quality score, and document-type
and supersession classification -- addressable by the stable
`review_document` key (`warehouse/lib/seqra_stable_keys.mjs`) and the
document's own content hash. It does not decide how a `land_use_filing_document`
row should reference a CEQR Access document, and it does not touch
`ontology/registry.v0.json` or LDP-23's own contracts. A downstream card
unblocking `ceqr_document_link` should reference this pipeline's
`document_key`/`content_hash` rather than operating a second CEQR Access
fetcher against the same source.

## Reuse and non-regression

This card adds no adapter for any Tier-1 structured source and performs no
fetch against them. It reuses SEQRA-01's `ceqr_access` source registry entry
(`warehouse/lib/seqra_source_registry.mjs`) and SEQRA-02's ontology vocabulary
(`SEQRA_REVIEW_DOCUMENT_TYPES`, `SEQRA_DOCUMENT_STAGES`,
`buildReviewDocumentKey`) directly rather than declaring parallel copies.
`warehouse/lib/ceqr_project_milestone_reconciliation.mjs` and
`warehouse/lib/zap_environmental_projection.mjs` are unmodified; their
existing behavior and measured baseline are outside this card's scope and not
regressed by it.
