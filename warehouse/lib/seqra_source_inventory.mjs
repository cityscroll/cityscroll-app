/**
 * SEQRA/CEQR source inventory and population profiler (SEQRA-01).
 *
 * Pure functions only: everything here consumes already-fetched SODA query
 * results (assembled by tools/build_seqra_source_inventory.mjs, which owns
 * the network I/O) and produces the measured profile, the target-specific
 * usable-population estimates, and the final machine-readable receipt. No
 * function in this file performs a network request, so it is fully testable
 * against bounded fixtures.
 *
 * This card establishes feasibility and denominators. It does not build the
 * process ontology, extract documents, or create a training corpus -- later
 * cards (SEQRA-02 onward) own that work. Every population estimate below
 * that depends on unbuilt machinery is reported `unknown` with a reason
 * naming the card that will produce it, never as zero or an estimate.
 */

import { SEQRA_SOURCE_REGISTRY } from "./seqra_source_registry.mjs";
import { SEQRA_SODA_SOURCE_CONFIG } from "./seqra_soda_source_config.mjs";

export const SEQRA_INVENTORY_RECEIPT_SCHEMA = "cityscroll.seqra_source_inventory_receipt.v1";
export const SEQRA_SOURCE_PROFILE_SCHEMA = "cityscroll.seqra_source_profile.v1";

const UNKNOWN = "unknown";
const NOT_APPLICABLE = "not_applicable";

function typedUnknown(reason) {
  return { status: UNKNOWN, value: null, reason };
}

function typedNotApplicable(reason) {
  return { status: NOT_APPLICABLE, value: null, reason };
}

function typedMeasured(value, extra = {}) {
  return { status: "measured", value, ...extra };
}

/**
 * Build the measured profile for one Tier-1 SODA source from its already
 * -fetched query results. `queries` mirrors the shape produced by
 * `fetchSodaSourceObservation` in the CLI runner.
 */
export function buildSodaSourceProfile(sourceId, queries = {}, opts = {}) {
  const config = SEQRA_SODA_SOURCE_CONFIG[sourceId];
  if (!config) throw new Error(`no SODA config for source_id ${sourceId}`);
  const registryEntry = SEQRA_SOURCE_REGISTRY.find((entry) => entry.source_id === sourceId);
  if (!registryEntry) throw new Error(`no registry entry for source_id ${sourceId}`);

  const totalCount = queries.total_count?.value;
  if (!Number.isFinite(totalCount)) {
    throw new Error(`${sourceId}: total_count query result missing or non-numeric`);
  }

  const counts = {
    total_rows: typedMeasured(totalCount),
    by_year: config.yearField
      ? typedMeasured(queries.year_breakdown?.rows ?? [], { field: config.yearField })
      : typedNotApplicable(`${sourceId} has no date field to derive a year breakdown from`),
    by_agency: config.agencyField
      ? typedMeasured(queries.agency_breakdown?.rows ?? [], { field: config.agencyField })
      : typedNotApplicable(`${sourceId} has no agency field`),
    by_event_type: config.eventTypeField
      ? typedMeasured(queries.event_type_breakdown?.rows ?? [], { field: config.eventTypeField })
      : typedNotApplicable(`${sourceId} has no event-type field`),
    by_review_status: config.reviewStatusField
      ? typedMeasured(queries.review_status_breakdown?.rows ?? [], { field: config.reviewStatusField })
      : typedNotApplicable(`${sourceId} has no review-status field`),
  };

  const missingness = {};
  for (const field of config.missingnessFields) {
    const nullCount = queries.missingness?.[field]?.value;
    missingness[field] = Number.isFinite(nullCount)
      ? typedMeasured(nullCount, {
          rate: totalCount > 0 ? Number((nullCount / totalCount).toFixed(6)) : null,
        })
      : typedUnknown(`missingness query for ${field} did not return a count`);
  }

  const dupQuery = queries.duplicate_keys ?? null;
  const duplicates = dupQuery
    ? typedMeasured({
        key_fields: config.dedupeKeyFields,
        duplicate_key_groups_count: dupQuery.duplicate_key_groups_count,
        // Prefer the exact count(distinct key) measurement, which is immune
        // to the $having group-listing pagination cap; fall back to the
        // (possibly incomplete) sum derived from the listed groups.
        duplicate_row_count: dupQuery.duplicate_row_count_exact ?? dupQuery.duplicate_row_count_from_groups,
        duplicate_row_count_is_exact: dupQuery.duplicate_row_count_exact != null,
        group_listing_pagination_complete: dupQuery.group_listing_pagination_complete !== false,
        sample_groups: dupQuery.sample_groups ?? [],
      })
    : typedUnknown("duplicate-key query was not run for this source");

  const dateRange = config.dateField
    ? (queries.date_range?.min_date != null || queries.date_range?.max_date != null
        ? typedMeasured({
            field: config.dateField,
            min_date: queries.date_range?.min_date ?? null,
            max_date: queries.date_range?.max_date ?? null,
          })
        : typedUnknown("date-range query did not return a value"))
    : typedNotApplicable(`${sourceId} has no date field`);

  const regimeLabelSample = config.regimeLabelField
    ? typedMeasured(queries.regime_label_sample?.rows ?? [], { field: config.regimeLabelField })
    : typedNotApplicable(`${sourceId} has no published environmental-regime label field`);

  const schemaSample = {
    columns: opts.datasetMetadata?.columns ?? [],
    sample_rows: queries.schema_sample?.rows ?? [],
    sample_row_count: (queries.schema_sample?.rows ?? []).length,
  };

  const observedLatencyMs = collectLatencies(queries);

  return {
    schema: SEQRA_SOURCE_PROFILE_SCHEMA,
    source_id: sourceId,
    tier: registryEntry.tier,
    jurisdiction_level: registryEntry.jurisdiction_level,
    environmental_regime: registryEntry.environmental_regime,
    dataset_identifier: registryEntry.dataset_identifier,
    dataset_metadata: opts.datasetMetadata ?? null,
    primary_fetch: queries.total_count?.fetch
      ? {
          fetch_id: queries.total_count.fetch.fetch_id ?? null,
          content_hash: queries.total_count.fetch.content_hash ?? null,
          retrieved_at: queries.total_count.fetch.retrieved_at ?? null,
          latency_ms: queries.total_count.fetch.latency_ms ?? null,
        }
      : null,
    counts,
    missingness,
    duplicates,
    date_range: dateRange,
    regime_label_sample: regimeLabelSample,
    schema_sample: schemaSample,
    observed_latency_ms: observedLatencyMs.length
      ? {
          status: "measured",
          samples: observedLatencyMs.length,
          min: Math.min(...observedLatencyMs),
          max: Math.max(...observedLatencyMs),
          median: median(observedLatencyMs),
        }
      : typedUnknown("no fetch receipts carried a latency measurement"),
    known_gaps: registryEntry.known_gaps,
  };
}

function collectLatencies(queries) {
  const out = [];
  for (const entry of Object.values(queries)) {
    if (entry && typeof entry === "object" && Number.isFinite(entry.fetch?.latency_ms)) {
      out.push(entry.fetch.latency_ms);
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      for (const nested of Object.values(entry)) {
        if (nested && Number.isFinite(nested.fetch?.latency_ms)) out.push(nested.fetch.latency_ms);
      }
    }
  }
  return out;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Register a non-SODA registry source (discovery-only or discovery-probe)
 * into the same profile shape, with every measurable field typed unknown
 * unless a discovery probe result was supplied.
 */
export function buildDiscoverySourceProfile(sourceId, discoveryResult = null) {
  const registryEntry = SEQRA_SOURCE_REGISTRY.find((entry) => entry.source_id === sourceId);
  if (!registryEntry) throw new Error(`no registry entry for source_id ${sourceId}`);
  const reason = registryEntry.known_gaps?.[0]
    ?? "Tier 2-4 source inventoried by documented discovery only in SEQRA-01; no population count attempted.";
  return {
    schema: SEQRA_SOURCE_PROFILE_SCHEMA,
    source_id: sourceId,
    tier: registryEntry.tier,
    jurisdiction_level: registryEntry.jurisdiction_level,
    environmental_regime: registryEntry.environmental_regime,
    dataset_identifier: registryEntry.dataset_identifier,
    dataset_metadata: null,
    counts: {
      total_rows: typedUnknown(reason),
      by_year: typedUnknown(reason),
      by_agency: typedUnknown(reason),
      by_event_type: typedUnknown(reason),
      by_review_status: typedUnknown(reason),
    },
    missingness: {},
    duplicates: typedUnknown(reason),
    date_range: typedUnknown(reason),
    regime_label_sample: typedUnknown(reason),
    schema_sample: { columns: [], sample_rows: [], sample_row_count: 0 },
    discovery_probe: discoveryResult
      ? {
          attempted: true,
          http_status: discoveryResult.http_status ?? null,
          content_type: discoveryResult.content_type ?? null,
          byte_count: discoveryResult.byte_count ?? null,
          fetch: discoveryResult.fetch ?? null,
        }
      : { attempted: false, reason: "not probed in SEQRA-01; see known_gaps" },
    observed_latency_ms: discoveryResult?.fetch?.latency_ms != null
      ? typedMeasured(discoveryResult.fetch.latency_ms)
      : typedUnknown("no discovery probe was attempted for this source"),
    known_gaps: registryEntry.known_gaps,
  };
}

/**
 * Grep the measured milestone-name breakdown for candidate supplemental
 * -review event strings (Target E). This reports a *raw string match*
 * against actually-fetched milestone_name values -- never an estimate --
 * and is explicit that it is not a validated label.
 */
function candidateSupplementalReviewCount(milestonesProfile) {
  const rows = milestonesProfile?.counts?.by_event_type?.value;
  if (!Array.isArray(rows)) return null;
  const pattern = /supplement|technical memo|revised (eas|eis)/i;
  const matches = rows.filter((row) => pattern.test(String(row.event_type ?? row.value ?? "")));
  return {
    matched_event_type_values: matches.map((row) => row.event_type ?? row.value),
    matched_row_count: matches.reduce((sum, row) => sum + Number(row.n ?? 0), 0),
  };
}

/**
 * Target-specific usable-population estimates (SEQRA-01 acceptance A5).
 * Every entry states whether the value is measured, derived from measured
 * fields, or unknown, and names the later card that would make it
 * label-ready. Nothing here is a training corpus or a release-gate claim.
 */
export function buildTargetPopulationEstimates(profilesBySourceId) {
  const ceqrProjects = profilesBySourceId.ceqr_projects;
  const ceqrMilestones = profilesBySourceId.ceqr_project_milestones;
  const zapProjects = profilesBySourceId.zap_projects;
  const dart = profilesBySourceId.nys_dec_dart;

  const zapCeqrTypeMissing = zapProjects?.missingness?.ceqr_number;
  const zapProjectStatusMissing = zapProjects?.missingness?.project_status;
  const dartDeterminationMissing = dart?.missingness?.seqr_determination;

  const targets = {};

  targets.review_path = {
    target: "Target A: Review path",
    status: "derived_from_measured_fields",
    ceqr_denominator: {
      numerator_description: "ZAP Projects rows with a non-null ceqr_number (CEQR review-path-indicative)",
      numerator: zapCeqrTypeMissing ? zapProjects.counts.total_rows.value - zapCeqrTypeMissing.value : null,
      denominator_description: "ZAP Projects total rows",
      denominator: zapProjects?.counts?.total_rows?.value ?? null,
    },
    seqra_denominator: {
      numerator_description: "NYS DEC DART rows with a non-null seqr_determination",
      numerator: dartDeterminationMissing ? dart.counts.total_rows.value - dartDeterminationMissing.value : null,
      denominator_description: "NYS DEC DART total rows",
      denominator: dart?.counts?.total_rows?.value ?? null,
    },
    exclusion_rules: ["No CEQR/SEQRA row is summed across the two denominators; they stay separate."],
    necessary_field_missingness: {
      ceqr_ceqr_number_missing_rate: zapCeqrTypeMissing?.rate ?? null,
      seqra_seqr_determination_missing_rate: dartDeterminationMissing?.rate ?? null,
    },
    source_tier_coverage: "Tier 1 only",
    usability_note:
      "This is a raw denominator of rows carrying a review-path-indicative field, not a labeled review-path population. No review-path label vocabulary exists yet; that is SEQRA-02 (process ontology and state projector).",
  };

  targets.next_milestone_and_time = {
    target: "Target B: Next milestone and time",
    status: UNKNOWN,
    reason: "Requires the append-only event model and as-of state projector (SEQRA-02); a milestone-sequencing denominator cannot be constructed from independent per-source counts.",
    context_only_measured_value: {
      description: "CEQR Project Milestones total rows (raw event count, not a per-review label)",
      value: ceqrMilestones?.counts?.total_rows?.value ?? null,
    },
  };

  targets.review_duration = {
    target: "Target C: Review duration",
    status: UNKNOWN,
    reason: "Requires paired start/end milestone dates per review under the process ontology (SEQRA-02); not constructible from an independent per-source inventory.",
  };

  targets.technical_issue_state = {
    target: "Target D: Technical issue state",
    status: UNKNOWN,
    reason: "Requires the document extraction pipeline and technical-topic classifier (SEQRA-04, SEQRA-05); no parsed documents exist yet.",
  };

  targets.supplemental_review = {
    target: "Target E: Supplemental review",
    status: ceqrMilestones ? "derived_from_measured_fields" : UNKNOWN,
    numerator_description: "CEQR Project Milestones rows whose published milestone_name string-matches a supplemental-review candidate term (revised EAS/EIS, technical memorandum, supplemental EIS)",
    candidate_match: ceqrMilestones ? candidateSupplementalReviewCount(ceqrMilestones) : null,
    denominator_description: "CEQR Project Milestones total rows",
    denominator: ceqrMilestones?.counts?.total_rows?.value ?? null,
    usability_note:
      "This is a raw string match against fetched milestone_name values, not a validated label; it does not distinguish a formal refusal to supplement from a completed supplemental filing. Label construction is SEQRA-08.",
  };

  targets.challenge_watch = {
    target: "Target F: Challenge watch",
    status: UNKNOWN,
    reason: "Requires bounded court-search coverage grading (A78-03) over Tier 4 sources, which are registered but not probed in SEQRA-01.",
  };

  for (const [key, label] of [
    ["procedural_survival", "Target G: Procedural survival"],
    ["durable_petitioner_relief", "Target H: Durable petitioner relief"],
    ["remedy_exposure_state", "Target I: Remedy exposure state"],
  ]) {
    targets[key] = {
      target: label,
      status: UNKNOWN,
      reason: "Requires the litigation ontology (A78-01) and court reconciliation with search-coverage grades (A78-03); zero litigation records exist in this card.",
    };
  }

  return targets;
}

/**
 * Overlay the static source registry (warehouse/lib/seqra_source_registry.mjs)
 * with this run's observed runtime fields -- `observed_latency`,
 * `last_success_at`, `last_row_count`, `last_content_hash`. The static
 * registry module stays declarative; this snapshot is the "as observed"
 * registry the commission's SOURCE RECEIPTS contract requires, and it is
 * only ever built from an actual fetch, never fabricated.
 */
export function buildRuntimeSourceRegistrySnapshot(sourceProfiles, generatedAt) {
  const profilesBySourceId = Object.fromEntries(sourceProfiles.map((profile) => [profile.source_id, profile]));
  return SEQRA_SOURCE_REGISTRY.map((entry) => {
    const profile = profilesBySourceId[entry.source_id];
    const measured = profile?.counts?.total_rows?.status === "measured";
    const discoveryFetch = profile?.discovery_probe?.attempted ? profile.discovery_probe.fetch : null;
    return {
      ...entry,
      observed_latency: profile?.primary_fetch?.latency_ms
        ?? (discoveryFetch?.latency_ms ?? null),
      last_success_at: measured
        ? (profile.primary_fetch?.retrieved_at ?? generatedAt)
        : (discoveryFetch && profile.discovery_probe.http_status != null && profile.discovery_probe.http_status < 400
          ? discoveryFetch.retrieved_at ?? generatedAt
          : null),
      last_row_count: measured ? profile.counts.total_rows.value : null,
      last_content_hash: measured
        ? (profile.primary_fetch?.content_hash ?? null)
        : (discoveryFetch?.content_hash ?? null),
    };
  });
}

/**
 * Assemble the SEQRA-01 machine-readable receipt. Fields the commission
 * receipt contract defines but that a later card owns are stamped explicit
 * `not_yet_produced` placeholders, never fabricated values.
 */
export function buildSeqraInventoryReceipt({
  generatedAt,
  sourceProfiles,
  scopeClassificationSummary,
  targetPopulationEstimates,
  coverageWarnings = [],
  reconciliationBaseline = null,
} = {}) {
  if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("generatedAt must be an ISO timestamp");
  }
  const notYetProduced = (reason) => ({ status: "not_yet_produced", value: null, reason });

  const jurisdictionCounts = {};
  const rawRowCounts = {};
  const sourceVintages = {};
  for (const profile of sourceProfiles) {
    jurisdictionCounts[profile.jurisdiction_level] = (jurisdictionCounts[profile.jurisdiction_level] ?? 0)
      + (profile.counts.total_rows.status === "measured" ? profile.counts.total_rows.value : 0);
    rawRowCounts[profile.source_id] = profile.counts.total_rows;
    sourceVintages[profile.source_id] = profile.dataset_metadata?.rows_updated_at ?? UNKNOWN;
  }

  return {
    schema: SEQRA_INVENTORY_RECEIPT_SCHEMA,
    schema_version: 1,
    generated_at: generatedAt,
    source_registry: buildRuntimeSourceRegistrySnapshot(sourceProfiles, generatedAt),
    jurisdiction_counts: jurisdictionCounts,
    source_vintages: sourceVintages,
    raw_row_counts: rawRowCounts,
    raw_document_counts: notYetProduced("Document manifests are SEQRA-04 scope (CEQR Access document pipeline); no documents have been fetched."),
    parsed_document_counts: notYetProduced("Document extraction is SEQRA-04/SEQRA-05 scope; no documents have been parsed."),
    review_counts_by_year_agency_and_status: Object.fromEntries(
      sourceProfiles.map((profile) => [profile.source_id, profile.counts]),
    ),
    identity_match_metrics: notYetProduced("Cross-source identity resolution beyond the existing exact-key CEQR join is SEQRA-02/SEQRA-03 scope."),
    topic_extraction_metrics: notYetProduced("Technical-topic extraction is SEQRA-05 scope; no documents have been classified."),
    target_prevalence: notYetProduced("Target prevalence requires labels, which do not exist until SEQRA-08 (label builder and rolling backtest corpus)."),
    fold_definitions: notYetProduced("Rolling-origin folds are SEQRA-08 scope."),
    model_versions: notYetProduced("No models exist; baselines are SEQRA-09/A78-05 scope."),
    metrics_by_target_and_fold: notYetProduced("No models exist; SEQRA-09/A78-05 scope."),
    calibration_metrics: notYetProduced("No models exist; SEQRA-09/A78-05 scope."),
    temporal_leakage_count: 0,
    out_of_scope_record_count: scopeClassificationSummary.out_of_scope_record_count,
    coverage_warnings: coverageWarnings,
    gate: buildReleaseGateStatus(sourceProfiles),
    scope_classification: scopeClassificationSummary,
    target_population_estimates: targetPopulationEstimates,
    existing_reconciliation_baseline: reconciliationBaseline
      ? {
          note: "Cited from the existing CEQR/ZAP reconciliation receipt for context only. Not a current source count produced by this inventory; verify against warehouse/receipts/proof/ceqr_project_milestone_reconciliation_latest.json.",
          ...reconciliationBaseline,
        }
      : notYetProduced("Existing reconciliation receipt was not supplied to this build."),
  };
}

const RELEASE_GATE_THRESHOLDS = Object.freeze({
  completed_reconciled_reviews: 1000,
  parsed_core_documents_with_provenance: 500,
  identity_exact_or_human_confirmed_rate: 0.9,
  evaluated_milestone_date_validity: 0.95,
  temporal_leakage_count: 0,
  verified_challenged_determinations: 100,
});

function buildReleaseGateStatus(sourceProfiles) {
  return {
    result: "NOT_EVALUATED",
    rationale:
      "SEQRA-01 measures source feasibility and denominators only; it creates no training corpus, reconciled review population, or model. Every release-gate threshold below is not yet measurable and is not a pass/fail claim.",
    thresholds: RELEASE_GATE_THRESHOLDS,
    thresholds_status: Object.fromEntries(
      Object.keys(RELEASE_GATE_THRESHOLDS).map((key) => [key, { status: UNKNOWN, reason: "Not measurable until the reconciliation, document, and label cards land (SEQRA-02 onward)." }]),
    ),
    resident_ingestion_committed: false,
    public_predictive_claim_authorized: false,
    sources_attempted: sourceProfiles.length,
  };
}
