/**
 * Resident renderer for a bounded Land authority summary.
 * Accepts a precomputed summary only — it does not resolve procedure or fetch.
 */

import { communityBoardPageHref } from "./community_board_links.mjs";

export const LAND_AUTHORITY_SUMMARY_URL = "data/land_authority_summary.json";
let landAuthorityLookup = null;

export function rememberLandAuthoritySummaries(payload) {
  landAuthorityLookup = payload?.summaries && typeof payload.summaries === "object" ? payload.summaries : {};
  return landAuthorityLookup;
}

export function attachLandAuthoritySummaries(target, payload) {
  if (payload) rememberLandAuthoritySummaries(payload);
  const summaries = landAuthorityLookup;
  const rows = Array.isArray(target) ? target : target?.projects;
  if (summaries && Array.isArray(rows)) {
    for (const row of rows) {
      const summary = summaries[row?.project_id];
      if (summary) row.authority_summary = summary;
    }
  }
  return target;
}

export function landAuthoritySummaryFor(row) {
  return row?.authority_summary || landAuthorityLookup?.[row?.project_id] || null;
}

export function loadLandAuthoritySummaryLookup() {
  return fetch(LAND_AUTHORITY_SUMMARY_URL, { cache: "force-cache", credentials: "omit" })
    .then((response) => response.ok ? response.json() : null)
    .then((payload) => rememberLandAuthoritySummaries(payload))
    .catch(() => rememberLandAuthoritySummaries(null));
}

function clean(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function actorHref(bodyRef) {
  const ref = clean(bodyRef);
  if (!ref) return null;
  const board = ref.match(/^community-board:(.+)$/);
  if (board) return communityBoardPageHref(board[1]);
  const agency = ref.match(/^agency:id:(.+)$/);
  if (agency) return `/agencies/${encodeURIComponent(agency[1])}/`;
  return null;
}

function actorLabel(bodyRef, translate) {
  const ref = clean(bodyRef) || "";
  const board = ref.match(/^community-board:([a-z]+(?:-[a-z]+)*)-cb-(\d{2})$/);
  if (board) {
    const borough = board[1].replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
    return `${borough} Community Board ${Number(board[2])}`;
  }
  if (ref === "agency:id:city-council") return translate("land_phase_city_council");
  if (ref === "agency:id:city-planning-commission") return translate("land_phase_cpc");
  if (ref === "agency:id:city-planning") return translate("land_authority_actor_dcp");
  if (ref === "agency:id:mayor") return translate("land_phase_mayoral_appeals");
  const president = ref.match(/^borough-president:([a-z]+(?:-[a-z]+)*)$/);
  if (president) {
    const borough = president[1].replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
    return `${borough} Borough President`;
  }
  const boroughBoard = ref.match(/^borough-board:([a-z]+(?:-[a-z]+)*)$/);
  if (boroughBoard) {
    const borough = boroughBoard[1].replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
    return `${borough} Borough Board`;
  }
  return ref || translate("land_authority_unknown");
}

function linkedActor(bodyRef, { t, esc }) {
  const label = actorLabel(bodyRef, t);
  const href = actorHref(bodyRef);
  if (!href) return `<span data-body-ref="${esc(bodyRef || "")}">${esc(label)}</span>`;
  return `<a href="${esc(href)}" data-body-ref="${esc(bodyRef || "")}">${esc(label)}</a>`;
}

function fieldValue(status, known, unknownText, esc) {
  if (status === "unknown" || known == null || known === "") return esc(unknownText);
  return known;
}

function roleKey(role) {
  if (!role) return null;
  return `land_authority_role_${role}`;
}

function stageLabel(stage, translate) {
  if (!stage || stage.status === "unknown" || !stage.spine_phase_id) {
    return translate("land_authority_unknown");
  }
  const key = `land_phase_${stage.spine_phase_id}`;
  const label = translate(key);
  return label === key ? stage.spine_phase_id : label;
}

function publishedLabel(published, translate, esc) {
  if (!published || published.status === "unknown") return esc(translate("land_authority_unknown"));
  if (published.status === "none") return esc(translate("land_authority_none_published"));
  const date = published.date ? ` (${esc(published.date)})` : "";
  const label = published.label || published.representing || translate("land_future_hearing");
  return `${esc(label)}${date}`;
}

function observedStatusCopy(observed, translate) {
  if (observed?.status === "draft_only") return translate("land_authority_draft_only");
  if (observed?.status === "no_observation") return translate("land_authority_no_observation");
  return null;
}

export function landAuthoritySummaryHTML(summary, { t, escape } = {}) {
  if (!summary || summary.schema !== "cityscroll.land_authority_summary.v1") return "";
  const translate = typeof t === "function" ? t : (key) => key;
  const esc = typeof escape === "function" ? escape : (value) => String(value ?? "");
  const unknown = translate("land_authority_unknown");
  const actors = Array.isArray(summary.current_actor_refs) ? summary.current_actor_refs : [];
  const actorHTML = actors.length
    ? actors.map((ref) => linkedActor(ref, { t: translate, esc })).join(", ")
    : esc(unknown);
  const role = summary.current_role
    ? translate(roleKey(summary.current_role))
    : unknown;
  const effect = summary.effect || unknown;
  const expected = summary.expected_next_stage?.stage_id
    ? stageLabel(summary.expected_next_stage, translate)
    : unknown;
  const published = publishedLabel(summary.published_next_opportunity, translate, esc);
  const observed = summary.observed || {};
  const recs = Array.isArray(observed.recommendations) ? observed.recommendations : [];
  const observedCopy = observedStatusCopy(observed, translate);
  const observedHTML = recs.length
    ? recs.map((row) => {
      const tally = row.votes_for != null || row.votes_against != null
        ? ` · ${translate("land_outcomes_vote_tally_html", {
          favor: String(row.votes_for ?? "—"),
          against: String(row.votes_against ?? "—"),
        })}`
        : "";
      const body = row.body_ref
        ? linkedActor(row.body_ref, { t: translate, esc })
        : esc(row.representing || unknown);
      return `<li data-land-authority-observed="1" data-body-ref="${esc(row.body_ref || "")}" data-source-id="${esc(row.source_id || "")}">${body}: ${esc(row.value || unknown)}${tally}</li>`;
    }).join("")
    : observedCopy
      ? `<li data-land-authority-observed="${esc(observed.status)}">${esc(observedCopy)}</li>`
      : "";
  const affected = Array.isArray(summary.affected_actor_refs) ? summary.affected_actor_refs : [];
  const affectedHTML = affected.map((row) => (
    `<li data-land-authority-affected="1" data-role="${esc(row.role || "")}">${linkedActor(row.body_ref, { t: translate, esc })}</li>`
  )).join("");

  return `<section class="land-authority-summary" data-land-authority-summary="1" data-land-authority-summary-first-paint="1" data-status="${esc(summary.status)}" data-procedure-id="${esc(summary.procedure_id || "")}" data-procedure-resolution="${esc(summary.procedure_resolution || "")}" data-reason="${esc(summary.reason || "")}">
    <div class="land-authority-kicker">${esc(translate("land_authority_heading"))}</div>
    <dl class="land-authority-facts">
      <div><dt>${esc(translate("land_authority_actor"))}</dt><dd data-land-authority-actor="1">${actorHTML}</dd></div>
      <div><dt>${esc(translate("land_authority_stage"))}</dt><dd data-land-authority-stage="${esc(summary.current_stage?.stage_id || "")}">${esc(stageLabel(summary.current_stage, translate))}</dd></div>
      <div><dt>${esc(translate("land_authority_role"))}</dt><dd data-land-authority-role="${esc(summary.current_role || "")}">${esc(role === roleKey(summary.current_role) ? summary.current_role : role)}</dd></div>
      <div><dt>${esc(translate("land_authority_effect"))}</dt><dd data-land-authority-effect="1">${esc(fieldValue(summary.status, summary.effect, unknown, (value) => value) === unknown ? unknown : effect)}</dd></div>
      <div><dt>${esc(translate("land_authority_expected_next"))}</dt><dd data-land-authority-expected-next="${esc(summary.expected_next_stage?.stage_id || "")}">${esc(expected)}</dd></div>
      <div><dt>${esc(translate("land_authority_published_next"))}</dt><dd data-land-authority-published-next="${esc(summary.published_next_opportunity?.status || "unknown")}" data-source-id="${esc(summary.published_next_opportunity?.source_id || "")}">${published}</dd></div>
    </dl>
    ${affectedHTML ? `<div class="land-authority-affected"><div class="land-authority-subhead">${esc(translate("land_authority_affected"))}</div><ul>${affectedHTML}</ul></div>` : ""}
    ${observedHTML ? `<div class="land-authority-observed"><div class="land-authority-subhead">${esc(translate("land_authority_observed"))}</div><ul>${observedHTML}</ul></div>` : ""}
  </section>`;
}

export const attachAuth = attachLandAuthoritySummaries;
export const loadAuth = loadLandAuthoritySummaryLookup;
export const authHTML = landAuthoritySummaryHTML;
