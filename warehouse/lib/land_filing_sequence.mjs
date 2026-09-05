/**
 * LDP-26: materialize a bounded, source-qualified filing sequence for one
 * land-use project by consuming the typed contracts LDP-23/LDP-24 already
 * registered (ontology/land_use_filing.mjs, land_filing_document_collector.mjs)
 * and the environmental facts LDP-02/LDP-13 already project and reconcile
 * (zap_environmental_projection.mjs, ceqr_project_milestone_reconciliation.mjs).
 *
 * This module builds no collector and fetches nothing. Every event is a pure
 * function of already-assembled records: a ZAP row, an obligation array, a
 * document manifest, and (optionally) one joined CEQR reconciliation row.
 * Environmental identity and milestones are read through the existing owners'
 * own exported functions/output shapes, never re-derived here -- the second
 * environmental collector the card's out-of-scope list forbids would mean
 * reimplementing that extraction, not calling it.
 *
 * Each event keeps its own clock: `clock_kind` names what kind of time
 * `observed_at` represents, and `observed_at`/`available_to_public_at` are
 * `null` together whenever no source clock could be resolved -- `clock_kind`
 * is then explicitly `"unknown"` rather than silently defaulting to "now".
 * No event here is ever translated into readiness, completeness, deficiency,
 * cooperation, delay, or procedural blockage: `legal_effect` is populated
 * only by copying an already-validated `procedural_effect` object off a real
 * LDP-23 obligation, never authored fresh, and no field in this module's own
 * exported vocabulary (event kinds, clock kinds, conflict states) may equal
 * a forbidden observation synonym -- enforced by this module's own test.
 *
 * This module holds no state across runs: unlike the LDP-24 document
 * collector (which reconciles `previousDocuments` so identity is stable
 * across reruns), a ZAP-row-derived event simply reflects whatever the
 * publisher currently asserts on each call. Only the document/obligation
 * records this module *consumes* carry their own already-reconciled clocks.
 */
import {
  FILING_CONFIDENCE_LEVELS,
} from "../../ontology/land_use_filing.mjs";
import {
  ZAP_ENVIRONMENTAL_DATASET_ID,
  projectZapEnvironmentalFields,
} from "./zap_environmental_projection.mjs";
import { CEQR_MILESTONES_DATASET_ID } from "./ceqr_project_milestone_reconciliation.mjs";

export const LAND_FILING_SEQUENCE_SCHEMA = "cityscroll.land_use_filing_sequence.v1";
export const LAND_FILING_SEQUENCE_VERSION = "1.0.0";
export const FILING_SEQUENCE_EVENT_SCHEMA = "cityscroll.land_use_filing_sequence_event.v1";
export const FILING_SEQUENCE_EVENT_VERSION = "1.0.0";
export const FILING_SEQUENCE_OBSERVATION_SUMMARY_SCHEMA = "cityscroll.land_use_filing_sequence_observation_summary.v1";
export const FILING_SEQUENCE_DIGEST_SCHEMA = "cityscroll.land_use_filing_sequence_digest.v1";

/** Resident/first-paint digests bound at 40 entries, matching this repo's existing link/batch convention. */
export const LAND_FILING_SEQUENCE_DIGEST_LIMIT = 40;

export const FILING_SEQUENCE_EVENT_KINDS = Object.freeze([
  "application_filed",
  "package_version_observed",
  "applicability_asserted",
  "report_first_observed",
  "report_not_timely_filed_notice",
  "notice_of_receipt_observed",
  "application_noticed",
  "application_certified_or_referred",
  "document_superseded",
  "environmental_identity_observed",
  "environmental_milestone_observed",
]);

export const FILING_SEQUENCE_CLOCK_KINDS = Object.freeze([
  "publisher_asserted_calendar_date",
  "document_first_observed_at",
  "source_materialization_vintage",
  "unknown",
]);

export const FILING_SEQUENCE_CONFLICT_STATES = Object.freeze([
  "none",
  "source_conflict",
  "multiple_candidates",
  "unresolved_clock",
]);

const ZAP_PUBLISHER_SOURCE_ID = "nyc-zap-open-data";
const ZAP_OUTCOMES_PUBLISHER_SOURCE_ID = "zap-api-outcomes";
const CEQR_MILESTONES_PUBLISHER_SOURCE_ID = "nyc-ceqr-milestones-open-data";

/* ------------------------------------------------------------------ */
/* Small local primitives (mirrors ontology/land_use_filing.mjs style) */
/* ------------------------------------------------------------------ */

function cleanText(value, max = 500) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function requireString(value, field, max = 500) {
  const result = cleanText(value, max);
  if (!result) throw new TypeError(`${field} is required`);
  return result;
}

function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${field} must be one of ${allowed.join("|")}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function isParseableTimestamp(value) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function optionalTimestamp(value, field) {
  if (value == null) return null;
  if (!isParseableTimestamp(value)) {
    throw new TypeError(`${field} must be an ISO timestamp or null, got ${JSON.stringify(value)}`);
  }
  return cleanText(value, 80);
}

function projectRefToken(value) {
  const result = cleanText(value, 240);
  if (!/^project:[^\s:]+$/.test(result)) {
    throw new TypeError(`project_ref must look like "project:{project_id}", got ${JSON.stringify(value)}`);
  }
  return result;
}

function boundedDetail(value, maxJsonLength = 4_000) {
  if (value == null) return null;
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new TypeError("detail must be JSON-serializable");
  }
  if (json.length > maxJsonLength) throw new TypeError(`detail exceeds ${maxJsonLength} bytes`);
  return Object.freeze(JSON.parse(json));
}

function buildPublisher(value) {
  if (!value || typeof value !== "object") throw new TypeError("publisher is required ({source_id, source_dataset_id?})");
  return Object.freeze({
    source_id: requireString(value.source_id, "publisher.source_id", 200),
    source_dataset_id: value.source_dataset_id == null ? null : cleanText(value.source_dataset_id, 100),
  });
}

function buildRefs(value = {}) {
  return Object.freeze({
    document_ref: value.document_ref == null ? null : requireString(value.document_ref, "refs.document_ref", 400),
    obligation_ref: value.obligation_ref == null ? null : requireString(value.obligation_ref, "refs.obligation_ref", 400),
  });
}

function buildLegalEffect(value) {
  if (value == null) return null;
  return Object.freeze({
    certification_blocker: value.certification_blocker === true,
    missing_report_notification_required: value.missing_report_notification_required ?? "unknown",
    legal_basis: value.legal_basis == null ? null : cleanText(value.legal_basis, 500),
  });
}

/** The clock is unresolved iff observed_at is null; an explicit stronger conflict wins over that default. */
function resolveConflictState({ observedAt, explicit = "none" }) {
  if (observedAt == null) return explicit === "none" ? "unresolved_clock" : explicit;
  return explicit;
}

/**
 * `available_to_public_at` is the later of the fact's own asserted clock and
 * the source vintage we actually observed it under -- CityScroll cannot claim
 * public availability earlier than either the real-world date or the moment
 * its own materialization first carried the value.
 */
export function bestSupportedAvailability({ observedAt = null, sourceVintage = null } = {}) {
  const validObserved = isParseableTimestamp(observedAt) ? observedAt : null;
  const validVintage = isParseableTimestamp(sourceVintage) ? sourceVintage : null;
  if (!validObserved && !validVintage) return null;
  if (!validObserved) return validVintage;
  if (!validVintage) return validObserved;
  return Date.parse(validVintage) >= Date.parse(validObserved) ? validVintage : validObserved;
}

/* ------------------------------------------------------------------ */
/* cityscroll.land_use_filing_sequence_event.v1                       */
/* ------------------------------------------------------------------ */

export function filingSequenceEventId({ project_ref, event_kind, disambiguator = null }) {
  const p = projectRefToken(project_ref);
  const k = requireEnum(event_kind, FILING_SEQUENCE_EVENT_KINDS, "event_kind");
  const d = disambiguator == null ? "none" : encodeURIComponent(cleanText(disambiguator, 400));
  return `land_use_filing_sequence_event:${p.slice("project:".length)}:${k}:${d}`;
}

export function buildFilingSequenceEvent(input = {}) {
  const projectRef = projectRefToken(input.project_ref);
  const eventKind = requireEnum(input.event_kind, FILING_SEQUENCE_EVENT_KINDS, "event_kind");
  const clockKind = requireEnum(input.clock_kind, FILING_SEQUENCE_CLOCK_KINDS, "clock_kind");
  const observedAt = optionalTimestamp(input.observed_at, "observed_at");
  if ((observedAt == null) !== (clockKind === "unknown")) {
    throw new TypeError(
      "clock_kind 'unknown' requires observed_at to be null, and any other clock_kind requires a non-null observed_at",
    );
  }
  const availableToPublicAt = optionalTimestamp(input.available_to_public_at, "available_to_public_at");
  if (observedAt == null && availableToPublicAt != null) {
    throw new TypeError("available_to_public_at cannot be set when observed_at is null (unresolved clock)");
  }
  const conflictState = requireEnum(
    input.conflict_state ?? (observedAt == null ? "unresolved_clock" : "none"),
    FILING_SEQUENCE_CONFLICT_STATES,
    "conflict_state",
  );
  if (observedAt == null && conflictState === "none") {
    throw new TypeError("conflict_state cannot be 'none' when observed_at is null; use 'unresolved_clock' or a stronger conflict state");
  }

  return Object.freeze({
    schema: FILING_SEQUENCE_EVENT_SCHEMA,
    version: FILING_SEQUENCE_EVENT_VERSION,
    event_id: filingSequenceEventId({ project_ref: projectRef, event_kind: eventKind, disambiguator: input.disambiguator }),
    project_ref: projectRef,
    event_kind: eventKind,
    publisher: buildPublisher(input.publisher),
    source_record_id: requireString(input.source_record_id, "source_record_id", 300),
    clock_kind: clockKind,
    observed_at: observedAt,
    available_to_public_at: availableToPublicAt,
    legal_effect: buildLegalEffect(input.legal_effect),
    confidence: requireEnum(input.confidence, FILING_CONFIDENCE_LEVELS, "confidence"),
    conflict_state: conflictState,
    refs: buildRefs(input.refs),
    detail: boundedDetail(input.detail),
    basis: input.basis == null ? null : cleanText(input.basis, 500),
  });
}

export function validateFilingSequenceEvent(record) {
  buildFilingSequenceEvent(record);
  return true;
}

/* ------------------------------------------------------------------ */
/* Per-source event builders -- each is a pure function over one       */
/* already-assembled record; none fetches or parses anything.          */
/* ------------------------------------------------------------------ */

/**
 * A ZAP row's publisher-asserted calendar date, when present and parseable.
 * Absent entirely -> no event (honest absence). Present but malformed -> an
 * explicit event with an unresolved clock, never silently dropped.
 */
function zapCalendarDateEvent({ projectRef, zapRow, zapSourceVintage, sourceField, eventKind }) {
  const raw = zapRow?.[sourceField];
  if (raw == null || cleanText(raw) === "") return null;
  const rawText = cleanText(raw, 80);
  const observedAt = isParseableTimestamp(rawText) ? rawText : null;
  const availableToPublicAt = observedAt ? bestSupportedAvailability({ observedAt, sourceVintage: zapSourceVintage }) : null;
  return buildFilingSequenceEvent({
    project_ref: projectRef,
    event_kind: eventKind,
    disambiguator: sourceField,
    publisher: { source_id: ZAP_PUBLISHER_SOURCE_ID, source_dataset_id: ZAP_ENVIRONMENTAL_DATASET_ID },
    source_record_id: projectRef.slice("project:".length),
    clock_kind: observedAt ? "publisher_asserted_calendar_date" : "unknown",
    observed_at: observedAt,
    available_to_public_at: availableToPublicAt,
    confidence: observedAt ? "high" : "unknown",
    detail: { source_field: sourceField, raw_value: rawText },
  });
}

export function applicationFiledEvent({ projectRef, zapRow, zapSourceVintage = null } = {}) {
  return zapCalendarDateEvent({ projectRef, zapRow, zapSourceVintage, sourceField: "app_filed_date", eventKind: "application_filed" });
}

export function applicationNoticedEvent({ projectRef, zapRow, zapSourceVintage = null } = {}) {
  return zapCalendarDateEvent({ projectRef, zapRow, zapSourceVintage, sourceField: "noticed_date", eventKind: "application_noticed" });
}

export function certifiedReferredFromZapEvent({ projectRef, zapRow, zapSourceVintage = null } = {}) {
  return zapCalendarDateEvent({ projectRef, zapRow, zapSourceVintage, sourceField: "certified_referred", eventKind: "application_certified_or_referred" });
}

/** One event per filed_land_use_package document -- never collapsed across versions. */
export function packageVersionObservedEvents(documents = []) {
  return documents
    .filter((d) => d.document_type === "filed_land_use_package")
    .map((doc) => buildFilingSequenceEvent({
      project_ref: doc.project_ref,
      event_kind: "package_version_observed",
      disambiguator: doc.document_id,
      publisher: { source_id: ZAP_OUTCOMES_PUBLISHER_SOURCE_ID },
      source_record_id: doc.publisher_document_id,
      clock_kind: "document_first_observed_at",
      observed_at: doc.first_observed_at,
      available_to_public_at: doc.available_to_public_at,
      confidence: doc.classification?.confidence ?? "unknown",
      refs: { document_ref: doc.document_id },
      detail: {
        version_ordinal: doc.version_ordinal,
        version_label: doc.version_label,
        supersedes: doc.supersedes,
        supersession_basis: doc.supersession_basis,
        content_duplicate_of: doc.content_duplicate_of,
        bytes_sha256: doc.bytes_sha256,
      },
    }));
}

/** One event per document that explicitly supersedes an earlier one -- the replacement is always this document's own (never backdated) first_observed_at. */
export function documentSupersededEvents(documents = []) {
  return documents
    .filter((d) => d.supersedes)
    .map((doc) => buildFilingSequenceEvent({
      project_ref: doc.project_ref,
      event_kind: "document_superseded",
      disambiguator: doc.document_id,
      publisher: { source_id: ZAP_OUTCOMES_PUBLISHER_SOURCE_ID },
      source_record_id: doc.publisher_document_id,
      clock_kind: "document_first_observed_at",
      observed_at: doc.first_observed_at,
      available_to_public_at: doc.available_to_public_at,
      confidence: doc.classification?.confidence ?? "unknown",
      refs: { document_ref: doc.document_id },
      detail: { supersedes: doc.supersedes, supersession_basis: doc.supersession_basis, document_type: doc.document_type },
    }));
}

/** One event per racial_equity_report document occurrence -- an obligation match copies its already-validated procedural_effect through, never authoring one. */
export function reportFirstObservedEvents(documents = [], obligations = []) {
  const obligationByDocumentRef = new Map();
  for (const ob of obligations) {
    for (const ref of ob.fulfillment?.document_refs || []) obligationByDocumentRef.set(ref, ob);
  }
  return documents
    .filter((d) => d.document_type === "racial_equity_report")
    .map((doc) => {
      const obligation = obligationByDocumentRef.get(doc.document_id) ?? null;
      return buildFilingSequenceEvent({
        project_ref: doc.project_ref,
        event_kind: "report_first_observed",
        disambiguator: doc.document_id,
        publisher: { source_id: ZAP_OUTCOMES_PUBLISHER_SOURCE_ID },
        source_record_id: doc.publisher_document_id,
        clock_kind: "document_first_observed_at",
        observed_at: doc.first_observed_at,
        available_to_public_at: doc.available_to_public_at,
        confidence: doc.classification?.confidence ?? "unknown",
        refs: { document_ref: doc.document_id, obligation_ref: obligation?.obligation_id ?? null },
        legal_effect: obligation?.procedural_effect ?? null,
        detail: { version_ordinal: doc.version_ordinal, supersedes: doc.supersedes },
      });
    });
}

/** Only an explicit publisher_identifies_not_timely_filed fulfillment produces this event -- never inferred from a document's absence. */
export function reportNotTimelyFiledNoticeEvents(obligations = []) {
  return obligations
    .filter((ob) => ob.fulfillment?.state === "publisher_identifies_not_timely_filed" && ob.fulfillment.publisher_assertion)
    .map((ob) => buildFilingSequenceEvent({
      project_ref: ob.project_ref,
      event_kind: "report_not_timely_filed_notice",
      disambiguator: ob.obligation_id,
      publisher: { source_id: ob.source_id },
      source_record_id: ob.source_record_id,
      clock_kind: "publisher_asserted_calendar_date",
      observed_at: ob.fulfillment.publisher_assertion.observed_at,
      available_to_public_at: ob.available_to_public_at,
      confidence: "high",
      refs: { obligation_ref: ob.obligation_id },
      legal_effect: ob.procedural_effect,
      detail: {
        source_field: ob.fulfillment.publisher_assertion.source_field,
        source_value: ob.fulfillment.publisher_assertion.source_value,
      },
    }));
}

/** Only an explicit applicability.publisher_assertion produces this event -- a non-public reconstructed_candidate is never promoted here either. */
export function applicabilityAssertedEvents(obligations = []) {
  return obligations
    .filter((ob) => ob.applicability?.publisher_assertion)
    .map((ob) => buildFilingSequenceEvent({
      project_ref: ob.project_ref,
      event_kind: "applicability_asserted",
      disambiguator: ob.obligation_id,
      publisher: { source_id: ob.source_id },
      source_record_id: ob.source_record_id,
      clock_kind: "publisher_asserted_calendar_date",
      observed_at: ob.applicability.publisher_assertion.observed_at,
      available_to_public_at: ob.available_to_public_at,
      confidence: "high",
      conflict_state: ob.applicability.state === "source_conflict" ? "source_conflict" : "none",
      refs: { obligation_ref: ob.obligation_id },
      detail: {
        state: ob.applicability.state,
        source_field: ob.applicability.publisher_assertion.source_field,
        source_value: ob.applicability.publisher_assertion.source_value,
      },
    }));
}

export function noticeOfReceiptEvents(documents = []) {
  return documents
    .filter((d) => d.document_type === "notice_of_receipt")
    .map((doc) => buildFilingSequenceEvent({
      project_ref: doc.project_ref,
      event_kind: "notice_of_receipt_observed",
      disambiguator: doc.document_id,
      publisher: { source_id: ZAP_OUTCOMES_PUBLISHER_SOURCE_ID },
      source_record_id: doc.publisher_document_id,
      clock_kind: "document_first_observed_at",
      observed_at: doc.first_observed_at,
      available_to_public_at: doc.available_to_public_at,
      confidence: doc.classification?.confidence ?? "unknown",
      refs: { document_ref: doc.document_id },
    }));
}

/** One event per certification/referral notice document -- a project with more than one is never collapsed to a single fact. */
export function certifiedOrReferredNoticeEvents(documents = []) {
  return documents
    .filter((d) => d.document_type === "notice_of_certification_or_referral")
    .map((doc) => buildFilingSequenceEvent({
      project_ref: doc.project_ref,
      event_kind: "application_certified_or_referred",
      disambiguator: doc.document_id,
      publisher: { source_id: ZAP_OUTCOMES_PUBLISHER_SOURCE_ID },
      source_record_id: doc.publisher_document_id,
      clock_kind: "document_first_observed_at",
      observed_at: doc.first_observed_at,
      available_to_public_at: doc.available_to_public_at,
      confidence: doc.classification?.confidence ?? "unknown",
      refs: { document_ref: doc.document_id },
    }));
}

/** Consumes zap_environmental_projection.mjs's own pure function -- never re-derives CEQR identity from title/action text itself. */
export function environmentalIdentityObservedEvent({ projectRef, zapRow, zapSourceVintage = null, ceqrKey = null } = {}) {
  if (!zapRow) return null;
  const projection = projectZapEnvironmentalFields(zapRow, { asOf: zapSourceVintage });
  const ceqrField = projection.fields.ceqr_number;
  if (ceqrField.presence !== "present") return null;
  const observedAt = isParseableTimestamp(zapSourceVintage) ? zapSourceVintage : null;
  const conflict = ceqrKey && ceqrKey !== ceqrField.value ? "source_conflict" : "none";
  return buildFilingSequenceEvent({
    project_ref: projectRef,
    event_kind: "environmental_identity_observed",
    disambiguator: "ceqr_number",
    publisher: { source_id: ZAP_PUBLISHER_SOURCE_ID, source_dataset_id: ZAP_ENVIRONMENTAL_DATASET_ID },
    source_record_id: projectRef.slice("project:".length),
    clock_kind: observedAt ? "source_materialization_vintage" : "unknown",
    observed_at: observedAt,
    available_to_public_at: observedAt,
    confidence: "high",
    conflict_state: resolveConflictState({ observedAt, explicit: conflict }),
    detail: {
      ceqr_number: ceqrField.value,
      ceqr_type: projection.fields.ceqr_type.value,
      ceqr_lead_agency: projection.fields.ceqr_lead_agency.value,
      environmental_review_type: projection.fields.environmental_review_type.value,
      reconciliation_ceqr_key: ceqrKey,
    },
  });
}

/** Consumes one already-joined CEQR reconciliation row (LDP-13's own output shape) -- never re-joins or re-fetches CEQR sources here. */
export function environmentalMilestoneObservedEvents({ projectRef, ceqrJoin = null } = {}) {
  if (!ceqrJoin || !Array.isArray(ceqrJoin.milestones?.rows)) return [];
  return ceqrJoin.milestones.rows.map((row, index) => {
    const observedAt = isParseableTimestamp(row.milestone_date) ? row.milestone_date : null;
    return buildFilingSequenceEvent({
      project_ref: projectRef,
      event_kind: "environmental_milestone_observed",
      disambiguator: `${row.source_record_id ?? index}`,
      publisher: { source_id: CEQR_MILESTONES_PUBLISHER_SOURCE_ID, source_dataset_id: CEQR_MILESTONES_DATASET_ID },
      source_record_id: row.source_record_id ?? `${ceqrJoin.ceqr_key}:${index}`,
      clock_kind: observedAt ? "publisher_asserted_calendar_date" : "unknown",
      observed_at: observedAt,
      available_to_public_at: observedAt,
      confidence: observedAt ? "high" : "medium",
      conflict_state: resolveConflictState({ observedAt, explicit: row.exact_duplicate ? "multiple_candidates" : "none" }),
      detail: {
        ceqr_key: ceqrJoin.ceqr_key,
        milestone_name: row.milestone_name ?? null,
        milestone_date: row.milestone_date ?? null,
        extends_zap_milestone: row.extends_zap_milestone === true,
        exact_duplicate: row.exact_duplicate === true,
      },
    });
  });
}

/** Purely observational: a version_ordinal gap is reported, never filled in. */
export function detectPackageVersionGaps(packageDocsWithOrdinal = []) {
  const ordinals = [...new Set(packageDocsWithOrdinal.map((d) => d.version_ordinal).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  if (ordinals.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < ordinals.length; i++) {
    if (ordinals[i] - ordinals[i - 1] > 1) gaps.push(`${ordinals[i - 1]}→${ordinals[i]}`);
  }
  if (!gaps.length) return null;
  return `observed package version_ordinal sequence has a gap (${gaps.join(", ")}); no intermediate version was observed -- recorded as an observation, not inferred`;
}

function buildSequenceOrder(events) {
  const orderedIds = events
    .filter((e) => e.observed_at != null)
    .slice()
    .sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at) || a.event_id.localeCompare(b.event_id))
    .map((e) => e.event_id);
  const unresolvedClockEventIds = events.filter((e) => e.observed_at == null).map((e) => e.event_id);
  const conflictedEventIds = events.filter((e) => e.conflict_state !== "none").map((e) => e.event_id);
  return Object.freeze({
    ordered_event_ids: Object.freeze(orderedIds),
    unresolved_clock_event_ids: Object.freeze(unresolvedClockEventIds),
    conflicted_event_ids: Object.freeze(conflictedEventIds),
  });
}

/* ------------------------------------------------------------------ */
/* Sequence materializer                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {object} opts
 * @param {string} opts.projectId
 * @param {object|null} [opts.zapRow] a retained ZAP row (LDP-02 fields: app_filed_date, noticed_date, certified_referred, plus the environmental columns)
 * @param {string|null} [opts.zapSourceVintage] the ZAP materialization's own vintage/materialized_at
 * @param {object[]} [opts.obligations] LDP-23 land_use_filing_obligation.v1 records for this project
 * @param {object[]} [opts.documents] LDP-24 land_use_filing_document.v1 manifest entries for this project (unbounded)
 * @param {object|null} [opts.ceqrJoin] one LDP-13 joined_projects[] row for this project, or null
 * @param {string} opts.materializedAt
 */
export function materializeLandFilingSequence({
  projectId,
  zapRow = null,
  zapSourceVintage = null,
  obligations = [],
  documents = [],
  ceqrJoin = null,
  materializedAt,
} = {}) {
  const project = requireString(projectId, "projectId", 240);
  if (!isParseableTimestamp(materializedAt)) throw new TypeError("materializeLandFilingSequence: materializedAt must be an ISO timestamp");
  const projectRef = `project:${project}`;
  const warnings = [];
  const events = [];
  const pushEvent = (event) => { if (event) events.push(event); };

  pushEvent(applicationFiledEvent({ projectRef, zapRow, zapSourceVintage }));
  pushEvent(applicationNoticedEvent({ projectRef, zapRow, zapSourceVintage }));
  pushEvent(certifiedReferredFromZapEvent({ projectRef, zapRow, zapSourceVintage }));
  if (!zapRow) {
    warnings.push("no ZAP row supplied for this project; application_filed/noticed/certified_referred and environmental identity events are absent, not inferred");
  }

  packageVersionObservedEvents(documents).forEach(pushEvent);
  documentSupersededEvents(documents).forEach(pushEvent);
  reportFirstObservedEvents(documents, obligations).forEach(pushEvent);
  noticeOfReceiptEvents(documents).forEach(pushEvent);
  certifiedOrReferredNoticeEvents(documents).forEach(pushEvent);
  reportNotTimelyFiledNoticeEvents(obligations).forEach(pushEvent);
  applicabilityAssertedEvents(obligations).forEach(pushEvent);

  const ceqrKey = ceqrJoin?.ceqr_key ?? null;
  pushEvent(environmentalIdentityObservedEvent({ projectRef, zapRow, zapSourceVintage, ceqrKey }));
  environmentalMilestoneObservedEvents({ projectRef, ceqrJoin }).forEach(pushEvent);
  if (!ceqrJoin) {
    warnings.push("no CEQR reconciliation join supplied for this project; environmental milestone events are absent, not inferred");
  }

  // A project asserting more than one certification-or-referral observation is
  // never collapsed to one fact: every one of those events is flagged, and a
  // disagreement among their clocks is a stronger source_conflict than a mere
  // multiple_candidates count.
  const certifiedEvents = events.filter((e) => e.event_kind === "application_certified_or_referred");
  if (certifiedEvents.length > 1) {
    const distinctDates = new Set(certifiedEvents.map((e) => e.observed_at).filter(Boolean));
    const nextState = distinctDates.size > 1 ? "source_conflict" : "multiple_candidates";
    for (let i = 0; i < events.length; i += 1) {
      const e = events[i];
      if (e.event_kind !== "application_certified_or_referred" || e.conflict_state !== "none") continue;
      events[i] = Object.freeze({ ...e, conflict_state: nextState });
    }
    warnings.push(`${certifiedEvents.length} certification-or-referral observations were recorded for this project; none was collapsed into a single fact`);
  }

  const packageDocsWithOrdinal = documents.filter((d) => d.document_type === "filed_land_use_package" && Number.isInteger(d.version_ordinal));
  const gapWarning = detectPackageVersionGaps(packageDocsWithOrdinal);
  if (gapWarning) warnings.push(gapWarning);

  return Object.freeze({
    schema: LAND_FILING_SEQUENCE_SCHEMA,
    version: LAND_FILING_SEQUENCE_VERSION,
    project_id: project,
    project_ref: projectRef,
    materialized_at: materializedAt,
    events: Object.freeze(events),
    order: buildSequenceOrder(events),
    event_count: events.length,
    warnings: Object.freeze(warnings),
  });
}

/* ------------------------------------------------------------------ */
/* Observational summary + bounded digest                             */
/* ------------------------------------------------------------------ */

/**
 * Reproduces the card's own negative-rule vocabulary as field names:
 * observed package-version count, first/last package observation, observed
 * revision interval, report-vs-certification ordering, and source-conflict
 * flags. Every field here is an observation; none is a readiness, completeness,
 * deficiency, cooperation, or delay label, and none of this module's own
 * exported constants may equal one of those words (see this module's test).
 */
export function summarizeFilingSequenceObservations(sequence) {
  const events = sequence?.events ?? [];
  const packageEvents = events.filter((e) => e.event_kind === "package_version_observed" && e.observed_at);
  const sortedPackageDates = packageEvents.map((e) => e.observed_at).sort((a, b) => Date.parse(a) - Date.parse(b));
  const firstPackageObservation = sortedPackageDates[0] ?? null;
  const lastPackageObservation = sortedPackageDates[sortedPackageDates.length - 1] ?? null;
  const observedRevisionIntervalDays = (firstPackageObservation && lastPackageObservation)
    ? Math.round((Date.parse(lastPackageObservation) - Date.parse(firstPackageObservation)) / 86_400_000)
    : null;

  const reportEvents = events.filter((e) => e.event_kind === "report_first_observed" && e.observed_at);
  const certifiedEvents = events.filter((e) => e.event_kind === "application_certified_or_referred" && e.observed_at);
  const earliestCertifiedAt = certifiedEvents.length
    ? certifiedEvents.map((e) => e.observed_at).sort((a, b) => Date.parse(a) - Date.parse(b))[0]
    : null;
  let reportObservedRelativeToCertification = "unknown";
  if (reportEvents.length && earliestCertifiedAt) {
    reportObservedRelativeToCertification = reportEvents.some((e) => Date.parse(e.observed_at) > Date.parse(earliestCertifiedAt))
      ? "after"
      : "before";
  }

  return Object.freeze({
    schema: FILING_SEQUENCE_OBSERVATION_SUMMARY_SCHEMA,
    project_ref: sequence?.project_ref ?? null,
    observed_package_version_count: packageEvents.length,
    first_package_observation: firstPackageObservation,
    last_package_observation: lastPackageObservation,
    observed_revision_interval_days: observedRevisionIntervalDays,
    report_observed_relative_to_certification: reportObservedRelativeToCertification,
    source_conflict_event_ids: Object.freeze(events.filter((e) => e.conflict_state !== "none").map((e) => e.event_id)),
  });
}

/**
 * Bounds only the first-paint digest; `sequence.events` (warehouse-side)
 * stays complete and untruncated, matching LDP-24's own "bound the digest,
 * never the manifest" rule.
 */
export function buildFilingSequenceDigest(sequence, { limit = LAND_FILING_SEQUENCE_DIGEST_LIMIT } = {}) {
  const orderedIds = sequence?.order?.ordered_event_ids ?? [];
  const byId = new Map((sequence?.events ?? []).map((e) => [e.event_id, e]));
  const boundedIds = orderedIds.slice(0, limit);
  return Object.freeze({
    schema: FILING_SEQUENCE_DIGEST_SCHEMA,
    project_ref: sequence?.project_ref ?? null,
    materialized_at: sequence?.materialized_at ?? null,
    truncated: orderedIds.length > limit,
    total_ordered_event_count: orderedIds.length,
    unresolved_clock_event_count: (sequence?.order?.unresolved_clock_event_ids ?? []).length,
    events: Object.freeze(boundedIds.map((id) => byId.get(id)).filter(Boolean)),
  });
}
