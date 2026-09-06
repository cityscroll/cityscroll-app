/**
 * PHC-00 — shared, evidence-bearing consequence projection.
 *
 * One small view over records already produced by hearing_logistics.mjs,
 * action_registry.js, meeting_process_profile.mjs, council_hearing_action_path.mjs,
 * rules_phase_spine.mjs / rules_participation.mjs, and land_authority_summary_view.mjs.
 * This module composes those existing outputs into one shape; it does not
 * parse notice text itself and does not add a new civic-process data model.
 *
 * Every non-null field carries at least one evidence entry naming an official
 * source URL or an existing exact CityScroll join basis. A field with no
 * qualifying evidence stays null/"unknown" rather than being guessed, and one
 * composer's absence of a field never suppresses another field that is known.
 *
 * `participation_modes` entries are each backed by their own independent
 * evidence: `watch` never implies `join_remote`, `join_remote` never implies
 * `register_to_testify`, and a physical venue plus a published livestream URL
 * never becomes `join_remote` on its own — only a recognized video-conference
 * join platform (or an explicit remote-testimony signal) does that.
 */

import * as actionRegistryModule from "./action_registry.js";
import { inferHearingLogistics, recognizedMeetingUrl } from "./hearing_logistics.mjs";
import { meetingProcessProjection } from "./meeting_process_profile.mjs";
import { buildCouncilHearingActionPath } from "./council_hearing_action_path.mjs";
import { buildRulesParticipationPath, extractCommentFacts } from "./rules_participation.mjs";
import { landAuthorityPanelProjection } from "./land_authority_summary_view.mjs";

const actionRegistry = globalThis.CrolActions || actionRegistryModule.default || actionRegistryModule;

export const CONSEQUENCE_PROJECTION_SCHEMA = "cityscroll.consequence_projection.v1";

export const PROCEEDING_KINDS = Object.freeze([
  "hearing",
  "public_meeting",
  "public_session",
  "comment_period",
  "unknown",
]);

export const BODY_ROLES = Object.freeze([
  "receives_record",
  "advisory",
  "conditional_decision_maker",
  "decision_maker",
  "oversight",
  "unknown",
]);

export const PARTICIPATION_MODES = Object.freeze([
  "watch",
  "attend_in_person",
  "join_remote",
  "register_to_testify",
  "submit_written",
]);

export const RECORD_DESTINATIONS = Object.freeze([
  "testimony",
  "transcript",
  "minutes",
  "comment_record",
  "decision_document",
]);

// Verified NYC operating facts the commission cites by official source. These
// are general regulatory facts about a proceeding family, not per-notice
// scrapes, so they may be attached as evidence whenever the matching
// composer runs for that family.
export const OFFICIAL_SOURCES = Object.freeze({
  councilTestimony: "https://council.nyc.gov/testify/",
  councilLegislation: "https://council.nyc.gov/legislation/",
  capa: "https://rules.cityofnewyork.us/capa/",
  mocsPublicComment: "https://www.nyc.gov/site/mocs/about/public-hearing.page",
});

// land_authority_summary_view.mjs current_role values that map cleanly onto
// this projection's body_role vocabulary. A role without a confident match
// (administrative_certifier, executive_review, plan_proposer) stays unknown
// rather than guessed.
const LAND_ROLE_TO_BODY_ROLE = Object.freeze({
  advisory_reviewer: "advisory",
  decision_maker: "decision_maker",
  conditional_decision_maker: "conditional_decision_maker",
});

function clean(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function httpsUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function cityRecordUrl(requestId) {
  const id = clean(requestId);
  return id ? `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}` : null;
}

/** Mirrors meeting_process_profile.mjs noticeText(): the same official-notice fields, nothing more. */
function noticeBody(record) {
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

function freezeProjection(projection) {
  return Object.freeze({
    ...projection,
    participation_modes: Object.freeze([...projection.participation_modes]),
    evidence: Object.freeze(projection.evidence.map((entry) => Object.freeze({ ...entry }))),
  });
}

/** A fully honest unknown projection — the required "no invented copy" fallback. */
export function emptyConsequenceProjection(unknownReason = null) {
  return freezeProjection({
    schema: CONSEQUENCE_PROJECTION_SCHEMA,
    proceeding_kind: "unknown",
    pending_question: null,
    body_role: "unknown",
    participation_modes: [],
    record_destination: null,
    next_official_action: null,
    evidence: [],
    unknown_reason: unknownReason || null,
  });
}

/**
 * Independent, evidence-gated participation-mode signals, combining:
 *  - `logistics` — an inferHearingLogistics() result (site/hearing_logistics.mjs),
 *    or the equivalent already-materialized `meeting_access` field on a
 *    shared-meeting-read-model row. This is the authority for attend/join
 *    presence because it is the module that merges body text with the
 *    notice's structured `source_links`.
 *  - `handoff` — an action_registry.js hearingHandoff / ruleHandoff /
 *    zoningHandoff result. This is the authority for testimony-specific
 *    signals (register_to_testify, submit_written) that hearing_logistics.mjs
 *    does not extract, and a fallback venue/livestream source when
 *    `logistics` is unavailable.
 *
 * Each mode is derived from its own field only — never from another mode's
 * presence — so `watch` cannot imply `join_remote`, `join_remote` cannot
 * imply `register_to_testify`, and a venue address next to a livestream URL
 * cannot become `join_remote` (that requires a recognized video-conference
 * join platform, not a livestream host).
 */
function participationSignals({ logistics = null, handoff = null, sourceUrl = null } = {}) {
  const modes = [];
  const evidence = [];
  const add = (mode, source_url, basis) => {
    if (modes.includes(mode)) return;
    modes.push(mode);
    evidence.push({ field: `participation_modes:${mode}`, source_url: source_url || null, basis });
  };

  const venueAddress = clean(logistics?.in_person_location) || clean(handoff?.venue_address);
  if (venueAddress) add("attend_in_person", sourceUrl, "published_venue_address");

  // recognizedMeetingUrl() is the precise video-conference host check (it
  // correctly matches zoomgov.com, for example); check both the logistics
  // module's merged remote_join_url and the handoff's participation_url so
  // neither module's narrower extraction silently drops a real join link.
  const recognizedJoinUrl = recognizedMeetingUrl(logistics?.remote_join_url)
    || recognizedMeetingUrl(handoff?.participation_url);
  if (recognizedJoinUrl) {
    add("join_remote", recognizedJoinUrl, "recognized_video_conference_join_url");
  } else if (handoff?.join_kind === "join" && handoff?.participation_url) {
    add("join_remote", handoff.participation_url, "recognized_video_conference_join_url");
  } else if (handoff?.join_kind === "livestream" && handoff?.participation_url) {
    add("watch", handoff.participation_url, "published_livestream_url");
  }
  const livestreamUrl = httpsUrl(handoff?.livestream_url) || httpsUrl(logistics?.broadcast_url);
  if (livestreamUrl) add("watch", livestreamUrl, "published_livestream_url");

  if (clean(handoff?.testimony_signup_url)) {
    add("register_to_testify", httpsUrl(handoff.testimony_signup_url) || sourceUrl, "published_testimony_signup");
  }

  if (clean(handoff?.testimony_email)) {
    add("submit_written", sourceUrl, "published_testimony_email");
  } else if (handoff?.mode === "comment_open" && (handoff?.comment_url || handoff?.destination)) {
    add("submit_written", httpsUrl(handoff.comment_url) || sourceUrl, "open_comment_submission_channel");
  }

  return { modes, evidence };
}

/**
 * Council hearing consequence. `record` is a shared-meeting-read-model row
 * (or any object shaped like one: meeting_id, request_id, decides, notice
 * fields) for a notice already classified as a Council hearing by its
 * caller — this composer does not itself decide that classification.
 * `opts.outcome` is the matching entry from meeting_outcomes_snapshot.json's
 * `by_notice` map (or the record's own `meeting_outcome` field) for the
 * strict Council meeting/matter join.
 */
export function councilHearingConsequence(record = {}, opts = {}) {
  if (!clean(record?.meeting_id)) return emptyConsequenceProjection("missing_meeting_id");

  const sourceUrl = httpsUrl(record.source_url) || cityRecordUrl(record.request_id);
  const evidence = [];

  const pendingQuestionText = clean(record.decides);
  const pending_question = pendingQuestionText
    ? { text: pendingQuestionText }
    : null;
  if (pending_question) {
    evidence.push({ field: "pending_question", source_url: sourceUrl, basis: "official_notice_decides_field" });
  }

  let body_role = "unknown";
  const hearingKind = clean(record.council_hearing_kind);
  if (hearingKind === "oversight") {
    body_role = "oversight";
    evidence.push({ field: "body_role", source_url: OFFICIAL_SOURCES.councilLegislation, basis: "explicit_council_hearing_kind:oversight" });
  } else if (hearingKind === "bill") {
    body_role = "conditional_decision_maker";
    evidence.push({ field: "body_role", source_url: OFFICIAL_SOURCES.councilLegislation, basis: "explicit_council_hearing_kind:bill" });
  } else if (hearingKind === "land_use") {
    body_role = "conditional_decision_maker";
    evidence.push({ field: "body_role", source_url: OFFICIAL_SOURCES.councilLegislation, basis: "explicit_council_hearing_kind:land_use" });
  }

  const body = noticeBody(record);
  const logistics = inferHearingLogistics({
    body,
    sourceLinks: record.source_links || record.participation?.links?.map((link) => link?.url) || [],
    physicalLocation: record.venue?.address,
  });
  const handoff = actionRegistry.hearingHandoff({
    notice_text: body,
    participation: record.participation,
    participation_url: record.participation?.links?.[0]?.url,
    deadline: null,
    event_date: record.event_date,
    email: null,
    contact_phone: null,
    contact_name: null,
  });
  const { modes, evidence: participationEvidence } = participationSignals({ logistics, handoff, sourceUrl });
  evidence.push(...participationEvidence);

  const outcome = opts.outcome || record.meeting_outcome || null;
  const actionPath = buildCouncilHearingActionPath(record, outcome);
  let record_destination = null;
  let next_official_action = null;
  if (actionPath) {
    const matched = outcome?.snapshot_state === "present" && outcome?.join?.matched;
    const matter = actionPath.continuation?.subject_ref ? outcome?.matters?.[0] : null;
    if (matched && (record.event_date || outcome?.event?.date)) {
      record_destination = "minutes";
      evidence.push({
        field: "record_destination",
        source_url: outcome?.event?.documents?.find((doc) => doc?.name === "Minutes")?.url || sourceUrl,
        basis: "strict Council meeting/outcome join",
      });
    }
    if (matched && actionPath.continuation?.subject_ref) {
      next_official_action = {
        label: matter?.outcome ? `Committee action: ${matter.outcome}` : "Matter continuation",
        date: outcome?.event?.date || null,
        status: matter?.outcome || "matter_continuation",
        source_url: matter?.matter_url || outcome?.event?.url || sourceUrl,
      };
      evidence.push({
        field: "next_official_action",
        source_url: matter?.matter_url || outcome?.event?.url || sourceUrl,
        basis: "strict Council meeting/outcome join",
      });
    }
  }

  return freezeProjection({
    schema: CONSEQUENCE_PROJECTION_SCHEMA,
    proceeding_kind: "hearing",
    pending_question,
    body_role,
    participation_modes: [...new Set(modes)],
    record_destination,
    next_official_action,
    evidence,
  });
}

/**
 * Agency rulemaking consequence (CAPA). `record` follows the /rules
 * materialization + City Record notice fields consumed by
 * rules_participation.mjs and action_registry.js's ruleHandoff.
 */
export function ruleConsequence(record = {}, opts = {}) {
  const sourceUrl = httpsUrl(record.official_notice_url) || httpsUrl(record.rule_url) || cityRecordUrl(record.request_id);
  const evidence = [];

  const pendingQuestionText = clean(record.decides);
  const pending_question = pendingQuestionText ? { text: pendingQuestionText } : null;
  if (pending_question) {
    evidence.push({ field: "pending_question", source_url: sourceUrl, basis: "official_notice_decides_field" });
  }

  const body = record.notice_text || noticeBody(record);
  const logistics = inferHearingLogistics({
    body,
    sourceLinks: record.source_links || [],
    physicalLocation: record.venue?.address || record.street_address_1,
  });
  const handoff = actionRegistry.ruleHandoff({ ...record, notice_text: body }, opts);
  const { modes, evidence: participationEvidence } = participationSignals({ logistics, handoff, sourceUrl });
  evidence.push(...participationEvidence);

  const hasHearingSignal = modes.includes("attend_in_person") || modes.includes("join_remote") || modes.includes("watch");
  const participationPath = buildRulesParticipationPath(record, opts.noticeRow || null, opts);
  const facts = extractCommentFacts(record);
  const hasCommentSignal = !!(participationPath?.open || facts.comment_by_date || facts.stage_comment_open);

  const proceeding_kind = hasHearingSignal ? "hearing" : hasCommentSignal ? "comment_period" : "unknown";

  // CAPA governs every notice this composer runs against; the agency
  // ultimately adopts (or does not adopt) the rule.
  const body_role = "decision_maker";
  evidence.push({ field: "body_role", source_url: OFFICIAL_SOURCES.capa, basis: "capa_rulemaking_decision_authority" });

  let record_destination = null;
  if (hasCommentSignal || hasHearingSignal) {
    record_destination = "comment_record";
    evidence.push({ field: "record_destination", source_url: OFFICIAL_SOURCES.capa, basis: "capa_public_comment_record_requirement" });
  }

  let next_official_action = null;
  if (handoff.hearing_upcoming && handoff.hearing_date) {
    next_official_action = {
      label: "Public hearing",
      date: handoff.hearing_date,
      status: "scheduled",
      source_url: handoff.official_notice_url || sourceUrl,
    };
    evidence.push({ field: "next_official_action", source_url: handoff.official_notice_url || sourceUrl, basis: "published_hearing_date" });
  } else if (participationPath?.open && participationPath.comment_by_date) {
    next_official_action = {
      label: "Comment period closes",
      date: participationPath.comment_by_date,
      status: "comment_open",
      source_url: participationPath.submit_url || sourceUrl,
    };
    evidence.push({ field: "next_official_action", source_url: participationPath.submit_url || sourceUrl, basis: "published_comment_deadline" });
  }

  return freezeProjection({
    schema: CONSEQUENCE_PROJECTION_SCHEMA,
    proceeding_kind,
    pending_question,
    body_role,
    participation_modes: [...new Set(modes)],
    record_destination,
    next_official_action,
    evidence,
  });
}

/**
 * Land-use hearing/review consequence. `summary` is a materialized
 * `cityscroll.land_authority_summary.v1` object (site/land_authority_summary.mjs);
 * `matter` is an optional zoningHandoff-shaped hearing payload for logistics.
 */
export function landHearingConsequence({ summary = null, matter = null } = {}) {
  const panel = landAuthorityPanelProjection(summary);
  if (!panel) return emptyConsequenceProjection("missing_land_authority_summary");

  const sourceUrl = httpsUrl(summary?.source_url)
    || (panel.project_id ? `https://zap.planning.nyc.gov/projects/${encodeURIComponent(panel.project_id)}` : null);
  const evidence = [];

  const pendingQuestionText = clean(matter?.decides);
  const pending_question = pendingQuestionText ? { text: pendingQuestionText } : null;
  if (pending_question) {
    evidence.push({ field: "pending_question", source_url: sourceUrl, basis: "official_notice_decides_field" });
  }

  let body_role = "unknown";
  const mappedRole = panel.current_role ? LAND_ROLE_TO_BODY_ROLE[panel.current_role] : null;
  if (mappedRole) {
    body_role = mappedRole;
    const citation = panel.profile_citation;
    evidence.push({
      field: "body_role",
      source_url: citation?.source_url || sourceUrl,
      basis: citation?.citation ? `land_authority_profile:${citation.citation}` : "land_authority_summary_current_role",
    });
  }

  let modes = [];
  if (matter) {
    const body = matter.notice_text || noticeBody(matter);
    const matterSourceUrl = httpsUrl(matter.official_notice_url) || sourceUrl;
    const logistics = inferHearingLogistics({
      body,
      sourceLinks: matter.source_links || [],
      physicalLocation: matter.venue?.address || matter.street_address_1,
    });
    const handoff = actionRegistry.zoningHandoff({ ...matter, notice_text: body });
    const signals = participationSignals({ logistics, handoff, sourceUrl: matterSourceUrl });
    modes = signals.modes;
    evidence.push(...signals.evidence);
  }

  const proceeding_kind = modes.length ? "hearing" : "unknown";

  let next_official_action = null;
  if (panel.published_next_status === "published") {
    next_official_action = {
      label: "Next expected review stage",
      date: null,
      status: panel.expected_next_stage_id || panel.expected_next_group_id || null,
      source_url: sourceUrl,
    };
    evidence.push({ field: "next_official_action", source_url: sourceUrl, basis: "land_authority_published_next_opportunity" });
  }

  return freezeProjection({
    schema: CONSEQUENCE_PROJECTION_SCHEMA,
    proceeding_kind,
    pending_question,
    body_role,
    participation_modes: [...new Set(modes)],
    record_destination: null,
    next_official_action,
    evidence,
  });
}

/**
 * Generic meeting consequence for a shared-meeting-read-model row
 * (`cityscroll.meeting_object.v1`). Only the community-board family is
 * classified as a public meeting here — a bare `descriptive_meeting_v0`
 * row (the City Record "Public Hearings and Meetings" section groups real
 * hearings with observation-only meetings) stays an honest unknown rather
 * than guessing which one it is.
 */
export function meetingConsequence(record = {}) {
  const projection = meetingProcessProjection(record);
  const sourceUrl = httpsUrl(record.source_url) || cityRecordUrl(record.request_id);
  const evidence = [];

  if (projection.meeting_family !== "community_board_meeting_v0") {
    return emptyConsequenceProjection("unresolved_meeting_family");
  }

  evidence.push({ field: "proceeding_kind", source_url: sourceUrl, basis: "meeting_family:community_board_meeting_v0" });

  // meeting_access is hearing_logistics.mjs's own materialized output on this
  // row; fall back to the row's structured venue/participation fields only
  // when it was never computed for this source.
  const logistics = record.meeting_access || {
    in_person_location: record.venue?.address || null,
    remote_join_url: record.participation?.remote_join_url || null,
  };
  const { modes, evidence: participationEvidence } = participationSignals({ logistics, sourceUrl });
  evidence.push(...participationEvidence);

  let record_destination = null;
  if (record.minutes_freshness?.status === "published") {
    record_destination = "minutes";
    evidence.push({ field: "record_destination", source_url: sourceUrl, basis: "minutes_freshness_receipt" });
  }

  let next_official_action = null;
  if (projection.observed_stage === "scheduled" && record.event_date) {
    next_official_action = { label: "Scheduled meeting", date: record.event_date, status: "scheduled", source_url: sourceUrl };
    evidence.push({ field: "next_official_action", source_url: sourceUrl, basis: "observed_event_state:published_event_date" });
  }

  return freezeProjection({
    schema: CONSEQUENCE_PROJECTION_SCHEMA,
    proceeding_kind: "public_meeting",
    pending_question: null,
    body_role: "unknown",
    participation_modes: [...new Set(modes)],
    record_destination,
    next_official_action,
    evidence,
  });
}

/**
 * Proposed-contract-award public comment consequence (post-2025-05-21 NYC
 * process). Deliberately produces only `submit_written` — never Attendance,
 * Zoom, or calendar-event participation modes — since this composer is only
 * for the online comment-window path; a genuinely scheduled live hearing is
 * a different notice and a different composer.
 */
export function contractCommentConsequence(record = {}) {
  const sourceUrl = httpsUrl(record.source_url) || cityRecordUrl(record.request_id);
  const evidence = [];

  const pendingQuestionText = clean(record.decides);
  const pending_question = pendingQuestionText ? { text: pendingQuestionText } : null;
  if (pending_question) {
    evidence.push({ field: "pending_question", source_url: sourceUrl, basis: "official_notice_decides_field" });
  }

  const body_role = "decision_maker";
  evidence.push({ field: "body_role", source_url: OFFICIAL_SOURCES.mocsPublicComment, basis: "mocs_final_award_decision_authority" });

  const record_destination = "comment_record";
  evidence.push({ field: "record_destination", source_url: OFFICIAL_SOURCES.mocsPublicComment, basis: "mocs_comments_considered_before_award" });

  const modes = [];
  const commentUrl = httpsUrl(record.comment_url) || httpsUrl(record.official_notice_url);
  const commentChannel = commentUrl || clean(record.comment_email);
  if (commentChannel) {
    modes.push("submit_written");
    evidence.push({ field: "participation_modes:submit_written", source_url: commentUrl || sourceUrl, basis: "published_comment_channel" });
  }

  let next_official_action = null;
  const deadline = clean(record.comment_by_date || record.deadline);
  if (deadline) {
    next_official_action = { label: "Comment period closes", date: deadline, status: "comment_open", source_url: sourceUrl };
    evidence.push({ field: "next_official_action", source_url: sourceUrl, basis: "published_comment_deadline" });
  }

  return freezeProjection({
    schema: CONSEQUENCE_PROJECTION_SCHEMA,
    proceeding_kind: "comment_period",
    pending_question,
    body_role,
    participation_modes: [...new Set(modes)],
    record_destination,
    next_official_action,
    evidence,
  });
}

/**
 * Single dispatcher over the composers above. `domain` must be one the
 * caller has already established for this record (e.g. from City Record
 * section_name / meeting_family / an explicit workflow) — this function
 * does not classify records on its own.
 */
export function buildConsequenceProjection(domain, record = {}, opts = {}) {
  switch (domain) {
    case "council_hearing":
      return councilHearingConsequence(record, opts);
    case "rule":
      return ruleConsequence(record, opts);
    case "land_hearing":
      return landHearingConsequence(opts);
    case "meeting":
      return meetingConsequence(record);
    case "contract_comment":
      return contractCommentConsequence(record);
    default:
      return emptyConsequenceProjection("unrecognized_domain");
  }
}
