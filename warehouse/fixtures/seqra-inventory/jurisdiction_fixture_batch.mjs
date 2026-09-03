/**
 * Required jurisdiction fixtures for the SEQRA-01 receipt's scope
 * classification. These are deliberately bounded test records, never live
 * source rows -- no Tier-1 SODA source in this inventory ever returns a
 * California/CEQA record, so this fixture is what exercises the rejection
 * test end to end and proves `out_of_scope_record_count` in the receipt.
 *
 * Required coverage: NYS `SEQR`, NYS `SEQRA`, NYC `CEQR`, California `CEQA`,
 * `source_jurisdiction="CA"`, an ambiguous/unknown jurisdiction, and a mixed
 * page combining several of the above.
 */

export const SEQRA_JURISDICTION_FIXTURE_BATCH = Object.freeze([
  {
    fixture_id: "nys-seqr-label",
    source_jurisdiction: "NYS",
    environmental_regime: "SEQR",
    review_label_as_published: "SEQR",
    judicial_review_regime: "NY_ARTICLE_78",
  },
  {
    fixture_id: "nys-seqra-label",
    source_jurisdiction: "NY",
    environmental_regime: "SEQRA",
    review_label_as_published: "SEQRA",
    judicial_review_regime: "NONE",
  },
  {
    fixture_id: "nyc-ceqr-label",
    source_jurisdiction: "NYC",
    environmental_regime: "CEQR",
    review_label_as_published: "CEQR",
    judicial_review_regime: "NY_ARTICLE_78",
  },
  {
    fixture_id: "california-ceqa-label",
    source_jurisdiction: "California",
    environmental_regime: "CEQA",
    review_label_as_published: "CEQA",
    judicial_review_regime: "UNKNOWN",
  },
  {
    fixture_id: "source-jurisdiction-ca-token",
    source_jurisdiction: "CA",
    environmental_regime: "CEQA",
    review_label_as_published: "CEQA",
    judicial_review_regime: "UNKNOWN",
  },
  {
    fixture_id: "ambiguous-unknown-jurisdiction",
    source_jurisdiction: "unspecified",
    environmental_regime: "SEQRA",
    review_label_as_published: "SEQRA",
    judicial_review_regime: "UNKNOWN",
  },
  // A mixed page: one clean NYS row, one clean NYC row, and one CA/CEQA row
  // arriving in the same batch as would happen scanning a multi-jurisdiction
  // search result. Zero of the CA/CEQA rows may reach the admitted count.
  {
    fixture_id: "mixed-page-nys",
    source_jurisdiction: "NYS",
    environmental_regime: "SEQR",
    review_label_as_published: "SEQR",
    judicial_review_regime: "NY_HYBRID",
  },
  {
    fixture_id: "mixed-page-nyc",
    source_jurisdiction: "NYC",
    environmental_regime: "CEQR",
    review_label_as_published: "CEQR",
    judicial_review_regime: "NONE",
  },
  {
    fixture_id: "mixed-page-ca",
    source_jurisdiction: "CA",
    environmental_regime: "CEQA",
    review_label_as_published: "CEQA",
    judicial_review_regime: "UNKNOWN",
  },
]);
