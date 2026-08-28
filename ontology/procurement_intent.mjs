/**
 * Prospective Procurement Intent Radar ontology.
 *
 * The source record, the actor's future-action assertion, and the provisional
 * procurement identity are separate registers. A later publisher identity is
 * deliberately represented by explicit nulls and empty relationship arrays at
 * creation time; it is never inferred from the source text.
 */

import { buildPrediction, validatePrediction } from "../worker/src/lib/prediction_contract.mjs";

export const SOURCE_RECORD_SCHEMA = "cityscroll.source_record.v0";
export const FUTURE_ACTION_ASSERTION_SCHEMA = "cityscroll.future_action_assertion.v0";
export const PROVISIONAL_PROCUREMENT_IDENTITY_SCHEMA = "cityscroll.provisional_procurement_identity.v0";
export const PROSPECTIVE_PROCESS_SCHEMA = "cityscroll.prospective_procurement_process.v0";
export const PROSPECTIVE_EVENT_KIND = "procurement.notice_published";
export const PROSPECTIVE_PREDICTION_VERSION = "0.1.0";

const SOURCE_FIELDS = new Set([
  "schema", "object_type", "source_record_id", "source_record_ref", "source_event_id",
  "observed_at", "observed_at_precision", "speaker", "source_type", "source_title",
  "source_span_text", "span_text_status", "citations",
]);
const ASSERTION_FIELDS = new Set([
  "schema", "object_type", "assertion_id", "source_record_id", "source_event_id",
  "source_span", "observed_at", "asserted_by_person_ref", "responsible_agency_ref",
  "action_kind", "object_text", "program_refs", "procurement_type",
  "quantity_assertions", "money_assertions", "geography_refs", "population_terms",
  "expected_window", "modality", "conditions", "extraction_method",
  "extraction_version", "extraction_confidence",
]);
const FORBIDDEN_ASSERTION_FIELDS = new Set([
  "epin", "pin", "procurement_id", "vendor", "vendor_ref", "vendor_name", "title",
  "later_title", "realized_at", "realized_by", "realization", "solicitation_id",
]);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const EPIN = /\b\d{5}[A-Z]\d{4}\b/u;

// These are readable source-side labels, not downstream procurement IDs. The
// deterministic fallback keeps custom sources stable without any realization
// lookup or title/vendor matching.
const SUBJECT_HINTS = Object.freeze({
  "faa:compass-dycd-2025-05-19": "dycd-compass-2025",
  "faa:hra-dv-beds-2024-10-09": "hra-dv-94-beds-2024",
  "faa:acs-atd-2022-03-09": "acs-atd-2022",
});

function clean(value, label, { required = false, max = 2_000 } = {}) {
  const result = String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, max);
  if (required && !result) throw new TypeError(`${label} is required`);
  return result;
}

function isoDay(value, label) {
  const result = clean(value, label, { required: true, max: 20 });
  if (!ISO_DAY.test(result)) throw new TypeError(`${label} must be an ISO date`);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new TypeError(`${label} must be a real ISO date`);
  }
  return result;
}

function token(value, label) {
  const result = clean(value, label, { required: true, max: 320 });
  if (/\s/.test(result)) throw new TypeError(`${label} must not contain whitespace`);
  return result;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function exactFields(value, fields, label) {
  requirePlainObject(value, label);
  const unknown = Object.keys(value).filter((key) => !fields.has(key));
  if (unknown.length) throw new TypeError(`${label} has unknown field ${unknown.join(", ")}`);
}

function requiredString(value, label) {
  return clean(value, label, { required: true });
}

function sourceRef(sourceRecordId) {
  return `source_record:${sourceRecordId}`;
}

function citationRows(value) {
  if (!Array.isArray(value)) throw new TypeError("source_record.citations must be an array");
  return value.map((citation, index) => {
    requirePlainObject(citation, `source_record.citations[${index}]`);
    return deepFreeze(clone(citation));
  });
}

/** Build the immutable evidence register from the PIR-1 source object. */
export function buildSourceRecord(source = {}) {
  requirePlainObject(source, "source");
  const recordId = requiredString(source.source_record_id, "source.source_record_id");
  const eventId = requiredString(source.source_event_id, "source.source_event_id");
  const observedAt = isoDay(source.observed_at, "source.observed_at");
  requirePlainObject(source.speaker, "source.speaker");
  const result = {
    schema: SOURCE_RECORD_SCHEMA,
    object_type: "source_record",
    source_record_id: recordId,
    source_record_ref: sourceRef(recordId),
    source_event_id: eventId,
    observed_at: observedAt,
    observed_at_precision: clean(source.observed_at_precision, "source.observed_at_precision", { max: 40 }) || "day",
    speaker: clone(source.speaker),
    source_type: requiredString(source.source_type, "source.source_type"),
    source_title: requiredString(source.source_title, "source.source_title"),
    source_span_text: requiredString(source.source_span_text, "source.source_span_text"),
    // PIR-1's materialized review row does not carry the fixture's optional
    // span status; retain that omission as an explicit unknown.
    span_text_status: clean(source.span_text_status, "source.span_text_status", { max: 40 }) || "unknown",
    citations: citationRows(source.citations),
  };
  exactFields(result, SOURCE_FIELDS, "source_record");
  return deepFreeze(result);
}

function rejectFutureOnlyAssertionFields(assertion) {
  const forbidden = Object.keys(assertion).filter((key) => FORBIDDEN_ASSERTION_FIELDS.has(key));
  if (forbidden.length) throw new TypeError(`future-action assertion contains future-only field ${forbidden.join(", ")}`);
  if (EPIN.test(JSON.stringify(assertion))) {
    throw new TypeError("future-action assertion contains a publisher EPIN");
  }
}

/**
 * Build the actor statement register. This is the PIR-1 assertion contract
 * plus an explicit ontology envelope; no realization fields are accepted.
 */
export function buildStatedIntent(assertion = {}, sourceRecord = null) {
  requirePlainObject(assertion, "assertion");
  const result = {
    schema: FUTURE_ACTION_ASSERTION_SCHEMA,
    object_type: "stated_intent",
    ...clone(assertion),
  };
  rejectFutureOnlyAssertionFields(result);
  exactFields(result, ASSERTION_FIELDS, "stated_intent");
  for (const field of ["assertion_id", "source_record_id", "source_event_id", "source_span", "object_text", "responsible_agency_ref", "action_kind", "procurement_type", "extraction_method", "extraction_version"]) {
    requiredString(result[field], `stated_intent.${field}`);
  }
  isoDay(result.observed_at, "stated_intent.observed_at");
  if (result.asserted_by_person_ref !== null) token(result.asserted_by_person_ref, "stated_intent.asserted_by_person_ref");
  if (result.action_kind !== "procurement.solicitation_publish") throw new TypeError("stated_intent.action_kind must be procurement.solicitation_publish");
  if (!Array.isArray(result.program_refs) || !Array.isArray(result.quantity_assertions)
      || !Array.isArray(result.money_assertions) || !Array.isArray(result.geography_refs)
      || !Array.isArray(result.population_terms) || !Array.isArray(result.conditions)) {
    throw new TypeError("stated_intent qualifier fields must be arrays");
  }
  requirePlainObject(result.expected_window, "stated_intent.expected_window");
  if (sourceRecord) {
    if (result.source_record_id !== sourceRecord.source_record_id
        || result.source_event_id !== sourceRecord.source_event_id
        || result.source_span !== sourceRecord.source_span_text
        || result.observed_at !== sourceRecord.observed_at) {
      throw new TypeError("stated_intent provenance must match source_record exactly");
    }
  }
  return deepFreeze(result);
}

function fallbackSubjectSlug(intent) {
  const agency = String(intent.responsible_agency_ref || "agency-unresolved")
    .replace(/^agency:id:/u, "")
    .replace(/[^a-z0-9]+/giu, "-");
  const object = String(intent.object_text || "procurement")
    .replace(/\bRFP\b/giu, "")
    .replace(/[^a-z0-9]+/giu, "-");
  const year = String(intent.observed_at || "").slice(0, 4);
  return [agency, object, year].filter(Boolean).join("-").replace(/-+/gu, "-").replace(/^-|-$/gu, "").toLowerCase();
}

export function makeProvisionalSubjectRef(intent = {}, subjectRef = null) {
  const supplied = clean(subjectRef, "subject_ref", { max: 320 });
  if (supplied) {
    if (!/^procurement-intent:[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(supplied)) {
      throw new TypeError("subject_ref must be a procurement-intent slug");
    }
    return supplied;
  }
  const hint = SUBJECT_HINTS[intent.assertion_id] || fallbackSubjectSlug(intent);
  if (!hint) throw new TypeError("unable to build a provisional procurement subject");
  return `procurement-intent:${hint}`;
}

/** Build the publisher identity placeholder, with unknowns explicit. */
export function buildProvisionalProcurementIdentity(subjectRef) {
  const ref = makeProvisionalSubjectRef({}, subjectRef);
  return deepFreeze({
    schema: PROVISIONAL_PROCUREMENT_IDENTITY_SCHEMA,
    object_type: "procurement_identity",
    identity_kind: "provisional_procurement_intent",
    subject_ref: ref,
    status: "prospective",
    epin: null,
    pin: null,
    procurement_id: null,
    publisher_identity: null,
    realized_by: [],
    superseded_by: [],
    unknowns: [
      "publisher_native_procurement_identity",
      "realized_procurement_records",
      "realization_cardinality",
      "superseding_intent",
    ],
  });
}

function edge({ relation, from, to, targetType, status, basis }) {
  return {
    relation,
    from,
    to,
    target_type: targetType,
    status,
    basis,
  };
}

function buildEdges(subjectRef, sourceRecord, intent) {
  const edges = [
    edge({ relation: "asserted_in", from: subjectRef, to: sourceRecord.source_record_ref, targetType: "source_record", status: "accepted", basis: "source_record_id" }),
    edge({ relation: "asserted_by", from: subjectRef, to: intent.asserted_by_person_ref, targetType: "person", status: intent.asserted_by_person_ref ? "accepted" : "unknown", basis: "source speaker identity" }),
    edge({ relation: "owned_by", from: subjectRef, to: intent.responsible_agency_ref === "agency:unresolved" ? null : intent.responsible_agency_ref, targetType: "agency", status: intent.responsible_agency_ref === "agency:unresolved" ? "unknown" : "accepted", basis: "responsible_agency_ref" }),
    edge({ relation: "expects_event", from: subjectRef, to: PROSPECTIVE_EVENT_KIND, targetType: "event_kind", status: "accepted", basis: "action_kind" }),
    edge({ relation: "realized_by", from: subjectRef, to: null, targetType: "procurement", status: "not_yet_observed", basis: "publisher identity absent at creation" }),
    edge({ relation: "superseded_by", from: subjectRef, to: null, targetType: "procurement-intent", status: "not_observed", basis: "no later intent supplied" }),
  ];
  const programs = intent.program_refs.filter((ref) => typeof ref === "string" && ref.trim());
  if (programs.length) {
    for (const program of programs) edges.push(edge({ relation: "concerns", from: subjectRef, to: program, targetType: "program", status: "accepted", basis: "program_refs" }));
  } else {
    edges.push(edge({ relation: "concerns", from: subjectRef, to: null, targetType: "program", status: "unknown", basis: "no program reference in source assertion" }));
  }
  return edges;
}

function midpoint(start, end) {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return new Date(a + Math.floor((b - a) / 2)).toISOString().slice(0, 10);
}

/** Convert the source-language window into a conservative prediction window. */
export function conservativePredictionWindow(expectedWindow, observedAt) {
  requirePlainObject(expectedWindow, "expected_window");
  const earliest = expectedWindow.earliest ? isoDay(expectedWindow.earliest, "expected_window.earliest") : observedAt;
  const latest = expectedWindow.latest ? isoDay(expectedWindow.latest, "expected_window.latest") : null;
  if (!latest) return null;
  if (earliest > latest) throw new TypeError("expected_window must not run backwards");
  return { p10: earliest, p50: midpoint(earliest, latest), p90: latest };
}

function predictionFor(subjectRef, intent, claim, window) {
  return buildPrediction({
    subject_ref: subjectRef,
    predicted_event_kind: PROSPECTIVE_EVENT_KIND,
    claim,
    predicted_window: window,
    // The prediction contract requires a probability. 0.5 is an explicitly
    // uncalibrated neutral placeholder and is not a public confidence score.
    probability: 0.5,
    basis: {
      method: "base_rate",
      n: 1,
      train_from: intent.observed_at,
      train_to: intent.observed_at,
      cohort: "pir.explicit_future_procurement",
      evidence_event_ids: [intent.source_event_id],
      statute_ref: null,
    },
    model_name: `prospective_procurement_${claim}`,
    model_version: PROSPECTIVE_PREDICTION_VERSION,
    generated_at: `${intent.observed_at}T00:00:00.000Z`,
    supersedes_prediction_id: null,
    status: "open",
    resolved_by_event_id: null,
  });
}

/** Materialize one open process from a PIR-1 candidate row or its two objects. */
export function buildProspectiveProcess({ source, sourceRecord, assertion, statedIntent, subjectRef = null } = {}) {
  const sourceObject = sourceRecord || source;
  const record = sourceObject?.schema === SOURCE_RECORD_SCHEMA ? sourceObject : buildSourceRecord(sourceObject);
  const intent = statedIntent || buildStatedIntent(assertion, record);
  const ref = makeProvisionalSubjectRef(intent, subjectRef);
  const identity = buildProvisionalProcurementIdentity(ref);
  const window = conservativePredictionWindow(intent.expected_window, intent.observed_at);
  const predictions = {
    occurrence: window ? predictionFor(ref, intent, "occurrence", window) : null,
    timing: window ? predictionFor(ref, intent, "timing", window) : null,
  };
  return deepFreeze({
    schema: PROSPECTIVE_PROCESS_SCHEMA,
    object_type: "prospective_procurement_process",
    process_ref: ref,
    status: "open",
    source_record: record,
    stated_intent: intent,
    procurement_identity: identity,
    edges: buildEdges(ref, record, intent),
    predictions,
    unknowns: [...identity.unknowns, ...(window ? [] : ["timing_prediction_window"])],
  });
}

export function validateProspectiveProcess(process = {}) {
  requirePlainObject(process, "prospective_process");
  if (process.schema !== PROSPECTIVE_PROCESS_SCHEMA || process.object_type !== "prospective_procurement_process") {
    throw new TypeError("invalid prospective process schema");
  }
  const sourceRecord = buildSourceRecord(process.source_record);
  const intent = buildStatedIntent(process.stated_intent, sourceRecord);
  const expectedRef = makeProvisionalSubjectRef(intent, process.process_ref);
  if (process.process_ref !== expectedRef || process.procurement_identity?.subject_ref !== expectedRef) {
    throw new TypeError("prospective process identity is inconsistent");
  }
  if (process.procurement_identity?.epin !== null || process.procurement_identity?.pin !== null
      || process.procurement_identity?.procurement_id !== null || process.procurement_identity?.publisher_identity !== null) {
    throw new TypeError("prospective process cannot contain a later publisher identity");
  }
  for (const claim of ["occurrence", "timing"]) {
    const prediction = process.predictions?.[claim];
    if (prediction) {
      validatePrediction(prediction);
      if (prediction.subject_ref !== expectedRef || prediction.predicted_event_kind !== PROSPECTIVE_EVENT_KIND || prediction.claim !== claim || prediction.status !== "open") {
        throw new TypeError(`${claim} prediction is not an open exact-subject prediction`);
      }
    }
  }
  return process;
}
