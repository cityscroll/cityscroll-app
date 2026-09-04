/**
 * SEQRA-05: synthetic fixture documents and a small human-reviewed benchmark
 * set for the card gate (tools/check_seqra_document_pipeline.mjs). Like
 * SEQRA-02/04's fixtures, every value here is a synthetic identity/shape
 * example built to exercise this pipeline's own contracts -- never a claim
 * about a real environmental review.
 *
 * Deliberately covers, across one review:
 *   - a topic (shadows) with an impact and a mitigation finding, plus a
 *     numeric threshold fact whose vintage-specific comparison differs
 *     between the two recorded CEQR Technical Manual editions (A3);
 *   - a topic (transportation) with a numeric threshold finding only;
 *   - a topic (historic_cultural_resources) with an explicit screened-out
 *     statement (A2's `screened_out`, reached only through explicit
 *     screening language);
 *   - a topic (hazardous_materials) mentioned nowhere at all in any fixture
 *     document (A2's `not_located`, distinct from `screened_out`);
 *   - a topic (air_quality) extracted from a page this fixture set marks as
 *     low quality, whose finding is confidence-capped below the quarantine
 *     threshold (A5);
 *   - a topic (noise) disputed in a comment letter and addressed in an
 *     agency response (the dispute-record deliverable).
 *
 * The paired benchmark set below is not scored as a trivial 100% match: two
 * entries deliberately diverge from what the pattern extractor actually
 * produces (one expected finding the extractor misses, one extractor
 * finding the human reviewer did not expect), so the precision/recall
 * report this fixture set drives is a real computation, not a stand-in
 * constant.
 */
export const TOPIC_EXTRACTION_REVIEW_KEY = "environmental_review:ceqr:26DCP555Q";

export const TOPIC_DEIS_FIXTURE = Object.freeze({
  candidateUrl: "https://a002-ceqraccess.nyc.gov/ceqr/document/sample-topic-deis",
  title: "Draft Environmental Impact Statement",
  issuedDate: "2024-02-01",
  bytes: Buffer.from("%PDF-1.4 fixture bytes for topic-extraction DEIS"),
  pages: [
    {
      pageNumber: 1,
      qualityState: "high",
      text:
        "Chapter 5: Shadows\n" +
        "The proposed action would result in an impact from new shadows cast onto the adjacent playground for 0.22 of " +
        "daylight hours during the analysis period, as shown in Table 5-1.\n" +
        "Mitigation measures proposed for the shadow impact include a redesigned building envelope, as illustrated in Figure 5-2.",
    },
    {
      pageNumber: 2,
      qualityState: "high",
      text:
        "Chapter 9: Transportation\n" +
        "The intersection of Main Street and First Avenue would experience 5.4 seconds of delay under the build " +
        "condition, exceeding the threshold established in the technical manual, as detailed in Table 9-1.",
    },
    {
      pageNumber: 3,
      qualityState: "high",
      text:
        "Chapter 12: Historic and Cultural Resources\n" +
        "The proposed action was screened out of detailed analysis for historic and cultural resources because the " +
        "project site contains no properties listed on or eligible for the State or National Registers of Historic Places.",
    },
    {
      pageNumber: 4,
      qualityState: "low",
      text:
        "Chapter 8: Air Quality\n" +
        "The proposed action would result in an impact on air quality due to increased particulate emissions from " +
        "equipment operating near the site during building activities.",
    },
  ],
});

export const TOPIC_COMMENT_LETTER_FIXTURE = Object.freeze({
  candidateUrl: "https://a002-ceqraccess.nyc.gov/ceqr/document/sample-topic-comment-letter",
  title: "Comment Letter",
  issuedDate: "2024-05-01",
  bytes: Buffer.from("%PDF-1.4 fixture bytes for topic-extraction comment letter"),
  pages: [
    {
      pageNumber: 1,
      qualityState: "high",
      text: "Commenters raised concern about noise from ongoing equipment activities affecting nearby residences during the anticipated building period.",
    },
  ],
});

export const TOPIC_AGENCY_RESPONSE_FIXTURE = Object.freeze({
  candidateUrl: "https://a002-ceqraccess.nyc.gov/ceqr/document/sample-topic-agency-response",
  title: "Agency Response to Comments",
  issuedDate: "2024-06-01",
  bytes: Buffer.from("%PDF-1.4 fixture bytes for topic-extraction agency response"),
  pages: [
    {
      pageNumber: 1,
      qualityState: "high",
      text:
        "In response to comments about noise, the lead agency notes that no further mitigation is required because " +
        "operating hours for noisy equipment will be limited to reduce impacts on nearby residences.",
    },
  ],
});

// A topic that appears in none of the fixture documents above -- the
// not_located control case for A2.
export const TOPIC_NEVER_MENTIONED = "hazardous_materials";

/**
 * Human-reviewed benchmark entries, keyed by document_key at scoring time
 * (the gate tool substitutes the real document_key once the fixture has
 * gone through the fetch/store pipeline). `pageNumber` here matches the
 * fixture pages above one for one.
 */
export const TOPIC_EXTRACTION_BENCHMARK_ENTRIES = Object.freeze([
  { documentRole: "deis", pageNumber: 1, expectedFindings: [{ technical_topic: "shadows", finding_type: "impact" }, { technical_topic: "shadows", finding_type: "mitigation" }] },
  { documentRole: "deis", pageNumber: 2, expectedFindings: [{ technical_topic: "transportation", finding_type: "threshold_comparison" }, { technical_topic: "transportation", finding_type: "impact" }] },
  { documentRole: "deis", pageNumber: 3, expectedFindings: [{ technical_topic: "historic_cultural_resources", finding_type: "screened_out_statement" }] },
  { documentRole: "deis", pageNumber: 4, expectedFindings: [{ technical_topic: "air_quality", finding_type: "impact" }] },
  { documentRole: "comment_letter", pageNumber: 1, expectedFindings: [{ technical_topic: "noise", finding_type: "comment" }] },
  { documentRole: "agency_response", pageNumber: 1, expectedFindings: [{ technical_topic: "noise", finding_type: "agency_response" }] },
]);
