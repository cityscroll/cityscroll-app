/**
 * SEQRA-06: DOB and ACRIS implementation events joined back to the
 * authorizing land_use_determination, feeding a remedy-exposure projection
 * (card acceptance A4).
 *
 * The commission's remedy-exposure question ("if litigation occurs... what
 * are the separate procedural, merits, and remedy risks?") depends on how
 * far a project has physically progressed: a court weighs vacatur very
 * differently against an unbroken ground lot than against a project that has
 * already received a temporary certificate of occupancy (see the commission
 * fixture note: "200 Amsterdam: ... construction affects remedy"). This
 * module never asserts a legal outcome -- it only states, from dated DOB/
 * ACRIS events, how far implementation had visibly progressed as of a
 * cutoff, so a downstream remedy model has a fact to condition on instead
 * of inferring progress from today's state of the lot.
 *
 * Both halves of this module are cutoff-scoped, not just the outer caller:
 * `joinImplementationEventsToDetermination` only attributes events dated on
 * or after the determination, and `projectRemedyExposureAsOf` only considers
 * events dated on or before its own `cutoff` -- an event dated after the
 * cutoff cannot raise the projected stage, which is the same no-backward-
 * leakage property seqra_layer_vintage.mjs proves for spatial layers (A2).
 */
import { buildImplementationEventKey, buildRemedyExposureProjectionKey } from "./seqra_spatial_stable_keys.mjs";

export const SEQRA_IMPLEMENTATION_EVENT_SCHEMA = "cityscroll.seqra_implementation_event.v1";
export const SEQRA_REMEDY_EXPOSURE_SCHEMA = "cityscroll.seqra_remedy_exposure_projection.v1";

export class SeqraImplementationEventError extends Error {
  constructor(message) {
    super(message);
    this.name = "SeqraImplementationEventError";
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Recognized DOB/ACRIS implementation event types, ranked into the remedy-
 * exposure ladder. Rank is monotonic construction/conveyance progress, not a
 * timeline guarantee -- a project can skip ranks (e.g. no recorded
 * `dob_first_permit_in_effect` before a TCO) and the projection still uses
 * the highest rank actually observed by the cutoff.
 */
const EVENT_STAGE_RANK = Object.freeze({
  dob_job_application_filed: 1,
  dob_permit_issued: 2,
  dob_first_permit_in_effect: 3,
  acris_document_recorded: 3,
  dob_temporary_certificate_of_occupancy: 4,
  dob_final_certificate_of_occupancy: 5,
});

const STAGE_LABEL_BY_RANK = Object.freeze({
  0: "not_started",
  1: "permit_filed",
  2: "permit_issued",
  3: "construction_or_conveyance_commenced",
  4: "substantially_complete",
  5: "complete",
});

export const SEQRA_REMEDY_EXPOSURE_STATES = Object.freeze(Object.values(STAGE_LABEL_BY_RANK));

function requireDateOnly(value, field) {
  if (typeof value !== "string" || !DATE_ONLY.test(value)) {
    throw new SeqraImplementationEventError(`${field} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SeqraImplementationEventError(`${field} is required and must be a non-empty string`);
  }
  return value;
}

/**
 * Build one implementation-event record from a raw DOB/ACRIS observation.
 * Does not itself attribute the event to a determination -- see
 * `joinImplementationEventsToDetermination`.
 */
export function buildImplementationEvent({
  sourceSystem,
  sourceEventId,
  eventType,
  eventDate,
  bbl,
  observedAt,
  sourceId,
  sourceRecordId,
} = {}) {
  requireNonEmptyString(sourceSystem, "sourceSystem");
  requireNonEmptyString(sourceEventId, "sourceEventId");
  if (!(eventType in EVENT_STAGE_RANK)) {
    throw new SeqraImplementationEventError(
      `eventType must be one of ${Object.keys(EVENT_STAGE_RANK).join(", ")}, got ${JSON.stringify(eventType)}`,
    );
  }
  requireDateOnly(eventDate, "eventDate");
  requireNonEmptyString(bbl, "bbl");
  requireNonEmptyString(observedAt, "observedAt");
  requireNonEmptyString(sourceId, "sourceId");
  requireNonEmptyString(sourceRecordId, "sourceRecordId");
  return Object.freeze({
    schema: SEQRA_IMPLEMENTATION_EVENT_SCHEMA,
    event_key: buildImplementationEventKey({ sourceSystem, sourceEventId }),
    source_system: sourceSystem,
    source_event_id: sourceEventId,
    event_type: eventType,
    event_date: eventDate,
    bbl,
    stage_rank: EVENT_STAGE_RANK[eventType],
    observed_at: observedAt,
    source_id: sourceId,
    source_record_id: sourceRecordId,
    authorizing_determination_key: null,
  });
}

/**
 * Attribute implementation events to the determination that authorized the
 * action they implement. An event is attributed only when both hold:
 *   - its BBL is in `bbls` (the project's footprint the determination's
 *     action covers -- pass the BBL-history footprint appropriate to the
 *     determination's own date, not the project's present-day BBL list);
 *   - its `event_date` is on or after `determinationDate`.
 *
 * An event dated before the determination is excluded, not silently kept:
 * implementation cannot be authorized by a determination that had not yet
 * issued, so an early event is reported separately as `unattributed` with
 * the reason, rather than either being dropped without a trace or wrongly
 * joined to a determination it precedes.
 */
export function joinImplementationEventsToDetermination({ determinationKey, determinationDate, bbls, events = [] }) {
  requireNonEmptyString(determinationKey, "determinationKey");
  if (!determinationKey.startsWith("determination:")) {
    throw new SeqraImplementationEventError(`determinationKey must be a determination stable key, got ${JSON.stringify(determinationKey)}`);
  }
  requireDateOnly(determinationDate, "determinationDate");
  if (!Array.isArray(bbls) || bbls.length === 0) {
    throw new SeqraImplementationEventError("bbls must be a non-empty array");
  }
  const bblSet = new Set(bbls);

  const attributed = [];
  const unattributed = [];
  for (const event of events) {
    if (!bblSet.has(event.bbl)) {
      unattributed.push({ event, reason: "bbl_not_in_determination_footprint" });
      continue;
    }
    if (event.event_date < determinationDate) {
      unattributed.push({ event, reason: "event_precedes_determination" });
      continue;
    }
    attributed.push(Object.freeze({ ...event, authorizing_determination_key: determinationKey }));
  }

  return {
    determination_key: determinationKey,
    determination_date: determinationDate,
    attributed_events: attributed,
    unattributed_events: unattributed,
  };
}

/**
 * Project the remedy-exposure state as of `cutoff` from a determination's
 * attributed implementation events. Only events with `event_date <= cutoff`
 * are considered -- a future event cannot raise the projected stage, which
 * is what makes a projection computed for a historical cutoff reproducible
 * today (A2). `not_started` is a valid, explicit result: it means no
 * attributed event on or before the cutoff reached even the lowest ranked
 * stage, not that implementation is known to be absent forever.
 */
export function projectRemedyExposureAsOf({ determinationKey, cutoff, attributedEvents = [] }) {
  requireNonEmptyString(determinationKey, "determinationKey");
  requireDateOnly(cutoff, "cutoff");
  for (const event of attributedEvents) {
    if (event.authorizing_determination_key !== determinationKey) {
      throw new SeqraImplementationEventError(
        `event ${event.event_key} is not attributed to ${determinationKey} (got ${event.authorizing_determination_key})`,
      );
    }
  }

  const inScope = attributedEvents.filter((event) => event.event_date <= cutoff);
  const highestRank = inScope.reduce((max, event) => Math.max(max, event.stage_rank), 0);
  const evidence = inScope
    .filter((event) => event.stage_rank === highestRank && highestRank > 0)
    .map((event) => event.event_key)
    .sort();

  return Object.freeze({
    schema: SEQRA_REMEDY_EXPOSURE_SCHEMA,
    projection_key: buildRemedyExposureProjectionKey({ determinationKey, cutoff }),
    determination_key: determinationKey,
    cutoff,
    state: STAGE_LABEL_BY_RANK[highestRank],
    stage_rank: highestRank,
    evidence_event_keys: Object.freeze(evidence),
    events_considered: inScope.length,
    events_excluded_after_cutoff: attributedEvents.length - inScope.length,
  });
}
