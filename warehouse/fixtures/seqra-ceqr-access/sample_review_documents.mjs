/**
 * SEQRA-04: synthetic fixture documents for the card gate
 * (tools/check_seqra_document_pipeline.mjs). These are not scraped or
 * derived from a real environmental review -- like SEQRA-02's ontology
 * fixtures, every value here is a synthetic identity/shape example built to
 * exercise the pipeline's own contracts (hash-preserving fetch, extraction
 * quality measurement, document-type/supersession classification, coverage
 * gaps), never a claim about a real project or review.
 */
export const SAMPLE_REVIEW_KEY = "environmental_review:ceqr:24DCP999Q";

export const CLEAN_DRAFT_DEIS_TEXT =
  "Draft Environmental Impact Statement. This chapter of the review describes the proposed action and its " +
  "expected effects on land use, transportation, and open space. The lead agency is the Department of City " +
  "Planning. Public comments on this draft statement are due to the environmental review board within the " +
  "comment period described in the notice of completion.";

export const CLEAN_FINAL_FEIS_TEXT =
  "Final Environmental Impact Statement. This Final Environmental Impact Statement supersedes the Draft " +
  "Environmental Impact Statement issued on January 15, 2024. It incorporates responses to public comments " +
  "received on transportation, open space, and land use, and describes the mitigation measures the applicant " +
  "has committed to as part of the environmental review process.";

// Deliberately garbled: simulates a poor-quality OCR pass or a corrupted text
// layer, used to prove low-quality pages stay identifiable downstream (A3).
export const GARBLED_PAGE_TEXT = "�□㷀 xkqq zzqv ¤¤¤ □□□□ 8#$%&*() qqqzzq wwvvxx mmnnpp";

export const DRAFT_DEIS_FIXTURE = Object.freeze({
  candidateUrl: "https://a002-ceqraccess.nyc.gov/ceqr/document/sample-draft-deis",
  title: "Draft Environmental Impact Statement",
  issuedDate: "2024-01-15",
  bytes: Buffer.from(`%PDF-1.4 fixture bytes for draft DEIS\n${CLEAN_DRAFT_DEIS_TEXT}`),
  pages: [
    { pageNumber: 1, text: CLEAN_DRAFT_DEIS_TEXT },
    { pageNumber: 2, text: GARBLED_PAGE_TEXT },
  ],
});

export const FINAL_FEIS_FIXTURE = Object.freeze({
  candidateUrl: "https://a002-ceqraccess.nyc.gov/ceqr/document/sample-final-feis",
  title: "Final Environmental Impact Statement",
  issuedDate: "2024-08-01",
  bytes: Buffer.from(`%PDF-1.4 fixture bytes for final FEIS\n${CLEAN_FINAL_FEIS_TEXT}`),
  pages: [
    { pageNumber: 1, text: CLEAN_FINAL_FEIS_TEXT },
  ],
});

// A period with zero documents found, for the coverage-gap check (A4): the
// review's earliest known milestone (synthetic) predates the earliest
// document this fixture set "found."
export const EARLIEST_KNOWN_MILESTONE_DATE = "2023-06-01";
export const COVERAGE_GAP_PERIOD = Object.freeze({ start: "2023-06-01", end: "2024-01-01" });
