// Append-only curation verdict receipts for entity-resolution gold candidates.
//
// This module is deliberately storage- and transport-neutral. A verdict is an
// immutable evaluation input; current state is projected from the receipt log.
// A desk verdict never contains or applies a public entity-link mutation.

export const CURATION_VERDICT_SCHEMA_VERSION = "cityscroll.curation-verdict.v1";
export const CURATION_EFFECT_VERSION = "cityscroll.curation-effect.v2";
export const CURATION_REVIEW_POLICY_VERSION = "curation_review_policy_v1";

export const CURATION_VERDICT = Object.freeze({
  ACCEPT: "ACCEPT",
  REJECT: "REJECT",
  REVIEW: "REVIEW",
});

export const CURATION_PROVISIONAL_STATE = Object.freeze({
  GOLD_CANDIDATE: "gold_candidate",
  ACCEPT_WITHHELD: "accept_withheld",
  REJECT_WITHHELD: "reject_withheld",
  REVIEW: "review",
});

const DECISIONS = new Set(Object.values(CURATION_VERDICT));
const POLICY_STATUSES = new Set(["satisfied", "unsatisfied", "not_applicable"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ASSERTION_ID = /^assertion:[A-Za-z0-9][A-Za-z0-9._:-]{0,479}:v[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
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

function normalizedGoldSide(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sourceSystem = cleanKind(value.source_system);
  const nativeKey = clean(
    value.native_key
    || value.source_system_id
    || value.native_record_id?.split(":").slice(1).join(":")
    || value.source_record_id?.split(":")[1],
  );
  const displayName = clean(value.display_name || value.vendor_name);
  if (!sourceSystem || !cleanToken(nativeKey) || !displayName) return null;
  const side = {
    source_system: sourceSystem,
    native_key: nativeKey,
    display_name: displayName,
  };
  const attrs = {};
  const pin = clean(value.pin || value.observed_fields?.pin || value.attrs?.pin);
  const epin = clean(value.epin || value.observed_fields?.epin || value.attrs?.epin);
  if (pin) attrs.pin = pin;
  if (epin) attrs.epin = epin;
  if (Object.keys(attrs).length) side.attrs = attrs;
  return side;
}

function normalizedGoldCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const left = normalizedGoldSide(value.left);
  const right = normalizedGoldSide(value.right);
  if (!left || !right) return null;
  return {
    entity_type: cleanKind(value.entity_type) || "vendor",
    left,
    right,
  };
}

function hasDirectEdgeIntent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const kind = clean(value.kind).toLowerCase().replace(/_/g, "-");
  return kind === "entity-link"
    || Object.hasOwn(value, "edge")
    || Object.hasOwn(value, "public_edge")
    || Object.hasOwn(value, "entity_link")
    || Object.hasOwn(value, "provisional_edge_id")
    || Object.hasOwn(value, "supersedes_link_id");
}

function normalizedTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = cleanKind(value.kind);
  const id = cleanToken(value.id);
  if (kind !== "entity_pair" || !id) return null;
  const target = { kind, id };
  const assertionId = clean(value.assertion_id);
  if (assertionId) {
    if (!ASSERTION_ID.test(assertionId)) return null;
    target.assertion_id = assertionId;
  }
  const family = cleanKind(value.edge_family);
  if (family) target.edge_family = family;
  const goldCandidate = normalizedGoldCandidate(value.gold_candidate);
  if (goldCandidate) target.gold_candidate = goldCandidate;
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

  if (decision === CURATION_VERDICT.ACCEPT || decision === CURATION_VERDICT.REJECT) {
    if (requestedStatus !== "satisfied") missing.push("review_policy_unsatisfied");
    if (!target?.gold_candidate) missing.push("gold_candidate_missing");
    if (!evidenceRefs.length) missing.push("evidence_refs_missing");
    if (!modelVersion) missing.push("model_version_missing");
    if (!ruleVersion) missing.push("rule_version_missing");
  }

  const adjudicated = decision === CURATION_VERDICT.ACCEPT || decision === CURATION_VERDICT.REJECT;
  const status = adjudicated
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

  const goldLabel = decision === CURATION_VERDICT.ACCEPT
    ? "same"
    : decision === CURATION_VERDICT.REJECT
      ? "different"
      : null;
  if (!goldLabel || policy.status !== "satisfied") {
    const provisionalState = decision === CURATION_VERDICT.REVIEW
      ? CURATION_PROVISIONAL_STATE.REVIEW
      : decision === CURATION_VERDICT.REJECT
        ? CURATION_PROVISIONAL_STATE.REJECT_WITHHELD
        : CURATION_PROVISIONAL_STATE.ACCEPT_WITHHELD;
    return {
      version: CURATION_EFFECT_VERSION,
      status: goldLabel ? "withheld" : "applied",
      operation: "retain_provisional",
      provisional_state: provisionalState,
      reversible: true,
      reverses_receipt_id: reversesReceiptId,
      undo,
    };
  }

  return {
    version: CURATION_EFFECT_VERSION,
    status: "candidate",
    operation: "export_gold_candidate",
    provisional_state: CURATION_PROVISIONAL_STATE.GOLD_CANDIDATE,
    gold_candidate: {
      action_id: receipt.id,
      pair_id: target.id,
      label: goldLabel,
      export_method: "review_action_export_v1",
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
  if (hasDirectEdgeIntent(input.target)) return { error: "direct-edge-mutation-forbidden" };
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
    state: active.reversible_effect?.provisional_state || "not_exportable",
    receipt_count: matching.length,
    active_receipt_id: active.id,
    edge: null,
  };
}
