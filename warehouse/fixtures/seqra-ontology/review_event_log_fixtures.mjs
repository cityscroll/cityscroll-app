/**
 * SEQRA-02 append-only event log fixtures: one clean full-lifecycle review
 * (positive declaration through final determination, with a draft/final EIS
 * pair and a late supplemental technical memorandum), and two deliberately
 * impossible sequences the contradiction detector must reject -- a final
 * document published before its draft, and two conflicting, unsuperseded
 * determinations for one action. Synthetic identity fixtures, not claims
 * about a real review.
 */

import { buildActionKey, buildDeterminationKey, buildEnvironmentalReviewKey, buildReviewDocumentKey } from "../../lib/seqra_stable_keys.mjs";
import { buildReviewEventKey } from "../../lib/seqra_review_event_log.mjs";

export const CLEAN_REVIEW_KEY = buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: "26DCP002X" });
const CLEAN_ACTION_KEY = buildActionKey({ agency: "DCP", sourceSystem: "ZAP", sourceActionId: "N-2026-0003" });

const DEIS_HASH = "a".repeat(64);
const FEIS_HASH = "b".repeat(64);
const DEIS_KEY = buildReviewDocumentKey({ reviewKey: CLEAN_REVIEW_KEY, documentType: "deis", issuedDate: "2026-03-01", contentHash: DEIS_HASH });
const FEIS_KEY = buildReviewDocumentKey({ reviewKey: CLEAN_REVIEW_KEY, documentType: "feis", issuedDate: "2026-05-01", contentHash: FEIS_HASH });
const DETERMINATION_KEY = buildDeterminationKey({ agency: "DCP", actionId: "N-2026-0003", date: "2026-06-01" });

function event({ eventType, effectiveAt, availableAt, sourceId, sourceRecordId, payload, reviewKey = CLEAN_REVIEW_KEY }) {
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

export const CLEAN_REVIEW_EVENTS = Object.freeze([
  event({
    eventType: "eas_or_eaf_accepted",
    effectiveAt: "2026-01-10T00:00:00.000Z",
    availableAt: "2026-01-10T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "26DCP002X-eas",
    payload: {},
  }),
  event({
    eventType: "positive_declaration_issued",
    effectiveAt: "2026-01-20T00:00:00.000Z",
    availableAt: "2026-01-20T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "26DCP002X-posdec",
    payload: {},
  }),
  event({
    eventType: "final_scope_issued",
    effectiveAt: "2026-02-15T00:00:00.000Z",
    availableAt: "2026-02-15T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "26DCP002X-scope",
    payload: {},
  }),
  event({
    eventType: "draft_document_published",
    effectiveAt: "2026-03-01T00:00:00.000Z",
    availableAt: "2026-03-01T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "26DCP002X-deis",
    payload: { document_key: DEIS_KEY, document_type: "deis", content_hash: DEIS_HASH },
  }),
  event({
    eventType: "public_hearing_held",
    effectiveAt: "2026-04-01T00:00:00.000Z",
    availableAt: "2026-04-01T00:00:00.000Z",
    sourceId: "city_record",
    sourceRecordId: "26DCP002X-hearing",
    payload: {},
  }),
  event({
    eventType: "final_document_published",
    effectiveAt: "2026-05-01T00:00:00.000Z",
    availableAt: "2026-05-01T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "26DCP002X-feis",
    payload: { document_key: FEIS_KEY, document_type: "feis", content_hash: FEIS_HASH, supersedes_document_key: DEIS_KEY },
  }),
  event({
    eventType: "findings_adopted",
    effectiveAt: "2026-05-20T00:00:00.000Z",
    availableAt: "2026-05-20T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "26DCP002X-findings",
    payload: {},
  }),
  event({
    eventType: "final_determination_issued",
    effectiveAt: "2026-06-01T00:00:00.000Z",
    availableAt: "2026-06-01T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "26DCP002X-determination",
    payload: {
      action_key: CLEAN_ACTION_KEY,
      determination_key: DETERMINATION_KEY,
      agency: "DCP",
      date: "2026-06-01",
      outcome: "approved_with_conditions",
      supersedes_determination_key: null,
    },
  }),
  event({
    eventType: "topic_assessed",
    effectiveAt: "2026-03-01T00:00:00.000Z",
    availableAt: "2026-03-01T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "26DCP002X-deis-shadows",
    payload: { technical_topic: "shadows", state: "detailed_analysis", document_key: DEIS_KEY },
  }),
  event({
    eventType: "topic_assessed",
    effectiveAt: "2026-05-01T00:00:00.000Z",
    availableAt: "2026-05-01T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "26DCP002X-feis-shadows",
    payload: { technical_topic: "shadows", state: "mitigated", document_key: FEIS_KEY },
  }),
  event({
    eventType: "mitigation_committed",
    effectiveAt: "2026-05-01T00:00:00.000Z",
    availableAt: "2026-05-01T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "26DCP002X-mitigation-shadows",
    payload: { technical_topic: "shadows", description: "Seasonal tree planting along the playground frontage", status: "adopted" },
  }),
]);

export const CLEAN_REVIEW_FIXTURE_CUTOFFS = Object.freeze({
  BEFORE_DEIS: "2026-02-20T00:00:00.000Z",
  AFTER_DEIS_BEFORE_FEIS: "2026-04-15T00:00:00.000Z",
  AFTER_DETERMINATION: "2026-07-01T00:00:00.000Z",
});

export const CLEAN_REVIEW_FIXTURE_KEYS = Object.freeze({
  CLEAN_REVIEW_KEY,
  CLEAN_ACTION_KEY,
  DEIS_KEY,
  FEIS_KEY,
  DETERMINATION_KEY,
});

// ---- contradiction fixtures ------------------------------------------------

const FINAL_BEFORE_DRAFT_REVIEW_KEY = buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: "26DCP003X" });
const ORPHAN_FINAL_HASH = "c".repeat(64);
const ORPHAN_DRAFT_KEY = buildReviewDocumentKey({
  reviewKey: FINAL_BEFORE_DRAFT_REVIEW_KEY, documentType: "deis", issuedDate: "2026-06-01", contentHash: "d".repeat(64),
});
const ORPHAN_FINAL_KEY = buildReviewDocumentKey({
  reviewKey: FINAL_BEFORE_DRAFT_REVIEW_KEY, documentType: "feis", issuedDate: "2026-01-01", contentHash: ORPHAN_FINAL_HASH,
});

export const FINAL_BEFORE_DRAFT_EVENTS = Object.freeze([
  // The "draft" is published in March -- after the final that claims to
  // supersede it, which was published in January. Impossible sequence.
  event({
    eventType: "final_document_published",
    effectiveAt: "2026-01-01T00:00:00.000Z",
    availableAt: "2026-01-01T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "26DCP003X-feis",
    payload: { document_key: ORPHAN_FINAL_KEY, document_type: "feis", content_hash: ORPHAN_FINAL_HASH, supersedes_document_key: ORPHAN_DRAFT_KEY },
    reviewKey: FINAL_BEFORE_DRAFT_REVIEW_KEY,
  }),
  event({
    eventType: "draft_document_published",
    effectiveAt: "2026-03-01T00:00:00.000Z",
    availableAt: "2026-03-01T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "26DCP003X-deis",
    payload: { document_key: ORPHAN_DRAFT_KEY, document_type: "deis", content_hash: "d".repeat(64) },
    reviewKey: FINAL_BEFORE_DRAFT_REVIEW_KEY,
  }),
]);

export const FINAL_BEFORE_DRAFT_FIXTURE_KEYS = Object.freeze({ FINAL_BEFORE_DRAFT_REVIEW_KEY });

const CONFLICTING_DETERMINATION_REVIEW_KEY = buildEnvironmentalReviewKey({ environmentalRegime: "CEQR", ceqrNumber: "26DCP004X" });
const CONFLICTING_ACTION_KEY = buildActionKey({ agency: "DCP", sourceSystem: "ZAP", sourceActionId: "N-2026-0004" });

export const CONFLICTING_DETERMINATIONS_EVENTS = Object.freeze([
  event({
    eventType: "final_determination_issued",
    effectiveAt: "2026-06-01T00:00:00.000Z",
    availableAt: "2026-06-01T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "26DCP004X-determination-approve",
    payload: {
      action_key: CONFLICTING_ACTION_KEY,
      determination_key: buildDeterminationKey({ agency: "DCP", actionId: "N-2026-0004", date: "2026-06-01" }),
      agency: "DCP",
      date: "2026-06-01",
      outcome: "approved",
      supersedes_determination_key: null,
    },
    reviewKey: CONFLICTING_DETERMINATION_REVIEW_KEY,
  }),
  // A second, unrelated determination for the SAME action with a different
  // outcome and no supersession link -- two conflicting determinations.
  event({
    eventType: "final_determination_issued",
    effectiveAt: "2026-06-15T00:00:00.000Z",
    availableAt: "2026-06-15T00:00:00.000Z",
    sourceId: "ceqr_access",
    sourceRecordId: "26DCP004X-determination-deny",
    payload: {
      action_key: CONFLICTING_ACTION_KEY,
      determination_key: buildDeterminationKey({ agency: "DCP", actionId: "N-2026-0004", date: "2026-06-15" }),
      agency: "DCP",
      date: "2026-06-15",
      outcome: "denied",
      supersedes_determination_key: null,
    },
    reviewKey: CONFLICTING_DETERMINATION_REVIEW_KEY,
  }),
]);

export { CONFLICTING_ACTION_KEY };
export const CONFLICTING_DETERMINATIONS_FIXTURE_KEYS = Object.freeze({ CONFLICTING_DETERMINATION_REVIEW_KEY, CONFLICTING_ACTION_KEY });
