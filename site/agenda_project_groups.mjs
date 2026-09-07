/**
 * One hearing agenda, read as the land use projects it is actually about.
 *
 * A Council land use agenda is a list of legislative identifiers. The
 * Subcommittee on Zoning and Franchises heard eleven matters on 27 May 2026, and
 * a reader who wanted to know how many applications that was had to notice that
 * LU 0067-2026, LU 0068-2026 and LU 0069-2026 all carry Monitor Point
 * application numbers, and then do the same for the rest. This module answers
 * that question from the connection that already exists.
 *
 * The grouping key is the project identity the accepted Council land-matter
 * bridge already assigned to each matter (`site/council_land_matter_links.mjs`),
 * and nothing else. Titles, addresses, applicants, committee names and the
 * shared meeting date are never grouping inputs — which is why the two Dewitt
 * Clinton Park North applications, whose titles differ only by street address,
 * stay two projects here rather than becoming one.
 *
 * What this view will not do:
 *
 *  - It never removes, reorders or replaces an agenda item. The groups are an
 *    index over the agenda; every original row, including one the bridge did not
 *    join, stays exactly where the source record put it.
 *  - It never invents an edge for a matter the bridge left unjoined, and it says
 *    how many such matters there are rather than reporting them as zero.
 *  - It never turns co-appearance into common purpose. Matters heard at one
 *    meeting share a meeting; the copy says so and says nothing more.
 *  - It never promotes a recorded committee step into a project decision. The
 *    published relation stays `about_project` with `is_decision` false.
 *
 * Both surfaces that show this agenda read the same builder over the same
 * committed lookup: the server-rendered notice first paint in
 * `site/meeting_outcomes_static.mjs`, and the client-rendered outcome list in
 * `site/app/meetings.mjs`. They therefore cannot assign a matter to different
 * projects, and neither of them fetches anything from the publisher to do it.
 */

import { councilLandMatterContext } from "./council_land_matter_links.mjs";
import { matterIdentity, resolveMatterDestination } from "./legislative_matter_availability.mjs";

export const AGENDA_PROJECT_GROUPS_SCHEMA = "cityscroll.agenda_project_groups.v1";

/**
 * The English copy this view renders with. The client surface passes its own
 * translated bag; the server-rendered first paint uses these. Every string is a
 * label or a statement about the records — none of them claims a shared position
 * or a decision.
 */
export const AGENDA_PROJECT_GROUP_LABELS = Object.freeze({
  heading: "Land use projects on this agenda",
  lead: ({ groups, linked, total }) => (groups === 1
    ? `One land use project covers ${linked} of the ${total} Council matters on this agenda.`
    : `${groups} land use projects cover ${linked} of the ${total} Council matters on this agenda.`),
  matters: (count) => (count === 1 ? "1 matter" : `${count} matters`),
  applications: (values) => `Application numbers ${values}`,
  expand: "Matters filed under this project",
  unlinked: (count) => (count === 1
    ? "One matter on this agenda is not part of a land use project in this source record. It is listed below on its own."
    : `${count} matters on this agenda are not part of a land use project in this source record. They are listed below on their own.`),
  limit: "Matters are grouped by the city application number that the matter and the project already share, never by a likeness between their titles. Being on the same agenda is not a shared position, and a recorded hearing or layover is a step in the review, not a decision on the project. Every item on this agenda is still listed below, in the order the source record gives it.",
});

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

function collapse(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function defaultEscape(value) {
  return collapse(value, 4000).replace(/[&<>"]/g, (character) => ESCAPES[character]);
}

function clean(value, max = 400) {
  return collapse(value, max);
}

/**
 * Resolve one label. A surface may override any of them with its own translated
 * string, or with a function when the wording depends on a count — the client
 * passes functions so its own CLDR plural rules choose the form, which a
 * placeholder in a fixed string cannot do for every shipping language.
 */
function labelFor(labels, key, ...args) {
  const bag = labels && typeof labels === "object" ? labels : {};
  const override = bag[key];
  const chosen = typeof override === "function" || (typeof override === "string" && override.trim())
    ? override
    : AGENDA_PROJECT_GROUP_LABELS[key];
  return typeof chosen === "function" ? String(chosen(...args) ?? "") : String(chosen ?? "");
}

/**
 * The reader label for one agenda row: the file number and the publisher's own
 * title, exactly as this agenda's own source record carries them. The bridge's
 * own retained label is consulted only when the agenda row itself carries
 * neither, so the agenda always speaks in its own record's words.
 */
function agendaMatterLabel(row, context) {
  const file = clean(row?.matter_file, 120);
  const title = clean(row?.title, 400);
  if (file && title) return `${file} — ${title}`;
  if (file || title) return file || title;
  const id = matterIdentity(row?.matter_id);
  const companion = (context?.companions || []).find((entry) => entry.matter_id === id);
  return clean(companion?.label, 400) || `Matter ${id}`;
}

/**
 * Group one agenda's matters by the land use project the accepted bridge
 * assigned them to.
 *
 * `matterRows` is the agenda in its own order: any row carrying `matter_id`,
 * and optionally that row's own `matter_file`, `title` and official address.
 * The compacted notice snapshot row, and the collapsed client agenda entry, both
 * satisfy that without conversion.
 *
 * Returns null when this agenda has no joined matter at all, so a hearing the
 * bridge never touched renders no group furniture of any kind.
 */
export function buildAgendaProjectGroups(matterRows, { lookup, published } = {}) {
  const rows = Array.isArray(matterRows) ? matterRows : [];
  const contextOptions = {};
  if (lookup !== undefined) contextOptions.lookup = lookup;
  if (published !== undefined) contextOptions.published = published;
  const destinationOptions = published === undefined ? {} : { published };
  const order = [];
  const byProject = new Map();
  const seenMatters = new Set();
  let unlinked = 0;
  let generatedAt = null;
  for (const row of rows) {
    const id = matterIdentity(row?.matter_id);
    // A procedural agenda row carries no matter identity. It is still an agenda
    // item; it is simply not a matter this index can count or group.
    if (!id || seenMatters.has(id)) continue;
    seenMatters.add(id);
    const context = councilLandMatterContext(id, contextOptions);
    if (!context?.project_id || !context.project_href) {
      unlinked += 1;
      continue;
    }
    if (!generatedAt) generatedAt = context.generated_at || null;
    const destination = resolveMatterDestination(row, destinationOptions);
    const entry = {
      matter_id: id,
      matter_file: clean(row?.matter_file, 120) || null,
      title: clean(row?.title, 400) || null,
      label: agendaMatterLabel(row, context),
      href: destination.href,
      availability: destination.availability,
      external: destination.external,
      join_value: clean(context.join?.value, 80) || null,
    };
    if (!byProject.has(context.project_id)) {
      order.push(context.project_id);
      byProject.set(context.project_id, {
        project_id: context.project_id,
        project_name: context.project_name,
        project_href: context.project_href,
        label: context.project_name
          ? `${context.project_name} (${context.project_id})`
          : `Land use project ${context.project_id}`,
        canonical_relation: context.canonical_relation,
        proceeding_relation: context.proceeding_relation,
        is_decision: false,
        negative_rule: context.negative_rule,
        matters: [],
      });
    }
    byProject.get(context.project_id).matters.push(entry);
  }
  const groups = order.map((projectId) => {
    const group = byProject.get(projectId);
    return {
      ...group,
      matter_count: group.matters.length,
      join_values: group.matters.map((matter) => matter.join_value).filter(Boolean),
    };
  });
  if (!groups.length) return null;
  const linked = groups.reduce((total, group) => total + group.matter_count, 0);
  return {
    schema: AGENDA_PROJECT_GROUPS_SCHEMA,
    generated_at: generatedAt,
    agenda_matter_count: seenMatters.size,
    linked_matter_count: linked,
    unlinked_matter_count: unlinked,
    group_count: groups.length,
    is_decision: false,
    groups,
  };
}

/**
 * Which groups this reader had open, so following a link out of the agenda and
 * pressing Back returns them to the agenda they were reading rather than to a
 * collapsed one. The browser restores scroll on its own; it does not restore an
 * expanded `details`, and the client surface re-renders the list from the read
 * model on the way back, so the open set has to survive that.
 *
 * It is a per-reader convenience in this tab's own storage: bounded, never sent
 * anywhere, never a saved watch, and absent storage is simply an agenda that
 * opens closed. Nothing here changes which project a matter belongs to.
 */
export const AGENDA_PROJECT_GROUP_STATE_KEY = "cityscroll.agenda_project_groups.open.v1";

const MAX_REMEMBERED_AGENDAS = 12;
const MAX_REMEMBERED_GROUPS = 40;

function stateStorage(storage) {
  if (storage) return storage;
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

function readState(storage) {
  const store = stateStorage(storage);
  if (!store) return {};
  try {
    const parsed = JSON.parse(store.getItem(AGENDA_PROJECT_GROUP_STATE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The project ids this reader had expanded on one agenda, newest state wins. */
export function readOpenAgendaProjectGroups(agendaId, storage) {
  const id = clean(agendaId, 60);
  if (!id) return [];
  const open = readState(storage)[id];
  return Array.isArray(open) ? open.map((value) => clean(value, 25)).filter(Boolean) : [];
}

/** Record the expanded set for one agenda. Never throws, and never grows without bound. */
export function writeOpenAgendaProjectGroups(agendaId, projectIds, storage) {
  const store = stateStorage(storage);
  const id = clean(agendaId, 60);
  if (!store || !id) return;
  const open = (Array.isArray(projectIds) ? projectIds : [])
    .map((value) => clean(value, 25))
    .filter(Boolean)
    .slice(0, MAX_REMEMBERED_GROUPS);
  const state = readState(storage);
  delete state[id];
  const next = open.length ? { ...state, [id]: open } : state;
  const keys = Object.keys(next);
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED_AGENDAS))) {
    delete next[stale];
  }
  try {
    store.setItem(AGENDA_PROJECT_GROUP_STATE_KEY, JSON.stringify(next));
  } catch {
    // A tab with storage denied or full simply opens the agenda closed.
  }
}

function groupMarkup(group, { esc, labels }) {
  const matters = group.matters.map((matter) => {
    const label = esc(matter.label);
    const link = matter.href
      ? `<a class="agenda-project-matter-link${matter.external ? "" : " ui-constellation-link"}" href="${esc(matter.href)}"${matter.external ? ' target="_blank" rel="noopener noreferrer"' : ""} lang="en" dir="ltr" data-agenda-project-matter="${esc(matter.matter_id)}" data-matter-availability="${esc(matter.availability)}">${label}</a>`
      : `<span lang="en" dir="ltr" data-agenda-project-matter="${esc(matter.matter_id)}" data-matter-availability="${esc(matter.availability)}">${label}</span>`;
    const join = matter.join_value
      ? ` <span class="meeting-sub agenda-project-join" lang="en" dir="ltr">${esc(matter.join_value)}</span>`
      : "";
    return `<li>${link}${join}</li>`;
  }).join("");
  const count = labelFor(labels, "matters", group.matter_count);
  const applications = group.join_values.length
    ? `<p class="meeting-sub agenda-project-applications">${esc(labelFor(labels, "applications", group.join_values.join(", ")))}</p>`
    : "";
  return `<li class="meeting-matter agenda-project-group" data-agenda-project-id="${esc(group.project_id)}" data-agenda-project-matter-count="${esc(String(group.matter_count))}" data-agenda-project-decision="false">
    <div class="meeting-matter-main">
      <div>
        <a class="meeting-file ui-constellation-link agenda-project-link" href="${esc(group.project_href)}" data-agenda-project-href="${esc(group.project_id)}">${esc(group.label)}</a>
        ${applications}
      </div>
      <span class="meeting-badge meeting-badge--other">${esc(count)}</span>
    </div>
    <details class="meeting-more agenda-project-matters"><summary>${esc(labelFor(labels, "expand"))}</summary><div class="meeting-detail"><ul class="meeting-actions agenda-project-matter-list">${matters}</ul></div></details>
  </li>`;
}

/**
 * Render the grouped agenda index.
 *
 * `esc` and `labels` are supplied by the calling surface so the server-rendered
 * first paint and the client-rendered list produce the same assignments under
 * their own escaping and their own translations. An empty view renders the empty
 * string: an agenda with no accepted project join gets no heading, no counts and
 * no container.
 */
export function renderAgendaProjectGroups(view, { esc = defaultEscape, labels } = {}) {
  if (!view?.groups?.length) return "";
  const lead = labelFor(labels, "lead", {
    groups: view.group_count,
    linked: view.linked_matter_count,
    total: view.agenda_matter_count,
  });
  // An unjoined matter is a state, never a zero: the line appears only when
  // there is one to report, and it says the row is still listed below.
  const unlinked = view.unlinked_matter_count === 0
    ? ""
    : `<p class="note agenda-project-unlinked">${esc(labelFor(labels, "unlinked", view.unlinked_matter_count))}</p>`;
  return `<section class="meeting-agenda-projects" data-agenda-project-groups="1" data-agenda-project-group-count="${esc(String(view.group_count))}" data-agenda-linked-matters="${esc(String(view.linked_matter_count))}" data-agenda-matters="${esc(String(view.agenda_matter_count))}" data-agenda-unlinked-matters="${esc(String(view.unlinked_matter_count))}" data-agenda-project-decision="false">
    <div class="chain-h">${esc(labelFor(labels, "heading"))}</div>
    <p class="note agenda-project-lead">${esc(lead)}</p>
    ${unlinked}
    <ol class="meeting-agenda agenda-project-group-list">${view.groups.map((group) => groupMarkup(group, { esc, labels })).join("")}</ol>
    <p class="note agenda-project-limit">${esc(labelFor(labels, "limit"))}</p>
  </section>`;
}
