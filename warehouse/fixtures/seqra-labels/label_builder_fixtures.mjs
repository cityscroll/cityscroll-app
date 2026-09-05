/**
 * SEQRA-08 fixtures: a small synthetic corpus of reviews spanning every
 * behavior the label-builder card must prove -- a resubmission sharing a
 * BBL with an earlier review (project-family disjointness), a review still
 * open with no classifying milestone (target A's own "unknown_or_incomplete"
 * category), a review whose supplemental-review horizons split across
 * observed and not-yet-observed (right-censoring), and one review wired all
 * the way through SEQRA-06's spatial/implementation joins and SEQRA-07's
 * public-position builder, reusing their own retained fixtures rather than
 * re-authoring parallel data.
 *
 * Synthetic identity fixtures, not claims about real reviews or projects.
 */
import { buildActionKey, buildDeterminationKey, buildEnvironmentalReviewKey } from "../../lib/seqra_stable_keys.mjs";
import { buildReviewEventKey } from "../../lib/seqra_review_event_log.mjs";
import { buildProjectBblHistory } from "../../lib/seqra_bbl_lot_history.mjs";
import { buildImplementationEvent } from "../../lib/seqra_implementation_remedy_projection.mjs";
import { resolveOrganization } from "../../lib/seqra_actor_resolution.mjs";
import { buildPublicPosition, DEFAULT_SUPPRESSION_RULE } from "../../lib/seqra_public_position_builder.mjs";
import {
  DETERMINATION_DATE as SPATIAL_DETERMINATION_DATE,
  DETERMINATION_KEY as SPATIAL_DETERMINATION_KEY,
  ORIGINAL_BBL as SPATIAL_ORIGINAL_BBL,
  PROJECT_KEY as SPATIAL_PROJECT_KEY,
  SAMPLE_IMPLEMENTATION_EVENTS_RAW,
  SAMPLE_LOT_CHANGE_EVENTS,
  SAMPLE_PROJECT_INITIAL_DATE,
  SUBDIVIDED_BBL_A,
  SUBDIVIDED_BBL_B,
  sampleLayerRegistry,
} from "../seqra-spatial/sample_multi_lot_project.mjs";

function event({ eventType, effectiveAt, availableAt, sourceId, sourceRecordId, payload, reviewKey }) {
  const base = { reviewKey, eventType, effectiveAt, sourceId, sourceRecordId, payload };
  return {
    event_key: buildReviewEventKey(base),
    review_key: reviewKey,
    event_type: eventType,
    effective_at: effectiveAt,
    supersedes_event_key: null,
    payload,
    observed_at: availableAt,
    available_to_public_at: availableAt,
    source_id: sourceId,
    source_record_id: sourceRecordId,
    source_vintage: effectiveAt.slice(0, 10),
    evidence: null,
    confidence: 0.9,
    rival_explanation: null,
    suppression_rule: null,
  };
}

/**
 * The corpus's own data-completeness horizon ("now", for backtest
 * purposes): a supplemental-review window ending after this date is not
 * yet knowable and must be right-censored, never scored as a non-event.
 */
export const OBSERVATION_HORIZON = "2026-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// R1, R2: same BBL, two review generations of the same underlying site --
// the near-duplicate project-family case (A3).
// ---------------------------------------------------------------------------
export const FAMILY_SHARED_BBL = "2001110001";

export const R1_PROJECT_KEY = "project:zap:sample-labels-alpha-v1";
export const R1_REVIEW_KEY = buildEnvironmentalReviewKey({ environmentalRegime: "SEQRA", leadAgency: "NYS DEC", sourceReviewId: "labels-alpha-v1" });
export const R1_CUTOFF = "2024-03-01T00:00:00.000Z";
export const R1_EVENTS = Object.freeze([
  event({
    eventType: "type_ii_classified",
    effectiveAt: "2024-02-15T00:00:00.000Z",
    availableAt: "2024-02-15T00:00:00.000Z",
    sourceId: "nys_dec_dart",
    sourceRecordId: "labels-alpha-v1-typeii",
    payload: {},
    reviewKey: R1_REVIEW_KEY,
  }),
]);

export const R2_PROJECT_KEY = "project:zap:sample-labels-alpha-v2";
export const R2_REVIEW_KEY = buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: "25DCP005X" });
export const R2_CUTOFF = "2025-03-01T00:00:00.000Z";
export const R2_EVENTS = Object.freeze([
  event({
    eventType: "positive_declaration_issued",
    effectiveAt: "2025-02-20T00:00:00.000Z",
    availableAt: "2025-02-20T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "25DCP005X-posdec",
    payload: {},
    reviewKey: R2_REVIEW_KEY,
  }),
]);

// ---------------------------------------------------------------------------
// R3: a clean negative declaration, its own family.
// ---------------------------------------------------------------------------
export const R3_PROJECT_KEY = "project:zap:sample-labels-beta";
export const R3_BBL = "2002220002";
export const R3_REVIEW_KEY = buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: "24DCP006X" });
export const R3_CUTOFF = "2024-06-01T00:00:00.000Z";
export const R3_EVENTS = Object.freeze([
  event({
    eventType: "negative_declaration_issued",
    effectiveAt: "2024-05-20T00:00:00.000Z",
    availableAt: "2024-05-20T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "24DCP006X-negdec",
    payload: {},
    reviewKey: R3_REVIEW_KEY,
  }),
]);

// ---------------------------------------------------------------------------
// R4: an open review with no classifying milestone -- target A's own
// "unknown_or_incomplete" category, and a target E right-censoring case
// where every horizon's window closes after OBSERVATION_HORIZON.
// ---------------------------------------------------------------------------
export const R4_PROJECT_KEY = "project:zap:sample-labels-gamma";
export const R4_BBL = "2003330003";
export const R4_REVIEW_KEY = buildEnvironmentalReviewKey({ environmentalRegime: "SEQRA", leadAgency: "NYS DEC", sourceReviewId: "labels-gamma" });
export const R4_CUTOFF = "2025-11-01T00:00:00.000Z";
export const R4_EVENTS = Object.freeze([
  event({
    eventType: "eas_or_eaf_accepted",
    effectiveAt: "2025-10-15T00:00:00.000Z",
    availableAt: "2025-10-15T00:00:00.000Z",
    sourceId: "nys_dec_dart",
    sourceRecordId: "labels-gamma-eaf",
    payload: {},
    reviewKey: R4_REVIEW_KEY,
  }),
  event({
    eventType: "lead_agency_established",
    effectiveAt: "2025-10-20T00:00:00.000Z",
    availableAt: "2025-10-20T00:00:00.000Z",
    sourceId: "nys_dec_dart",
    sourceRecordId: "labels-gamma-lead-agency",
    payload: {},
    reviewKey: R4_REVIEW_KEY,
  }),
]);

// ---------------------------------------------------------------------------
// R5: a conditioned negative declaration whose 90-day supplemental-review
// window is fully observed (a true negative) while its 180-day window is
// not -- the same review censored on one horizon and not another (A2).
// ---------------------------------------------------------------------------
export const R5_PROJECT_KEY = "project:zap:sample-labels-delta";
export const R5_BBL = "2004440004";
export const R5_REVIEW_KEY = buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: "25DCP007X" });
export const R5_CUTOFF = "2025-08-01T00:00:00.000Z";
export const R5_EVENTS = Object.freeze([
  event({
    eventType: "conditioned_negative_declaration_issued",
    effectiveAt: "2025-07-20T00:00:00.000Z",
    availableAt: "2025-07-20T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "25DCP007X-cnd",
    payload: {},
    reviewKey: R5_REVIEW_KEY,
  }),
]);

// ---------------------------------------------------------------------------
// R6: the full-integration review -- reuses SEQRA-06's own retained
// multi-lot/vintage/implementation fixture for its spatial footprint, and
// wires SEQRA-07's actor-resolution/public-position builder for its
// institutional signal. A positive declaration through final determination,
// with a technical memorandum landing before the determination (positive at
// the 180-day and before-final-determination/before-implementation-
// completion horizons, negative at 90 days -- all fully observed).
// ---------------------------------------------------------------------------
export const R6_PROJECT_KEY = SPATIAL_PROJECT_KEY;
export const R6_REVIEW_KEY = buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: "24DCP008X" });
const R6_ACTION_KEY = buildActionKey({ agency: "DCP", sourceSystem: "ZAP", sourceActionId: "N-2024-0008" });
export const R6_CUTOFF = "2024-02-01T00:00:00.000Z";
export const R6_DETERMINATION_DATE = "2024-07-01";
export const R6_DETERMINATION_KEY = buildDeterminationKey({ agency: "DCP", actionId: "N-2024-0008", date: R6_DETERMINATION_DATE });

export const R6_EVENTS = Object.freeze([
  event({
    eventType: "positive_declaration_issued",
    effectiveAt: "2024-01-25T00:00:00.000Z",
    availableAt: "2024-01-25T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "24DCP008X-posdec",
    payload: {},
    reviewKey: R6_REVIEW_KEY,
  }),
  event({
    eventType: "draft_document_published",
    effectiveAt: "2024-04-01T00:00:00.000Z",
    availableAt: "2024-04-01T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "24DCP008X-deis",
    payload: { document_key: `review_document:${R6_REVIEW_KEY}:deis:2024-04-01:${"a".repeat(12)}`, document_type: "deis", content_hash: "a".repeat(64) },
    reviewKey: R6_REVIEW_KEY,
  }),
  event({
    eventType: "final_document_published",
    effectiveAt: "2024-06-01T00:00:00.000Z",
    availableAt: "2024-06-01T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "24DCP008X-feis",
    payload: {
      document_key: `review_document:${R6_REVIEW_KEY}:feis:2024-06-01:${"b".repeat(12)}`,
      document_type: "feis",
      content_hash: "b".repeat(64),
      supersedes_document_key: `review_document:${R6_REVIEW_KEY}:deis:2024-04-01:${"a".repeat(12)}`,
    },
    reviewKey: R6_REVIEW_KEY,
  }),
  event({
    eventType: "final_determination_issued",
    effectiveAt: `${R6_DETERMINATION_DATE}T00:00:00.000Z`,
    availableAt: `${R6_DETERMINATION_DATE}T00:00:00.000Z`,
    sourceId: "ceqr_access",
    sourceRecordId: "24DCP008X-determination",
    payload: {
      action_key: R6_ACTION_KEY,
      determination_key: R6_DETERMINATION_KEY,
      agency: "DCP",
      date: R6_DETERMINATION_DATE,
      outcome: "approved",
      supersedes_determination_key: null,
    },
    reviewKey: R6_REVIEW_KEY,
  }),
  // Lands before the determination: positive at before_final_determination
  // and within_180_days, negative at within_90_days.
  event({
    eventType: "technical_memorandum_issued",
    effectiveAt: "2024-06-20T00:00:00.000Z",
    availableAt: "2024-06-20T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "24DCP008X-techmemo",
    payload: {},
    reviewKey: R6_REVIEW_KEY,
  }),
]);

/** Extends SEQRA-06's retained implementation-event fixture with the final CO this card's before_implementation_completion horizon needs -- SEQRA-06's own fixture stops at "substantially_complete" (TCO). */
export const R6_COMPLETION_DATE = "2024-12-01";
export const R6_IMPLEMENTATION_EVENTS_RAW = Object.freeze([
  ...SAMPLE_IMPLEMENTATION_EVENTS_RAW,
  {
    sourceSystem: "dob_now",
    sourceEventId: "FCO-2024-000400",
    eventType: "dob_final_certificate_of_occupancy",
    eventDate: R6_COMPLETION_DATE,
    bbl: SUBDIVIDED_BBL_A,
    observedAt: "2024-12-02T00:00:00.000Z",
    sourceId: "dob_now_approved_permits",
    sourceRecordId: "FCO-2024-000400",
  },
].map((raw) => buildImplementationEvent(raw)));

export function r6BblHistory() {
  return buildProjectBblHistory({
    projectKey: SPATIAL_PROJECT_KEY,
    initialBbls: [SPATIAL_ORIGINAL_BBL],
    initialDate: SAMPLE_PROJECT_INITIAL_DATE,
    lotChangeEvents: SAMPLE_LOT_CHANGE_EVENTS,
  });
}
export { sampleLayerRegistry as r6LayerRegistry, SPATIAL_DETERMINATION_DATE, SPATIAL_DETERMINATION_KEY, SUBDIVIDED_BBL_A, SUBDIVIDED_BBL_B };

// One position two months before R6's cutoff (correctly included), one the
// month after (must be excluded from the as-of-cutoff snapshot -- A1).
const R6_ORG = resolveOrganization({ rawName: "Sample Community Board 8", sourceSystem: "community_board_positions" });
export const R6_POSITION_BEFORE_CUTOFF = buildPublicPosition({
  organizationKey: R6_ORG.organization_key,
  organizationType: R6_ORG.organization_type,
  reviewKey: R6_REVIEW_KEY,
  position: "conditional",
  namedIssue: "shadows_on_adjacent_park",
  observedAt: "2023-12-01T00:00:00.000Z",
  availableToPublicAt: "2023-12-05T00:00:00.000Z",
  sourceId: "community_board_positions",
  sourceRecordId: "cb8-24dcp008x-scoping-comment",
  confidence: 0.8,
  rivalExplanation: "A conditional position at scoping reflects the board's standard practice of reserving final judgment for the DEIS, not a settled objection.",
  suppressionRule: DEFAULT_SUPPRESSION_RULE,
});
export const R6_POSITION_AFTER_CUTOFF = buildPublicPosition({
  organizationKey: R6_ORG.organization_key,
  organizationType: R6_ORG.organization_type,
  reviewKey: R6_REVIEW_KEY,
  position: "oppose",
  namedIssue: "shadows_on_adjacent_park",
  observedAt: "2024-03-01T00:00:00.000Z",
  availableToPublicAt: "2024-03-05T00:00:00.000Z",
  sourceId: "community_board_positions",
  sourceRecordId: "cb8-24dcp008x-hearing-comment",
  confidence: 0.8,
  rivalExplanation: "Opposition raised at the public hearing reflects a specific, named shadow-study concern, not a general anti-development stance.",
  suppressionRule: DEFAULT_SUPPRESSION_RULE,
});
export const R6_PUBLIC_POSITIONS = Object.freeze([R6_POSITION_BEFORE_CUTOFF, R6_POSITION_AFTER_CUTOFF]);

// ---------------------------------------------------------------------------
// Every review this card's corpus builder consumes, plus the project rows
// buildProjectFamilies groups by shared BBL.
// ---------------------------------------------------------------------------
export const LABEL_CORPUS_REVIEWS = Object.freeze([
  { reviewKey: R1_REVIEW_KEY, projectKey: R1_PROJECT_KEY, cutoff: R1_CUTOFF, events: R1_EVENTS, publicPositions: [], determinationDate: null, implementationCompletionDate: null },
  { reviewKey: R2_REVIEW_KEY, projectKey: R2_PROJECT_KEY, cutoff: R2_CUTOFF, events: R2_EVENTS, publicPositions: [], determinationDate: null, implementationCompletionDate: null },
  { reviewKey: R3_REVIEW_KEY, projectKey: R3_PROJECT_KEY, cutoff: R3_CUTOFF, events: R3_EVENTS, publicPositions: [], determinationDate: null, implementationCompletionDate: null },
  { reviewKey: R4_REVIEW_KEY, projectKey: R4_PROJECT_KEY, cutoff: R4_CUTOFF, events: R4_EVENTS, publicPositions: [], determinationDate: null, implementationCompletionDate: null },
  { reviewKey: R5_REVIEW_KEY, projectKey: R5_PROJECT_KEY, cutoff: R5_CUTOFF, events: R5_EVENTS, publicPositions: [], determinationDate: null, implementationCompletionDate: null },
  {
    reviewKey: R6_REVIEW_KEY,
    projectKey: R6_PROJECT_KEY,
    cutoff: R6_CUTOFF,
    events: R6_EVENTS,
    publicPositions: R6_PUBLIC_POSITIONS,
    determinationDate: R6_DETERMINATION_DATE,
    implementationCompletionDate: R6_COMPLETION_DATE,
    bblHistory: r6BblHistory(),
    spatialLayerRegistry: sampleLayerRegistry(),
  },
]);

export const LABEL_CORPUS_PROJECTS = Object.freeze([
  { projectKey: R1_PROJECT_KEY, bbls: [FAMILY_SHARED_BBL] },
  { projectKey: R2_PROJECT_KEY, bbls: [FAMILY_SHARED_BBL] },
  { projectKey: R3_PROJECT_KEY, bbls: [R3_BBL] },
  { projectKey: R4_PROJECT_KEY, bbls: [R4_BBL] },
  { projectKey: R5_PROJECT_KEY, bbls: [R5_BBL] },
  { projectKey: R6_PROJECT_KEY, bbls: [SPATIAL_ORIGINAL_BBL] },
]);

/** Two rolling-origin folds; R1/R2 conflict in FOLD_1 (both in-window, same family) and resolve in FOLD_2 (both land in train). */
export const LABEL_CORPUS_FOLDS = Object.freeze([
  { foldId: "fold-2024h2", trainEnd: "2024-12-31T23:59:59.999Z", testStart: "2024-12-31T23:59:59.999Z", testEnd: "2025-06-30T23:59:59.999Z" },
  { foldId: "fold-2025h2", trainEnd: "2025-06-30T23:59:59.999Z", testStart: "2025-06-30T23:59:59.999Z", testEnd: "2025-12-31T23:59:59.999Z" },
]);
