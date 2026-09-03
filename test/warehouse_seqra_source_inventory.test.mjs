import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDiscoverySourceProfile,
  buildSeqraInventoryReceipt,
  buildSodaSourceProfile,
  buildTargetPopulationEstimates,
} from "../warehouse/lib/seqra_source_inventory.mjs";
import { summarizeScopeClassification } from "../warehouse/lib/seqra_scope_classifier.mjs";

function fetchStub(latencyMs) {
  return { latency_ms: latencyMs };
}

function ceqrProjectsQueries() {
  return {
    total_count: { value: 15383, fetch: fetchStub(120) },
    agency_breakdown: {
      rows: [
        { agency: "Department of City Planning", n: 4376 },
        { agency: "Board of Standards and Appeals", n: 3864 },
      ],
      fetch: fetchStub(110),
    },
    missingness: {
      ceqr: { value: 0, fetch: fetchStub(90) },
      lead_agency: { value: 5, fetch: fetchStub(90) },
      project_name: { value: 0, fetch: fetchStub(90) },
    },
    duplicate_keys: {
      duplicate_key_groups_count: 2,
      duplicate_row_count_from_groups: 2,
      duplicate_row_count_exact: 2,
      group_listing_pagination_complete: true,
      sample_groups: [
        { key_values: ["00DPR001M"], n: 2 },
        { key_values: ["03BSA087R"], n: 2 },
      ],
      fetch: fetchStub(100),
    },
    schema_sample: { rows: [{ ceqr: "26DCP139X", project_name: "Sample project" }], fetch: fetchStub(80) },
  };
}

function ceqrMilestonesQueries() {
  return {
    total_count: { value: 42000, fetch: fetchStub(130) },
    year_breakdown: { rows: [{ year: 2024, n: 900 }, { year: 2025, n: 1100 }], fetch: fetchStub(115) },
    event_type_breakdown: {
      rows: [
        { event_type: "Draft Scope of Work", n: 300 },
        { event_type: "Supplemental EIS Filed", n: 12 },
        { event_type: "Final Environmental Impact Statement", n: 250 },
      ],
      fetch: fetchStub(140),
    },
    missingness: {
      ceqr: { value: 3, fetch: fetchStub(85) },
      milestone_name: { value: 0, fetch: fetchStub(85) },
      milestone_date: { value: 20, fetch: fetchStub(85) },
    },
    duplicate_keys: {
      duplicate_key_groups_count: 0,
      duplicate_row_count_from_groups: 0,
      duplicate_row_count_exact: 0,
      group_listing_pagination_complete: true,
      sample_groups: [],
      fetch: fetchStub(95),
    },
    date_range: { min_date: "1990-01-01", max_date: "2026-08-30", fetch: fetchStub(105) },
    schema_sample: { rows: [{ ceqr: "26DCP139X", milestone_name: "Draft Scope of Work", milestone_date: "2024-01-01" }], fetch: fetchStub(80) },
  };
}

describe("SEQRA source inventory profiler", () => {
  it("builds a measured profile for a SODA source and types absent breakdown fields not_applicable", () => {
    const profile = buildSodaSourceProfile("ceqr_projects", ceqrProjectsQueries(), {
      datasetMetadata: { name: "CEQR Projects", rows_updated_at: "2026-08-30T00:00:00.000Z", columns: [] },
    });
    assert.equal(profile.counts.total_rows.status, "measured");
    assert.equal(profile.counts.total_rows.value, 15383);
    assert.equal(profile.counts.by_agency.status, "measured");
    assert.equal(profile.counts.by_year.status, "not_applicable");
    assert.equal(profile.counts.by_event_type.status, "not_applicable");
    assert.equal(profile.counts.by_review_status.status, "not_applicable");
    assert.equal(profile.missingness.ceqr.value, 0);
    assert.equal(profile.missingness.lead_agency.rate, Number((5 / 15383).toFixed(6)));
    assert.equal(profile.duplicates.status, "measured");
    assert.equal(profile.duplicates.value.duplicate_key_groups_count, 2);
    assert.equal(profile.duplicates.value.duplicate_row_count, 2);
    assert.equal(profile.duplicates.value.duplicate_row_count_is_exact, true);
    assert.equal(profile.date_range.status, "not_applicable");
    assert.equal(profile.observed_latency_ms.status, "measured");
    assert.ok(profile.observed_latency_ms.samples > 0);
  });

  it("never fabricates a count when a query result is missing -- throws instead of defaulting to zero", () => {
    assert.throws(() => buildSodaSourceProfile("ceqr_projects", { agency_breakdown: { rows: [] } }));
  });

  it("registers a discovery-only Tier 2-4 source with every count typed unknown and a stated reason", () => {
    const profile = buildDiscoverySourceProfile("nyscef");
    assert.equal(profile.counts.total_rows.status, "unknown");
    assert.ok(profile.counts.total_rows.reason.length > 0);
    assert.equal(profile.discovery_probe.attempted, false);
  });

  it("records a discovery probe result without turning it into a population count", () => {
    const profile = buildDiscoverySourceProfile("ceqr_access", {
      http_status: 200,
      content_type: "text/html",
      byte_count: 4096,
      fetch: fetchStub(220),
    });
    assert.equal(profile.discovery_probe.attempted, true);
    assert.equal(profile.discovery_probe.http_status, 200);
    // Reachability evidence must not leak into a fabricated row count.
    assert.equal(profile.counts.total_rows.status, "unknown");
  });

  it("builds target-specific population estimates that keep CEQR and statewide SEQRA denominators separate", () => {
    const zapProjects = buildSodaSourceProfile("zap_projects", {
      total_count: { value: 5000, fetch: fetchStub(100) },
      missingness: {
        project_id: { value: 0, fetch: fetchStub(80) },
        ceqr_number: { value: 4200, fetch: fetchStub(80) },
        ceqr_leadagency: { value: 4200, fetch: fetchStub(80) },
        current_envmilestone: { value: 3000, fetch: fetchStub(80) },
        project_status: { value: 0, fetch: fetchStub(80) },
      },
      duplicate_keys: {
        duplicate_key_groups_count: 0,
        duplicate_row_count_from_groups: 0,
        duplicate_row_count_exact: 0,
        group_listing_pagination_complete: true,
        sample_groups: [],
        fetch: fetchStub(90),
      },
      schema_sample: { rows: [], fetch: fetchStub(70) },
    });
    const dart = buildSodaSourceProfile("nys_dec_dart", {
      total_count: { value: 8000, fetch: fetchStub(100) },
      missingness: {
        application_id: { value: 0, fetch: fetchStub(80) },
        seqr_class: { value: 100, fetch: fetchStub(80) },
        seqr_determination: { value: 6000, fetch: fetchStub(80) },
        lead_agency: { value: 0, fetch: fetchStub(80) },
      },
      duplicate_keys: {
        duplicate_key_groups_count: 0,
        duplicate_row_count_from_groups: 0,
        duplicate_row_count_exact: 0,
        group_listing_pagination_complete: true,
        sample_groups: [],
        fetch: fetchStub(90),
      },
      schema_sample: { rows: [], fetch: fetchStub(70) },
    });
    const ceqrMilestones = buildSodaSourceProfile("ceqr_project_milestones", ceqrMilestonesQueries());

    const targets = buildTargetPopulationEstimates({
      zap_projects: zapProjects,
      nys_dec_dart: dart,
      ceqr_project_milestones: ceqrMilestones,
    });

    assert.equal(targets.review_path.status, "derived_from_measured_fields");
    assert.equal(targets.review_path.ceqr_denominator.numerator, 800); // 5000 - 4200
    assert.equal(targets.review_path.ceqr_denominator.denominator, 5000);
    assert.equal(targets.review_path.seqra_denominator.numerator, 2000); // 8000 - 6000
    assert.equal(targets.review_path.seqra_denominator.denominator, 8000);
    // CEQR and statewide SEQRA denominators are never summed into one number.
    assert.notEqual(targets.review_path.ceqr_denominator, targets.review_path.seqra_denominator);

    assert.equal(targets.next_milestone_and_time.status, "unknown");
    assert.match(targets.next_milestone_and_time.reason, /SEQRA-02/);
    assert.equal(targets.next_milestone_and_time.context_only_measured_value.value, 42000);

    assert.equal(targets.review_duration.status, "unknown");
    assert.equal(targets.technical_issue_state.status, "unknown");

    assert.equal(targets.supplemental_review.status, "derived_from_measured_fields");
    assert.deepEqual(
      targets.supplemental_review.candidate_match.matched_event_type_values.sort(),
      ["Supplemental EIS Filed"],
    );
    assert.equal(targets.supplemental_review.candidate_match.matched_row_count, 12);

    for (const key of ["challenge_watch", "procedural_survival", "durable_petitioner_relief", "remedy_exposure_state"]) {
      assert.equal(targets[key].status, "unknown");
      assert.ok(targets[key].reason.length > 0);
    }
  });

  it("stamps unbuilt receipt fields as explicit not_yet_produced placeholders, never fabricated values", () => {
    const profile = buildSodaSourceProfile("ceqr_projects", ceqrProjectsQueries(), {
      datasetMetadata: { name: "CEQR Projects", rows_updated_at: "2026-08-30T00:00:00.000Z", columns: [] },
    });
    const scopeSummary = summarizeScopeClassification([
      { source_jurisdiction: "NYC", environmental_regime: "CEQR", review_label_as_published: "CEQR" },
    ]);
    const receipt = buildSeqraInventoryReceipt({
      generatedAt: "2026-09-03T00:00:00.000Z",
      sourceProfiles: [profile],
      scopeClassificationSummary: scopeSummary,
      targetPopulationEstimates: { review_path: { status: "unknown" } },
    });
    assert.equal(receipt.raw_document_counts.status, "not_yet_produced");
    assert.equal(receipt.identity_match_metrics.status, "not_yet_produced");
    assert.equal(receipt.target_prevalence.status, "not_yet_produced");
    assert.equal(receipt.model_versions.status, "not_yet_produced");
    assert.equal(receipt.temporal_leakage_count, 0);
    assert.equal(receipt.out_of_scope_record_count, 0);
    assert.equal(receipt.gate.result, "NOT_EVALUATED");
    assert.equal(receipt.gate.resident_ingestion_committed, false);
    assert.equal(receipt.gate.public_predictive_claim_authorized, false);
    assert.equal(receipt.jurisdiction_counts.NYC, 15383);
  });

  it("rejects building a receipt with a non-ISO generatedAt", () => {
    assert.throws(() => buildSeqraInventoryReceipt({ generatedAt: "not-a-date", sourceProfiles: [], scopeClassificationSummary: {}, targetPopulationEstimates: {} }));
  });
});
