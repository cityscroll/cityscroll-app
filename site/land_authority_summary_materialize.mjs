/**
 * Build-time Land authority-summary materializer.
 *
 * Kept separate from site/land_authority_summary.mjs so the Notice cold path
 * (which resolves already-published summaries) does not download the
 * seed-merge / hoist publisher used only by tools/build_land_authority_summary.mjs.
 */
import {
  LAND_AUTHORITY_SOURCE_BASIS_DEFAULTS,
  LAND_AUTHORITY_SUMMARY_JOIN_VERSION,
  LAND_AUTHORITY_SUMMARY_RECEIPT_SCHEMA,
  LAND_AUTHORITY_SUMMARY_SCHEMA,
  LAND_AUTHORITY_SUMMARY_STATUSES,
  asObject,
  buildLandAuthoritySummary,
  clean,
  hearingsByProject,
  hearingsList,
  legalBasisForStage,
  projectUniverse,
  stageFactsForStage,
  stripToTierA,
} from "./land_authority_summary.mjs";
import { mergeLandOutcomeSeedRecord } from "./land_outcomes_merge.mjs";

export function materializeLandAuthoritySummaries(inputs = {}) {
  const landDefault = asObject(inputs.landDefault);
  const geography = inputs.geography || null;
  const publishedOpportunities = asObject(inputs.publishedOpportunities);
  const hashes = asObject(inputs.artifactHashes);
  const asOf = inputs.asOf || landDefault.generated_at || publishedOpportunities.generated_at || null;
  const generatedAt = inputs.generatedAt || asOf;
  const universe = projectUniverse(landDefault);
  const hearingsIndex = hearingsByProject(publishedOpportunities);
  // The default Land List snapshot keeps each outcome record's light, first-
  // paint fields; the phase spine, milestone roster, statutory clock, and
  // source observations travel in their own committed seed document so the
  // list snapshot stays inside its fixed byte budget. Materializing the
  // authority summaries needs the heavy half, so it is merged back here.
  const seedByProject = asObject(inputs.outcomesSeed?.by_project);
  const outcomesByProject = asObject(landDefault.outcomes?.by_project);
  const outcomeRecordFor = (projectId) => mergeLandOutcomeSeedRecord(
    outcomesByProject[projectId] || {},
    seedByProject[projectId] || null,
  );
  const summaries = {};
  const outcomes = [];
  const counts = {
    universe: universe.length,
    resolved: 0,
    unknown: 0,
  };

  for (const project of universe) {
    const projectId = clean(project.project_id);
    const outcomeRecord = outcomeRecordFor(projectId);
    const hearings = hearingsIndex.get(projectId) || [];
    const summary = stripToTierA(buildLandAuthoritySummary({
      project,
      geography,
      outcomes: {
        ...outcomeRecord,
        generated_at: outcomeRecord.generated_at || landDefault.generated_at,
      },
      publishedOpportunities: {
        hearings,
        generated_at: publishedOpportunities.generated_at,
        materialization: publishedOpportunities.materialization,
      },
      asOf,
      generatedAt,
    }));
    summaries[projectId] = summary;
    const bucket = summary.status === LAND_AUTHORITY_SUMMARY_STATUSES.RESOLVED ? "resolved" : "unknown";
    counts[bucket] += 1;
    outcomes.push({
      project_id: projectId,
      status: summary.status,
      reason: summary.reason,
      procedure_resolution: summary.procedure_resolution,
      current_stage_id: summary.current_stage?.stage_id || null,
      observed_status: summary.observed?.status || null,
      published_next_status: summary.published_next_opportunity?.status || null,
    });
  }

  // The legal citation for a stage is the same wherever that stage appears, so
  // it is published once per stage rather than once per project.
  // A vintage that is the same on every summary is a property of the build, not
  // of a project, so it is hoisted into the defaults rather than repeated. One
  // that differs stays where it is. Missing/null values are UNKNOWN: a single
  // known vintage among them must not hoist, or resolve would fill the unknowns.
  const hoistUniform = (read, drop) => {
    const present = Object.values(summaries).map(read);
    if (!present.length || present.some((value) => value == null)) return null;
    const values = new Set(present);
    if (values.size !== 1) return null;
    const [only] = values;
    for (const summary of Object.values(summaries)) drop(summary, only);
    return only;
  };
  const boundaryVintage = hoistUniform(
    (summary) => summary?.source_basis?.geography?.boundary_vintage,
    (summary) => { if (summary?.source_basis?.geography) delete summary.source_basis.geography.boundary_vintage; },
  );
  const checkedVintage = hoistUniform(
    (summary) => summary?.source_basis?.publisher?.checked_vintage,
    (summary) => { if (summary?.source_basis?.publisher) delete summary.source_basis.publisher.checked_vintage; },
  );
  const geographyStatus = hoistUniform(
    (summary) => summary?.source_basis?.geography?.status,
    (summary) => { if (summary?.source_basis?.geography) delete summary.source_basis.geography.status; },
  );
  const geographyProfileVersion = hoistUniform(
    (summary) => summary?.source_basis?.geography?.profile_version,
    (summary) => { if (summary?.source_basis?.geography) delete summary.source_basis.geography.profile_version; },
  );
  const sourceBasisDefaults = {
    ...LAND_AUTHORITY_SOURCE_BASIS_DEFAULTS,
    geography: {
      ...LAND_AUTHORITY_SOURCE_BASIS_DEFAULTS.geography,
      ...(geographyStatus ? { status: geographyStatus } : {}),
      ...(geographyProfileVersion ? { profile_version: geographyProfileVersion } : {}),
      ...(boundaryVintage ? { boundary_vintage: boundaryVintage } : {}),
    },
    publisher: {
      ...LAND_AUTHORITY_SOURCE_BASIS_DEFAULTS.publisher,
      ...(checkedVintage ? { checked_vintage: checkedVintage } : {}),
    },
  };
  const legalBasisByStage = {};
  const stageFactsByStage = {};
  const summaryStageIds = new Set(Object.values(summaries)
    .map((summary) => summary?.source_basis?.profile?.stage_id)
    .filter(Boolean));
  for (const stageId of summaryStageIds) {
    const citation = legalBasisForStage(stageId);
    if (citation) legalBasisByStage[stageId] = citation;
    // A stage's normative role and effect are registry constants, so they are
    // stated once per stage and merged back by resolveLandAuthoritySummary.
    const stage = stageFactsForStage(stageId);
    if (stage) stageFactsByStage[stageId] = stage;
  }
  for (const summary of Object.values(summaries)) {
    const stageId = summary?.source_basis?.profile?.stage_id;
    const facts = stageId ? stageFactsByStage[stageId] : null;
    if (!facts) continue;
    if (summary.current_role != null && summary.current_role === facts.role) delete summary.current_role;
    if (summary.effect != null && summary.effect === facts.effect) delete summary.effect;
    if (summary.source_basis?.profile?.role != null) delete summary.source_basis.profile.role;
  }
  // The freshness envelope's build-level fields are the same on every summary;
  // only vintages that genuinely vary by project stay per project.
  const hoistedFreshness = {};
  const hoistFreshnessKey = (key, read = (freshness) => freshness[key]) => {
    const value = hoistUniform(
      (summary) => (summary?.freshness ? read(summary.freshness) : null),
      (summary) => { if (summary?.freshness) delete summary.freshness[key]; },
    );
    if (value != null) hoistedFreshness[key] = value;
    return value;
  };
  hoistFreshnessKey("generated_at");
  hoistFreshnessKey("as_of");
  const hearingsVintage = hoistUniform(
    (summary) => summary?.freshness?.source_vintages?.hearings_generated_at,
    (summary) => { if (summary?.freshness?.source_vintages) delete summary.freshness.source_vintages.hearings_generated_at; },
  );
  const outcomesVintage = hoistUniform(
    (summary) => summary?.freshness?.source_vintages?.outcomes_generated_at,
    (summary) => { if (summary?.freshness?.source_vintages) delete summary.freshness.source_vintages.outcomes_generated_at; },
  );
  const hoistedSourceVintages = {};
  if (hearingsVintage != null) hoistedSourceVintages.hearings_generated_at = hearingsVintage;
  if (outcomesVintage != null) hoistedSourceVintages.outcomes_generated_at = outcomesVintage;
  if (Object.keys(hoistedFreshness).length || Object.keys(hoistedSourceVintages).length) {
    if (Object.keys(hoistedSourceVintages).length) {
      hoistedFreshness.source_vintages = hoistedSourceVintages;
    }
  }
  const freshnessDefaults = Object.keys(hoistedFreshness).length ? hoistedFreshness : null;
  // A checked "no published opportunity" says the same thing everywhere: the
  // hearings artifact was checked and nothing is scheduled. Its constant shape
  // is hoisted; a genuinely published or stale opportunity keeps its own shape.
  const noneSummaries = Object.values(summaries)
    .filter((summary) => summary?.published_next_opportunity?.status === "none");
  const publishedNextDefaults = {};
  if (noneSummaries.length) {
    for (const key of ["checked", "checked_vintage", "source", "source_id", "label", "date", "representing", "phase_id", "body_ref"]) {
      const values = new Set(noneSummaries.map((summary) => summary.published_next_opportunity[key] ?? null));
      if (values.size !== 1) continue;
      const [only] = values;
      publishedNextDefaults[key] = only;
      for (const summary of noneSummaries) delete summary.published_next_opportunity[key];
    }
  }
  const payload = {
    schema: LAND_AUTHORITY_SUMMARY_SCHEMA,
    join_version: LAND_AUTHORITY_SUMMARY_JOIN_VERSION,
    generated_at: generatedAt,
    source_basis_defaults: sourceBasisDefaults,
    legal_basis_by_stage: legalBasisByStage,
    ...(Object.keys(stageFactsByStage).length ? { stage_facts_by_stage: stageFactsByStage } : {}),
    ...(freshnessDefaults ? { freshness_defaults: freshnessDefaults } : {}),
    ...(Object.keys(publishedNextDefaults).length ? { published_next_defaults: publishedNextDefaults } : {}),
    summaries,
  };
  const receipt = {
    schema: LAND_AUTHORITY_SUMMARY_RECEIPT_SCHEMA,
    join_version: LAND_AUTHORITY_SUMMARY_JOIN_VERSION,
    generated_at: generatedAt,
    counts,
    resolved_project_ids: outcomes.filter((row) => row.status === "resolved").map((row) => row.project_id),
    unknown_project_ids: outcomes.filter((row) => row.status === "unknown").map((row) => row.project_id),
    outcomes,
    inputs: {
      land_default: {
        path: "site/data/land_default_ulurp.json",
        count: universe.length,
        vintage: { generated_at: landDefault.generated_at || null },
        sha256: hashes.land_default || null,
      },
      ...(inputs.outcomesSeed ? {
        land_outcomes_seed: {
          path: "site/data/land_outcomes_seed.json",
          count: Object.keys(seedByProject).length,
          vintage: { generated_at: inputs.outcomesSeed.generated_at || null },
          sha256: hashes.land_outcomes_seed || null,
        },
      } : {}),
      geography: {
        path: "site/data/community_board_geography_lookup.json",
        vintage: { boundary_vintage: geography?.boundary_vintage || null },
        sha256: hashes.geography || null,
      },
      upcoming_hearings: {
        path: "site/data/land_upcoming_hearings.json",
        count: (hearingsList(publishedOpportunities) || []).length,
        vintage: { generated_at: publishedOpportunities.generated_at || null },
        sha256: hashes.upcoming_hearings || null,
      },
      join_keys: ["project_id"],
    },
    generation: {
      derivation: "node tools/build_land_authority_summary.mjs",
    },
  };
  return { payload, receipt };
}
