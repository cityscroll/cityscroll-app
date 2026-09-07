/**
 * "Other projects listing this applicant" for the Land project detail record.
 *
 * Groups the bounded Zoning Application Portal project rows the Land route has
 * already loaded by the EXACT published `primary_applicant` string. Two
 * projects appear together only because the publisher wrote the identical label
 * into that one field.
 *
 * This is a record grouping, not an identity resolution. It never folds two
 * spellings together, never resolves a canonical organization, and never
 * asserts ownership, corporate control, a parent company, representation or a
 * political position. Like every other party position in this repository, being
 * named in `primary_applicant` says the publisher recorded that name as the
 * applicant on that record and says nothing else — a person-shaped applicant
 * keeps the applicant position it was published in and is never relabelled an
 * owner or a developer.
 *
 * The module is pure: it reads rows it is handed, never a publisher, and its
 * renderer emits nothing at all unless another retained project actually
 * carries the same exact label.
 */

export const LAND_SAME_APPLICANT_SCHEMA = "cityscroll.land_same_applicant_projects.v1";

/** The one relation this section publishes. It is a shared published label, nothing more. */
export const LAND_SAME_APPLICANT_RELATION = "lists_same_applicant";

/** Bound on rendered rows. Larger groups keep an exact, visible total. */
export const LAND_SAME_APPLICANT_DISPLAY_LIMIT = 12;

const sameApplicantText = (value, max = 320) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

const SAME_APPLICANT_PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/;

const sameApplicantProjectId = (value) => {
  const id = sameApplicantText(value, 25);
  return SAME_APPLICANT_PROJECT_ID.test(id) ? id : "";
};

/**
 * The grouping key. Control characters and runs of whitespace are collapsed so
 * the same published string does not fail to match itself over a formatting
 * artefact; nothing else is normalised. Case, punctuation, abbreviation and
 * word order are all preserved, so `DOT - NYC Dept of Transportation` and
 * `NYC DOT Department of Transportation` remain two separate labels.
 */
export function sameApplicantLabelKey(value) {
  return sameApplicantText(value);
}

/**
 * Invert the bounded project rows into `exact applicant label -> project rows`.
 *
 * Rows without a project id or without a published applicant contribute
 * nothing. A repeated project id keeps its first row, so a project can never
 * appear twice inside one label's list.
 */
export function buildApplicantProjectIndex(rows) {
  const index = new Map();
  if (!Array.isArray(rows)) return index;
  for (const row of rows) {
    const id = sameApplicantProjectId(row?.project_id);
    const label = sameApplicantLabelKey(row?.primary_applicant);
    if (!id || !label) continue;
    let group = index.get(label);
    if (!group) {
      group = { ids: new Set(), rows: [] };
      index.set(label, group);
    }
    if (group.ids.has(id)) continue;
    group.ids.add(id);
    group.rows.push(row);
  }
  return index;
}

/** One listed project, carrying the publisher's own status and milestone text. */
function sameApplicantProjectEntry(row) {
  const id = sameApplicantProjectId(row?.project_id);
  const publicStatus = sameApplicantText(row?.public_status, 120);
  const projectStatus = sameApplicantText(row?.project_status, 120);
  const status = publicStatus || projectStatus;
  const milestoneDate = sameApplicantText(row?.current_milestone_date, 40);
  return {
    project_id: id,
    project_ref: `project:${id}`,
    project_name: sameApplicantText(row?.project_name, 240),
    href: `#land/${encodeURIComponent(id)}`,
    status: status || null,
    // Which published field the shown status came from, so a reader inspecting
    // the evidence is never left guessing which column was read.
    status_field: publicStatus ? "public_status" : (projectStatus ? "project_status" : null),
    public_status: publicStatus || null,
    project_status: projectStatus || null,
    milestone: sameApplicantText(row?.current_milestone, 240) || null,
    milestone_date: milestoneDate || null,
  };
}

/**
 * Build the reader model for one project's applicant.
 *
 * The four states are distinct on purpose and never collapse into each other:
 *
 * - `unavailable` — the bounded project input never arrived. This must not be
 *   reported as "no other projects"; the absence of an answer is not an answer.
 * - `not_observed` + `applicant_not_published` — this project publishes no
 *   applicant, so there is nothing to group by.
 * - `not_observed` + `single_project_with_this_applicant` — the label occurs
 *   exactly once in the bounded corpus.
 * - `matched` — at least one other retained project carries the same exact
 *   label.
 */
export function sameApplicantProjectsView({
  projectId,
  applicantLabel,
  rows = null,
  index = null,
  vintage = null,
  scope = null,
  limit = LAND_SAME_APPLICANT_DISPLAY_LIMIT,
} = {}) {
  const id = sameApplicantProjectId(projectId);
  const label = sameApplicantLabelKey(applicantLabel);
  const base = {
    schema: LAND_SAME_APPLICANT_SCHEMA,
    relation: LAND_SAME_APPLICANT_RELATION,
    project_id: id || null,
    project_ref: id ? `project:${id}` : null,
    applicant_label: label || null,
    vintage: sameApplicantText(vintage, 80) || null,
    scope: sameApplicantText(scope, 80) || null,
    total: null,
    items: [],
  };
  const resolved = index instanceof Map ? index : (Array.isArray(rows) ? buildApplicantProjectIndex(rows) : null);
  if (!resolved) {
    return { ...base, status: "unavailable", gap: "project_snapshot_unavailable" };
  }
  if (!id) {
    return { ...base, status: "unavailable", gap: "project_not_identified" };
  }
  if (!label) {
    return { ...base, status: "not_observed", gap: "applicant_not_published", total: 0 };
  }
  const group = resolved.get(label);
  const others = (group?.rows || [])
    .filter((row) => sameApplicantProjectId(row?.project_id) !== id)
    .map(sameApplicantProjectEntry)
    .filter((entry) => entry.project_id)
    .sort((left, right) => (left.project_id < right.project_id ? -1 : left.project_id > right.project_id ? 1 : 0));
  if (!others.length) {
    return { ...base, status: "not_observed", gap: "single_project_with_this_applicant", total: 0 };
  }
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : others.length;
  return {
    ...base,
    status: "matched",
    gap: null,
    total: others.length,
    truncated: others.length > cap,
    items: others.slice(0, cap),
  };
}

function sameApplicantRowHTML(item, { translate, esc, formatDate }) {
  const nameHTML = item.project_name
    ? esc(item.project_name)
    : esc(translate("land_same_applicant_name_unpublished"));
  const statusHTML = item.status
    ? `<span class="land-same-applicant-status" lang="en" dir="ltr" data-source-field="${esc(item.status_field || "")}">${esc(item.status)}</span>`
    : `<span class="land-same-applicant-status" data-source-field="" data-unpublished="1">${esc(translate("land_same_applicant_status_unpublished"))}</span>`;
  const milestoneText = [item.milestone, item.milestone_date ? formatDate(item.milestone_date) : ""]
    .filter(Boolean)
    .join(" · ");
  const whenHTML = milestoneText
    ? `<span class="land-same-applicant-when" data-milestone-date="${esc(item.milestone_date || "")}">${esc(milestoneText)}</span>`
    : `<span class="land-same-applicant-when" data-milestone-date="" data-unpublished="1">${esc(translate("land_same_applicant_milestone_unpublished"))}</span>`;
  return `<li class="land-same-applicant-item" data-same-applicant-project="${esc(item.project_id)}">
      <a class="land-same-applicant-link" href="${esc(item.href)}" data-project-id="${esc(item.project_id)}" lang="en" dir="ltr">${nameHTML}</a>
      <span class="land-same-applicant-id" lang="en" dir="ltr">${esc(item.project_id)}</span>
      ${statusHTML}
      ${whenHTML}
    </li>`;
}

/**
 * Render the section, or nothing at all.
 *
 * Anything other than `matched` renders the empty string: a project with no
 * applicant, a label that occurs once, and an input that never loaded all leave
 * the page exactly as it was rather than adding an empty panel or a
 * "no other projects" claim the evidence does not support.
 */
export function landSameApplicantProjectsHTML(view, { t, tn, escape, formatDate } = {}) {
  if (view?.schema !== LAND_SAME_APPLICANT_SCHEMA || view.status !== "matched" || !view.items?.length) return "";
  const translate = typeof t === "function" ? t : (key) => key;
  const plural = typeof tn === "function" ? tn : (base, n) => translate(`${base}_other`, { n });
  const esc = typeof escape === "function" ? escape : (value) => String(value ?? "");
  const fdate = typeof formatDate === "function" ? formatDate : (value) => String(value ?? "").slice(0, 10);
  const rows = view.items.map((item) => sameApplicantRowHTML(item, { translate, esc, formatDate: fdate })).join("");
  const truncatedHTML = view.truncated
    ? `<p class="land-same-applicant-truncated" data-land-same-applicant-truncated="1">${esc(translate("land_same_applicant_truncated", { shown: view.items.length, total: view.total }))}</p>`
    : "";
  const vintageHTML = view.vintage
    ? `<p class="land-same-applicant-vintage" data-same-applicant-vintage="${esc(view.vintage)}">${esc(translate("land_same_applicant_vintage", { date: fdate(view.vintage) }))}</p>`
    : "";
  return `<section class="land-same-applicant" id="land-same-applicant" data-land-same-applicant="1" data-relation="${esc(LAND_SAME_APPLICANT_RELATION)}" data-project-ref="${esc(view.project_ref || "")}" data-applicant-label="${esc(view.applicant_label || "")}" data-same-applicant-shown="${esc(String(view.items.length))}" data-same-applicant-total="${esc(String(view.total))}">
    <details class="land-same-applicant-disclosure" data-land-same-applicant-disclosure="1" open>
      <summary class="land-same-applicant-summary">
        <span class="land-same-applicant-kicker">${esc(translate("land_same_applicant_heading"))}</span>
        <span class="land-same-applicant-count">${esc(plural("land_same_applicant_count", view.total))}</span>
      </summary>
      <p class="land-same-applicant-note">${esc(translate("land_same_applicant_note"))}</p>
      <ul class="land-same-applicant-list">${rows}</ul>
      ${truncatedHTML}${vintageHTML}
    </details>
  </section>`;
}

/**
 * The land renderer's single call site: one project record plus the bounded
 * project rows the route already loaded, in and rendered markup out.
 *
 * The retained land corpus is never legitimately empty, so a rejected load and
 * an empty merge both mean the input did not arrive. Both become `null` here,
 * which keeps that an unavailable state rather than an answered "no other
 * projects".
 */
export function landSameApplicantProjectsSectionHTML(
  { record, projects, vintage } = {},
  options = {},
) {
  return landSameApplicantProjectsHTML(sameApplicantProjectsView({
    projectId: record?.project_id,
    applicantLabel: record?.primary_applicant,
    rows: Array.isArray(projects) && projects.length ? projects : null,
    vintage,
    scope: "retained_land_project_snapshot",
  }), options);
}
