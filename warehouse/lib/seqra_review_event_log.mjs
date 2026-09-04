/**
 * SEQRA-02: append-only review-event log and the as-of state projector.
 *
 * The event log is the only place review state is recorded. There is no
 * mutable "current row" anywhere in this module: `projectReviewStateAsOf`
 * always rebuilds state from scratch by filtering and folding the log, so
 * cutoff validity is a property of the fold, not of a query someone has to
 * remember to write carefully. Replay order never changes the result --
 * every fold sorts by (effective_at, event_key) before reducing, so passing
 * the same events in a different array order produces an identical
 * projection.
 *
 * A contradictory or impossible sequence (a final document published before
 * its draft, two conflicting determinations for one action with no
 * supersession between them) is never silently resolved into a plausible
 * current state: `projectReviewStateAsOf` returns `{ ok: false,
 * contradictions }` instead of a state object, and callers must treat that
 * as a hard failure.
 *
 * Payload contract by event_type (validated by `validateReviewEventShape`,
 * beyond the generic review_event entity schema):
 *   draft_document_published:  { document_key, document_type, content_hash }
 *   final_document_published:  { document_key, document_type, content_hash,
 *                                 supersedes_document_key }
 *   document_superseded:       { document_key, superseded_by_document_key }
 *   final_determination_issued:{ action_key, determination_key, agency,
 *                                 date, outcome, supersedes_determination_key }
 *   determination_superseded:  { determination_key, superseded_by_determination_key }
 *   topic_assessed:            { technical_topic, state, document_key }
 *   mitigation_committed:      { technical_topic, description, status }
 *   alternative_considered:    { name, status }
 *   position_taken:            { organization_key, position, named_issue }
 *   every other lifecycle event_type: any object payload (may be empty {}).
 */

import { createHash } from "node:crypto";

import {
  SEQRA_REVIEW_EVENT_TYPES,
  SEQRA_REVIEW_DOCUMENT_TYPES,
  SEQRA_TECHNICAL_TOPICS,
  SEQRA_TOPIC_ASSESSMENT_STATES,
  validateSeqraEntity,
} from "./seqra_ontology_spec.mjs";

export const SEQRA_REVIEW_PROJECTION_SCHEMA = "cityscroll.seqra_review_event_log.projection.v1";

export const CONTRADICTION_TYPES = Object.freeze({
  FINAL_BEFORE_DRAFT: "final_before_draft",
  CONFLICTING_DETERMINATIONS: "conflicting_determinations_for_action",
});

class SeqraOntologyValidationError extends Error {
  constructor(findings) {
    super(`invalid SEQRA review event(s):\n${findings.join("\n")}`);
    this.name = "SeqraOntologyValidationError";
    this.findings = findings;
  }
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

/** Deterministic event_key: a function of identity + content, not of insertion order or fetch time. */
export function buildReviewEventKey({ reviewKey, eventType, effectiveAt, sourceId, sourceRecordId, payload = {} } = {}) {
  if (!reviewKey || !eventType || !effectiveAt || !sourceId || !sourceRecordId) {
    throw new Error("buildReviewEventKey requires reviewKey, eventType, effectiveAt, sourceId, sourceRecordId");
  }
  const contentHash = sha256Hex(JSON.stringify(stable({ reviewKey, eventType, effectiveAt, sourceId, sourceRecordId, payload })));
  return `review_event:${reviewKey}:${eventType}:${effectiveAt}:${contentHash.slice(0, 12)}`;
}

function payloadFindings(event, label) {
  const findings = [];
  const payload = event.payload || {};
  const require = (field, predicate, description) => {
    if (!predicate(payload[field])) findings.push(`${label}: payload.${field} ${description}`);
  };
  const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

  switch (event.event_type) {
    case "draft_document_published":
      require("document_key", isNonEmptyString, "must be a non-empty string");
      require("document_type", (value) => SEQRA_REVIEW_DOCUMENT_TYPES.includes(value), `must be one of SEQRA_REVIEW_DOCUMENT_TYPES`);
      require("content_hash", isNonEmptyString, "must be a non-empty string");
      break;
    case "final_document_published":
      require("document_key", isNonEmptyString, "must be a non-empty string");
      require("document_type", (value) => SEQRA_REVIEW_DOCUMENT_TYPES.includes(value), `must be one of SEQRA_REVIEW_DOCUMENT_TYPES`);
      require("content_hash", isNonEmptyString, "must be a non-empty string");
      require("supersedes_document_key", isNonEmptyString, "is required (a final document must name the draft it supersedes)");
      break;
    case "document_superseded":
      require("document_key", isNonEmptyString, "must be a non-empty string");
      require("superseded_by_document_key", isNonEmptyString, "must be a non-empty string");
      break;
    case "final_determination_issued":
      require("action_key", isNonEmptyString, "must be a non-empty string");
      require("determination_key", isNonEmptyString, "must be a non-empty string");
      require("agency", isNonEmptyString, "must be a non-empty string");
      require("date", isNonEmptyString, "must be a non-empty string");
      require("outcome", isNonEmptyString, "must be a non-empty string");
      if (!("supersedes_determination_key" in payload)) findings.push(`${label}: payload.supersedes_determination_key is required (use null when this is not a correction)`);
      break;
    case "determination_superseded":
      require("determination_key", isNonEmptyString, "must be a non-empty string");
      require("superseded_by_determination_key", isNonEmptyString, "must be a non-empty string");
      break;
    case "topic_assessed":
      require("technical_topic", (value) => SEQRA_TECHNICAL_TOPICS.includes(value), "must be one of SEQRA_TECHNICAL_TOPICS");
      require("state", (value) => SEQRA_TOPIC_ASSESSMENT_STATES.includes(value), "must be one of SEQRA_TOPIC_ASSESSMENT_STATES");
      break;
    case "mitigation_committed":
      require("description", isNonEmptyString, "must be a non-empty string");
      require("status", isNonEmptyString, "must be a non-empty string");
      break;
    case "alternative_considered":
      require("name", isNonEmptyString, "must be a non-empty string");
      require("status", isNonEmptyString, "must be a non-empty string");
      break;
    case "position_taken":
      require("organization_key", isNonEmptyString, "must be a non-empty string");
      require("position", isNonEmptyString, "must be a non-empty string");
      break;
    default:
      break;
  }
  return findings;
}

/** Validate one review_event against the ontology schema plus its event_type payload contract. */
export function validateReviewEventShape(event, label = event?.event_key ?? "review_event") {
  const findings = validateSeqraEntity("review_event", event, label);
  if (findings.length === 0) findings.push(...payloadFindings(event, label));
  return findings;
}

function effectiveAtMs(event) {
  const ms = Date.parse(event.effective_at);
  if (!Number.isFinite(ms)) throw new Error(`review event ${event.event_key}: effective_at is not a parseable timestamp`);
  return ms;
}
function availableAtMs(event) {
  const ms = Date.parse(event.available_to_public_at);
  if (!Number.isFinite(ms)) throw new Error(`review event ${event.event_key}: available_to_public_at is not a parseable timestamp`);
  return ms;
}

/** Sort events deterministically by (effective_at, event_key); never by array insertion order. */
export function sortReviewEvents(events) {
  return [...events].sort((a, b) => {
    const diff = effectiveAtMs(a) - effectiveAtMs(b);
    if (diff !== 0) return diff;
    return a.event_key < b.event_key ? -1 : a.event_key > b.event_key ? 1 : 0;
  });
}

/**
 * Validate and deduplicate a batch of review events into a canonical,
 * deterministically sorted append-only log. Throws SeqraOntologyValidationError
 * (collecting every finding, not just the first) rather than silently
 * dropping or coercing a malformed event -- an event that does not match its
 * own declared shape never enters the log.
 */
export function buildAppendOnlyLog(events = []) {
  const findings = [];
  for (const event of events) {
    findings.push(...validateReviewEventShape(event, event?.event_key ?? "(missing event_key)"));
  }
  if (findings.length > 0) throw new SeqraOntologyValidationError(findings);

  const byKey = new Map();
  for (const event of events) {
    const existing = byKey.get(event.event_key);
    if (existing && JSON.stringify(stable(existing)) !== JSON.stringify(stable(event))) {
      throw new SeqraOntologyValidationError([
        `${event.event_key}: duplicate event_key with differing content -- event keys are content-addressed and must be immutable`,
      ]);
    }
    byKey.set(event.event_key, event);
  }
  return {
    schema: "cityscroll.seqra_review_event_log.v1",
    events: Object.freeze(sortReviewEvents([...byKey.values()])),
  };
}

/**
 * Detect contradictions across a set of already schema-valid review events,
 * independent of cutoff. Pure and order-independent: the same event set
 * produces the same contradictions regardless of array order.
 */
export function detectContradictions(events) {
  const contradictions = [];
  const byKey = new Map(events.map((event) => [event.event_key, event]));

  // Final-before-draft: every final_document_published event must name a
  // draft_document_published event for the same document_key, strictly
  // earlier by effective_at.
  const draftPublishByDocumentKey = new Map();
  for (const event of events) {
    if (event.event_type === "draft_document_published") {
      draftPublishByDocumentKey.set(event.payload.document_key, event);
    }
  }
  for (const event of events) {
    if (event.event_type !== "final_document_published") continue;
    const draftKey = event.payload.supersedes_document_key;
    const draftEvent = draftKey ? draftPublishByDocumentKey.get(draftKey) : null;
    if (!draftEvent) {
      contradictions.push({
        type: CONTRADICTION_TYPES.FINAL_BEFORE_DRAFT,
        message: `${event.event_key}: final document ${event.payload.document_key} names no known prior draft (supersedes_document_key=${JSON.stringify(draftKey)})`,
        event_keys: [event.event_key],
      });
      continue;
    }
    if (effectiveAtMs(draftEvent) >= effectiveAtMs(event)) {
      contradictions.push({
        type: CONTRADICTION_TYPES.FINAL_BEFORE_DRAFT,
        message: `${event.event_key}: final document published at ${event.effective_at} is not after its draft ${draftEvent.event_key} published at ${draftEvent.effective_at}`,
        event_keys: [draftEvent.event_key, event.event_key],
      });
    }
  }

  // Conflicting determinations: group final_determination_issued events by
  // action_key; after removing every determination explicitly superseded
  // (by a determination_superseded event or by a later determination's
  // supersedes_determination_key), more than one surviving outcome for the
  // same action is a contradiction.
  const determinationEventsByAction = new Map();
  for (const event of events) {
    if (event.event_type !== "final_determination_issued") continue;
    const bucket = determinationEventsByAction.get(event.payload.action_key) ?? [];
    bucket.push(event);
    determinationEventsByAction.set(event.payload.action_key, bucket);
  }
  const supersededDeterminationKeys = new Set();
  for (const event of events) {
    if (event.event_type === "determination_superseded") {
      supersededDeterminationKeys.add(event.payload.determination_key);
    }
    if (event.event_type === "final_determination_issued" && event.payload.supersedes_determination_key) {
      supersededDeterminationKeys.add(event.payload.supersedes_determination_key);
    }
  }
  for (const [actionKey, determinationEvents] of determinationEventsByAction) {
    const surviving = determinationEvents.filter((event) => !supersededDeterminationKeys.has(event.payload.determination_key));
    const outcomes = new Set(surviving.map((event) => event.payload.outcome));
    if (surviving.length > 1 && outcomes.size > 1) {
      contradictions.push({
        type: CONTRADICTION_TYPES.CONFLICTING_DETERMINATIONS,
        message: `${actionKey}: ${surviving.length} unsuperseded determinations with conflicting outcomes (${[...outcomes].join(", ")})`,
        event_keys: surviving.map((event) => event.event_key),
      });
    }
  }

  for (const contradiction of contradictions) {
    for (const key of contradiction.event_keys) {
      if (!byKey.has(key)) throw new Error(`internal error: contradiction references unknown event_key ${key}`);
    }
  }
  return contradictions;
}

/**
 * Reconstruct the state of one review as of an arbitrary historical cutoff,
 * from the append-only log alone. Only events whose available_to_public_at
 * is on or before the cutoff are considered -- a feature that became public
 * after the cutoff never leaks into the projection. When a contradiction
 * touching this review's own events is visible as of the cutoff, this
 * returns `{ ok: false, contradictions }` instead of guessing a state.
 */
export function projectReviewStateAsOf(allEvents, { reviewKey, cutoff } = {}) {
  if (!reviewKey) throw new Error("projectReviewStateAsOf requires reviewKey");
  if (!cutoff) throw new Error("projectReviewStateAsOf requires cutoff");
  const cutoffMs = Date.parse(cutoff);
  if (!Number.isFinite(cutoffMs)) throw new Error(`cutoff is not a parseable timestamp: ${cutoff}`);

  const visible = sortReviewEvents(allEvents.filter((event) => availableAtMs(event) <= cutoffMs));
  const contradictions = detectContradictions(visible);
  const surfaced = contradictions.filter((contradiction) =>
    contradiction.event_keys.some((key) => visible.find((event) => event.event_key === key)?.review_key === reviewKey));

  if (surfaced.length > 0) {
    return { ok: false, schema: SEQRA_REVIEW_PROJECTION_SCHEMA, review_key: reviewKey, cutoff, contradictions: surfaced };
  }

  const reviewEvents = visible.filter((event) => event.review_key === reviewKey);

  const milestones = reviewEvents.map((event) => ({
    event_key: event.event_key,
    event_type: event.event_type,
    effective_at: event.effective_at,
  }));

  const documents = {};
  const documentSupersededBy = {};
  for (const event of reviewEvents) {
    if (event.event_type === "draft_document_published" || event.event_type === "final_document_published") {
      documents[event.payload.document_key] = {
        document_key: event.payload.document_key,
        document_type: event.payload.document_type,
        document_stage: event.event_type === "draft_document_published" ? "draft" : "final",
        content_hash: event.payload.content_hash,
        effective_at: event.effective_at,
        published_by_event_key: event.event_key,
      };
      if (event.event_type === "final_document_published" && event.payload.supersedes_document_key) {
        documentSupersededBy[event.payload.supersedes_document_key] = event.payload.document_key;
      }
    }
    if (event.event_type === "document_superseded") {
      documentSupersededBy[event.payload.document_key] = event.payload.superseded_by_document_key;
    }
  }
  for (const [key, doc] of Object.entries(documents)) {
    doc.superseded_by_document_key = documentSupersededBy[key] ?? null;
  }

  const determinations = {};
  const determinationSupersededBy = {};
  for (const event of reviewEvents) {
    if (event.event_type === "final_determination_issued") {
      determinations[event.payload.determination_key] = {
        determination_key: event.payload.determination_key,
        action_key: event.payload.action_key,
        agency: event.payload.agency,
        date: event.payload.date,
        outcome: event.payload.outcome,
        effective_at: event.effective_at,
        issued_by_event_key: event.event_key,
      };
      if (event.payload.supersedes_determination_key) {
        determinationSupersededBy[event.payload.supersedes_determination_key] = event.payload.determination_key;
      }
    }
    if (event.event_type === "determination_superseded") {
      determinationSupersededBy[event.payload.determination_key] = event.payload.superseded_by_determination_key;
    }
  }
  for (const [key, determination] of Object.entries(determinations)) {
    determination.superseded_by_determination_key = determinationSupersededBy[key] ?? null;
  }

  const topics = {};
  for (const event of reviewEvents) {
    if (event.event_type !== "topic_assessed") continue;
    topics[event.payload.technical_topic] = {
      technical_topic: event.payload.technical_topic,
      state: event.payload.state,
      document_key: event.payload.document_key ?? null,
      effective_at: event.effective_at,
      as_of_event_key: event.event_key,
    };
  }

  const mitigations = reviewEvents
    .filter((event) => event.event_type === "mitigation_committed")
    .map((event) => ({ description: event.payload.description, status: event.payload.status, effective_at: event.effective_at, event_key: event.event_key }));

  const alternatives = reviewEvents
    .filter((event) => event.event_type === "alternative_considered")
    .map((event) => ({ name: event.payload.name, status: event.payload.status, effective_at: event.effective_at, event_key: event.event_key }));

  const positions = reviewEvents
    .filter((event) => event.event_type === "position_taken")
    .map((event) => ({
      organization_key: event.payload.organization_key,
      position: event.payload.position,
      named_issue: event.payload.named_issue ?? null,
      effective_at: event.effective_at,
      event_key: event.event_key,
    }));

  return {
    ok: true,
    schema: SEQRA_REVIEW_PROJECTION_SCHEMA,
    review_key: reviewKey,
    cutoff,
    event_count: reviewEvents.length,
    current_stage: milestones.length > 0 ? milestones[milestones.length - 1].event_type : null,
    milestones,
    documents,
    determinations,
    topics,
    mitigations,
    alternatives,
    positions,
  };
}

export function stringifyReviewState(state) {
  return `${JSON.stringify(stable(state), null, 2)}\n`;
}

export { SEQRA_REVIEW_EVENT_TYPES, SeqraOntologyValidationError };
