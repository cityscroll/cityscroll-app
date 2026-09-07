/**
 * The one read model for "this land project's Council matters" and its inverse.
 *
 * `site/data/council_land_matter_links.json` is the compact projection of the
 * accepted Council land-matter bridge (see
 * `warehouse/lib/council_land_matter_links.mjs` and its builder). Two reader
 * surfaces need it and they need it to agree: the land project detail lists the
 * Council matters that carry the project's own retained application number, and
 * a published matter history names the project it belongs to plus the other
 * matters filed under the same application. Both questions are answered here,
 * from one generation, so a project cannot list a matter that does not link
 * back.
 *
 * What this module will not do. It never joins on a title, an address, a
 * committee name, or a meeting date — the artifact only holds joins the bridge
 * already accepted on an exact retained identifier. It never advertises a matter
 * route the published generation does not carry; that stays the one shared
 * availability rule's decision. And it never promotes a recorded committee
 * action into a project decision: the accepted relation is `about_project`,
 * `is_decision` is false, and the artifact's own negative rule travels with the
 * view so a renderer cannot lose it.
 */

import councilLandMatterLinks from "./data/council_land_matter_links.json" with { type: "json" };
import { landProjectPath } from "./land_project_route.mjs";
import { publishedMatterHref } from "./legislative_matter_availability.mjs";

export const COUNCIL_LAND_MATTER_VIEW_SCHEMA = "cityscroll.council_land_matter_view.v1";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function source(provided) {
  return provided && typeof provided === "object" ? provided : councilLandMatterLinks;
}

function matterEntry(lookup, matterId) {
  const id = clean(matterId, 40).replace(/^matter:/, "");
  if (!/^\d+$/.test(id)) return null;
  const entry = lookup?.matters?.[id];
  return entry && entry.matter_id === id ? entry : null;
}

/** The reader label for a matter: its file number and the publisher's own title. */
export function councilMatterLabel(entry) {
  const file = clean(entry?.matter_file, 120);
  const title = clean(entry?.title, 400);
  if (file && title) return `${file} — ${title}`;
  return file || title || `Matter ${clean(entry?.matter_id, 40)}`;
}

/** The most recent retained appearance date, or null when none was retained. */
export function councilMatterLatestDate(entry) {
  const dates = (Array.isArray(entry?.appearances) ? entry.appearances : [])
    .map((appearance) => clean(appearance?.event_date, 20))
    .filter(Boolean)
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/**
 * The recorded actions for a matter, in the order the source recorded them and
 * deduplicated across repeated appearances. These are observed committee steps,
 * never a disposition.
 */
export function councilMatterRecordedActions(entry) {
  const seen = [];
  for (const appearance of Array.isArray(entry?.appearances) ? entry.appearances : []) {
    for (const action of Array.isArray(appearance?.actions) ? appearance.actions : []) {
      const value = clean(action, 240);
      if (value && !seen.includes(value)) seen.push(value);
    }
  }
  return seen;
}

function relationBlock(lookup) {
  const relation = lookup?.relation || {};
  return {
    canonical_relation: clean(relation.canonical, 80) || "about_project",
    proceeding_relation: clean(relation.proceeding, 80) || "reviews_project",
    compatibility_relation: clean(relation.compatibility, 80) || "decides_land_project",
    is_decision: false,
    negative_rule: clean(relation.negative_rule, 500) || null,
  };
}

function evidenceLabel(entry) {
  const value = clean(entry?.join_value, 80);
  return value ? `exact retained application number ${value}` : "exact retained application number";
}

function matterHref(matterId, published) {
  return published === undefined
    ? publishedMatterHref(matterId)
    : publishedMatterHref(matterId, { published });
}

/**
 * The Council matters connected to one land project, shaped as project
 * connection items. Returns an empty array when this project has no accepted
 * matter join — the caller renders nothing for an empty group.
 */
export function councilLandMatterProjectItems(projectId, { lookup: provided, published } = {}) {
  const lookup = source(provided);
  const id = clean(projectId, 25);
  const project = lookup?.projects?.[id];
  if (!project || project.project_id !== id) return [];
  const relation = relationBlock(lookup);
  return (Array.isArray(project.matter_ids) ? project.matter_ids : [])
    .map((matterId) => matterEntry(lookup, matterId))
    .filter((entry) => entry && entry.project_id === id)
    .map((entry) => {
      const actions = councilMatterRecordedActions(entry);
      return {
        ref: `matter:${entry.matter_id}`,
        href: matterHref(entry.matter_id, published),
        label: councilMatterLabel(entry),
        when: councilMatterLatestDate(entry),
        outcome: actions.length ? actions.join(" · ") : null,
        relation: relation.compatibility_relation,
        canonical_relation: relation.canonical_relation,
        proceeding_relation: relation.proceeding_relation,
        reader_label: "About this project",
        is_decision: false,
        confidence: "strong",
        evidence: evidenceLabel(entry),
        source_proof: {
          identifier: clean(entry.join_value, 80) || null,
          join_key: clean(entry.join_key, 80) || null,
          join_value: clean(entry.join_value, 80) || null,
          method: clean(entry.join_method, 80) || null,
          source_system: "legistar",
          source_record_id: `legistar:matter:${entry.matter_id}`,
          source_url: clean(entry.source_url, 1000) || null,
          observed_time: councilMatterLatestDate(entry),
        },
      };
    });
}

/**
 * The land project one published matter belongs to, with the other matters
 * filed under the same retained application. Returns null when this matter
 * carries no accepted project join, so a matter page with no connection renders
 * no section at all.
 */
export function councilLandMatterContext(matterId, { lookup: provided, published } = {}) {
  const lookup = source(provided);
  const entry = matterEntry(lookup, matterId);
  if (!entry) return null;
  const projectId = clean(entry.project_id, 25);
  const project = lookup?.projects?.[projectId];
  if (!project) return null;
  const projectHref = landProjectPath(projectId);
  if (!projectHref) return null;
  const companions = (Array.isArray(project.matter_ids) ? project.matter_ids : [])
    .filter((candidate) => candidate !== entry.matter_id)
    .map((candidate) => matterEntry(lookup, candidate))
    .filter(Boolean)
    .map((companion) => ({
      matter_id: companion.matter_id,
      matter_file: clean(companion.matter_file, 120) || null,
      title: clean(companion.title, 400) || null,
      label: councilMatterLabel(companion),
      href: matterHref(companion.matter_id, published),
      when: councilMatterLatestDate(companion),
      join_value: clean(companion.join_value, 80) || null,
    }));
  return {
    schema: COUNCIL_LAND_MATTER_VIEW_SCHEMA,
    generated_at: clean(lookup?.generated_at, 80) || null,
    matter_id: entry.matter_id,
    project_id: projectId,
    project_name: clean(project.project_name, 320) || null,
    project_href: projectHref,
    join: {
      method: clean(entry.join_method, 80) || null,
      key: clean(entry.join_key, 80) || null,
      value: clean(entry.join_value, 80) || null,
    },
    ...relationBlock(lookup),
    companions,
  };
}
