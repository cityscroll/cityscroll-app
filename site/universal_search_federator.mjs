/**
 * Pure rank-and-merge boundary for universal search.
 *
 * Each lens remains responsible for retrieval, civic-object classification,
 * and literal match evidence. The federator validates those immutable
 * SearchDocuments, calibrates only their local order, and preserves source
 * observations on every match edge.
 */

import { admitSearchDocument } from "./search_document_contract.mjs";

export const UNIVERSAL_SEARCH_FEDERATOR_SCHEMA =
  "cityscroll.universal_search_federator.v1";
export const UNIVERSAL_SEARCH_RESULT_SCHEMA =
  "cityscroll.universal_search_result.v1";
export const UNIVERSAL_SEARCH_COVERAGE_SCHEMA =
  "cityscroll.universal_search_coverage.v1";

export const UNIVERSAL_SEARCH_LENS_IDS = Object.freeze([
  "notices",
  "people",
  "agencies",
  "vendors",
  "committees",
  "community_boards",
  "exams",
  "parcels",
]);

const COVERAGE_STATES = new Set([
  "matched",
  "empty",
  "partial",
  "not_indexed",
  "provider_unavailable",
]);

const TYPE_WEIGHTS = Object.freeze({
  procurement: 1,
  rulemaking: 1,
  meeting: 1,
  mandate: 1,
  land_use_project: 1,
  person: 1,
  official: 1,
  agency: 1,
  vendor: 1,
  committee: 1,
  community_board: 1,
  civil_service_exam: 1,
  parcel: 1,
  // Evidence-only notices remain findable without outranking a canonical
  // civic object solely because their local corpus was smaller.
  unclassified: 0.92,
});

const FIELD_WEIGHTS = Object.freeze({
  identifier: 1.12,
  exam_number: 1.12,
  bbl: 1.12,
  title: 1.1,
  display_name: 1.1,
  name: 1.1,
  alias: 1.06,
  address: 1.06,
  summary: 1.02,
  description: 1,
  notice_text: 1,
  attachment_text: 1,
  search_text: 1,
});

const LIFECYCLE_WEIGHTS = Object.freeze({
  active: 1.02,
  current: 1.02,
  open: 1.02,
  scheduled: 1.02,
  upcoming: 1.02,
  archived: 0.98,
  closed: 0.98,
  expired: 0.98,
  past: 0.98,
  unknown: 1,
});

export const UNIVERSAL_SEARCH_RANKING_POLICY = deepFreeze({
  id: "cityscroll.cross_lens_rank.v1",
  local_score_direction: "lower_is_better",
  local_calibration: "reciprocal_rank_within_lens",
  formula: "local_rank_score * type_weight * field_weight * lifecycle_weight",
  type_weights: TYPE_WEIGHTS,
  field_weights: FIELD_WEIGHTS,
  lifecycle_weights: LIFECYCLE_WEIGHTS,
  tie_break: [
    "calibrated_score_desc",
    "entity_type_asc",
    "stable_key_asc",
    "lens_asc",
  ],
});

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze));
  if (!plainObject(value)) return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, deepFreeze(nested)]),
  ));
}

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Conservative query normalization shared by every participating lens. */
export function normalizeUniversalSearchQuery(value) {
  return clean(value, 500)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function nullableCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function normalizedMatchFields(value, document) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 40) return null;
  const sourceRefs = new Set(document.source_observation_refs || []);
  const fields = [];
  for (const match of value) {
    const field = clean(match?.field, 80).toLocaleLowerCase("en-US");
    const matchedTerm = clean(match?.matched_term, 240).toLocaleLowerCase("en-US");
    const sourceRef = clean(match?.source_observation_ref, 240);
    if (!field || !matchedTerm || !sourceRefs.has(sourceRef)) return null;
    fields.push({
      field,
      matched_term: matchedTerm,
      source_observation_ref: sourceRef,
    });
  }
  return deepFreeze(fields);
}

function lifecycleState(document) {
  const lifecycle = document?.provenance?.lifecycle || {};
  const candidates = [
    lifecycle.state,
    lifecycle.schedule_status,
    lifecycle.status,
  ].map((value) => clean(value, 80).toLocaleLowerCase("en-US"));
  return candidates.find((value) => Object.hasOwn(LIFECYCLE_WEIGHTS, value)) || "unknown";
}

function fieldWeight(matchFields) {
  return Math.max(...matchFields.map((match) => FIELD_WEIGHTS[match.field] || 1));
}

function candidateTieKey(candidate) {
  return [
    candidate.document.object_ref,
    candidate.document.object_type,
    JSON.stringify(candidate.match_fields),
  ].join("|");
}

function compareLocal(left, right) {
  return left.local_score - right.local_score
    || candidateTieKey(left).localeCompare(candidateTieKey(right), "en-US");
}

function prepareCandidates(rawCandidates, lensId, method) {
  const valid = [];
  let invalidCount = 0;
  for (const raw of Array.isArray(rawCandidates) ? rawCandidates : []) {
    const outcome = raw?.document?.outcome === "evidence_only" ? "evidence_only" : "indexed";
    const admitted = admitSearchDocument(raw?.document, { outcome });
    const localScore = Number(raw?.local_score);
    if (!admitted.document || !Number.isFinite(localScore)) {
      invalidCount += 1;
      continue;
    }
    const matchFields = normalizedMatchFields(raw?.match_fields, admitted.document);
    if (!matchFields) {
      invalidCount += 1;
      continue;
    }
    valid.push({
      document: admitted.document,
      outcome,
      lens: lensId,
      local_score: localScore,
      local_score_kind: method,
      match_fields: matchFields,
    });
  }

  valid.sort(compareLocal);
  return {
    candidates: valid.map((candidate, index) => {
      const localRank = index + 1;
      const localRankScore = 1 / localRank;
      const typeWeight = TYPE_WEIGHTS[candidate.document.object_type] || 1;
      const bestFieldWeight = fieldWeight(candidate.match_fields);
      const state = lifecycleState(candidate.document);
      const lifecycleWeight = LIFECYCLE_WEIGHTS[state];
      return {
        ...candidate,
        local_rank: localRank,
        local_rank_score: localRankScore,
        type_weight: typeWeight,
        field_weight: bestFieldWeight,
        lifecycle_state: state,
        lifecycle_weight: lifecycleWeight,
        calibrated_score: localRankScore * typeWeight * bestFieldWeight * lifecycleWeight,
      };
    }),
    invalidCount,
  };
}

function missingCoverage(lensId) {
  return deepFreeze({
    lens: lensId,
    participated: false,
    state: "not_indexed",
    reason: "lens_provider_not_registered",
    matched_count: null,
    candidate_count: null,
    invalid_candidate_count: null,
    indexed_count: null,
    as_of: null,
    source: null,
    method: null,
  });
}

function unavailableCoverage(lensId) {
  return deepFreeze({
    lens: lensId,
    participated: true,
    state: "provider_unavailable",
    reason: "lens_provider_failed",
    matched_count: null,
    candidate_count: null,
    invalid_candidate_count: null,
    indexed_count: null,
    as_of: null,
    source: null,
    method: null,
  });
}

async function queryLens(lensId, provider, query, tokens, limit) {
  if (!provider || typeof provider.search !== "function") {
    return { candidates: [], coverage: missingCoverage(lensId) };
  }
  try {
    const response = await provider.search({ query, tokens, limit });
    const declared = plainObject(response?.coverage) ? response.coverage : {};
    const method = clean(declared.method, 120) || "unknown";
    const prepared = prepareCandidates(response?.candidates, lensId, method);
    let state = COVERAGE_STATES.has(declared.state) ? declared.state : "partial";
    if (prepared.invalidCount > 0 && !["not_indexed", "provider_unavailable"].includes(state)) {
      state = "partial";
    }
    if (prepared.candidates.length > 0 && state === "empty") state = "partial";
    return {
      candidates: prepared.candidates,
      coverage: deepFreeze({
        lens: lensId,
        participated: true,
        state,
        reason: clean(declared.reason, 240)
          || (prepared.invalidCount ? "one_or_more_candidates_failed_admission" : null),
        matched_count: prepared.candidates.length,
        candidate_count: Array.isArray(response?.candidates) ? response.candidates.length : 0,
        invalid_candidate_count: prepared.invalidCount,
        indexed_count: nullableCount(declared.indexed_count),
        as_of: clean(declared.as_of, 80) || null,
        source: clean(declared.source, 240) || null,
        method,
      }),
    };
  } catch {
    return { candidates: [], coverage: unavailableCoverage(lensId) };
  }
}

function compareGlobal(left, right) {
  return right.calibrated_score - left.calibrated_score
    || left.document.object_type.localeCompare(right.document.object_type, "en-US")
    || left.document.object_ref.localeCompare(right.document.object_ref, "en-US")
    || left.lens.localeCompare(right.lens, "en-US");
}

function matchEdge(candidate) {
  return deepFreeze({
    lens: candidate.lens,
    local_score: candidate.local_score,
    local_score_kind: candidate.local_score_kind,
    match_fields: candidate.match_fields,
    source_observation_refs: candidate.document.source_observation_refs,
    document_producer: candidate.document.provenance.producer,
  });
}

function mergeByStableIdentity(candidates) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = candidate.document.object_ref;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  return [...groups.values()].map((group) => {
    group.sort(compareGlobal);
    return { winner: group[0], matches: group.map(matchEdge) };
  });
}

function rounded(value) {
  return Number(value.toFixed(6));
}

/**
 * Query every registered lens concurrently and return one deterministic set.
 * Provider failures are isolated and represented in coverage; they never turn
 * a successful lens into an empty response.
 */
export async function federateUniversalSearch({ query, lenses = {}, limit = 40 } = {}) {
  const normalized = normalizeUniversalSearchQuery(query);
  const tokens = normalized ? normalized.split(/\s+/) : [];
  const boundedLimit = Math.max(0, Math.min(100, Number(limit) || 0));
  const queried = await Promise.all(UNIVERSAL_SEARCH_LENS_IDS.map((lensId) => (
    queryLens(lensId, lenses?.[lensId], normalized, tokens, boundedLimit)
  )));
  const coverageByLens = Object.fromEntries(UNIVERSAL_SEARCH_LENS_IDS.map((lensId, index) => (
    [lensId, queried[index].coverage]
  )));
  const merged = mergeByStableIdentity(queried.flatMap((result) => result.candidates));
  merged.sort((left, right) => compareGlobal(left.winner, right.winner));
  const maxScore = Math.max(0, ...merged.map(({ winner }) => winner.calibrated_score));

  const results = merged.slice(0, boundedLimit).map(({ winner, matches }, index) => {
    const document = winner.document;
    const matchedLenses = UNIVERSAL_SEARCH_LENS_IDS.filter((lensId) => (
      matches.some((match) => match.lens === lensId)
    ));
    return deepFreeze({
      ...document,
      outcome: winner.outcome,
      result_schema: UNIVERSAL_SEARCH_RESULT_SCHEMA,
      entity_type: document.object_type,
      stable_key: document.object_ref,
      lens: winner.lens,
      source_route: document.canonical_href,
      local_score: winner.local_score,
      local_score_kind: winner.local_score_kind,
      local_rank: winner.local_rank,
      normalized_rank: maxScore ? rounded(winner.calibrated_score / maxScore) : 0,
      rank: index + 1,
      match_fields: winner.match_fields,
      matched_lenses: matchedLenses,
      ranking: {
        policy: UNIVERSAL_SEARCH_RANKING_POLICY.id,
        local_rank_score: rounded(winner.local_rank_score),
        type_weight: winner.type_weight,
        field_weight: winner.field_weight,
        lifecycle_state: winner.lifecycle_state,
        lifecycle_weight: winner.lifecycle_weight,
        calibrated_score: rounded(winner.calibrated_score),
      },
      edge_provenance: {
        document_producer: document.provenance.producer,
        source_observation_refs: document.source_observation_refs,
        matches,
      },
      handoff: {
        query: normalized,
        lens: winner.lens,
        entity_type: document.object_type,
        domain: document.domain,
        canonical_href: document.canonical_href,
      },
    });
  });

  const coverageRows = Object.values(coverageByLens);
  return deepFreeze({
    schema: UNIVERSAL_SEARCH_FEDERATOR_SCHEMA,
    query: { normalized, tokens },
    ranking_policy: UNIVERSAL_SEARCH_RANKING_POLICY,
    results,
    coverage: {
      schema: UNIVERSAL_SEARCH_COVERAGE_SCHEMA,
      all_lenses_participated: coverageRows.every((row) => row.participated),
      total_matches: merged.length,
      returned_count: results.length,
      by_lens: coverageByLens,
    },
  });
}
