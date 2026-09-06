/**
 * Wider-project context for a matched procurement pursuit.
 *
 * A vendor reading a construction solicitation with a four-word title and
 * generic portal instructions cannot tell what the wider project is for, how
 * big it is, or which agency wanted it. The city publishes all of that against
 * the project code the notice already prints -- it is simply published
 * somewhere else. This module puts the two side by side.
 *
 * What it will not do:
 *
 *   - It never matches anything. The relation is materialized once, during
 *     acquisition (warehouse/lib/capital_project_relations.py), and this module
 *     reads the result. There is no browser-side join, no resemblance scoring,
 *     and no request to a publisher at read time.
 *   - It never presents project scope as package requirements. The published
 *     description covers the whole capital project; the advertised package is a
 *     part of it, and only the official notice says which part.
 *   - It never turns a project amount into a solicitation value, or a project
 *     forecast into a bid deadline or a contract term. Each carries its own
 *     label wherever it renders.
 *   - It never repairs a published identifier. Where a notice's structured
 *     identifier and its own text disagree, both are shown as published and
 *     neither is offered as a resolved portal lookup.
 *   - It renders nothing at all when there is no relation, so an absent match
 *     never becomes an empty panel or a "no project found" claim.
 *
 * The existing official action is untouched: this section sits beside the
 * pursuit snapshot's official-notice link, never in place of it.
 */

export const PROCUREMENT_PROJECT_CONTEXT_SCHEMA = "cityscroll.procurement_project_context.v1";

// The one relation this surface will read. A row carrying any other relation
// name is ignored rather than rendered under this heading.
export const PROJECT_CONTEXT_RELATION = "solicitation_names_capital_project_code";

const PROJECT_CONTEXT_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function projectContextText(value) {
  const s = String(value ?? "").trim();
  return s || null;
}

function projectContextEsc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

/** "2029-06-25" -> "June 25, 2029". A partial or unparseable day renders nothing. */
export function projectContextDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  if (!match) return null;
  const month = PROJECT_CONTEXT_MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${Number(match[3])}, ${match[1]}` : null;
}

/** "202605" -> "May 2026". An unrecognised period renders nothing rather than raw digits. */
export function projectContextReportingPeriod(value) {
  const match = /^(\d{4})(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const month = PROJECT_CONTEXT_MONTHS[Number(match[2]) - 1];
  return month ? `${month} ${match[1]}` : null;
}

/** Whole dollars. Cents on a multi-million capital budget are noise, not precision. */
export function projectContextAmount(value) {
  const published = String(value ?? "").replace(/[$,]/g, "").trim();
  if (!published) return null;
  const amount = Number(published);
  if (!Number.isFinite(amount)) return null;
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

function projectContextMaterializationAccepted(materialization) {
  return Boolean(
    materialization
    && materialization.schema === PROCUREMENT_PROJECT_CONTEXT_SCHEMA
    && materialization.policy?.agency_match_alone_is_not_a_relation === true
    && materialization.policy?.unresolved_candidates_remain_unlinked === true
    && Array.isArray(materialization.relations),
  );
}

/**
 * Every materialized relation for one published notice, in code order.
 *
 * A notice that names two project codes keeps two relations: collapsing them
 * would silently pick one component to stand for the package.
 */
export function projectRelationsForNotice(materialization, requestId) {
  const id = projectContextText(requestId);
  if (!id || !projectContextMaterializationAccepted(materialization)) return [];
  return materialization.relations
    .filter((relation) => (
      relation?.relation === PROJECT_CONTEXT_RELATION
      && projectContextText(relation.solicitation?.request_id) === id
    ))
    .sort((a, b) => String(a.evidence?.matched_code).localeCompare(String(b.evidence?.matched_code)));
}

/** Component codes this notice names that the agency does not publish as project codes. */
export function unresolvedComponentsForNotice(materialization, requestId) {
  const id = projectContextText(requestId);
  if (!id || !projectContextMaterializationAccepted(materialization)) return [];
  return (materialization.unresolved_component_codes || [])
    .filter((entry) => projectContextText(entry?.request_id) === id)
    .map((entry) => projectContextText(entry.token))
    .filter(Boolean)
    .sort();
}

function projectContextView(relation) {
  const project = relation.capital_project || {};
  const scheduleIds = project.schedule_identity?.schedule_ids || [];
  return {
    project_code: projectContextText(relation.evidence?.matched_code),
    managing_agency: projectContextText(project.financial_identity?.managing_agency),
    sponsor_agency: projectContextText(project.sponsor_agency),
    project_name: projectContextText(project.project_name),
    // Absent when the publisher left the description column blank. The row is
    // then omitted rather than rendered empty.
    project_scope: project.project_scope_published_blank ? null : projectContextText(project.project_scope),
    current_phase: projectContextText(project.current_phase),
    borough: projectContextText(project.borough),
    schedule_ids: scheduleIds.slice(),
    project_budget: projectContextAmount(project.project_budget),
    recorded_project_spending: projectContextAmount(project.recorded_project_spending),
    project_forecast_completion: projectContextDay(project.project_forecast_completion),
    observation_dates: {
      reporting_period: projectContextText(project.observation_dates?.reporting_period),
      agency_data_date: projectContextDay(project.observation_dates?.agency_data_date),
      financial_data_date: projectContextDay(project.observation_dates?.financial_data_date),
    },
    source_url: projectContextText(project.landing_url) || projectContextText(project.source_url),
  };
}

/**
 * Build the section, or null when this notice has no materialized relation.
 *
 * `officialNotice` is the destination the pursuit surface already resolved; it
 * is carried through unchanged so a reader always leaves for the official
 * record rather than for anything derived here.
 */
export function buildProjectContextView(materialization, notice = {}, { officialNotice = null } = {}) {
  const requestId = projectContextText(notice.request_id);
  const relations = projectRelationsForNotice(materialization, requestId);
  if (!relations.length) return null;

  const solicitation = relations[0].solicitation || {};
  const structuredPin = projectContextText(solicitation.structured_pin);
  const bodyIdentifiers = (solicitation.body_identifiers || []).map(projectContextText).filter(Boolean);

  return {
    schema: PROCUREMENT_PROJECT_CONTEXT_SCHEMA,
    request_id: requestId,
    projects: relations.map(projectContextView),
    unresolved_components: unresolvedComponentsForNotice(materialization, requestId),
    // Both published values, as published. The relation above stands on the
    // project code, so it is unaffected by which identifier a portal expects.
    identifier_conflict: solicitation.identifier_conflict
      ? { structured: structuredPin, in_notice_text: bodyIdentifiers }
      : null,
    // A qualification route publishes a date for joining a qualified list.
    qualification_route: Boolean(solicitation.qualification_route),
    official_notice: officialNotice?.href
      ? { href: officialNotice.href, label: officialNotice.label || "Official notice" }
      : (projectContextText(solicitation.source_url) ? { href: solicitation.source_url, label: "Official notice" } : null),
    source_scope: {
      capital: materialization.source_scope?.capital_projects || null,
      solicitations: materialization.source_scope?.solicitations || null,
    },
  };
}

/**
 * A single line for an in-place inspection, where the full section does not
 * fit. Returns null when there is nothing worth interrupting the reader with.
 */
export function projectContextInspectSummary(view) {
  const project = view?.projects?.[0];
  if (!project) return null;
  const parts = [];
  if (project.project_name) parts.push(project.project_name);
  if (project.sponsor_agency) parts.push(`for ${project.sponsor_agency}`);
  if (project.project_budget) parts.push(`project budget ${project.project_budget}`);
  if (project.project_forecast_completion) {
    parts.push(`project forecast ${project.project_forecast_completion}`);
  }
  if (!parts.length) return null;
  return `Wider project: ${parts.join(" · ")}. Project figures, not the advertised package.`;
}

function projectContextDefinitionRow(term, value) {
  return `<div class="project-context-row"><dt>${projectContextEsc(term)}</dt><dd>${projectContextEsc(value)}</dd></div>`;
}

function projectContextRowsHtml(project) {
  const rows = [
    project.project_name ? projectContextDefinitionRow("Project", project.project_name) : "",
    project.project_code ? projectContextDefinitionRow("Published project code", project.project_code) : "",
    project.sponsor_agency ? projectContextDefinitionRow("Sponsor agency", project.sponsor_agency) : "",
    project.managing_agency ? projectContextDefinitionRow("Managing agency", project.managing_agency) : "",
    project.current_phase ? projectContextDefinitionRow("Project phase", project.current_phase) : "",
    project.borough ? projectContextDefinitionRow("Borough", project.borough) : "",
    project.project_budget ? projectContextDefinitionRow("Project budget", project.project_budget) : "",
    project.recorded_project_spending
      ? projectContextDefinitionRow("Recorded project spending", project.recorded_project_spending) : "",
    project.project_forecast_completion
      ? projectContextDefinitionRow("Project forecast completion", project.project_forecast_completion) : "",
    project.schedule_ids.length
      ? projectContextDefinitionRow("Project schedule number", project.schedule_ids.join(", ")) : "",
  ].filter(Boolean).join("");
  return rows ? `<dl class="project-context-facts">${rows}</dl>` : "";
}

function projectContextScopeHtml(project) {
  if (!project.project_scope) return "";
  return `<p class="project-context-scope">${projectContextEsc(project.project_scope)}</p>`;
}

function projectContextObservationHtml(project, capital) {
  const dates = project.observation_dates;
  const lines = [
    projectContextReportingPeriod(capital?.reporting_period)
      ? `City capital project record published for ${projectContextReportingPeriod(capital.reporting_period)}.` : "",
    dates.agency_data_date ? `Agency record dated ${dates.agency_data_date}.` : "",
    dates.financial_data_date ? `Financial record dated ${dates.financial_data_date}.` : "",
  ].filter(Boolean);
  if (!lines.length && !project.source_url) return "";
  const link = project.source_url
    ? `<p><a class="project-context-source-link" href="${projectContextEsc(project.source_url)}" target="_blank" rel="noopener noreferrer">City capital project records</a></p>`
    : "";
  return `<details class="project-context-observations"><summary>Source records</summary>` +
    (lines.length ? `<p>${projectContextEsc(lines.join(" "))}</p>` : "") + link + `</details>`;
}

function projectContextProjectHtml(project, capital) {
  const body = [projectContextRowsHtml(project), projectContextScopeHtml(project), projectContextObservationHtml(project, capital)]
    .filter(Boolean).join("");
  if (!body) return "";
  return `<div class="project-context-project" data-project-code="${projectContextEsc(project.project_code || "")}">${body}</div>`;
}

function projectContextBoundaryNotesHtml(view) {
  const notes = [];
  if (view.unresolved_components.length) {
    notes.push(
      `This notice also names ${view.unresolved_components.join(", ")}. `
      + `The city does not publish that as a project code for this agency, so it is not covered above.`,
    );
  }
  if (view.identifier_conflict) {
    const { structured, in_notice_text: inText } = view.identifier_conflict;
    notes.push(
      `The notice lists ${structured} as its identifier and writes ${inText.join(", ")} in its text. `
      + `Both appear here as the city published them. The project above is matched on the project code, `
      + `so use the official notice to confirm which identifier the portal expects.`,
    );
  }
  if (view.qualification_route) {
    notes.push(
      "This notice is a route to a qualified vendor list. Its published date is for that list, "
      + "not a construction bid deadline.",
    );
  }
  if (!notes.length) return "";
  return `<ul class="project-context-boundaries">${
    notes.map((note) => `<li>${projectContextEsc(note)}</li>`).join("")
  }</ul>`;
}

function projectContextOfficialActionHtml(view) {
  if (!view.official_notice?.href) return "";
  return `<p class="project-context-official"><a class="project-context-official-link" href="${
    projectContextEsc(view.official_notice.href)
  }" target="_blank" rel="noopener noreferrer">${projectContextEsc(view.official_notice.label)}</a></p>`;
}

/**
 * Render the section beside the pursuit facts. Returns "" for a null section so a
 * caller can splice this in unconditionally without producing an empty panel.
 */
export function renderProjectContextHtml(view, { headingId = "project-context-heading" } = {}) {
  if (!view) return "";
  const capital = view.source_scope?.capital || null;
  const projects = view.projects.map((project) => projectContextProjectHtml(project, capital)).filter(Boolean).join("");
  if (!projects) return "";
  return `<section class="project-context" aria-labelledby="${projectContextEsc(headingId)}" data-project-context="1">
    <h2 id="${projectContextEsc(headingId)}">The wider project</h2>
    <p class="project-context-lede">The city publishes this project record against the project code printed in the notice. It describes the whole project. The advertised package is one part of it, and the official notice is the only place its requirements are stated.</p>
    ${projects}
    ${projectContextBoundaryNotesHtml(view)}
    ${projectContextOfficialActionHtml(view)}
  </section>`;
}
