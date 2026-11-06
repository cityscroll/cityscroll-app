/**
 * Board-acquisition deployed parity observation contract.
 *
 * Schema: cityscroll.board_acquisition_deployed_parity.v1
 *
 * One retained observation that reads the seven bounded community-board
 * acquisition sources through the deployed acquisition worker's real public
 * surface (GET /health plus one GET /hearings browse per board) and records,
 * per source, an identity-bound record assertion — not an HTTP status and a
 * count. The builder is deliberately pure: callers supply the deployed
 * responses they actually fetched, so a local replay cannot be mislabeled as a
 * deployed observation, and the validator re-derives every status, count, and
 * digest from the payload's own facts so a constant or hand-edited field is
 * refused.
 */

import { createHash } from "node:crypto";

export const BOARD_ACQUISITION_DEPLOYED_PARITY_SCHEMA =
  "cityscroll.board_acquisition_deployed_parity.v1";
// Mirrors BOARD_MEETING_ACQUISITION_PRESENCE_POPULATION_BOARDS in
// tools/build_community_board_meeting_index.mjs, restated here because that
// builder's import graph statically loads materialized data that a
// focused-reduced checkout may not hold. The board-acquisition test locks the
// two lists together by reading that file's source text, so neither can drift.
export const DEPLOYED_PARITY_BOARDS = Object.freeze([
  "bronx-cb-06", "bronx-cb-08", "manhattan-cb-02", "manhattan-cb-04",
  "manhattan-cb-10", "manhattan-cb-11", "manhattan-cb-12",
]);
export const DEPLOYED_PARITY_EVIDENCE_CLASS = "external_live_endpoint";
export const DEPLOYED_PARITY_EXECUTION_ENVIRONMENT = "external-network-observed";
export const DEPLOYED_PARITY_PROVENANCE_KINDS = Object.freeze([
  "deployed", "replay", "rehearsal", "isolated",
]);
export const DEPLOYED_PARITY_RECOVERY_BASES = Object.freeze([
  "record_identity_binding",
  "not_observed",
  "browse_unavailable",
  "no_records_served",
  "board_binding_failed",
  "registered_source_url_mismatch",
  "registered_source_url_missing",
]);
export const DEPLOYED_PARITY_STATUSES = Object.freeze([
  "all_sources_recovered",
  "partial_recovery",
  "no_sources_recovered",
  "observation_incomplete",
]);
export const DEPLOYED_PARITY_COUNT_PARITY_STATES = Object.freeze([
  "exact", "differs", "unavailable",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseableTimestamp(value) {
  return typeof value === "string" && ISO_TIMESTAMP_PATTERN.test(value)
    && Number.isFinite(Date.parse(value));
}

function recordIdentity(row) {
  return {
    meeting_id: String(row?.meeting_id || ""),
    event_date: String(row?.event_date || ""),
    title: String(row?.title || ""),
  };
}

function wellFormedIdentity(identity) {
  return identity.meeting_id.startsWith("meeting:")
    && identity.event_date.length >= 10
    && Number.isFinite(Date.parse(identity.event_date))
    && identity.title.trim().length > 0;
}

/** Digest over one source's examined record identities, in served order. */
export function boardIdentitiesDigest(identities) {
  return sha256Hex(stableJson(identities.map(recordIdentity)));
}

/** Digest binding this observation to one run: cannot be reused across runs. */
export function evidenceBindingDigest({
  schema, observedAt, runId, commit, sources,
}) {
  return sha256Hex(stableJson({
    schema,
    observed_at: observedAt,
    run_id: runId,
    deployment_commit: commit,
    sources: sources.map((source) => ({
      board_id: source?.board_id ?? null,
      identities_sha256: source?.record_binding?.identities_sha256 ?? null,
    })),
  }));
}

/**
 * Derive one source's deployed parity result from the browse pages actually
 * fetched and the tracked index entry. Every field is derived — no constants.
 */
export function deriveBoardSourceResult({ boardId, browse, tracked }) {
  const pages = Array.isArray(browse?.pages) ? browse.pages : [];
  const rows = pages.flatMap((page) => (Array.isArray(page?.rows) ? page.rows : []));
  const availability = pages[0]?.availability ?? null;
  const totalMatches = Number.isFinite(pages[0]?.total_matches) ? pages[0].total_matches : null;
  const sourceStatus = browse?.communityBoardSourceStatus ?? null;
  const generatedAt = browse?.communityBoardGeneratedAt ?? null;

  const observed = pages.length > 0 && availability !== null && Array.isArray(pages[0]?.rows);
  const identities = rows.map(recordIdentity);
  const rowsBoundToBoard = rows.filter((row) => (
    row?.board_id === boardId && row?.source_record?.board_id === boardId
  )).length;
  const firstReceipt = rows.find((row) => row?.source_record?.receipt)?.source_record.receipt || null;
  const servedSourceUrl = firstReceipt?.source_url || null;
  const registeredSourceUrl = tracked?.source_url || null;
  const registeredMatchesServed = Boolean(registeredSourceUrl)
    && registeredSourceUrl === servedSourceUrl;

  let basis;
  if (!observed) basis = "not_observed";
  else if (availability === "unavailable") basis = "browse_unavailable";
  else if (!tracked) basis = "registered_source_url_missing";
  else if (!rows.length) basis = "no_records_served";
  else if (rowsBoundToBoard !== rows.length) basis = "board_binding_failed";
  else if (!registeredMatchesServed) basis = "registered_source_url_mismatch";
  else basis = "record_identity_binding";
  const recovered = basis === "record_identity_binding";

  const countParity = !Number.isFinite(tracked?.record_count) || totalMatches === null
    ? "unavailable"
    : (tracked.record_count === totalMatches ? "exact" : "differs");

  return {
    board_id: boardId,
    board_name: tracked?.board_name || rows[0]?.board_name || null,
    attempted: true,
    observed,
    recovered,
    recovery_basis: basis,
    deployed_read: {
      availability,
      source_status: sourceStatus,
      source_generated_at: generatedAt,
      total_matches: totalMatches,
      rows_examined: rows.length,
      pages_fetched: pages.length,
      truncated: Boolean(browse?.truncated),
    },
    registered_source_url: registeredSourceUrl,
    served_source_url: servedSourceUrl,
    registered_source_url_matches_served: observed && rows.length > 0 ? registeredMatchesServed : null,
    acquisition_observed_at: firstReceipt?.observed_at || null,
    tracked_record_count: Number.isFinite(tracked?.record_count) ? tracked.record_count : null,
    count_parity: countParity,
    record_binding: {
      assertion: "every examined deployed row carries this board's identity; digest covers all examined identities in served order",
      examined_row_count: rows.length,
      rows_bound_to_board: rowsBoundToBoard,
      identities,
      identities_count: identities.length,
      identities_sha256: boardIdentitiesDigest(identities),
      acquisition_receipt: firstReceipt ? {
        source_url: firstReceipt.source_url || null,
        observed_at: firstReceipt.observed_at || null,
        parser: firstReceipt.parser || null,
        fetch_status: firstReceipt.fetch_status ?? null,
        content_sha256: firstReceipt.content_sha256 || null,
      } : null,
    },
  };
}

export function deriveDeployedParityStatus({ sources_attempted, sources_observed, sources_recovered } = {}) {
  const expected = DEPLOYED_PARITY_BOARDS.length;
  if (sources_attempted !== expected || sources_observed !== expected) return "observation_incomplete";
  if (sources_recovered === 0) return "no_sources_recovered";
  if (sources_recovered === expected) return "all_sources_recovered";
  return "partial_recovery";
}

/**
 * Build a complete deployed parity observation from fetched deployed facts.
 * Status fields, counts, and digests are derived from those facts alone.
 */
export function buildBoardAcquisitionDeployedParityObservation({
  health,
  boardBrowses,
  trackedIndex,
  observedAt = new Date().toISOString(),
  runId,
  baseUrl = "https://api.cityscroll.org",
  originMainTip,
  commitIsAncestorOfOriginMain,
}) {
  const sources = DEPLOYED_PARITY_BOARDS.map((boardId) => deriveBoardSourceResult({
    boardId,
    browse: boardBrowses?.[boardId],
    tracked: trackedIndex?.boards?.[boardId] || null,
  }));
  const counts = {
    sources_attempted: sources.length,
    sources_observed: sources.filter((source) => source.observed).length,
    sources_recovered: sources.filter((source) => source.recovered).length,
  };
  const observation = {
    schema: BOARD_ACQUISITION_DEPLOYED_PARITY_SCHEMA,
    produced_by: "tools/capture_board_acquisition_deployed_parity.mjs",
    evidence_class: DEPLOYED_PARITY_EVIDENCE_CLASS,
    execution_environment: DEPLOYED_PARITY_EXECUTION_ENVIRONMENT,
    observed_at: observedAt,
    provenance: {
      kind: "deployed",
      transport: "public-internet",
      fetch_overridden: false,
      run_id: runId,
    },
    deployment: {
      base_url: baseUrl,
      health_path: "/health",
      read_path: "/hearings",
      health_response_status: Number.isFinite(health?.response_status) ? health.response_status : null,
      commit: health?.commit || null,
      environment: health?.environment || null,
      commit_shape_valid: /^[0-9a-f]{40}$/.test(health?.commit || ""),
      commit_ancestry_verified_against: "origin/main",
      commit_is_ancestor_of_origin_main: commitIsAncestorOfOriginMain === true,
      origin_main_tip_at_capture: originMainTip || null,
    },
    tracked_index: {
      path: "site/data/community_board_meeting_index.json",
      generated_at: trackedIndex?.generated_at || null,
      code_revision: trackedIndex?.code_revision || null,
    },
    counts,
    sources,
    status: deriveDeployedParityStatus(counts),
    evidence_binding: null,
  };
  observation.evidence_binding = {
    digest_input: "sha256 over canonical JSON of schema, observed_at, run_id, deployment commit, and per-source identities digests",
    digest: evidenceBindingDigest({
      schema: observation.schema,
      observedAt: observation.observed_at,
      runId: observation.provenance.run_id,
      commit: observation.deployment.commit,
      sources: observation.sources,
    }),
  };
  return observation;
}

/**
 * Validate a deployed parity observation against its own facts. Refuses a
 * payload whose sources carry only status and count (no identity binding), a
 * payload marked replay/rehearsal/isolated, an unproven deployment commit, and
 * any status, count, or digest that does not match what the payload itself
 * records.
 */
export function validateBoardAcquisitionDeployedParityObservation(observation, {
  expectedBoardCount = DEPLOYED_PARITY_BOARDS.length,
} = {}) {
  const errors = [];
  const push = (error) => errors.push(error);
  if (observation?.schema !== BOARD_ACQUISITION_DEPLOYED_PARITY_SCHEMA) push("schema");
  if (observation?.evidence_class !== DEPLOYED_PARITY_EVIDENCE_CLASS) push("evidence_class");
  if (observation?.execution_environment !== DEPLOYED_PARITY_EXECUTION_ENVIRONMENT) push("execution_environment");
  if (!parseableTimestamp(observation?.observed_at)) push("observed_at");

  const provenance = observation?.provenance;
  if (!DEPLOYED_PARITY_PROVENANCE_KINDS.includes(provenance?.kind)) push("provenance.kind");
  else if (provenance.kind !== "deployed") push("provenance.kind:not_deployed");
  if (provenance?.transport !== "public-internet") push("provenance.transport");
  if (provenance?.fetch_overridden !== false) push("provenance.fetch_overridden");
  if (!provenance?.run_id || typeof provenance.run_id !== "string") push("provenance.run_id");

  const deployment = observation?.deployment;
  if (!/^[0-9a-f]{40}$/.test(deployment?.commit || "")) push("deployment.commit");
  if (deployment?.commit_shape_valid !== true) push("deployment.commit_shape_valid");
  if (deployment?.commit_ancestry_verified_against !== "origin/main") push("deployment.commit_ancestry_verified_against");
  if (deployment?.commit_is_ancestor_of_origin_main !== true) push("deployment.commit_is_ancestor_of_origin_main");
  if (!/^[0-9a-f]{40}$/.test(deployment?.origin_main_tip_at_capture || "")) push("deployment.origin_main_tip_at_capture");

  const sources = Array.isArray(observation?.sources) ? observation.sources : [];
  if (sources.length !== expectedBoardCount) push("sources.length");
  const expectedBoards = [...DEPLOYED_PARITY_BOARDS].sort();
  const actualBoards = sources.map((source) => source?.board_id).sort();
  if (JSON.stringify(actualBoards) !== JSON.stringify(expectedBoards)) push("sources.board_ids");

  for (const source of sources) {
    const id = source?.board_id || "unknown";
    if (!DEPLOYED_PARITY_RECOVERY_BASES.includes(source?.recovery_basis)) push(`${id}:recovery_basis`);
    if (source?.attempted !== true) push(`${id}:attempted`);
    if (typeof source?.observed !== "boolean") push(`${id}:observed`);
    // Recompute recovery from the source's own recorded facts: a `recovered`
    // constant cannot survive this check.
    const claimsRecovered = source?.recovered === true;
    const binding = source?.record_binding;
    const bindingPresent = binding
      && Array.isArray(binding.identities)
      && binding.identities_count === binding.identities.length
      && binding.examined_row_count === binding.identities.length
      && binding.rows_bound_to_board === binding.identities.length
      && binding.identities.every(wellFormedIdentity);
    if (claimsRecovered && source?.recovery_basis !== "record_identity_binding") push(`${id}:recovered_basis_mismatch`);
    if (claimsRecovered && !bindingPresent) push(`${id}:record_binding`);
    if (claimsRecovered && !(binding?.identities_count >= 1)) push(`${id}:record_binding_empty`);
    // A basis that asserts no records were served cannot coexist with a
    // binding full of served identities — the contradiction a flipped
    // `recovered` flag leaves behind.
    const zeroRecordBasis = ["not_observed", "browse_unavailable", "no_records_served"].includes(source?.recovery_basis);
    if (zeroRecordBasis && (binding?.identities?.length ?? 0) > 0) push(`${id}:basis_record_contradiction`);
    if (!claimsRecovered && source?.recovery_basis === "record_identity_binding") push(`${id}:basis_without_recovery`);
    if (binding && Array.isArray(binding.identities)) {
      if (!SHA256_PATTERN.test(binding.identities_sha256 || "")) push(`${id}:identities_sha256_shape`);
      else if (boardIdentitiesDigest(binding.identities) !== binding.identities_sha256) push(`${id}:identities_sha256_mismatch`);
    }
    if (source?.recovered === true && source?.observed !== true) push(`${id}:recovered_without_observed`);
    if (claimsRecovered) {
      // The registered-source-url parity claim is checkable offline: all three
      // recorded URLs must agree for a source claimed recovered.
      const receiptUrl = source?.record_binding?.acquisition_receipt?.source_url || null;
      if (typeof source?.registered_source_url !== "string" || !source.registered_source_url.startsWith("https://")) push(`${id}:registered_source_url`);
      if (source?.registered_source_url_matches_served !== true) push(`${id}:registered_source_url_matches_served`);
      else if (source?.served_source_url !== source?.registered_source_url
        || receiptUrl !== source?.registered_source_url) push(`${id}:source_url_disagreement`);
    }
    if (!DEPLOYED_PARITY_COUNT_PARITY_STATES.includes(source?.count_parity)) push(`${id}:count_parity`);
  }

  const counts = observation?.counts;
  const recomputedCounts = {
    sources_attempted: sources.length,
    sources_observed: sources.filter((source) => source?.observed === true).length,
    sources_recovered: sources.filter((source) => source?.recovered === true).length,
  };
  if (counts?.sources_attempted !== expectedBoardCount) push("counts.sources_attempted");
  if (counts?.sources_attempted !== recomputedCounts.sources_attempted) push("counts.sources_attempted_mismatch");
  if (counts?.sources_observed !== recomputedCounts.sources_observed) push("counts.sources_observed_mismatch");
  if (counts?.sources_recovered !== recomputedCounts.sources_recovered) push("counts.sources_recovered_mismatch");

  const derivedStatus = deriveDeployedParityStatus(recomputedCounts);
  if (observation?.status !== derivedStatus) push("status_not_derived");
  if (!DEPLOYED_PARITY_STATUSES.includes(observation?.status)) push("status_vocabulary");

  const binding = observation?.evidence_binding;
  if (!SHA256_PATTERN.test(binding?.digest || "")) push("evidence_binding.digest_shape");
  else if (evidenceBindingDigest({
    schema: observation.schema,
    observedAt: observation.observed_at,
    runId: observation.provenance?.run_id,
    commit: observation.deployment?.commit,
    sources,
  }) !== binding.digest) push("evidence_binding.digest_mismatch");

  return { valid: errors.length === 0, errors: [...new Set(errors)].sort() };
}
