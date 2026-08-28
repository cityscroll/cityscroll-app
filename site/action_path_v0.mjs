/**
 * Pure Action Path v0 projection.
 *
 * This module is deliberately below presentation and transport. It validates
 * an already-built reader action, keeps the grounded object refs that explain
 * what the action affects, and carries an exact continuation when one exists.
 * It does not create watches, infer participation, or fetch source data.
 */

import actionRegistry from "./action_registry.js";
import { normalizeScope, SCOPE_SCHEMA, SCOPE_VERSION } from "./scope_v0.mjs";

export const ACTION_PATH_SCHEMA = "cityscroll.civic_action_path.v0";
export const ACTION_PATH_VERSION = 0;
export const ACTION_PATH_CAPABILITY_ID = "action_path_v0";

export const ACTION_PATH_AMBIGUITIES = Object.freeze([
  "none",
  "multiple",
  "unknown",
]);

export const ACTION_PATH_CONTINUATION_KINDS = Object.freeze(["subject", "scope"]);

const UNKNOWN_CONTINUATION_STATES = new Set([
  "unknown",
  "unsupported",
  "unavailable",
  "lossy",
  "not_replayable",
]);

const ACTOR_FIELDS = new Set([
  "actor",
  "actor_id",
  "account_id",
  "behavior",
  "email",
  "identity",
  "performed_by",
  "resident_id",
  "session_id",
  "telemetry",
  "user",
  "user_id",
]);

const REF_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*:[^\s]+$/;
const ACTION_PATH_COPY_FIELDS = Object.freeze(["label", "reason"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function requiredText(value, label) {
  const normalized = text(value);
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function refFrom(value) {
  if (typeof value === "string") return text(value);
  if (!isRecord(value)) return null;
  return text(value.ref || value.subject_ref || value.target_ref || value.id);
}

function requiredRef(value, label) {
  const ref = requiredText(refFrom(value), label);
  if (!REF_PATTERN.test(ref)) throw new TypeError(`${label} must be a typed civic ref`);
  return ref;
}

function assertNoActorFields(value, path = "input", skipAction = false) {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (skipAction && key === "action") continue;
    if (ACTOR_FIELDS.has(key.toLowerCase())) {
      throw new TypeError(`${path}.${key} is not allowed in an Action Path`);
    }
    if (isRecord(child)) assertNoActorFields(child, `${path}.${key}`, false);
    else if (Array.isArray(child)) {
      child.forEach((item, index) => assertNoActorFields(item, `${path}.${key}[${index}]`, false));
    }
  }
}

function assertActionHasNoActorFields(action) {
  if (!isRecord(action)) return;
  for (const key of Object.keys(action)) {
    if (key.toLowerCase() !== "email" && ACTOR_FIELDS.has(key.toLowerCase())) {
      throw new TypeError(`action.${key} is not allowed in an Action Path`);
    }
  }
}

function safeHttps(value, label) {
  if (value == null || value === "") return null;
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:") throw new TypeError(`${label} must be HTTPS`);
    return url.href;
  } catch (error) {
    if (error instanceof TypeError && error.message.endsWith("must be HTTPS")) throw error;
    throw new TypeError(`${label} must be a valid HTTPS URL`);
  }
}

function normalizeEvidence(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError("Action Path requires provenance-bearing evidence");
  }
  return input.map((entry, index) => {
    if (!isRecord(entry)) throw new TypeError(`evidence[${index}] must be an object`);
    const sourceRef = text(
      entry.source_ref
      || entry.observation_ref
      || entry.source_record_ref
      || entry.source_record_id
      || entry.receipt_ref,
    );
    const sourceUrl = safeHttps(entry.source_url || entry.url || entry.href, `evidence[${index}] URL`);
    const receipt = entry.receipt || entry.observed_receipt || entry.source_receipt;
    if (!sourceRef && !sourceUrl && !receipt) {
      throw new TypeError(`evidence[${index}] must carry a source ref, URL, or receipt`);
    }
    const normalized = { ...entry };
    if (sourceRef && !normalized.source_ref) normalized.source_ref = sourceRef;
    if (sourceUrl) normalized.source_url = sourceUrl;
    return Object.freeze(normalized);
  });
}

function normalizeCopy(input) {
  const copy = isRecord(input?.copy) ? input.copy : input;
  if (!isRecord(copy)) return null;
  const normalized = Object.fromEntries(
    ACTION_PATH_COPY_FIELDS
      .map((field) => [field, text(copy[field])])
      .filter(([, value]) => value),
  );
  return Object.keys(normalized).length ? Object.freeze(normalized) : null;
}

function normalizeAvailability(input, action) {
  const supplied = input?.availability;
  let state = action.delivery === "unavailable" ? "unavailable" : "available";
  let deadline = text(input?.deadline) || text(action.deadline);
  if (typeof supplied === "boolean") state = supplied ? "available" : "unavailable";
  else if (typeof supplied === "string") state = supplied;
  else if (isRecord(supplied)) {
    state = text(supplied.state || supplied.status) || state;
    deadline = text(supplied.deadline) || deadline;
  }
  if (!["available", "unavailable", "unknown"].includes(state)) {
    throw new TypeError(`unsupported action availability: ${state}`);
  }
  return Object.freeze({ state, deadline: deadline || null });
}

function scopeIsReplayable(candidate) {
  if (candidate.replayable === false || candidate.scope_replayable === false) return false;
  if (candidate.lossy === true || candidate.supported === false) return false;
  const status = text(candidate.status);
  if (status && UNKNOWN_CONTINUATION_STATES.has(status.toLowerCase())) return false;
  return candidate.replayable === true
    || candidate.scope_replayable === true
    || candidate.scope?.replayable === true;
}

/**
 * Return the normalized scope only when the producer has proved exact replay.
 * `normalizeScope` alone is intentionally insufficient: it can serialize a
 * scope while dropping a relation the subscription compiler cannot replay.
 */
export function continuationScopeForSubject(_subject, candidate = {}) {
  if (!isRecord(candidate) || candidate.kind !== "scope" || !scopeIsReplayable(candidate)) return null;
  const rawScope = isRecord(candidate.scope) ? { ...candidate.scope } : null;
  if (!rawScope) return null;
  delete rawScope.replayable;
  if (rawScope.schema && rawScope.schema !== SCOPE_SCHEMA) return null;
  if (rawScope.version != null && Number(rawScope.version) !== SCOPE_VERSION) return null;
  const scope = normalizeScope(rawScope);
  return Object.freeze(scope);
}

function unsupportedContinuation(candidate) {
  if (!isRecord(candidate)) return true;
  if (candidate.supported === false || candidate.lossy === true || candidate.replayable === false) return true;
  const status = text(candidate.status);
  return Boolean(status && UNKNOWN_CONTINUATION_STATES.has(status.toLowerCase()));
}

function normalizeCandidate(subject, candidate, inheritedCopy) {
  if (unsupportedContinuation(candidate)) return null;
  const kind = text(candidate?.kind) || (candidate?.scope ? "scope" : "subject");
  if (!ACTION_PATH_CONTINUATION_KINDS.includes(kind)) return null;

  const normalized = {
    kind,
    subject_ref: null,
    scope: null,
    label: text(candidate?.label) || inheritedCopy?.label || null,
    reason: text(candidate?.reason) || inheritedCopy?.reason || null,
  };
  if (kind === "subject") {
    const subjectRef = refFrom(candidate);
    if (!subjectRef || !REF_PATTERN.test(subjectRef)) return null;
    normalized.subject_ref = subjectRef;
  } else {
    normalized.scope = continuationScopeForSubject(subject, { ...candidate, kind });
    if (!normalized.scope) return null;
  }
  return Object.freeze(normalized);
}

function normalizeContinuation(input, subject, copy) {
  const raw = input?.continuation;
  const candidateInput = Array.isArray(input?.continuation_candidates)
    ? input.continuation_candidates
    : Array.isArray(raw?.candidates)
      ? raw.candidates
      : raw
        ? [raw]
        : [];
  if (!candidateInput.length) {
    const status = text(raw?.status);
    return {
      continuation: null,
      ambiguity: status && UNKNOWN_CONTINUATION_STATES.has(status.toLowerCase()) ? "unknown" : "none",
      state: status && UNKNOWN_CONTINUATION_STATES.has(status.toLowerCase()) ? "unknown" : "none",
    };
  }

  const candidates = candidateInput.map((candidate) => normalizeCandidate(subject, candidate, copy));
  if (candidates.some((candidate) => !candidate)) {
    return { continuation: null, ambiguity: "unknown", state: "unknown" };
  }

  const ambiguity = candidates.length > 1 ? "multiple" : "none";
  const first = candidates[0];
  const continuation = Object.freeze({
    kind: candidates.length === 1 ? first.kind : null,
    subject_ref: candidates.length === 1 ? first.subject_ref : null,
    scope: candidates.length === 1 ? first.scope : null,
    label: text(raw?.label) || first.label || copy?.label || null,
    reason: text(raw?.reason) || first.reason || copy?.reason || null,
    candidates: Object.freeze(candidates),
    ambiguity,
  });
  return { continuation, ambiguity, state: candidates.length > 1 ? "ambiguous" : "available" };
}

function freezeDescriptor(descriptor) {
  Object.freeze(descriptor.evidence);
  Object.freeze(descriptor.provenance);
  return Object.freeze(descriptor);
}

/**
 * Validate an Action Path descriptor. Returns the same descriptor for callers
 * that want a guard in a projection pipeline; it never repairs invalid input.
 */
export function validateActionPath(path) {
  if (!isRecord(path)) throw new TypeError("Action Path must be an object");
  if (path.schema !== ACTION_PATH_SCHEMA) throw new TypeError(`expected schema ${ACTION_PATH_SCHEMA}`);
  if (Number(path.version) !== ACTION_PATH_VERSION) throw new TypeError("unsupported Action Path version");
  assertNoActorFields(path, "path", true);
  assertActionHasNoActorFields(path.action);
  const action = actionRegistry.validateAction(path.action);
  if (action !== path.action) throw new TypeError("Action Path action must remain the validated action object");
  requiredRef(path.subject_ref, "subject_ref");
  requiredRef(path.target_ref, "target_ref");
  const evidence = normalizeEvidence(path.evidence || path.provenance);
  if (!Array.isArray(path.provenance) || path.provenance.length !== evidence.length) {
    throw new TypeError("Action Path provenance must mirror evidence");
  }
  if (!path.availability || !["available", "unavailable", "unknown"].includes(path.availability.state)) {
    throw new TypeError("Action Path availability is invalid");
  }
  if (!ACTION_PATH_AMBIGUITIES.includes(path.ambiguity)) {
    throw new TypeError("Action Path ambiguity is invalid");
  }
  if (!["none", "available", "ambiguous", "unknown"].includes(path.continuation_state)) {
    throw new TypeError("Action Path continuation state is invalid");
  }
  if (path.continuation) {
    const candidates = path.continuation.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new TypeError("continuation requires candidates");
    }
    if (candidates.length === 1) {
      if (!ACTION_PATH_CONTINUATION_KINDS.includes(path.continuation.kind)) {
        throw new TypeError("single continuation kind is invalid");
      }
      if (path.continuation.kind === "subject") requiredRef(path.continuation.subject_ref, "continuation.subject_ref");
      else if (!path.continuation.scope) throw new TypeError("scope continuation requires a scope");
    } else if (path.ambiguity !== "multiple" || path.continuation.kind !== null) {
      throw new TypeError("multiple continuation candidates must remain ambiguous");
    }
  } else if (!["none", "unknown"].includes(path.ambiguity)) {
    throw new TypeError("missing continuation has invalid ambiguity");
  }
  const expectedCta = Boolean(path.continuation && path.continuation_state === "available");
  if (path.continuation_cta !== expectedCta) throw new TypeError("Action Path CTA state is inconsistent");
  return path;
}

/** Build one immutable, actorless Action Path descriptor from existing facts. */
export function buildActionPath(input = {}) {
  if (!isRecord(input)) throw new TypeError("Action Path input must be an object");
  assertNoActorFields(input, "input", true);
  assertActionHasNoActorFields(input.action);
  const action = actionRegistry.validateAction(input.action);
  const subjectRef = requiredRef(input.subject_ref || input.subject, "subject_ref");
  const targetRef = requiredRef(input.target_ref || input.target, "target_ref");
  const evidence = normalizeEvidence(input.evidence || input.provenance);
  const copy = normalizeCopy(input);
  const availability = normalizeAvailability(input, action);
  const continuationResult = normalizeContinuation(input, subjectRef, copy);
  const descriptor = {
    schema: ACTION_PATH_SCHEMA,
    version: ACTION_PATH_VERSION,
    subject_ref: subjectRef,
    action,
    target_ref: targetRef,
    process_ref: input.process_ref == null ? null : requiredRef(input.process_ref, "process_ref"),
    continuation: continuationResult.continuation,
    continuation_cta: Boolean(continuationResult.continuation && continuationResult.state === "available"),
    ambiguity: continuationResult.ambiguity,
    continuation_state: continuationResult.state,
    evidence: Object.freeze(evidence),
    provenance: Object.freeze(evidence),
    availability,
    copy,
  };
  validateActionPath(descriptor);
  return freezeDescriptor(descriptor);
}
