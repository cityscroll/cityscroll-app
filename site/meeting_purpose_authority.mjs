/**
 * PHC-02 — projects PHC-00's evidence-gated consequence projection
 * (site/consequence_projection.mjs) into the small purpose-and-authority
 * summary a meetings result card and a meeting detail page both need: the
 * pending question when the notice itself sourced one, the body's plain-
 * language role, what a submission becomes, and the nearest exact next
 * official action when one has been published.
 *
 * This module adds no new signal and infers nothing beyond what
 * consequence_projection.mjs already proved. It reuses the same
 * council-hearing/meeting domain split site/meetings_attendance.mjs already
 * established for the Meetings landing's attendance filter (PHC-01), so a
 * record's domain resolution is identical across the attendance filter, the
 * participation actions, and this projection. A pending question is only
 * ever the notice's own `decides` text carried through by the composer —
 * never derived from this module — so a descriptive meeting the shared
 * projection could not classify (its `pending_question` stays null) never
 * gets one paraphrased from its title here. A `body_role` or
 * `record_destination` without its own evidence entry likewise stays null
 * rather than guessed.
 */

import { buildConsequenceProjection } from "./consequence_projection.mjs";
import { attendanceDomainForRecord } from "./meetings_attendance.mjs";

export const MEETING_PURPOSE_AUTHORITY_SCHEMA = "cityscroll.meeting_purpose_authority.v1";

/** Plain-language English labels for consequence_projection.mjs's BODY_ROLES, for
 * direct use by English-only surfaces (site/meeting_document.mjs). Surfaces that
 * translate copy (site/app/feed-actions.mjs) key their own i18n string from the
 * `body_role` value instead of reusing this map. */
export const BODY_ROLE_PLAIN_LABEL = Object.freeze({
  receives_record: "Must receive and consider the record, but does not itself decide",
  advisory: "Can recommend, but cannot decide",
  conditional_decision_maker: "Can decide, conditioned on another body's action",
  decision_maker: "Can decide",
  oversight: "Can question and oversee, but cannot decide",
});

/** Plain-language English labels for consequence_projection.mjs's RECORD_DESTINATIONS. */
export const RECORD_DESTINATION_PLAIN_LABEL = Object.freeze({
  testimony: "Becomes part of the hearing testimony record",
  transcript: "Becomes part of the official transcript",
  minutes: "Becomes part of the meeting minutes",
  comment_record: "Becomes part of the official comment record the body must consider",
  decision_document: "Becomes part of the decision record",
});

/** i18n key per non-unknown body role, for surfaces that translate copy
 * (site/app/feed-actions.mjs) instead of reusing BODY_ROLE_PLAIN_LABEL. */
export const BODY_ROLE_LABEL_KEY = Object.freeze({
  receives_record: "meeting_body_role_receives_record",
  advisory: "meeting_body_role_advisory",
  conditional_decision_maker: "meeting_body_role_conditional_decision_maker",
  decision_maker: "meeting_body_role_decision_maker",
  oversight: "meeting_body_role_oversight",
});

/**
 * Project one meeting/hearing record's sourced purpose and authority.
 * `domain` defaults to the same council-hearing/meeting split
 * attendanceDomainForRecord() already uses; pass an explicit `domain` only
 * when the caller has already established a different one (mirrors
 * buildConsequenceProjection()'s own contract).
 */
export function meetingPurposeAuthority(record = {}, opts = {}) {
  const domain = opts.domain || attendanceDomainForRecord(record);
  const projection = buildConsequenceProjection(domain, record, opts.projectionOpts || {});
  const pendingQuestion = projection.pending_question?.text || null;
  const bodyRole = projection.body_role && projection.body_role !== "unknown"
    ? projection.body_role
    : null;
  const recordDestination = projection.record_destination || null;
  return Object.freeze({
    schema: MEETING_PURPOSE_AUTHORITY_SCHEMA,
    proceeding_kind: projection.proceeding_kind,
    pending_question: pendingQuestion,
    body_role: bodyRole,
    body_role_label: bodyRole ? (BODY_ROLE_PLAIN_LABEL[bodyRole] || null) : null,
    record_destination: recordDestination,
    record_destination_label: recordDestination
      ? (RECORD_DESTINATION_PLAIN_LABEL[recordDestination] || null)
      : null,
    next_official_action: projection.next_official_action || null,
  });
}

/**
 * Result-card fragment: the sourced pending question and plain-language
 * body role only (record_destination and next_official_action are the
 * meeting detail page's fuller "what this means" pattern, not the compact
 * card's). Renders nothing unless meetingPurposeAuthority() itself sourced
 * a pending question or a body role. Takes its i18n `t()` and HTML-escape
 * function from the caller so this module stays free of a UI-runtime
 * dependency; `excerpt(text, maxLen)` bounds the pending-question length.
 */
export function meetingPurposeAuthorityCardHTML(record, { t, escape, excerpt }) {
  const purpose = meetingPurposeAuthority(record);
  const rows = [];
  if (purpose.pending_question) {
    rows.push(`<p class="meetings-purpose-question"><b>${escape(t("meeting_purpose_question_label"))}</b> ${excerpt(purpose.pending_question, 220)}</p>`);
  }
  const roleKey = purpose.body_role && BODY_ROLE_LABEL_KEY[purpose.body_role];
  if (roleKey) {
    rows.push(`<p class="meetings-purpose-role">${escape(t(roleKey))}.</p>`);
  }
  return rows.length ? `<div class="meetings-purpose-authority">${rows.join("")}</div>` : "";
}
