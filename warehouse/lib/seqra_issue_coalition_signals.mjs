/**
 * SEQRA-07: issue-preservation and coalition-continuity features derived
 * from a review's `public_position` rows (G2 / A2).
 *
 * Both features exist to answer one question the raw position rows cannot
 * answer alone: is this a named, specific objection that keeps getting
 * raised, or undifferentiated background opposition? Neither feature is a
 * legal or procedural conclusion (this module makes no exhaustion, standing,
 * or merits claim) -- it is a process-observation summary over dated,
 * sourced positions, always computed as of an explicit cutoff.
 *
 * Cutoff validity (A4 / negative rule) is enforced here independently of
 * whatever validated the input positions: any position missing
 * `available_to_public_at`, or whose `available_to_public_at` is after
 * `asOfCutoff`, is excluded before any grouping happens. Undated advocacy
 * never becomes a cutoff-valid signal, and a position never counts toward a
 * cutoff before it was itself public.
 */

export const SEQRA_ISSUE_COALITION_SIGNAL_SCHEMA = "cityscroll.seqra_issue_coalition_signal.v1";

export const ISSUE_PRESERVATION_RIVAL_EXPLANATION =
  "The same normalized issue text recurring across positions may reflect independent commenters " +
  "submitting similar boilerplate language rather than a coordinated or persistent campaign around " +
  "one preserved concern; this signal does not distinguish the two.";

export const COALITION_CONTINUITY_RIVAL_EXPLANATION =
  "Multiple organizations naming the same issue may share a common information source (a shared " +
  "advocacy toolkit, a widely circulated notice, or overlapping membership) rather than reflecting " +
  "independent, uncoordinated agreement; apparent coalition size is not evidence of the issue's " +
  "technical merit, and it is not a judgment about why any participating organization joined.";

export const ISSUE_COALITION_SUPPRESSION_RULE =
  "This is a process signal about what was formally raised, when, and by how many distinct " +
  "organizations. It must never be read, displayed, or modeled as a misconduct or motive label for " +
  "any participating organization, including labor, developer, or community participants.";

class SeqraIssueCoalitionSignalError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeqraIssueCoalitionSignalError";
  }
}

/**
 * Deterministic normalization for free-text `named_issue` values: lowercase,
 * collapse whitespace, strip surrounding punctuation. Two positions whose
 * named_issue differs only by case or incidental punctuation preserve as the
 * same issue; this function does not do fuzzy/semantic matching, so a
 * genuinely differently-worded restatement of the same concern is treated as
 * a distinct issue rather than silently merged.
 */
export function normalizeNamedIssue(rawIssue) {
  if (rawIssue == null) return null;
  const collapsed = String(rawIssue)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed === "" ? null : collapsed;
}

function requireIsoDateTime(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SeqraIssueCoalitionSignalError(`${fieldName} is required and must be a non-empty ISO date-time string`);
  }
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) {
    throw new SeqraIssueCoalitionSignalError(`${fieldName} must be a parseable ISO date-time, got ${JSON.stringify(value)}`);
  }
  return ms;
}

/**
 * Keep only positions that are cutoff-valid as of `asOfCutoff`: a
 * non-null, parseable `available_to_public_at` that is not after the
 * cutoff. Returns `{ included, excludedUndated, excludedNotYetPublic }` so a
 * caller/gate can assert on how many rows were dropped and why, rather than
 * silently losing them.
 */
export function filterCutoffValidPositions(positions, { asOfCutoff } = {}) {
  const cutoffMs = requireIsoDateTime(asOfCutoff, "asOfCutoff");
  const included = [];
  let excludedUndated = 0;
  let excludedNotYetPublic = 0;
  for (const position of positions ?? []) {
    const raw = position?.available_to_public_at;
    if (typeof raw !== "string" || raw.trim() === "") {
      excludedUndated += 1;
      continue;
    }
    const availableMs = new Date(raw).getTime();
    if (Number.isNaN(availableMs)) {
      excludedUndated += 1;
      continue;
    }
    if (availableMs > cutoffMs) {
      excludedNotYetPublic += 1;
      continue;
    }
    included.push(position);
  }
  return { included, excludedUndated, excludedNotYetPublic };
}

function groupByNamedIssue(positions) {
  const groups = new Map();
  let genericOppositionCount = 0;
  for (const position of positions) {
    const normalized = normalizeNamedIssue(position.named_issue);
    if (normalized == null) {
      genericOppositionCount += 1;
      continue;
    }
    if (!groups.has(normalized)) groups.set(normalized, []);
    groups.get(normalized).push(position);
  }
  return { groups, genericOppositionCount };
}

/**
 * Issue-preservation: for each named issue raised on a review as of a
 * cutoff, whether it was raised once or reaffirmed over time (G2 / A2).
 * `preserved` requires the issue to recur across at least two distinct
 * observation dates -- a single mention, however many organizations happen
 * to co-sign it on the same day, is not yet "preservation" in the temporal
 * sense this feature measures (that is coalition breadth, computed
 * separately below).
 */
export function computeIssuePreservation(positions, { asOfCutoff } = {}) {
  const { included, excludedUndated, excludedNotYetPublic } = filterCutoffValidPositions(positions, { asOfCutoff });
  const { groups, genericOppositionCount } = groupByNamedIssue(included);

  const issues = [...groups.entries()].map(([namedIssue, group]) => {
    const sorted = [...group].sort((a, b) => new Date(a.observed_at) - new Date(b.observed_at));
    const distinctDates = new Set(sorted.map((p) => p.observed_at.slice(0, 10)));
    const distinctOrganizations = new Set(sorted.map((p) => p.organization_key));
    return {
      named_issue: namedIssue,
      first_observed_at: sorted[0].observed_at,
      last_observed_at: sorted[sorted.length - 1].observed_at,
      mention_count: sorted.length,
      distinct_observation_date_count: distinctDates.size,
      distinct_organization_count: distinctOrganizations.size,
      preserved: distinctDates.size >= 2,
      rival_explanation: ISSUE_PRESERVATION_RIVAL_EXPLANATION,
      suppression_rule: ISSUE_COALITION_SUPPRESSION_RULE,
    };
  });
  issues.sort((a, b) => a.named_issue.localeCompare(b.named_issue));

  return {
    schema: SEQRA_ISSUE_COALITION_SIGNAL_SCHEMA,
    as_of_cutoff: asOfCutoff,
    issues,
    generic_opposition_count: genericOppositionCount,
    excluded_undated_position_count: excludedUndated,
    excluded_not_yet_public_position_count: excludedNotYetPublic,
  };
}

/**
 * Coalition-continuity: for each named issue, whether it is being raised by
 * more than one distinct organization (a coalition, not a lone actor) and
 * whether that breadth persists across more than one source or occasion
 * (continuity, not one shared submission event) (G2 / A2).
 */
export function computeCoalitionContinuity(positions, { asOfCutoff } = {}) {
  const { included, excludedUndated, excludedNotYetPublic } = filterCutoffValidPositions(positions, { asOfCutoff });
  const { groups } = groupByNamedIssue(included);

  const coalitions = [...groups.entries()].map(([namedIssue, group]) => {
    const sorted = [...group].sort((a, b) => new Date(a.observed_at) - new Date(b.observed_at));
    const organizationKeys = [...new Set(sorted.map((p) => p.organization_key))].sort();
    const distinctSources = new Set(sorted.map((p) => p.source_id));
    const firstPublicAt = sorted.reduce((min, p) => (p.available_to_public_at < min ? p.available_to_public_at : min), sorted[0].available_to_public_at);
    const lastPublicAt = sorted.reduce((max, p) => (p.available_to_public_at > max ? p.available_to_public_at : max), sorted[0].available_to_public_at);
    const spanDays = Math.round((new Date(lastPublicAt) - new Date(firstPublicAt)) / 86400000);
    return {
      named_issue: namedIssue,
      organization_keys: organizationKeys,
      distinct_organization_count: organizationKeys.length,
      distinct_source_count: distinctSources.size,
      first_public_at: firstPublicAt,
      last_public_at: lastPublicAt,
      span_days: spanDays,
      coalition: organizationKeys.length >= 2,
      continuity: distinctSources.size >= 2 || spanDays >= 1,
      rival_explanation: COALITION_CONTINUITY_RIVAL_EXPLANATION,
      suppression_rule: ISSUE_COALITION_SUPPRESSION_RULE,
    };
  });
  coalitions.sort((a, b) => a.named_issue.localeCompare(b.named_issue));

  return {
    schema: SEQRA_ISSUE_COALITION_SIGNAL_SCHEMA,
    as_of_cutoff: asOfCutoff,
    coalitions,
    excluded_undated_position_count: excludedUndated,
    excluded_not_yet_public_position_count: excludedNotYetPublic,
  };
}

export { SeqraIssueCoalitionSignalError };
