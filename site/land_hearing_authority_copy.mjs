/**
 * PHC-06 -- plain-language body-role statement for the Land "Where this
 * stands" authority panel (site/land_authority_summary_view.mjs) and the
 * compressed upcoming-hearing row (site/app/land.mjs's landHearingRowHTML).
 *
 * This is not a second process explainer: it is a short-sentence projection
 * of the `current_role` the existing authority summary
 * (site/land_authority_summary.mjs) already resolved from the procedure
 * profile and decision-relation vocabulary
 * (site/land_project_decision_relations.mjs). It adds no new signal, infers
 * no role, and renders nothing when the current role does not resolve -- an
 * unresolved procedure, an unmatched current stage, or an observed-only
 * route beyond the profile's own vocabulary (e.g. an observed Council action
 * under an unresolved §197-e(k) variant) all stay silent here exactly as the
 * panel's own fields already do.
 *
 * Voice matches PHC-02's meeting-body plain-role labels
 * (site/meeting_purpose_authority.mjs's BODY_ROLE_PLAIN_LABEL) so a reader
 * meets the same "can decide" / "cannot decide" phrasing whether the record
 * is a meeting or a land-use hearing.
 */

export const LAND_HEARING_AUTHORITY_COPY_SCHEMA = "cityscroll.land_hearing_authority_copy.v1";

/** i18n key per land_authority_summary_view.mjs current_role, for the panel's
 * one-sentence plain-role statement. */
export const LAND_AUTHORITY_PLAIN_ROLE_LABEL_KEY = Object.freeze({
  advisory_reviewer: "land_authority_plain_role_advisory_reviewer",
  decision_maker: "land_authority_plain_role_decision_maker",
  conditional_decision_maker: "land_authority_plain_role_conditional_decision_maker",
  administrative_certifier: "land_authority_plain_role_administrative_certifier",
  executive_review: "land_authority_plain_role_executive_review",
  plan_proposer: "land_authority_plain_role_plan_proposer",
});

/** Same vocabulary, compressed for the upcoming-hearing row. */
export const LAND_HEARING_ROW_ROLE_LABEL_KEY = Object.freeze({
  advisory_reviewer: "land_hearing_row_role_advisory_reviewer",
  decision_maker: "land_hearing_row_role_decision_maker",
  conditional_decision_maker: "land_hearing_row_role_conditional_decision_maker",
  administrative_certifier: "land_hearing_row_role_administrative_certifier",
  executive_review: "land_hearing_row_role_executive_review",
  plan_proposer: "land_hearing_row_role_plan_proposer",
});

/**
 * The evidence-gated current role, or null. A summary the authority
 * materializer could not resolve (`status !== "resolved"`) never reaches a
 * role here, matching landAuthoritySummaryHTML's own unknown-state handling.
 */
function resolvedRole(summary) {
  return summary && summary.status === "resolved" && summary.current_role
    ? summary.current_role
    : null;
}

export function landAuthorityPlainRoleKey(summary) {
  const role = resolvedRole(summary);
  return role ? (LAND_AUTHORITY_PLAIN_ROLE_LABEL_KEY[role] || null) : null;
}

export function landHearingRowRoleKey(summary) {
  const role = resolvedRole(summary);
  return role ? (LAND_HEARING_ROW_ROLE_LABEL_KEY[role] || null) : null;
}

/**
 * Panel fragment: one short sentence stating this body's role in plain
 * terms, sited inside the existing "Where this stands" panel markup -- never
 * a second explainer beside it. Renders "" when the role does not resolve.
 */
export function landAuthorityPlainRoleHTML(summary, { t, escape } = {}) {
  const key = landAuthorityPlainRoleKey(summary);
  if (!key) return "";
  const translate = typeof t === "function" ? t : (value) => value;
  const esc = typeof escape === "function" ? escape : (value) => String(value ?? "");
  return `<p class="land-authority-plain-role" data-land-authority-plain-role="${esc(summary.current_role)}">${esc(translate(key))}</p>`;
}

/**
 * Upcoming-hearing row fragment: the same evidence, compressed to a short
 * phrase for a row that already carries date, venue, and mode. Renders ""
 * when the role does not resolve, so a record the panel itself would show no
 * role for never gains one here either.
 */
export function landHearingRowRoleHTML(summary, { t, escape } = {}) {
  const key = landHearingRowRoleKey(summary);
  if (!key) return "";
  const translate = typeof t === "function" ? t : (value) => value;
  const esc = typeof escape === "function" ? escape : (value) => String(value ?? "");
  return `<span class="land-hearing-row-role" data-land-hearing-row-role="${esc(summary.current_role)}">${esc(translate(key))}</span>`;
}
