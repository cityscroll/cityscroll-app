#!/usr/bin/env node
/**
 * PHC-06 evidence helper: render the Land "Where this stands" authority panel
 * (site/land_authority_summary_view.mjs's landAuthoritySummaryHTML(), which
 * now includes the new plain-role line from
 * site/land_hearing_authority_copy.mjs) and a literal reproduction of the
 * upcoming-hearing row (site/app/land.mjs's landHearingRowHTML(), which is
 * not exported — its structure is reproduced here verbatim and checked
 * against the real source by tools/capture_phc06_land_hearing_authority_copy.py
 * before capture) for the specimens named in the card: a decision-maker with
 * prior advisory recommendations, a conditional decision-maker, an
 * advisory-only body, a pre-application/certification administrative
 * certifier, an expedited (ELURP) terminal decision-maker, and an unresolved
 * record with no current role. Writes each rendered fragment under
 * site/.phc06-capture-tmp/ so the .py companion can serve it locally (real
 * /index.html CSS rules) and run axe-core against it. Prints the case
 * manifest (id, path, assertion, kind) as JSON to stdout.
 *
 *   node tools/capture_phc06_land_hearing_authority_copy.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildLandAuthoritySummary } from "../site/land_authority_summary.mjs";
import { landAuthoritySummaryHTML } from "../site/land_authority_summary_view.mjs";
import { landHearingRowRoleHTML } from "../site/land_hearing_authority_copy.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, "site/.phc06-capture-tmp");
const requireJson = createRequire(import.meta.url);

const geography = requireJson(path.join(ROOT, "site/data/community_board_geography_lookup.json"));
const warehouse = requireJson(path.join(ROOT, "site/data/zap_projects_warehouse_lookup.json"));
const landDefault = requireJson(path.join(ROOT, "site/data/land_default_ulurp.json"));
const hearings = requireJson(path.join(ROOT, "site/data/land_upcoming_hearings.json"));
const elurpCorpus = requireJson(path.join(ROOT, "test/fixtures/land_authority_summary/elurp_197e_corpus.v1.json"));

const i18nSrc = readFileSync(path.join(ROOT, "site/i18n.js"), "utf8");
const copy = {};
for (const match of i18nSrc.matchAll(/^\s+([a-z0-9_]+):\s*"((?:\\.|[^"\\])*)"/gm)) {
  copy[match[1]] = match[2].replace(/\\"/g, '"');
}
function t(key, vars) {
  let text = copy[key] || key;
  if (vars) {
    text = text.replace(/\{(\w+)\}/g, (all, name) => (Object.hasOwn(vars, name) ? String(vars[name] ?? "") : all));
  }
  return text;
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

function warehouseRow(projectId) {
  return (warehouse.rows || []).find((row) => row.project_id === projectId);
}
function defaultRow(projectId) {
  return (landDefault.projects || []).find((row) => row.project_id === projectId);
}
function projectHearings(projectId) {
  return (hearings.hearings || []).filter((row) => row.project_id === projectId);
}
function summarize(projectId) {
  const project = defaultRow(projectId) || warehouseRow(projectId);
  const outcome = landDefault.outcomes?.by_project?.[projectId] || {};
  return buildLandAuthoritySummary({
    project,
    geography,
    outcomes: { dispositions: outcome.dispositions, generated_at: outcome.generated_at || landDefault.generated_at },
    publishedOpportunities: { hearings: projectHearings(projectId), generated_at: hearings.generated_at },
    asOf: landDefault.generated_at,
    generatedAt: landDefault.generated_at,
  });
}
function summarizeElurp(specimenKey) {
  const specimen = elurpCorpus.specimens[specimenKey];
  const project = requireJson(path.join(ROOT, `test/fixtures/land_phase_spine/${specimen.project_id}.json`));
  return buildLandAuthoritySummary({ ...project, geography, asOf: elurpCorpus.as_of, generatedAt: elurpCorpus.as_of });
}

const ADVISORY_ONLY_SUMMARY = {
  schema: "cityscroll.land_authority_summary.v1",
  status: "resolved",
  project_id: "PHC06-ADVISORY-ONLY",
  procedure_id: "ulurp_197c",
  current_stage: { stage_id: "ulurp_197c.community_board_review", spine_phase_id: "community_board", status: "known" },
  current_actor_refs: ["community-board:brooklyn-cb-11"],
  current_role: "advisory_reviewer",
  effect: "May hold a public hearing and submit a written recommendation; the recommendation is advisory, not binding.",
  source_basis: {
    profile: { source_type: "reviewed_static_registry", procedure_id: "ulurp_197c", stage_id: "ulurp_197c.community_board_review", registry_version: "2026-08-27.v1" },
    phase: { source_type: "publisher_current_milestone", source_field: "current_milestone", current_milestone: "Community Board hearing" },
    geography: { source_type: "affected_review_body_for", status: "resolved" },
    publisher: { source_type: "published_hearing", checked: true },
  },
  expected_next_stage: { stage_id: "ulurp_197c.borough_president_review", spine_phase_id: "borough_president", status: "known" },
  published_next_opportunity: { status: "none" },
  observed: { status: "no_observation", recommendations: [] },
  affected_actor_refs: [{ body_ref: "community-board:brooklyn-cb-11", role: "affected_community_board" }],
};

/**
 * Literal reproduction of site/app/land.mjs's landHearingRowHTML() markup,
 * with the new roleTxt fragment from landHearingRowRoleHTML() spliced in the
 * same position as the real function. The .py capture companion checks this
 * template's key substrings against the real source before rendering, so a
 * later edit to the real row markup fails the capture instead of silently
 * drifting from it.
 */
function hearingRowHTML({ title, borough, representing, whenLabel, modeTxt, venue, roleTxt, projectId }) {
  return `<div class="row land-hearing-row" data-i="0" data-project-id="${esc(projectId)}" tabindex="0" role="group">
    <p class="rtitle">${esc(title)}</p>
    <p class="rmeta"><span class="ragency">${esc(borough)}${representing ? ` · ${esc(representing)}` : ""}</span>${roleTxt ? ` · ${roleTxt}` : ""}
      · ${esc(t("land_hearings_card_when", { date: whenLabel }))}${modeTxt ? ` · ${esc(modeTxt)}` : ""}
      ${venue ? `<br>${esc(venue)}` : ""}
    </p>
    <div class="fcard-compact-actions"><a class="act" href="https://maps.example.test/phc06">${esc(t("land_action_attend_in_person"))}</a><a class="act" href="#land/${esc(projectId)}">${esc(t("land_hearings_open_project"))}</a></div>
  </div>`;
}

const PANEL_CASES = [
  {
    id: "decision_maker_with_prior_advisory",
    kind: "panel",
    assertion: "A1/A2: CPC's decision role renders in plain terms in the existing panel while the CB/BP advisory recommendations that preceded it stay visible as separate, still-labeled-advisory prior events.",
    summary: summarize("2025M0252"),
  },
  {
    id: "conditional_decision_maker",
    kind: "panel",
    assertion: "A1/A2: a conditional decision-maker (City Council under § 197-d) renders its own conditional plain-role sentence, distinct from an unconditional decider's.",
    summary: summarize("2026Q0210"),
  },
  {
    id: "advisory_only_never_final_decider",
    kind: "panel",
    assertion: "A2/negative rule: an advisory-only body renders \"Can recommend, but cannot decide\" — never described as the final decider.",
    summary: ADVISORY_ONLY_SUMMARY,
  },
  {
    id: "pre_application_certifier_no_vote",
    kind: "panel",
    assertion: "A3: a project in pre-application/certification (DCP, ELURP) renders \"Certifies the filing is complete, but does not decide it\" — it does not acquire a public-review vote.",
    summary: summarizeElurp("E1-2024Q0356"),
  },
  {
    id: "expedited_terminal_decision_maker",
    kind: "panel",
    assertion: "A4: an ELURP record terminal at CPC renders its own plain decision role without implying the ordinary-route Council stage this expedited profile omits.",
    summary: summarizeElurp("E2-2024Q0419"),
  },
  {
    id: "unresolved_no_role_honest_gap",
    kind: "panel",
    assertion: "A5/A6: a record whose current stage does not resolve renders no plain-role line at all — an honest gap, never an inferred disposition.",
    summary: summarizeElurp("E4-2026X0362"),
  },
];

const ROW_CASES = [
  {
    id: "hearing_row_decision_maker",
    kind: "row",
    assertion: "A1: the compressed upcoming-hearing row states \"Decides\" for a decision-maker body, reusing the same authority evidence as the panel.",
    row: { title: "165-05 Liberty Avenue Rezoning", borough: "Queens", representing: "City Planning Commission", whenLabel: "Wed, Oct 14", modeTxt: t("land_hearings_card_modes", { modes: t("land_hearings_mode_list_in_person") }), venue: "22 Reade Street, New York, NY", projectId: "2025M0252" },
    summary: summarize("2025M0252"),
  },
  {
    id: "hearing_row_advisory",
    kind: "row",
    assertion: "A2: the compressed row states \"Recommends, doesn't decide\" for an advisory body, never a decision verb.",
    row: { title: "Community Board Hearing", borough: "Brooklyn", representing: "Brooklyn Community Board 11", whenLabel: "Thu, Oct 8", modeTxt: t("land_hearings_card_modes", { modes: t("land_hearings_mode_list_in_person") }), venue: "123 Example Street, Brooklyn, NY", projectId: "PHC06-ADVISORY-ONLY" },
    summary: ADVISORY_ONLY_SUMMARY,
  },
  {
    id: "hearing_row_unresolved_no_role",
    kind: "row",
    assertion: "A5/A6: a row for a record with no resolved current role shows no role text at all — an honest gap, never a guessed one.",
    row: { title: "Referred Application", borough: "Bronx", representing: "City Council", whenLabel: "Fri, Oct 9", modeTxt: "", venue: "", projectId: "2026X0362" },
    summary: summarizeElurp("E4-2026X0362"),
  },
];

mkdirSync(OUT_DIR, { recursive: true });
const manifestCases = [];

for (const { id, kind, assertion, summary } of PANEL_CASES) {
  const html = landAuthoritySummaryHTML(summary, { t, escape: esc });
  const file = path.join(OUT_DIR, `${id}.html`);
  writeFileSync(file, html, "utf8");
  manifestCases.push({ id, kind, assertion, path: `/.phc06-capture-tmp/${id}.html`, project_id: summary.project_id || null });
}

for (const { id, kind, assertion, row, summary } of ROW_CASES) {
  const roleTxt = landHearingRowRoleHTML(summary, { t, escape: esc });
  const html = hearingRowHTML({ ...row, roleTxt });
  const file = path.join(OUT_DIR, `${id}.html`);
  writeFileSync(file, html, "utf8");
  manifestCases.push({ id, kind, assertion, path: `/.phc06-capture-tmp/${id}.html`, project_id: row.projectId });
}

process.stdout.write(JSON.stringify(manifestCases, null, 2));
