/**
 * Community Board / Borough President land-document bridge (LDP-12), extended
 * with a five-canonical-Borough-Board source registry and exact
 * recommendation edges (LDP-14).
 *
 * Measures exact land-identifier prevalence in the existing Community
 * Board and Borough President rows of `shared_meeting_read_model.json`,
 * then classifies each eligible row against the retained ZAP project
 * registry. Only a publisher-supplied ULURP token, ZAP project id, CEQR
 * key, or ZAP disposition id that exactly matches a retained ZAP row may
 * advance a row past `unresolved`. Title, address, meeting date, or board
 * identity alone never mint a land-project join.
 *
 * A successful exact subject join supports `considers` at most.
 * Recommendation/action edges additionally require an explicit
 * recommendation/action statement, a retained source document, and a
 * non-draft disposition; absent that, the row stays at the `considers`
 * tier or unresolved. See `site/land_project_decision_relations.mjs` for
 * the shared relation vocabulary this module reuses rather than
 * redefining.
 *
 * A Borough Board row is a city_record row that already satisfies
 * `isBoardOrBpRow` (it carries a Borough President agency) and additionally
 * names the Borough Board in its title. This is a body_kind sub-
 * classification of the same eligible corpus, not a second scraper or a
 * new source_system: the five canonical boards, their exact-identifier
 * extraction, and the recommendation/considers gate above are all reused
 * unchanged. See `measureBoroughBoardSources` and
 * `materializeBoroughBoardRecommendationEdge`.
 */

import { createHash } from "node:crypto";

import { extractUlurpKeys } from "../../site/ulurp_tokens.mjs";
import { boroughBoardIdentity, REVIEWED_BOROUGH_BOARDS } from "../../site/borough_board_identity.mjs";
import {
  classifyLandRecommendationRelation,
  LAND_PROJECT_RELATION_VOCABULARY,
} from "../../site/land_project_decision_relations.mjs";
import { normalizeCeqrKey } from "./ceqr_project_milestone_reconciliation.mjs";

export const BOARD_BP_LAND_BRIDGE_SCHEMA = "cityscroll.board_bp_land_bridge_measurement.v1";
export const CONSIDERS_EDGE_SCHEMA = "cityscroll.board_bp_considers_project_edge.v1";
export const BOROUGH_BOARD_SOURCE_REGISTRY_SCHEMA = "cityscroll.borough_board_source_registry.v1";
export const BOROUGH_BOARD_RECOMMENDATION_EDGE_SCHEMA = "cityscroll.borough_board_recommendation_edge.v1";
export const USEFULNESS_THRESHOLD = 0.3;

export const JOIN_METHODS = Object.freeze({
  EXACT_ULURP_TOKEN: "exact_ulurp_token",
  EXACT_ZAP_PROJECT_ID: "exact_zap_project_id",
  EXACT_CEQR_KEY: "exact_ceqr_key",
  EXACT_DISPOSITION_ID: "exact_disposition_id",
});

export const REJECTION_REASONS = Object.freeze({
  NOT_ELIGIBLE: "not_board_or_bp",
  NO_REFERENCE: "no_reference",
  NO_EXACT_LAND_KEY: "no_exact_land_key",
  AMBIGUOUS_KEY: "ambiguous_key",
});

const ZAP_PROJECT_ID_RE = /\b(?:19|20)\d{2}[A-Z]\d{4}\b/g;
const CEQR_CANDIDATE_RE = /\b\d{2}[A-Z]{2,6}\d{2,4}[A-Z]\b|\b\d{2}-\d{3}[A-Z]\b/g;
const DISPOSITION_ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const BP_AGENCY_RE = /(?:Borough President\s*-?\s*|Office of the Borough President of\s*)(Bronx|Brooklyn|Manhattan|Queens|Staten Island)/i;
const EXPLICIT_ACTION_RE = /\b(recommends?|recommendation|adopts?|adopted|approved|approves?|rejects?|rejected|disapproved|denied|favorable|unfavorable|conditional[- ]favorable)\b/i;
const DRAFT_STATUS_RE = /^draft$/i;

function clean(value) {
  return String(value ?? "").trim();
}

/** Community Board rows are eligible by source; Borough President rows are
 * identified the same way the retired non-Council collector identified them
 * (see `warehouse/scripts/non_council_outcomes.mjs#bodyIdForNotice`). */
export function isBoardOrBpRow(row = {}) {
  if (row.source_system === "community_board") return true;
  if (row.source_system === "city_record" && BP_AGENCY_RE.test(clean(row.agency_name || row.agency))) {
    return true;
  }
  return false;
}

function rowHaystack(row = {}) {
  const parts = [row.title, row.search_text, row.description, row.short_title];
  for (const document of row.meeting_documents || []) {
    parts.push(document?.title, document?.document_url, document?.publisher_document_id);
  }
  return parts.filter(Boolean).map(String).join(" \n ");
}

/**
 * Build the retained-ZAP exact-key registry a candidate row is measured
 * against. `zapRows` is the committed `zap_projects_warehouse_lookup.json`
 * row set; `dispositionsByProject` is the committed
 * `land_default_ulurp.json` outcomes.by_project map.
 */
export function buildZapKeyRegistry(zapRows = [], dispositionsByProject = {}) {
  const byUlurp = new Map();
  const byProjectId = new Map();
  const byCeqr = new Map();
  const byDispositionId = new Map();
  const draftDispositionIds = new Set();
  const dispositionStatusesByProject = new Map();

  for (const row of zapRows || []) {
    const projectId = clean(row?.project_id);
    if (!projectId) continue;
    byProjectId.set(projectId, projectId);
    for (const key of extractUlurpKeys(row.ulurp_numbers)) {
      if (!byUlurp.has(key)) byUlurp.set(key, new Set());
      byUlurp.get(key).add(projectId);
    }
    const ceqrKey = normalizeCeqrKey(row.ceqr_number);
    if (ceqrKey) {
      if (!byCeqr.has(ceqrKey)) byCeqr.set(ceqrKey, new Set());
      byCeqr.get(ceqrKey).add(projectId);
    }
  }

  for (const [projectId, entry] of Object.entries(dispositionsByProject || {})) {
    for (const disposition of entry?.dispositions || []) {
      const isDraft = DRAFT_STATUS_RE.test(clean(disposition?.status));
      if (!dispositionStatusesByProject.has(projectId)) dispositionStatusesByProject.set(projectId, []);
      dispositionStatusesByProject.get(projectId).push(isDraft);
      const id = clean(disposition?.id).toLowerCase();
      if (!id) continue;
      if (!byDispositionId.has(id)) byDispositionId.set(id, new Set());
      byDispositionId.get(id).add(projectId);
      if (isDraft) draftDispositionIds.add(id);
    }
  }

  return { byUlurp, byProjectId, byCeqr, byDispositionId, draftDispositionIds, dispositionStatusesByProject };
}

/** True only when every known disposition for a project is a draft row, or none is known. */
function isDraftDispositionOnlyProject(registry, projectId) {
  const statuses = registry.dispositionStatusesByProject.get(projectId);
  return Boolean(statuses?.length) && statuses.every(Boolean);
}

function candidateKeysForRow(haystack, registry) {
  const candidates = [];
  for (const key of extractUlurpKeys(haystack)) {
    const projectIds = registry.byUlurp.get(key);
    if (projectIds?.size) candidates.push({ method: JOIN_METHODS.EXACT_ULURP_TOKEN, key, project_ids: [...projectIds] });
  }
  for (const match of haystack.toUpperCase().matchAll(ZAP_PROJECT_ID_RE)) {
    const key = match[0];
    if (registry.byProjectId.has(key)) candidates.push({ method: JOIN_METHODS.EXACT_ZAP_PROJECT_ID, key, project_ids: [key] });
  }
  for (const token of haystack.match(CEQR_CANDIDATE_RE) || []) {
    const key = normalizeCeqrKey(token);
    const projectIds = key ? registry.byCeqr.get(key) : null;
    if (projectIds?.size) candidates.push({ method: JOIN_METHODS.EXACT_CEQR_KEY, key, project_ids: [...projectIds] });
  }
  for (const match of haystack.toLowerCase().matchAll(DISPOSITION_ID_RE)) {
    const key = match[0];
    const projectIds = registry.byDispositionId.get(key);
    if (projectIds?.size) {
      candidates.push({
        method: JOIN_METHODS.EXACT_DISPOSITION_ID,
        key,
        project_ids: [...projectIds],
        draft: registry.draftDispositionIds.has(key),
      });
    }
  }
  return candidates;
}

/**
 * Classify one board/BP row's exact-land-identifier eligibility.
 * Similarity, title, address, or meeting-date signals are never join
 * inputs; only a candidate key present in the retained ZAP registry can
 * advance a row past `unresolved`.
 */
export function classifyBoardBpRow(row = {}, registry) {
  if (!isBoardOrBpRow(row)) {
    return { status: "not_eligible", reason: REJECTION_REASONS.NOT_ELIGIBLE, candidates: [] };
  }
  const haystack = rowHaystack(row);
  if (!haystack.trim()) {
    return { status: "rejected", reason: REJECTION_REASONS.NO_REFERENCE, candidates: [] };
  }
  const candidates = candidateKeysForRow(haystack, registry);
  if (!candidates.length) {
    return { status: "unresolved", reason: REJECTION_REASONS.NO_EXACT_LAND_KEY, candidates: [] };
  }
  const projectIdSet = new Set(candidates.flatMap((candidate) => candidate.project_ids));
  if (projectIdSet.size > 1) {
    return { status: "rejected", reason: REJECTION_REASONS.AMBIGUOUS_KEY, candidates };
  }
  const projectId = [...projectIdSet][0];
  return {
    status: "matched",
    reason: null,
    project_id: projectId,
    candidates,
    draft_disposition_only: isDraftDispositionOnlyProject(registry, projectId),
  };
}

/**
 * Whether a matched row also carries recommendation/action evidence:
 * explicit action wording, a retained source document, and no draft-only
 * disposition. A `considers`-tier match without this evidence never
 * promotes to a recommendation edge (LDP-12 negative rule).
 */
export function recommendationEvidence(row = {}, classification) {
  if (classification?.status !== "matched") {
    return { eligible: false, reason: "not_matched" };
  }
  if (classification.draft_disposition_only) {
    return { eligible: false, reason: "draft_only" };
  }
  const haystack = rowHaystack(row);
  if (!EXPLICIT_ACTION_RE.test(haystack)) {
    return { eligible: false, reason: "explicit_action_language_absent" };
  }
  const document = (row.meeting_documents || []).find((entry) => clean(entry?.document_url));
  if (!document) {
    return { eligible: false, reason: "retained_document_missing" };
  }
  return { eligible: true, reason: null, document_url: clean(document.document_url) };
}

/** Build the `considers` edge for one matched row (materialized only when the gate is GO). */
export function materializeConsidersEdge(row = {}, classification) {
  if (classification?.status !== "matched") return null;
  const primary = classification.candidates[0];
  return Object.freeze({
    schema: CONSIDERS_EDGE_SCHEMA,
    relation: "considers",
    is_decision: false,
    from: clean(row.meeting_id),
    to: `project:${classification.project_id}`,
    project_id: classification.project_id,
    provenance: Object.freeze({
      source_system: row.source_system,
      source_record_id: clean(row.request_id || row.publisher_identifier || row.meeting_id),
      source_url: clean(row.source_url) || null,
      join_key: primary.key,
      join_method: primary.method,
      observed_at: clean(row.event_date) || null,
    }),
    negative_rule: "Exact subject identity supports considers at most; it is never a recommendation or decision.",
  });
}

// ---------------------------------------------------------------------------
// LDP-14: five canonical Borough Board source registry and exact
// recommendation edges. This extends the classification and evidence gates
// already defined above; it adds no new fetch path and no second scraper.
// ---------------------------------------------------------------------------

export const BOROUGH_BOARD_TITLE_RE = /\bBorough Board\b/i;

export const BOROUGH_BOARD_SOURCE_STATUS = Object.freeze({
  SUPPORTED: "supported",
  INVENTORY_ONLY: "inventory_only",
  UNAVAILABLE: "unavailable",
});

/**
 * The observed, non-guessed publication channel for Borough Board notices:
 * a City Record filing under the borough's Borough President agency whose
 * title explicitly names the Borough Board. No per-board website is
 * invented; a board with no observed row stays inventory_only rather than
 * carry a guessed URL.
 */
export const BOROUGH_BOARD_OFFICIAL_PATTERN = Object.freeze({
  channel: "city_record",
  publisher: "City Record",
  agency_pattern: BP_AGENCY_RE.source,
  title_pattern: BOROUGH_BOARD_TITLE_RE.source,
  source_domain: "a856-cityrecord.nyc.gov",
  basis: "observed_publication_pattern",
});

/**
 * Sub-classify an already-eligible board/BP row's body kind. This is source
 * identity, not action inference: it never decides whether a row carries a
 * recommendation, only which body's official channel produced it.
 */
export function boardBpBodyKind(row = {}) {
  if (row.source_system === "community_board") return "community_board";
  if (row.source_system === "city_record") {
    const agencyMatch = clean(row.agency_name || row.agency).match(BP_AGENCY_RE);
    if (!agencyMatch) return null;
    return BOROUGH_BOARD_TITLE_RE.test(rowHaystack(row)) ? "borough_board" : "borough_president";
  }
  return null;
}

/** Canonical `borough-board:<slug>` ref for a row classified borough_board, else null. */
export function boroughBoardRefForRow(row = {}) {
  if (boardBpBodyKind(row) !== "borough_board") return null;
  const agencyMatch = clean(row.agency_name || row.agency).match(BP_AGENCY_RE);
  const identity = agencyMatch ? boroughBoardIdentity(agencyMatch[1]) : null;
  return identity ? identity.id : null;
}

/**
 * Tri-state source status. `hasOfficialPattern` is a parameter (rather than
 * always true) so the unavailable branch stays reachable and testable
 * without fabricating a board that does not exist.
 */
export function boroughBoardSourceStatus(observedCount, hasOfficialPattern = true) {
  if (!hasOfficialPattern) return BOROUGH_BOARD_SOURCE_STATUS.UNAVAILABLE;
  return observedCount > 0 ? BOROUGH_BOARD_SOURCE_STATUS.SUPPORTED : BOROUGH_BOARD_SOURCE_STATUS.INVENTORY_ONLY;
}

function boroughBoardRowReceipt(ref, row) {
  const sourceRecordId = clean(row.request_id || row.publisher_identifier || row.meeting_id) || null;
  const sourceUrl = clean(row.source_url) || null;
  const vintage = clean(row.event_date) || null;
  return Object.freeze({
    source_record_id: sourceRecordId,
    source_url: sourceUrl,
    checked_at: clean(row.source_receipt?.observed_at) || null,
    vintage,
    content_hash: createHash("sha256")
      .update(`${ref}\n${sourceRecordId || ""}\n${sourceUrl || ""}\n${vintage || ""}\n${clean(row.title)}`)
      .digest("hex"),
  });
}

/**
 * Measure explicit supported/inventory-only/unavailable source status for
 * each of the five canonical Borough Boards from the already-eligible
 * board/BP rows. Never fetches; never guesses a per-board URL. A board with
 * zero observed rows stays inventory_only, not absent.
 */
export function measureBoroughBoardSources({ rows = [], generatedAt } = {}) {
  if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("generatedAt must be an ISO timestamp");
  }
  const byRef = new Map();
  for (const row of rows) {
    const ref = boroughBoardRefForRow(row);
    if (!ref) continue;
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push(row);
  }
  const sources = REVIEWED_BOROUGH_BOARDS.map((board) => {
    const observedRows = byRef.get(board.id) || [];
    const receipts = observedRows.map((row) => boroughBoardRowReceipt(board.id, row));
    return Object.freeze({
      body_ref: board.id,
      borough: board.borough,
      official_url: receipts[0]?.source_url || null,
      official_pattern: BOROUGH_BOARD_OFFICIAL_PATTERN,
      status: boroughBoardSourceStatus(observedRows.length, true),
      checked_at: generatedAt,
      observed_count: observedRows.length,
      receipts: Object.freeze(receipts),
    });
  });
  return {
    schema: BOROUGH_BOARD_SOURCE_REGISTRY_SCHEMA,
    generated_at: generatedAt,
    coverage: {
      canonical_boards: sources.length,
      supported: sources.filter((source) => source.status === BOROUGH_BOARD_SOURCE_STATUS.SUPPORTED).length,
      inventory_only: sources.filter((source) => source.status === BOROUGH_BOARD_SOURCE_STATUS.INVENTORY_ONLY).length,
      unavailable: sources.filter((source) => source.status === BOROUGH_BOARD_SOURCE_STATUS.UNAVAILABLE).length,
    },
    sources,
  };
}

/**
 * Materialize a Borough Board `issues_recommendation` edge for one matched
 * row. Requires everything `recommendationEvidence` already requires (exact
 * identifier, explicit action wording, retained document, non-draft
 * disposition) plus the shared relation vocabulary's own evidence-
 * completeness gate. Returns null for any row that is not
 * body_kind=borough_board, or that fails either gate -- an affected role, a
 * draft disposition, or a title alone never produces this edge.
 */
export function materializeBoroughBoardRecommendationEdge(row = {}, classification) {
  const boroughBoardRef = boroughBoardRefForRow(row);
  if (!boroughBoardRef) return null;
  const evidence = recommendationEvidence(row, classification);
  if (!evidence.eligible) return null;
  const primary = classification.candidates[0];
  const classified = classifyLandRecommendationRelation({
    source_record: clean(row.request_id || row.publisher_identifier || row.meeting_id),
    join_key: primary.method,
    join_value: primary.key,
    source_fields: ["title", "search_text"],
    method: primary.method,
    method_version: "1",
    observed_time: clean(row.event_date) || null,
    document_url: evidence.document_url,
  });
  if (!classified.accepted) return null;
  return Object.freeze({
    schema: BOROUGH_BOARD_RECOMMENDATION_EDGE_SCHEMA,
    relation: LAND_PROJECT_RELATION_VOCABULARY.issues_recommendation.id,
    family: classified.family,
    is_decision: classified.is_decision,
    from: boroughBoardRef,
    to: `project:${classification.project_id}`,
    project_id: classification.project_id,
    provenance: Object.freeze({
      source_system: row.source_system,
      source_record_id: classified.evidence.source_record,
      source_url: clean(row.source_url) || null,
      document_url: classified.evidence.document_url,
      join_key: classified.evidence.join_key,
      join_value: classified.evidence.join_value,
      method: classified.evidence.method,
      method_version: classified.evidence.method_version,
      observed_time: classified.evidence.observed_time,
    }),
    negative_rule: LAND_PROJECT_RELATION_VOCABULARY.issues_recommendation.negative_rule,
  });
}

function tally(rows, key) {
  const counts = {};
  for (const row of rows) {
    const value = row[key];
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

/**
 * Measure exact land-identifier coverage across the board/BP corpus and
 * produce a versioned receipt. Edges materialize only when both the row
 * count and the measured rate clear `USEFULNESS_THRESHOLD`; otherwise the
 * receipt is an honest stop receipt and no edge is returned.
 */
export function measureBoardBpLandBridge({
  rows = [],
  zapRows = [],
  dispositionsByProject = {},
  generatedAt,
  sourceVintage = {},
} = {}) {
  if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("generatedAt must be an ISO timestamp");
  }
  const registry = buildZapKeyRegistry(zapRows, dispositionsByProject);
  const eligible = rows.filter(isBoardOrBpRow);
  const classified = eligible.map((row) => ({ row, classification: classifyBoardBpRow(row, registry) }));

  const matched = classified.filter((entry) => entry.classification.status === "matched");
  const unresolved = classified.filter((entry) => entry.classification.status === "unresolved");
  const rejected = classified.filter((entry) => entry.classification.status === "rejected");

  const recommendationCandidates = matched
    .map((entry) => ({ ...entry, evidence: recommendationEvidence(entry.row, entry.classification) }))
    .filter((entry) => entry.evidence.eligible);

  const rate = eligible.length ? matched.length / eligible.length : 0;
  const aboveThreshold = eligible.length > 0 && rate >= USEFULNESS_THRESHOLD;
  const gate = matched.length > 0 && aboveThreshold ? "GO" : "STOP";

  const precisionSample = matched.slice(0, 10).map((entry) => ({
    meeting_id: entry.row.meeting_id,
    source_system: entry.row.source_system,
    project_id: entry.classification.project_id,
    join_method: entry.classification.candidates[0]?.method,
    join_key: entry.classification.candidates[0]?.key,
    source_url: entry.row.source_url || null,
  }));

  const materializedEdges = gate === "GO"
    ? matched.flatMap((entry) => {
      const recommendationEdge = materializeBoroughBoardRecommendationEdge(entry.row, entry.classification);
      if (recommendationEdge) return [recommendationEdge];
      const considersEdge = materializeConsidersEdge(entry.row, entry.classification);
      return considersEdge ? [considersEdge] : [];
    })
    : [];

  const boroughBoardSources = measureBoroughBoardSources({ rows: eligible, generatedAt });

  return {
    schema: BOARD_BP_LAND_BRIDGE_SCHEMA,
    generated_at: generatedAt,
    source_vintage: sourceVintage,
    join_measurement: {
      strategy: "exact_ulurp_token | exact_zap_project_id | exact_ceqr_key | exact_disposition_id",
      usefulness_threshold: USEFULNESS_THRESHOLD,
      rates: {
        exact_land_identifier: {
          joined: matched.length,
          total: eligible.length,
          rate: Number(rate.toFixed(6)),
        },
      },
      verdict: gate === "GO"
        ? `Above usefulness threshold (>=${Math.round(USEFULNESS_THRESHOLD * 100)}%). Ship considers-tier edge materialization.`
        : `Below usefulness threshold (${(rate * 100).toFixed(2)}%). The board/BP land-document bridge stays disabled; the retired broad bridge stays disabled.`,
    },
    coverage: {
      eligible_rows: eligible.length,
      eligible_community_board_rows: eligible.filter((row) => row.source_system === "community_board").length,
      eligible_borough_president_rows: eligible.filter((row) => row.source_system === "city_record").length,
      eligible_borough_board_rows: eligible.filter((row) => boardBpBodyKind(row) === "borough_board").length,
      matched: matched.length,
      unresolved: unresolved.length,
      rejected: rejected.length,
      unresolved_reasons: tally(unresolved.map((entry) => entry.classification), "reason"),
      rejected_reasons: tally(rejected.map((entry) => entry.classification), "reason"),
      recommendation_candidates: recommendationCandidates.length,
    },
    precision_sample: precisionSample,
    gate: {
      result: gate,
      thresholds: { minimum_matches: 1, minimum_rate: USEFULNESS_THRESHOLD },
      rationale: gate === "GO"
        ? `${matched.length} of ${eligible.length} eligible rows (${(rate * 100).toFixed(2)}%) carry a retained exact land identifier.`
        : `${matched.length} of ${eligible.length} eligible rows (${(rate * 100).toFixed(2)}%) carry a retained exact land identifier; below the ${Math.round(USEFULNESS_THRESHOLD * 100)}% usefulness bar. The prior broad body+date+matter bridge (warehouse/scripts/non_council_outcomes.mjs) remains disabled independently of this result.`,
      resident_ingestion_committed: false,
      prior_broad_bridge_reactivated: false,
    },
    materialized_edges: materializedEdges,
    borough_board_sources: boroughBoardSources,
    honest_absent: gate === "STOP",
  };
}
