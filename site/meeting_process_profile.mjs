/**
 * Meeting-family profiles keep source observations separate from expectations.
 *
 * Observed facts can drive descriptive explorer stages. Only a registered
 * family can select normative expectations, and those expectations never
 * evaluate missing observations as compliance or non-compliance.
 */

export const MEETING_PROCESS_PROFILE_SCHEMA = "cityscroll.meeting_process_profile.v1";
export const MEETING_OBSERVED_STATE_SCHEMA = "cityscroll.meeting_observed_state.v1";
export const MEETING_PROCESS_PROJECTION_SCHEMA = "cityscroll.meeting_process_projection.v1";

export const MEETING_FAMILY = Object.freeze({
  AGENCY_RULEMAKING_HEARING: "agency_rulemaking_hearing",
  COMMUNITY_BOARD_MEETING_V0: "community_board_meeting_v0",
  DESCRIPTIVE_MEETING_V0: "descriptive_meeting_v0",
});

export const MEETING_EVENT_STATES = Object.freeze([
  "scheduled",
  "cancelled",
  "postponed",
  "held",
  "unknown",
]);

export const MEETING_PUBLICATION_STATES = Object.freeze([
  "observed",
  "not_observed",
  "unknown",
]);

const REGISTERED_FAMILIES = new Set(Object.values(MEETING_FAMILY));

const RULEMAKING_EXPECTATIONS = Object.freeze({
  process_kind: "rulemaking",
  process_stage: "hearing",
  publication_roles: Object.freeze(["agenda", "outcome"]),
});

const PROFILES = Object.freeze({
  [MEETING_FAMILY.AGENCY_RULEMAKING_HEARING]: Object.freeze({
    schema: MEETING_PROCESS_PROFILE_SCHEMA,
    id: "agency_rulemaking_hearing",
    version: 1,
    meeting_family: MEETING_FAMILY.AGENCY_RULEMAKING_HEARING,
    expectation_mode: "normative",
    process_role: "rulemaking_hearing",
    normative_expectations: RULEMAKING_EXPECTATIONS,
  }),
  [MEETING_FAMILY.COMMUNITY_BOARD_MEETING_V0]: Object.freeze({
    schema: MEETING_PROCESS_PROFILE_SCHEMA,
    id: "community_board_meeting",
    version: 0,
    meeting_family: MEETING_FAMILY.COMMUNITY_BOARD_MEETING_V0,
    expectation_mode: "descriptive",
    process_role: null,
    normative_expectations: null,
  }),
  [MEETING_FAMILY.DESCRIPTIVE_MEETING_V0]: Object.freeze({
    schema: MEETING_PROCESS_PROFILE_SCHEMA,
    id: "descriptive_meeting",
    version: 0,
    meeting_family: MEETING_FAMILY.DESCRIPTIVE_MEETING_V0,
    expectation_mode: "descriptive",
    process_role: null,
    normative_expectations: null,
  }),
});

function clean(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || null;
}

function noticeText(record) {
  return [
    record?.title,
    record?.short_title,
    record?.description,
    record?.decides,
    record?.additional_description_1,
    record?.additional_description_2,
    record?.additional_description_3,
    record?.other_info_1,
    record?.other_info_2,
    record?.other_info_3,
  ].filter(Boolean).join(" ");
}

function attachedDocument(record, role) {
  const documents = Array.isArray(record?.meeting_documents)
    ? record.meeting_documents : [];
  return documents.some((document) => (
    document?.role === role && document?.attachment_status === "attached"
  ));
}

function eventState(record) {
  const structured = clean(
    record?.observed_event_state
      || record?.event_status
      || record?.meeting_status,
  )?.toLowerCase();
  const normalized = structured === "canceled" ? "cancelled" : structured;
  if (MEETING_EVENT_STATES.includes(normalized) && normalized !== "unknown") {
    return { value: normalized, basis: "explicit_event_status" };
  }

  const haystack = noticeText(record);
  if (/\b(?:cancelled|canceled)\b/i.test(haystack)) {
    return { value: "cancelled", basis: "published_status_statement" };
  }
  if (/\bpostponed\b/i.test(haystack)) {
    return { value: "postponed", basis: "published_status_statement" };
  }
  if (/\b(?:meeting|hearing)\s+(?:was\s+)?held\b|\bwas held\b/i.test(haystack)) {
    return { value: "held", basis: "published_status_statement" };
  }
  if (clean(record?.event_date)) {
    return { value: "scheduled", basis: "published_event_date" };
  }
  return { value: "unknown", basis: null };
}

function publication(state, basis = []) {
  return Object.freeze({ state, basis: Object.freeze([...basis]) });
}

function publicationState(record, role) {
  if (!record || typeof record !== "object") return publication("unknown");
  const basis = [];
  const haystack = noticeText(record);

  if (attachedDocument(record, role)) basis.push(`attached_${role}_document`);
  if (role === "agenda") {
    if (record.agenda_available === true || record.agenda_published === true) {
      basis.push("explicit_agenda_flag");
    }
    if (/\bagenda\b/i.test(haystack)
      || (/\bcalendar\b/i.test(haystack) && /\b(items?|matters?)\b/i.test(haystack))) {
      basis.push("published_agenda_statement");
    }
  }
  if (role === "minutes") {
    if (record.minutes_available === true || record.minutes_published === true) {
      basis.push("explicit_minutes_flag");
    }
    if (record.minutes_freshness?.status === "published") {
      basis.push("minutes_freshness_receipt");
    }
    if (/\bminutes\b/i.test(haystack)) basis.push("published_minutes_statement");
  }
  if (role === "outcome") {
    if (record.meeting_outcomes_matched === true || record.outcomes_available === true) {
      basis.push("explicit_outcome_flag");
    }
    const join = record.meeting_outcomes?.join || record.outcomes_join || null;
    if (join?.matched) basis.push("matched_outcome_join");
    if (record.council_event?.event_id || record.council_event?.event_url) {
      basis.push("council_event_receipt");
    }
    if (/\b(?:outcomes?|roll[\s-]?call|vote tally|voting results?)\b/i.test(haystack)) {
      basis.push("published_outcome_statement");
    }
  }

  return basis.length ? publication("observed", basis) : publication("not_observed");
}

/** Resolve only registered families; source-qualified board rows get v0. */
export function resolveMeetingFamily(record = {}) {
  const explicit = clean(typeof record === "string" ? record : record?.meeting_family);
  if (REGISTERED_FAMILIES.has(explicit)) return explicit;
  if (record?.source_system === "community_board") {
    return MEETING_FAMILY.COMMUNITY_BOARD_MEETING_V0;
  }
  return MEETING_FAMILY.DESCRIPTIVE_MEETING_V0;
}

/** Return the immutable profile selected by the resolved meeting family. */
export function meetingProcessProfile(record = {}) {
  return PROFILES[resolveMeetingFamily(record)];
}

/** Materialize source-backed event and publication facts without expectations. */
export function meetingObservedState(record = {}) {
  return Object.freeze({
    schema: MEETING_OBSERVED_STATE_SCHEMA,
    event_state: Object.freeze(eventState(record)),
    publications: Object.freeze({
      agenda: publicationState(record, "agenda"),
      minutes: publicationState(record, "minutes"),
      outcome: publicationState(record, "outcome"),
    }),
  });
}

/** Descriptive stage for the explorer; chronology never changes observation. */
export function observedMeetingStage(observed) {
  const state = observed?.event_state?.value;
  if (state === "cancelled" || state === "postponed") return null;
  if (observed?.publications?.outcome?.state === "observed"
    || observed?.publications?.minutes?.state === "observed") return "outcomes";
  if (state === "held") return "held";
  if (observed?.publications?.agenda?.state === "observed") return "agenda";
  if (state === "scheduled") return "scheduled";
  return null;
}

/** Project one meeting into independent observed and expectation fields. */
export function meetingProcessProjection(record = {}) {
  const processProfile = meetingProcessProfile(record);
  const observed = meetingObservedState(record);
  return Object.freeze({
    schema: MEETING_PROCESS_PROJECTION_SCHEMA,
    meeting_family: processProfile.meeting_family,
    process_profile: processProfile,
    observed,
    observed_stage: observedMeetingStage(observed),
    normative_expectations: processProfile.normative_expectations,
    process_role: processProfile.process_role,
  });
}
