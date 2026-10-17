/** Land-only projection of retained outcomes into the authority card. */
import { buildLandAuthoritySummary } from "./land_authority_summary.mjs";
import { AFFECTED_REVIEW_BODY_SCHEMA } from "./land_affected_review_body.mjs";
import { landAuthoritySummaryCandidates, landAuthoritySummaryFor } from "./land_authority_summary_view.mjs";

/** Recover the retained, publication-approved geography shared by the authority card and timeline. */
export function landAffectedReviewBodiesFor(row) {
  if (!row?.project_id) return null;
  const previous = landAuthoritySummaryFor(row);
  const geographySummary = [previous, landAuthoritySummaryCandidates(row)[1]].find(
    (summary) => summary?.project_id === row.project_id && summary.source_basis?.geography?.status === "resolved"
  );
  const refs = geographySummary?.affected_actor_refs || [];
  const bodies = (role) => refs.filter((ref) => ref.role === role).map((ref) => ref.body_ref);
  return refs.length ? {
    schema: AFFECTED_REVIEW_BODY_SCHEMA,
    ...geographySummary.source_basis.geography,
    edges: refs,
    facts: {
      community_boards: bodies("affected_community_board"),
      borough_presidents: bodies("affected_borough_president"),
      borough_president: bodies("affected_borough_president").length === 1 ? bodies("affected_borough_president")[0] : null,
      borough_boards: bodies("affected_borough_board"),
      borough_board: bodies("affected_borough_board").length > 0,
    },
  } : null;
}

/** Project materialized outcome evidence into the same card after cache/refresh resolution. */
export function landAuthoritySummaryFromOutcome(row, record) {
  const previous = landAuthoritySummaryFor(row);
  const affected = landAffectedReviewBodiesFor(row);
  const summary = buildLandAuthoritySummary({
    affectedReviewBodies: affected,
    project: { ...row, ...Object.fromEntries(Object.entries(record?.open_data || {}).filter(([, value]) => value != null)), project_id: row.project_id },
    outcomes: record || {},
    stale: !record || record.evidence_stale === true,
    asOf: record?.stage_observation?.observed_at || record?.generated_at || null,
    generatedAt: record?.generated_at || null,
  });
  // Published opportunities have their own checked source and clock. Outcome
  // hydration must not turn an already checked calendar into an unchecked one.
  const publishedSummary = [previous, landAuthoritySummaryCandidates(row)[1]].find(
    (candidate) => candidate?.published_next_opportunity?.checked === true
  ) || previous;
  if (publishedSummary?.published_next_opportunity) {
    summary.published_next_opportunity = publishedSummary.published_next_opportunity;
    summary.next_procedural_body = publishedSummary.next_procedural_body || null;
    summary.source_basis.publisher = publishedSummary.source_basis?.publisher || summary.source_basis.publisher;
    summary.freshness.source_vintages.hearings_generated_at = publishedSummary.freshness?.source_vintages?.hearings_generated_at || null;
  }
  return summary;
}
