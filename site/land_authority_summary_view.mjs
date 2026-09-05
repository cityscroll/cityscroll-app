/**
 * Resident renderer for a bounded Land authority summary.
 * Accepts a precomputed summary only — it does not resolve procedure or fetch
 * a publisher. Profile, phase, geography, and published-opportunity facts stay
 * in separate DOM/data structures.
 */

import { communityBoardPageHref } from "./community_board_links.mjs";
import { calendarNativeSubscriptionUrl } from "./calendar_subscription.mjs";
import {
  projectCalendarFeedUrl,
  projectCalendarFollowHref,
} from "./project_calendar.mjs";

export const LAND_AUTHORITY_SUMMARY_URL = "data/land_authority_summary.json";
export const LAND_AUTHORITY_PANEL_HEADING = "Where this stands";

export const GEOGRAPHY_LEGAL_BASIS = Object.freeze({
  citation: "NYC Charter § 196",
  source_url: "https://codelibrary.amlegal.com/codes/newyorkcity/latest/NYCcharter/0-0-0-824",
});

const ADVISORY_BODY_PREFIXES = Object.freeze([
  "community-board:",
  "borough-president:",
  "borough-board:",
]);

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

function applyVars(text, vars) {
  if (!vars) return text;
  return String(text).replace(/\{(\w+)\}/g, (match, name) => (
    Object.hasOwn(vars, name) ? String(vars[name] ?? "") : match
  ));
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

export function actorLabel(bodyRef, translate) {
  const ref = clean(bodyRef) || "";
  const board = ref.match(/^community-board:([a-z]+(?:-[a-z]+)*)-cb-(\d{2})$/);
  if (board) {
    const borough = board[1].replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
    return `${borough} Community Board ${Number(board[2])}`;
  }
  if (ref === "agency:id:city-council") return translate("land_authority_actor_council");
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

function actorStandLabel(bodyRef, translate) {
  const ref = clean(bodyRef) || "";
  if (ref === "agency:id:city-council") return translate("land_authority_actor_short_council");
  if (ref === "agency:id:city-planning-commission") return translate("land_authority_actor_short_cpc");
  return actorLabel(bodyRef, translate);
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

function roleHereKey(role) {
  if (!role) return null;
  return `land_authority_role_here_${role}`;
}

function phaseLabel(phaseId, translate) {
  const key = `land_phase_${phaseId}`;
  const label = translate(key);
  return label === key ? phaseId : label;
}

/**
 * A parallel-group next stage (e.g. Community Board / Borough President
 * reviewed at the same time under § 197-e) is never collapsed into a single
 * label implying a first-then-second order.
 */
function stageLabel(stage, translate) {
  if (stage?.group_id && Array.isArray(stage.spine_phase_ids) && stage.spine_phase_ids.length) {
    return translate("land_authority_expected_next_parallel", {
      members: stage.spine_phase_ids.map((phaseId) => phaseLabel(phaseId, translate)).join(` ${translate("land_authority_and")} `),
    });
  }
  if (!stage || stage.status === "unknown" || !stage.spine_phase_id) {
    return translate("land_authority_unknown");
  }
  return phaseLabel(stage.spine_phase_id, translate);
}

function publishedOpportunityCopy(published, translate) {
  const status = published?.status;
  const vintage = published?.checked_vintage || "";
  if (status === "published") {
    const date = published.date ? ` (${published.date})` : "";
    return `${published.label || published.representing || translate("land_future_hearing")}${date}`;
  }
  if (status === "none") return translate("land_authority_opportunity_none", { date: vintage });
  if (status === "stale") return translate("land_authority_opportunity_stale", { date: vintage });
  return translate("land_authority_opportunity_unknown");
}

function publishedLabel(published, translate, esc) {
  return esc(publishedOpportunityCopy(published, translate));
}

function observedStatusCopy(observed, translate) {
  if (observed?.status === "draft_only") return translate("land_authority_draft_only");
  if (observed?.status === "no_observation") return translate("land_authority_no_observation");
  return null;
}

function isAdvisoryBody(bodyRef) {
  const ref = clean(bodyRef) || "";
  return ADVISORY_BODY_PREFIXES.some((prefix) => ref.startsWith(prefix));
}

function whyKind(summary) {
  if (summary?.status === "unknown") return "unknown";
  const refs = Array.isArray(summary?.current_actor_refs) ? summary.current_actor_refs : [];
  if (refs.some((ref) => String(ref).startsWith("community-board:"))) return "community_board";
  if (refs.some((ref) => String(ref).startsWith("borough-board:"))) return "borough_board";
  if (refs.some((ref) => String(ref).startsWith("borough-president:"))) return "borough_president";
  return "profile";
}

function whyCopy(summary, translate) {
  if (summary?.status === "unknown") {
    const reasonKey = summary.reason ? `land_authority_reason_${summary.reason}` : "land_authority_why_unknown";
    const labeled = translate(reasonKey);
    return labeled === reasonKey ? translate("land_authority_why_unknown") : labeled;
  }
  const kind = whyKind(summary);
  if (kind === "community_board") return translate("land_authority_why_community_board");
  if (kind === "borough_board") return translate("land_authority_why_borough_board");
  if (kind === "borough_president") return translate("land_authority_why_borough_president");
  return translate("land_authority_why_profile");
}

function whyProvenanceKind(summary) {
  const kind = whyKind(summary);
  if (kind === "unknown") return "unknown";
  if (kind === "profile") return "profile";
  return "geography";
}

export function profileLegalBasis(summary) {
  const profile = summary?.source_basis?.profile || {};
  const basis = profile.legal_basis && typeof profile.legal_basis === "object"
    ? profile.legal_basis
    : null;
  const procedureId = profile.procedure_id || summary?.procedure_id || null;
  const stageId = profile.stage_id || summary?.current_stage?.stage_id || null;
  if (!basis && !procedureId) return null;
  return {
    citation: basis?.citation || null,
    source_url: basis?.source_url || null,
    registry_version: profile.registry_version || null,
    procedure_id: procedureId,
    stage_id: stageId,
  };
}

/**
 * A "Follow next decision" watch is only offered when the resolved procedure
 * profile names a concrete next stage. An unresolved procedure, a terminal
 * stage, or an observed event beyond the resolved profile's own vocabulary
 * (e.g. E4's Council completion under an unresolved §197-e(k) variant) all
 * fall back to "Follow this project" — a real project-level watch, never a
 * placeholder next-decision target.
 */
function hasMaterializedNextDecision(summary) {
  const next = summary?.expected_next_stage;
  return summary?.status === "resolved" && Boolean(next?.stage_id || next?.group_id);
}

function calendarEligible(published) {
  return published?.status === "published" && Boolean(published?.date);
}

export function landAuthorityPanelProjection(summary) {
  if (!summary || summary.schema !== "cityscroll.land_authority_summary.v1") return null;
  const published = summary.published_next_opportunity || {};
  return {
    project_id: summary.project_id || null,
    status: summary.status || "unknown",
    reason: summary.reason || null,
    current_role: summary.current_role || null,
    current_stage_id: summary.current_stage?.stage_id || null,
    current_phase_id: summary.current_stage?.spine_phase_id || null,
    expected_next_stage_id: summary.expected_next_stage?.stage_id || null,
    expected_next_group_id: summary.expected_next_stage?.group_id || null,
    published_next_status: published.status || "unknown",
    published_next_source_id: published.source_id || null,
    published_next_checked: published.checked === true,
    published_next_checked_vintage: published.checked_vintage || null,
    observed_status: summary.observed?.status || "no_observation",
    why_kind: whyKind(summary),
    why_provenance: whyProvenanceKind(summary),
    profile_citation: profileLegalBasis(summary),
    phase_milestone: summary.source_basis?.phase?.current_milestone || null,
    milestone_phase_id: summary.source_basis?.phase?.milestone_phase_id || null,
    geography_status: summary.source_basis?.geography?.status || null,
    publisher_checked: published.checked === true,
    watch_target: hasMaterializedNextDecision(summary) ? "next_decision" : "project",
    calendar_eligible: calendarEligible(published),
  };
}

function sourceLink(href, label, esc) {
  if (!href || !label) return esc(label || "");
  return `<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${esc(label)}</a>`;
}

function panelActionsHTML(summary, esc, translate) {
  const projectId = summary?.project_id;
  if (!projectId) return "";
  const followUrl = projectCalendarFollowHref(projectId);
  const bits = [];
  if (followUrl) {
    const nextDecision = hasMaterializedNextDecision(summary);
    const watchKey = nextDecision ? "land_authority_follow_next" : "next_action_watch_project";
    const watchTarget = nextDecision ? "next_decision" : "project";
    bits.push(`<a class="act project-follow-btn" data-land-authority-follow="1" data-project-follow="${esc(watchTarget)}" href="${esc(followUrl)}">${esc(translate(watchKey))}</a>`);
  }
  const published = summary.published_next_opportunity || {};
  if (calendarEligible(published)) {
    const feedUrl = projectCalendarFeedUrl(projectId);
    const webcalUrl = calendarNativeSubscriptionUrl(feedUrl);
    if (webcalUrl) {
      bits.push(`<a class="act calendar-subscribe-btn" data-land-authority-calendar="1" data-calendar-subscription="scope" data-calendar-subscription-feed="${esc(feedUrl)}" data-calendar-subscription-webcal="${esc(webcalUrl)}" href="${esc(webcalUrl)}">${esc(translate("land_authority_add_calendar"))}</a>`);
    }
  }
  if (!bits.length) return "";
  return `<div class="land-authority-actions" data-land-authority-actions="1">${bits.join("")}</div>`;
}

export function landAuthoritySummaryHTML(summary, { t, escape } = {}) {
  if (!summary || summary.schema !== "cityscroll.land_authority_summary.v1") return "";
  const translate = typeof t === "function"
    ? (key, vars) => applyVars(t(key, vars), vars)
    : (key) => key;
  const esc = typeof escape === "function" ? escape : (value) => String(value ?? "");
  const unknown = translate("land_authority_unknown");
  const actors = Array.isArray(summary.current_actor_refs) ? summary.current_actor_refs : [];
  const actorHTML = actors.length
    ? actors.map((ref) => linkedActor(ref, { t: translate, esc })).join(", ")
    : esc(unknown);
  const standActor = actors.length ? actorStandLabel(actors[0], translate) : unknown;
  const role = summary.current_role
    ? translate(roleKey(summary.current_role))
    : unknown;
  const roleHere = summary.current_role
    ? translate(roleHereKey(summary.current_role))
    : unknown;
  const resolvedRole = role === roleKey(summary.current_role) ? summary.current_role : role;
  const resolvedRoleHere = roleHere === roleHereKey(summary.current_role)
    ? resolvedRole
    : roleHere;
  const effect = summary.effect || unknown;
  const expected = (summary.expected_next_stage?.stage_id || summary.expected_next_stage?.group_id)
    ? stageLabel(summary.expected_next_stage, translate)
    : (summary.status === "unknown" ? unknown : translate("land_authority_no_expected"));
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
      const advisory = isAdvisoryBody(row.body_ref);
      const advisoryBit = advisory
        ? ` <span class="land-authority-advisory" data-land-authority-advisory="1">${esc(translate("land_authority_advisory"))}</span>`
        : "";
      return `<li data-land-authority-observed="1" data-land-authority-observed-kind="${advisory ? "advisory" : "observed"}" data-body-ref="${esc(row.body_ref || "")}" data-source-id="${esc(row.source_id || "")}">${body}: ${esc(row.value || unknown)}${tally}${advisoryBit}</li>`;
    }).join("")
    : observedCopy
      ? `<li data-land-authority-observed="${esc(observed.status)}">${esc(observedCopy)}</li>`
      : "";
  const affected = Array.isArray(summary.affected_actor_refs) ? summary.affected_actor_refs : [];
  const affectedHTML = affected.map((row) => (
    `<li data-land-authority-affected="1" data-role="${esc(row.role || "")}" data-land-authority-provenance="geography">${linkedActor(row.body_ref, { t: translate, esc })}</li>`
  )).join("");
  const why = whyCopy(summary, translate);
  const whyKindValue = whyKind(summary);
  const whyProvenance = whyProvenanceKind(summary);
  const stage = stageLabel(summary.current_stage, translate);
  const stand = summary.status === "unknown"
    ? translate("land_authority_stand_unknown")
    : translate("land_authority_stand", {
      stage,
      actor: standActor,
      role: resolvedRoleHere,
      why,
    });
  const citation = profileLegalBasis(summary);
  const phaseMilestone = summary.source_basis?.phase?.current_milestone || "";
  const publisher = summary.published_next_opportunity || {};
  const publisherCopy = publishedOpportunityCopy(publisher, translate);
  const profileCitation = citation?.citation
    ? sourceLink(citation.source_url, citation.citation, esc)
    : esc(translate("land_authority_not_found"));
  const geographyCitation = sourceLink(
    GEOGRAPHY_LEGAL_BASIS.source_url,
    GEOGRAPHY_LEGAL_BASIS.citation,
    esc,
  );

  return `<section class="land-authority-summary" id="land-authority-summary" data-land-authority-summary="1" data-land-authority-summary-first-paint="1" data-project-id="${esc(summary.project_id || "")}" data-status="${esc(summary.status)}" data-procedure-id="${esc(summary.procedure_id || "")}" data-procedure-resolution="${esc(summary.procedure_resolution || "")}" data-reason="${esc(summary.reason || "")}">
    <h3 class="land-authority-kicker">${esc(translate("land_authority_heading"))}</h3>
    <p class="land-authority-stand" data-land-authority-stand="1">${esc(stand)}</p>
    <dl class="land-authority-facts">
      <div data-land-authority-provenance="phase"><dt>${esc(translate("land_authority_stage"))}</dt><dd data-land-authority-stage="${esc(summary.current_stage?.stage_id || "")}">${esc(stage)}</dd></div>
      <div><dt>${esc(translate("land_authority_actor"))}</dt><dd data-land-authority-actor="1">${actorHTML}</dd></div>
      <div data-land-authority-provenance="profile"><dt>${esc(translate("land_authority_role"))}</dt><dd data-land-authority-role="${esc(summary.current_role || "")}">${esc(resolvedRole)}</dd></div>
      <div data-land-authority-provenance="profile"><dt>${esc(translate("land_authority_effect"))}</dt><dd data-land-authority-effect="1">${esc(fieldValue(summary.status, summary.effect, unknown, (value) => value) === unknown ? unknown : effect)}</dd></div>
      <div data-land-authority-why-kind="${esc(whyKindValue)}" data-land-authority-provenance="${esc(whyProvenance)}"><dt>${esc(translate("land_authority_why"))}</dt><dd data-land-authority-why="1">${esc(why)}</dd></div>
      <div data-land-authority-provenance="profile"><dt>${esc(translate("land_authority_expected_next"))}</dt><dd data-land-authority-expected-next="${esc(summary.expected_next_stage?.stage_id || summary.expected_next_stage?.group_id || "")}" data-land-authority-expected-next-kind="${esc(summary.expected_next_stage?.group_id ? "parallel_group" : (summary.expected_next_stage?.stage_id ? "sequential" : ""))}">${esc(expected)}</dd></div>
      <div data-land-authority-provenance="publisher"><dt>${esc(translate("land_authority_published_next"))}</dt><dd data-land-authority-published-next="${esc(publisher.status || "unknown")}" data-land-authority-published-checked="${esc(String(publisher.checked === true))}" data-land-authority-published-vintage="${esc(publisher.checked_vintage || "")}" data-source-id="${esc(publisher.source_id || "")}">${published}</dd></div>
    </dl>
    <div class="land-authority-provenance" data-land-authority-sources="1">
      <div class="land-authority-subhead">${esc(translate("land_authority_provenance"))}</div>
      <ul>
        <li data-land-authority-provenance="profile" data-registry-version="${esc(citation?.registry_version || "")}" data-procedure-id="${esc(citation?.procedure_id || "")}">${esc(translate("land_authority_provenance_profile"))}: ${profileCitation}</li>
        <li data-land-authority-provenance="phase" data-source-field="current_milestone">${esc(translate("land_authority_provenance_phase"))}: ${esc(phaseMilestone || translate("land_authority_not_found"))}</li>
        <li data-land-authority-provenance="geography" data-source-type="affected_review_body_for">${esc(translate("land_authority_provenance_geography"))}: ${geographyCitation}</li>
        <li data-land-authority-provenance="publisher" data-source-id="${esc(publisher.source_id || "")}">${esc(translate("land_authority_provenance_publisher"))}: ${esc(publisherCopy)}</li>
      </ul>
    </div>
    ${panelActionsHTML(summary, esc, translate)}
    ${affectedHTML ? `<div class="land-authority-affected" data-land-authority-provenance="geography"><div class="land-authority-subhead">${esc(translate("land_authority_affected"))}</div><ul>${affectedHTML}</ul></div>` : ""}
    ${observedHTML ? `<div class="land-authority-observed"><div class="land-authority-subhead">${esc(translate("land_authority_observed"))}</div><ul>${observedHTML}</ul></div>` : ""}
  </section>`;
}

export const attachAuth = attachLandAuthoritySummaries;
export const loadAuth = loadLandAuthoritySummaryLookup;
export const authHTML = landAuthoritySummaryHTML;
