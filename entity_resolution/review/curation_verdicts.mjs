// Append-only curation verdict receipts for entity-resolution edges.
//
// This module is deliberately storage- and transport-neutral. A verdict is an
// immutable ontology action; current state is projected from the receipt log.
// Public serializers do not consume this shape.

export const CURATION_VERDICT_SCHEMA_VERSION = "cityscroll.curation-verdict.v1";
export const CURATION_EFFECT_VERSION = "cityscroll.curation-effect.v1";
export const CURATION_REVIEW_POLICY_VERSION = "curation_review_policy_v1";

export const CURATION_VERDICT = Object.freeze({
  ACCEPT: "ACCEPT",
  REJECT: "REJECT",
  REVIEW: "REVIEW",
});

export const CURATION_PROVISIONAL_STATE = Object.freeze({
  ACCEPT_WITHHELD: "accept_withheld",
  REJECTED: "rejected",
  REVIEW: "review",
});

const DECISIONS = new Set(Object.values(CURATION_VERDICT));
const POLICY_STATUSES = new Set(["satisfied", "unsatisfied", "not_applicable"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const KIND = /^[a-z][a-z0-9_-]{0,63}$/;

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function cleanToken(value) {
  const token = clean(value);
  return TOKEN.test(token) ? token : "";
}

function cleanKind(value) {
  const kind = clean(value).toLowerCase();
  return KIND.test(kind) ? kind : "";
}

function isoTimestamp(value) {
  const text = clean(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : "";
}

function normalizedEvidenceRefs(value) {
  const seen = new Set();
  const refs = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const kind = cleanKind(raw?.kind);
    const id = cleanToken(raw?.id);
    if (!kind || !id) continue;
    const key = `${kind}\0${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind, id });
  }
  return refs;
}

function normalizedEdge(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = cleanToken(value.id);
  const sourceRecordId = cleanToken(value.source_record_id);
  const canonicalEntityId = cleanToken(value.canonical_entity_id);
  if (!id || !sourceRecordId || !canonicalEntityId) return null;
  const confidence = value.confidence == null ? null : Number(value.confidence);
  if (confidence != null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    return null;
  }
  const edge = {
    id,
    source_record_id: sourceRecordId,
    canonical_entity_id: canonicalEntityId,
    confidence,
    method: cleanToken(value.method) || "curation_accept",
    matcher_version: cleanToken(value.matcher_version),
    resolution_run_id: cleanToken(value.resolution_run_id) || null,
    supersedes_link_id: cleanToken(value.supersedes_link_id) || null,
  };
  if (value.evidence && typeof value.evidence === "object" && !Array.isArray(value.evidence)) {
    edge.evidence = structuredClone(value.evidence);
  }
  return edge;
}

function normalizedTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = cleanKind(value.kind);
  const id = cleanToken(value.id);
  if (!kind || !id) return null;
  const target = { kind, id };
  const family = cleanKind(value.edge_family);
  if (family) target.edge_family = family;
  const provisionalEdgeId = cleanToken(value.provisional_edge_id);
  if (provisionalEdgeId) target.provisional_edge_id = provisionalEdgeId;
  const edge = normalizedEdge(value.edge);
  if (edge) target.edge = edge;
  return target;
}

function policyFor(input, decision, target, evidenceRefs, modelVersion, ruleVersion) {
  const supplied = input && typeof input === "object" ? input : {};
  const suppliedStatus = clean(supplied.status).toLowerCase();
  const requestedStatus = POLICY_STATUSES.has(suppliedStatus) ? suppliedStatus : "unsatisfied";
  const reasons = [...new Set((Array.isArray(supplied.reasons) ? supplied.reasons : [])
    .map(clean)
    .filter(Boolean))];
  const missing = [];

  if (decision === CURATION_VERDICT.ACCEPT) {
    if (requestedStatus !== "satisfied") missing.push("review_policy_unsatisfied");
    if (!target?.edge) missing.push("materializable_edge_missing");
    if (!evidenceRefs.length) missing.push("evidence_refs_missing");
    if (!modelVersion) missing.push("model_version_missing");
    if (!ruleVersion) missing.push("rule_version_missing");
  }

  const status = decision === CURATION_VERDICT.ACCEPT
    ? (missing.length ? "unsatisfied" : "satisfied")
    : (requestedStatus === "satisfied" ? "not_applicable" : requestedStatus || "not_applicable");
  return {
    version: cleanToken(supplied.version) || CURATION_REVIEW_POLICY_VERSION,
    status,
    reasons: [...new Set([...reasons, ...missing])],
  };
}

function effectFor(receipt) {
  const { decision, target, review_policy: policy } = receipt;
  const reversesReceiptId = receipt.reverses_receipt_id || null;
  const undo = {
    operation: "append_verdict",
    target_id: target.id,
    reverses_receipt_id: receipt.id,
  };

  if (decision !== CURATION_VERDICT.ACCEPT || policy.status !== "satisfied") {
    const provisionalState = decision === CURATION_VERDICT.REJECT
      ? CURATION_PROVISIONAL_STATE.REJECTED
      : decision === CURATION_VERDICT.REVIEW
        ? CURATION_PROVISIONAL_STATE.REVIEW
        : CURATION_PROVISIONAL_STATE.ACCEPT_WITHHELD;
    return {
      version: CURATION_EFFECT_VERSION,
      status: decision === CURATION_VERDICT.ACCEPT ? "withheld" : "applied",
      operation: "retain_provisional",
      provisional_state: provisionalState,
      edge: null,
      reversible: true,
      reverses_receipt_id: reversesReceiptId,
      undo,
    };
  }

  const suppliedEdge = target.edge;
  const supersedesLinkId = target.provisional_edge_id || suppliedEdge.supersedes_link_id || null;
  const evidence = {
    ...(suppliedEdge.evidence || {}),
    curation: {
      receipt_id: receipt.id,
      evidence_refs: receipt.evidence_refs,
      model_version: receipt.model_version,
      rule_version: receipt.rule_version,
    },
  };
  return {
    version: CURATION_EFFECT_VERSION,
    status: "applied",
    operation: supersedesLinkId ? "promote_edge" : "materialize_edge",
    provisional_state: null,
    edge: {
      ...suppliedEdge,
      matcher_version: suppliedEdge.matcher_version || receipt.model_version,
      decision: "reviewed_link",
      review_status: "accepted",
      evidence,
      supersedes_link_id: supersedesLinkId,
      supersession_reason: supersedesLinkId ? "curation_accept" : null,
    },
    reversible: true,
    reverses_receipt_id: reversesReceiptId,
    undo,
  };
}

/**
 * Build the fixed v1 receipt shape. Invalid input returns an explicit error and
 * never falls through to an edge effect.
 */
export function buildCurationVerdictReceipt(input = {}, opts = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "invalid-input" };
  const id = cleanToken(opts.id || input.id);
  const actor = cleanToken(input.actor);
  const decision = clean(input.decision).toUpperCase();
  const target = normalizedTarget(input.target);
  const evidenceRefs = normalizedEvidenceRefs(input.evidence_refs);
  const modelVersion = cleanToken(input.model_version);
  const ruleVersion = cleanToken(input.rule_version);
  const timestamp = isoTimestamp(opts.now || input.timestamp || input.created_at);
  const reversesReceiptId = cleanToken(input.reverses_receipt_id) || null;

  if (!id) return { error: "receipt-id-required" };
  if (!actor) return { error: "actor-required" };
  if (!DECISIONS.has(decision)) return { error: "invalid-decision" };
  if (!target) return { error: "target-required" };
  if (!evidenceRefs.length) return { error: "evidence-refs-required" };
  if (!modelVersion) return { error: "model-version-required" };
  if (!ruleVersion) return { error: "rule-version-required" };
  if (!timestamp) return { error: "timestamp-required" };
  if (reversesReceiptId === id) return { error: "self-reversal" };

  const receipt = {
    id,
    schema_version: CURATION_VERDICT_SCHEMA_VERSION,
    actor,
    decision,
    target,
    evidence_refs: evidenceRefs,
    model_version: modelVersion,
    rule_version: ruleVersion,
    timestamp,
    reverses_receipt_id: reversesReceiptId,
    review_policy: policyFor(
      input.review_policy,
      decision,
      target,
      evidenceRefs,
      modelVersion,
      ruleVersion,
    ),
  };
  receipt.reversible_effect = effectFor(receipt);
  return receipt;
}

/** Project the latest honest state for a target without altering its history. */
export function projectCurationVerdictState(receipts = [], targetId = "") {
  const id = cleanToken(targetId);
  const matching = (Array.isArray(receipts) ? receipts : [])
    .filter((receipt) => receipt?.schema_version === CURATION_VERDICT_SCHEMA_VERSION)
    .filter((receipt) => !id || receipt?.target?.id === id)
    .sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp))
      || String(left.id).localeCompare(String(right.id)));
  if (!matching.length) {
    return { state: "not_yet_observed", receipt_count: 0, active_receipt_id: null, edge: null };
  }
  const active = matching.at(-1);
  return {
    state: active.reversible_effect?.provisional_state || "accepted",
    receipt_count: matching.length,
    active_receipt_id: active.id,
    edge: active.reversible_effect?.edge || null,
  };
}
