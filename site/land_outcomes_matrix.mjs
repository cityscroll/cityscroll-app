/**
 * Recommendations-and-decisions matrix for Land project detail (LDP-10).
 *
 * Consumes the SAME `observed_outcomes[]` contract that powers timeline
 * evidence (`land_actor_outcome.mjs`) — this module never re-derives an
 * actor, action, or raw value from a source disposition row. It only adds a
 * presentation-shaped `body_href` and reconciles affected bodies that never
 * produced an observed outcome ("recommendation not found"), which is
 * disclosure, not a manufactured row.
 */

import { communityBoardPageHref } from "./community_board_links.mjs";
import { buildActorObservedOutcomes } from "./land_actor_outcome.mjs";

export const LAND_OUTCOMES_MATRIX_SCHEMA = "cityscroll.land_outcomes_matrix.v1";

function clean(value, max = 500) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function actorHrefForOutcome(bodyRef) {
  const ref = clean(bodyRef, 120);
  const board = ref.match(/^community-board:(.+)$/);
  if (board) return communityBoardPageHref(board[1]);
  const agency = ref.match(/^agency:id:(.+)$/);
  if (agency) return `/agencies/${encodeURIComponent(agency[1])}/`;
  return null;
}

function matrixRowFromOutcome(outcome) {
  return {
    schema: LAND_OUTCOMES_MATRIX_SCHEMA,
    status: "observed",
    body_ref: outcome.actor_ref,
    body_href: actorHrefForOutcome(outcome.actor_ref),
    actor_kind: outcome.actor_kind,
    is_advisory: outcome.is_advisory,
    observed_action: outcome.observed_action,
    raw_outcome: outcome.raw_outcome,
    date: outcome.observed_at,
    vote_tally: outcome.vote_tally,
    document_count: outcome.document_count,
    legal_effect_from_profile: outcome.legal_effect_from_profile,
    action_key: outcome.action_key,
    disposition_id: outcome.disposition_id,
    source_ids: outcome.source_ids,
  };
}

function actorKindFromAffectedRole(role) {
  const match = clean(role, 40).match(/^affected_(.+)$/);
  return match ? match[1] : null;
}

/**
 * Rows for bodies the project's own geography names as affected (LDP-04)
 * that never produced an observed outcome in `observed_outcomes[]`. This is
 * "recommendation not found" disclosure — it never fabricates a value.
 */
function notFoundRows(observedOutcomes, affectedEdges) {
  const seenRefs = new Set(observedOutcomes.map((outcome) => outcome.actor_ref));
  const rows = [];
  for (const edge of Array.isArray(affectedEdges) ? affectedEdges : []) {
    const bodyRef = edge?.body_ref;
    if (!bodyRef || seenRefs.has(bodyRef)) continue;
    rows.push({
      schema: LAND_OUTCOMES_MATRIX_SCHEMA,
      status: "recommendation_not_found",
      body_ref: bodyRef,
      body_href: edge.href || actorHrefForOutcome(bodyRef),
      actor_kind: actorKindFromAffectedRole(edge.role),
      is_advisory: true,
      observed_action: null,
      raw_outcome: null,
      date: null,
      vote_tally: null,
      document_count: null,
      legal_effect_from_profile: null,
      action_key: null,
      disposition_id: null,
      source_ids: [],
    });
  }
  return rows;
}

/**
 * Build the matrix row set: one row per observed outcome, plus one
 * "recommendation not found" row per affected body with no observed outcome
 * (e.g. Borough Board affected on a draft-only project). `affectedEdges` is
 * the compact `affected_actor_refs`/`edges` list from `land_affected_review_body.mjs`.
 */
export function buildLandOutcomesMatrixRows(observedOutcomes = [], { affectedEdges = [] } = {}) {
  const rows = Array.isArray(observedOutcomes) ? observedOutcomes.map(matrixRowFromOutcome) : [];
  return [...rows, ...notFoundRows(observedOutcomes, affectedEdges)];
}

function fdateOr(value, dash) {
  return value || dash;
}

/**
 * Resident renderer. Body, observed role/action, published outcome, raw
 * source value, date, vote/document, and profile-derived effect — one column
 * per Product-delta field, straight from the shared row shape above.
 */
export function landOutcomesMatrixHTML(rows, { t, escape } = {}) {
  const translate = typeof t === "function" ? t : (key) => key;
  const esc = typeof escape === "function" ? escape : (value) => String(value ?? "");
  if (!Array.isArray(rows) || !rows.length) return "";
  const dash = translate("land_outcomes_matrix_dash");
  const body = rows.map((row) => {
    const notFound = row.status === "recommendation_not_found";
    const actorLabel = row.body_href
      ? `<a href="${esc(row.body_href)}" data-body-ref="${esc(row.body_ref || "")}">${esc(row.body_ref || dash)}</a>`
      : `<span data-body-ref="${esc(row.body_ref || "")}">${esc(row.body_ref || dash)}</span>`;
    const actionLabel = notFound
      ? translate("land_outcomes_matrix_not_found")
      : esc(translate(`land_outcomes_matrix_action_${row.observed_action}`));
    const tally = row.vote_tally
      ? translate("land_outcomes_vote_tally_html", {
        favor: String(row.vote_tally.for ?? "—"),
        against: String(row.vote_tally.against ?? "—"),
      })
      : "";
    const effect = row.legal_effect_from_profile?.effect || dash;
    return `<tr data-land-outcomes-matrix-row="1" data-status="${esc(row.status)}" data-body-ref="${esc(row.body_ref || "")}" data-actor-kind="${esc(row.actor_kind || "")}" data-observed-action="${esc(row.observed_action || "")}" data-action-key="${esc(row.action_key || "")}">
      <td data-land-outcomes-matrix-body="1">${actorLabel}${row.is_advisory ? ` <span class="land-authority-advisory">${esc(translate("land_authority_advisory"))}</span>` : ""}</td>
      <td data-land-outcomes-matrix-action="1">${actionLabel}</td>
      <td data-land-outcomes-matrix-raw="1">${esc(fdateOr(row.raw_outcome, dash))}</td>
      <td data-land-outcomes-matrix-date="1">${esc(fdateOr(row.date, dash))}</td>
      <td data-land-outcomes-matrix-vote="1">${tally ? esc(tally) : esc(dash)}${row.document_count ? ` · ${esc(String(row.document_count))}` : ""}</td>
      <td data-land-outcomes-matrix-effect="1">${esc(effect)}</td>
    </tr>`;
  }).join("");
  return `<table class="land-outcomes-matrix" data-land-outcomes-matrix="1">
    <caption>${esc(translate("land_outcomes_matrix_heading"))}</caption>
    <thead><tr>
      <th>${esc(translate("land_outcomes_matrix_col_body"))}</th>
      <th>${esc(translate("land_outcomes_matrix_col_action"))}</th>
      <th>${esc(translate("land_outcomes_matrix_col_raw"))}</th>
      <th>${esc(translate("land_outcomes_matrix_col_date"))}</th>
      <th>${esc(translate("land_outcomes_matrix_col_vote"))}</th>
      <th>${esc(translate("land_outcomes_matrix_col_effect"))}</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

/** One-call glue for a ZAP outcome record + its list row (route callers only). */
export default function matrixHTML(record, listRow, t, escape) {
  const outcomes = buildActorObservedOutcomes(record?.dispositions, {
    projectId: record?.project_id,
    project: listRow || record,
  });
  const rows = buildLandOutcomesMatrixRows(outcomes, {
    affectedEdges: listRow?.authority_summary?.affected_actor_refs || [],
  });
  return landOutcomesMatrixHTML(rows, { t, escape });
}
