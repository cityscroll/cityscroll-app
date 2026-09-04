import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  ARTIFACT_TITLE_TOKENS,
  RER_CRITERIA_ACTION_CODES,
  assertLandFilingCensusReceiptShape,
  buildLandFilingEvidenceCensusReceipt,
  bucketRerObservationCounts,
  classifyZapArtifactGroup,
  computeSameNameDifferentHashStats,
  computeSameNameDifferentIdStats,
  extractZapFilingManifest,
  nominateSpecimens,
  normalizeDocumentName,
  percentiles,
  scanForPublisherTardyAssertion,
} from "../warehouse/lib/land_filing_evidence_census.mjs";

const goldPayload = JSON.parse(readFileSync(new URL("./fixtures/land_filing_evidence_census/gold_project.v1.json", import.meta.url)));

function proxyUrl(kind, sourceId) {
  return `https://zap-api-production.herokuapp.com/document/${kind}/${sourceId.replace(/^\//, "")}`;
}

describe("classifyZapArtifactGroup", () => {
  it("classifies packages as an explicit publisher relationship type (tier 1)", () => {
    const result = classifyZapArtifactGroup({ relationshipType: "packages", groupTitle: "2025Q0247_Filed LU Package_1", packageTypeRaw: 717170011 });
    assert.equal(result.document_type, "filed_land_use_package");
    assert.equal(result.method, "explicit_publisher_relationship_type");
  });

  it("classifies artifact groups by title token only (tier 2, never tier 1)", () => {
    const result = classifyZapArtifactGroup({ relationshipType: "artifacts", groupTitle: "2025Q0247_Racial Equity Report_" });
    assert.equal(result.document_type, "racial_equity_report");
    assert.equal(result.method, "title_token_strong");
    assert.notEqual(result.method, "explicit_publisher_type");
  });

  it("never invents a classification from a loose token match beyond the controlled vocabulary", () => {
    const result = classifyZapArtifactGroup({ relationshipType: "artifacts", groupTitle: "Miscellaneous Exhibit 7" });
    assert.equal(result.document_type, "unknown");
    assert.equal(result.method, "no_match");
  });

  it("has at least the vocabulary this census actually observed", () => {
    const types = ARTIFACT_TITLE_TOKENS.map((t) => t.document_type);
    for (const expected of ["racial_equity_report", "notice_of_receipt", "notice_of_certification_or_referral"]) {
      assert.ok(types.includes(expected), `missing ${expected}`);
    }
  });
});

describe("extractZapFilingManifest", () => {
  it("extracts an untruncated manifest with real artifact/package group identity", () => {
    const manifest = extractZapFilingManifest(goldPayload, { projectId: "2025Q0247", buildDocumentUrl: proxyUrl });
    assert.equal(manifest.ok, true);
    // 1 RER + 2 NoC + 1 NoR + 1 pkg1 + 1 pkg2 = 6, never truncated to 40.
    assert.equal(manifest.n_documents, 6);
    assert.equal(manifest.documents.length, 6);
    const rerDoc = manifest.documents.find((d) => d.source_id === "RER_SOURCE_A");
    assert.equal(rerDoc.classification.document_type, "racial_equity_report");
  });

  it("retains the raw dcp-applicability value without translating it into an RER state", () => {
    const manifest = extractZapFilingManifest(goldPayload, { projectId: "2025Q0247" });
    assert.equal(manifest.dcp_applicability_raw, "Yes");
  });

  it("handles response-schema drift: missing data.type gracefully, with a warning, not a throw", () => {
    const manifest = extractZapFilingManifest({ data: { type: "not-a-project" } }, { projectId: "X" });
    assert.equal(manifest.ok, false);
    assert.ok(manifest.warnings.length > 0);
    assert.equal(manifest.n_documents, 0);
  });

  it("handles an empty included[] without throwing", () => {
    const manifest = extractZapFilingManifest({ data: { type: "projects", id: "EMPTY", attributes: {} }, included: [] }, { projectId: "EMPTY" });
    assert.equal(manifest.ok, true);
    assert.equal(manifest.n_documents, 0);
    assert.deepEqual(manifest.documents, []);
  });

  it("warns on a malformed relationship item missing group id and document identity", () => {
    const payload = {
      data: { type: "projects", id: "MALFORMED", attributes: {} },
      included: [
        { type: "artifacts", attributes: { "dcp-name": "Untitled", documents: [{ name: "no-url.pdf" }] } },
      ],
    };
    const manifest = extractZapFilingManifest(payload, { projectId: "MALFORMED" });
    assert.equal(manifest.ok, true);
    assert.ok(manifest.warnings.some((w) => w.includes("missing group id")));
    assert.ok(manifest.warnings.some((w) => w.includes("missing serverRelativeUrl")));
    assert.equal(manifest.documents[0].source_id, null);
  });

  it("counts more than 40 documents without truncation", () => {
    const documents = Array.from({ length: 45 }, (_, i) => ({ name: `Exhibit ${i}.pdf`, serverRelativeUrl: `/DOC_${i}` }));
    const payload = {
      data: { type: "projects", id: "BIG", attributes: {} },
      included: [{ type: "artifacts", id: "big-artifact", attributes: { "dcp-artifactsid": "big-artifact", "dcp-name": "Big Exhibit Set", documents } }],
    };
    const manifest = extractZapFilingManifest(payload, { projectId: "BIG" });
    assert.equal(manifest.n_documents, 45);
  });
});

describe("same-name identity and hash statistics", () => {
  it("measures same-name/different-source-id rate structurally", () => {
    const manifest = extractZapFilingManifest(goldPayload, { projectId: "2025Q0247" });
    const stats = computeSameNameDifferentIdStats(manifest.documents);
    // Two real same-name/different-source-id pairs in the gold fixture: the RER
    // filename repeated under two source ids, and the authorization-letter
    // filename repeated across two Filed LU Package versions.
    assert.equal(stats.numerator_names_with_multiple_ids, 2);
    assert.equal(stats.denominator_distinct_names, 4);
    assert.ok(stats.examples.every((example) => example.distinct_source_ids.length === 2));
  });

  it("distinguishes an identical-hash duplicate from a genuinely different-hash same-name pair", () => {
    const documentsWithHash = [
      { normalized_name: normalizeDocumentName("rer.pdf"), bytes_sha256: "aaa" },
      { normalized_name: normalizeDocumentName("rer.pdf"), bytes_sha256: "aaa" }, // exact byte duplicate under a different source record
      { normalized_name: normalizeDocumentName("project description.pdf"), bytes_sha256: "bbb" },
      { normalized_name: normalizeDocumentName("project description.pdf"), bytes_sha256: "ccc" }, // revised between versions
    ];
    const stats = computeSameNameDifferentHashStats(documentsWithHash);
    assert.equal(stats.denominator_names_with_multiple_hashed_docs, 2);
    assert.equal(stats.numerator_names_with_different_hash, 1);
    assert.equal(stats.numerator_names_with_identical_hash_duplicate, 1);
    assert.equal(stats.rate, 0.5);
  });

  it("never claims a hash-based rate over documents that were never byte-fetched", () => {
    const stats = computeSameNameDifferentHashStats([{ normalized_name: "a", bytes_sha256: null }, { normalized_name: "a", bytes_sha256: null }]);
    assert.equal(stats.denominator_names_with_multiple_hashed_docs, 0);
    assert.equal(stats.rate, null);
  });
});

describe("publisher missing/tardy assertion scan", () => {
  it("finds an explicit publisher tardy/missing token when present", () => {
    const manifests = [{ project_id: "TARDY1", dcp_applicability_raw: "Yes", public_status: "Active", groups: [{ group_title: "Notice - Report Not Timely Filed" }] }];
    const hits = scanForPublisherTardyAssertion(manifests);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].project_id, "TARDY1");
  });

  it("never fires merely because zero RER documents were observed", () => {
    const manifests = [{
      project_id: "NONE_OBSERVED",
      dcp_applicability_raw: "Yes",
      public_status: "Active",
      groups: [{ group_title: "Filed LU Package_1", classification: classifyZapArtifactGroup({ relationshipType: "packages", groupTitle: "Filed LU Package_1" }) }],
    }];
    assert.equal(scanForPublisherTardyAssertion(manifests).length, 0);
    const buckets = bucketRerObservationCounts(manifests);
    assert.equal(buckets.zero_rer_groups, 1);
    // "not_observed" and "publisher_identifies_not_timely_filed" must stay distinguishable:
    // this manifest has zero observed RER groups AND zero tardy-assertion hits, which is
    // exactly the "no qualifying document observed" state, never the publisher-tardy state.
  });
});

describe("percentiles", () => {
  it("computes bounded percentiles without extrapolating past the sample", () => {
    const p = percentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [50, 90, 100]);
    assert.equal(p[100], 10);
    assert.equal(p[50], 5);
  });

  it("returns nulls rather than NaN or zero for an empty sample", () => {
    const p = percentiles([], [50, 90]);
    assert.equal(p[50], null);
  });
});

describe("nominateSpecimens", () => {
  it("reports a measured absence with search coverage when no candidate exists, never a fabricated one", () => {
    const manifests = [{ project_id: "P1", n_documents: 3, documents: [], groups: [] }];
    const result = nominateSpecimens({ manifests, deepDiveDocs: [], sampleActionsByProjectId: { P1: ["ZM"] } });
    assert.equal(result.not_required.status, "not_found");
    assert.ok(result.not_required.search_coverage.length > 0);
    assert.equal(result.missing_or_tardy.status, "not_found");
    assert.equal(result.scanned_ocr.status, "not_found");
    assert.equal(result.over_40_documents.status, "not_found");
  });

  it("nominates a reconstructed (not publisher-asserted) not-required candidate when action codes fall outside the criteria chart", () => {
    const manifests = [{ project_id: "OFF_CHART", n_documents: 0, documents: [], groups: [] }];
    const result = nominateSpecimens({ manifests, deepDiveDocs: [], sampleActionsByProjectId: { OFF_CHART: ["BSA-VARIANCE-CODE"] } });
    assert.equal(result.not_required.classification, "reconstructed_candidate");
    assert.equal(result.not_required.project_id, "OFF_CHART");
    for (const code of result_actions_not_in_criteria()) assert.ok(!RER_CRITERIA_ACTION_CODES.includes(code));
    function result_actions_not_in_criteria() { return ["BSA-VARIANCE-CODE"]; }
  });

  it("nominates the >40-documents specimen when the structural sample contains one", () => {
    const manifests = [{ project_id: "BIGDOC", n_documents: 58, documents: [], groups: [] }];
    const result = nominateSpecimens({ manifests, deepDiveDocs: [], sampleActionsByProjectId: {} });
    assert.equal(result.over_40_documents.project_id, "BIGDOC");
    assert.equal(result.over_40_documents.n_documents, 58);
  });
});

describe("buildLandFilingEvidenceCensusReceipt", () => {
  function observationFixture(overrides = {}) {
    const manifest = extractZapFilingManifest(goldPayload, { projectId: "2025Q0247", buildDocumentUrl: proxyUrl });
    const activeManifest = extractZapFilingManifest(
      { data: { type: "projects", id: "2026K0123", attributes: { "dcp-applicability": "Yes", "dcp-publicstatus": "Noticed" } }, included: [] },
      { projectId: "2026K0123" },
    );
    const base = {
      schema: "cityscroll.land_filing_evidence_census_observation.v1",
      materialized_at: "2026-09-03T00:00:00.000Z",
      collection_started_at: "2026-09-03T00:00:00.000Z",
      collection_ended_at: "2026-09-03T00:05:00.000Z",
      soda: {
        dataset_metadata: { rows_updated_at: "2026-08-01T00:00:00.000Z", metadata_updated_at: "2026-08-01T00:00:00.000Z", columns: [] },
        dataset_metadata_fetch: { fetch_id: "f1", http_status: 200 },
        total_count: { value: 32964, fetch: { fetch_id: "f2", http_status: 200 } },
        year_breakdown: { rows: [{ year: "2026", n: 100 }], fetch: { fetch_id: "f3", http_status: 200 }, pagination_complete: true },
        borough_breakdown: { rows: [{ borough: "Queens", n: 50 }], fetch: { fetch_id: "f4", http_status: 200 }, pagination_complete: true },
        project_status_breakdown: { rows: [{ project_status: "Active", n: 50 }], fetch: { fetch_id: "f5", http_status: 200 }, pagination_complete: true },
        public_status_breakdown: { rows: [{ public_status: "Noticed", n: 20 }], fetch: { fetch_id: "f6", http_status: 200 }, pagination_complete: true },
        ulurp_non_breakdown: { rows: [{ ulurp_non: "ULURP", n: 90 }], fetch: { fetch_id: "f7", http_status: 200 }, pagination_complete: true },
        actions_raw_breakdown: { rows: [{ actions: "ZM", n: 30 }], fetch: { fetch_id: "f8", http_status: 200 }, pagination_complete: true },
        date_range: { min_date: "1990-01-01", max_date: "2026-08-01", fetch: { fetch_id: "f9", http_status: 200 } },
        operative_period_proxy_count: { value: 5000, fetch: { fetch_id: "f10", http_status: 200 }, where_clause: "app_filed_date >= '2021-01-01'" },
        rate_behavior: { n: 10, median_latency_ms: 120, max_latency_ms: 300, min_latency_ms: 80, throttling_or_429_observed: false },
      },
      soda_fetch_attempts: 10,
      soda_fetch_failures: 0,
      statute_sources: {
        attempts: 2,
        failures: 1,
        admin_code_25_118: { url: "https://example.invalid/admin-code", fetch: { http_status: 403 }, resolved: false, note: "blocked" },
        dcp_rer_criteria_pdf: { url: "https://example.invalid/rer-criteria.pdf", fetch: { http_status: 200 }, resolved: true, names_governing_law: "Local Law 78 of 2021", extracted_action_codes: RER_CRITERIA_ACTION_CODES, extracted_text_excerpt: "excerpt" },
      },
      sample: {
        frame: { definition: "test frame", rows: [{ project_id: "2025Q0247" }, { project_id: "2026K0123" }], pagination_complete: true, fetch: { fetch_id: "f11", http_status: 200 } },
        sampling_method: "test",
        pinned: ["2025Q0247", "2026K0123"],
        zap_api_fetches: [
          { project_id: "2025Q0247", http_status: 200, included_types: ["artifacts", "packages", "actions"] },
          { project_id: "2026K0123", http_status: 200, included_types: [] },
        ],
        manifests: [manifest, activeManifest],
        sample_actions_by_project_id: { "2025Q0247": ["ZM", "ZR"], "2026K0123": ["ZM"] },
        rate_behavior: { n: 2, median_latency_ms: 400, max_latency_ms: 500, min_latency_ms: 300, throttling_or_429_observed: false },
        collection_started_at: "2026-09-03T00:01:00.000Z",
        collection_ended_at: "2026-09-03T00:04:00.000Z",
      },
      deep_dive: { documents: [
        { project_id: "2025Q0247", source_id: "RER_SOURCE_A", normalized_name: "rer_108th street_1.22.26.pdf", http_status: 200, content_type: "application/pdf", byte_length: 1431975, bytes_sha256: "50b99a3", pages: 80, extracted_text_bytes: 190596 },
        { project_id: "2025Q0247", source_id: "RER_SOURCE_B", normalized_name: "rer_108th street_1.22.26.pdf", http_status: 200, content_type: "application/pdf", byte_length: 1431975, bytes_sha256: "50b99a3", pages: 80, extracted_text_bytes: 190596 },
      ] },
      specimen_nominations: nominateSpecimens({
        manifests: [manifest, activeManifest],
        deepDiveDocs: [
          { project_id: "2025Q0247", source_id: "RER_SOURCE_A", extracted_text_bytes: 190596, pages: 80 },
        ],
        sampleActionsByProjectId: { "2025Q0247": ["ZM", "ZR"], "2026K0123": ["ZM"] },
      }),
      go_stop_decisions: {
        rer_document_observation: { result: "GO", rationale: "..." },
        rer_applicability_state_derivation: { result: "STOP", rationale: "..." },
      },
    };
    return { ...base, ...overrides };
  }

  it("produces a receipt satisfying the shape contract", () => {
    const receipt = buildLandFilingEvidenceCensusReceipt(observationFixture());
    assertLandFilingCensusReceiptShape(receipt);
  });

  it("is deterministic: rebuilding from the same observation is byte-identical", () => {
    const observation = observationFixture();
    const first = JSON.stringify(buildLandFilingEvidenceCensusReceipt(observation));
    const second = JSON.stringify(buildLandFilingEvidenceCensusReceipt(observation));
    assert.equal(first, second);
  });

  it("never derives a public required/not_required applicability state from ZAP alone", () => {
    const receipt = buildLandFilingEvidenceCensusReceipt(observationFixture());
    assert.equal(receipt.applicability.required.status, "not_applicable");
    assert.equal(receipt.applicability.not_required.status, "not_applicable");
    assert.equal(receipt.applicability.unknown.value, 2);
    assert.equal(receipt.applicability.conflicting.value, 0);
  });

  it("reports total_discoverable_projects and operative_period_projects with method and an explicit exact-boundary-unknown flag", () => {
    const receipt = buildLandFilingEvidenceCensusReceipt(observationFixture());
    assert.equal(receipt.population.total_discoverable_projects.status, "measured");
    assert.equal(receipt.population.total_discoverable_projects.value, 32964);
    assert.equal(receipt.population.operative_period_projects.exact_statutory_boundary, "unknown");
  });

  it("reports fetch success rate as a real numerator/denominator, not a bare fraction", () => {
    const receipt = buildLandFilingEvidenceCensusReceipt(observationFixture());
    assert.equal(receipt.sample.fetch_success_rate.numerator, 2);
    assert.equal(receipt.sample.fetch_success_rate.denominator, 2);
  });

  it("degrades a rate/fetch failure into a lower success rate, not a thrown error", () => {
    const observation = observationFixture();
    observation.sample.zap_api_fetches = [...observation.sample.zap_api_fetches, { project_id: "FAILED", http_status: 503 }];
    const receipt = buildLandFilingEvidenceCensusReceipt(observation);
    assert.equal(receipt.sample.fetch_success_rate.denominator, 3);
    assert.equal(receipt.sample.fetch_success_rate.numerator, 2);
  });

  it("reports document counts and percentiles over the untruncated manifest, and flags the >40-document project", () => {
    const receipt = buildLandFilingEvidenceCensusReceipt(observationFixture());
    assert.equal(receipt.document_counts.status, "measured");
    assert.equal(receipt.projects_exceeding_40_documents.value, 0); // gold fixture here has 6 docs, not >40
  });

  it("measures the same-name/different-id and same-name/different-hash rates with distinct denominators", () => {
    const receipt = buildLandFilingEvidenceCensusReceipt(observationFixture());
    assert.equal(receipt.same_name_different_id_rate.numerator, 2);
    assert.equal(receipt.same_name_different_hash_rate.numerator, 0); // identical hash -> a duplicate, not a "different hash" case
  });

  it("distinguishes not_observed from publisher-tardy in the fulfillment section", () => {
    const receipt = buildLandFilingEvidenceCensusReceipt(observationFixture());
    assert.equal(receipt.fulfillment.publisher_missing_or_tardy_assertions.value, 0);
    assert.equal(receipt.fulfillment.publisher_missing_or_tardy_assertions.note, "No publisher field or title token corresponding to a missing/tardy RER assertion was found anywhere in the sample.");
  });

  it("never fabricates media types or a scanned-pdf rate beyond the deep-dive subset it actually byte-fetched", () => {
    const receipt = buildLandFilingEvidenceCensusReceipt(observationFixture());
    assert.equal(receipt.media_types.structural_sample.status, "not_applicable");
    assert.equal(receipt.media_types.deep_dive_subset.status, "measured");
    assert.equal(receipt.media_types.deep_dive_subset.value["application/pdf"], 2);
  });

  it("carries specimen nominations and GO/stop decisions through untouched", () => {
    const receipt = buildLandFilingEvidenceCensusReceipt(observationFixture());
    assert.equal(receipt.specimens.positive_gold.project_id, "2025Q0247");
    assert.equal(receipt.go_stop_decisions.rer_applicability_state_derivation.result, "STOP");
  });

  it("marks CEQR-document overlap as an explicit unknown rather than zero (SEQRA-04 does not exist yet)", () => {
    const receipt = buildLandFilingEvidenceCensusReceipt(observationFixture());
    assert.equal(receipt.ceqr_document_overlap.status, "unknown");
    assert.notEqual(receipt.ceqr_document_overlap.value, 0);
  });

  it("throws a named error when a required top-level key is missing", () => {
    const receipt = buildLandFilingEvidenceCensusReceipt(observationFixture());
    delete receipt.applicability;
    assert.throws(() => assertLandFilingCensusReceiptShape(receipt), /missing keys/);
  });
});

describe("committed receipt fitness", () => {
  it("the committed receipt matches the schema contract and rebuilds byte-identically from its retained observation", () => {
    const committedReceipt = JSON.parse(readFileSync(new URL("../warehouse/receipts/proof/land_filing_evidence_census_latest.json", import.meta.url)));
    assertLandFilingCensusReceiptShape(committedReceipt);
    const observation = JSON.parse(readFileSync(new URL("../warehouse/fixtures/land-filing-census/observation.v1.json", import.meta.url)));
    const rebuilt = buildLandFilingEvidenceCensusReceipt(observation);
    assert.deepEqual(rebuilt, committedReceipt);
  });
});
