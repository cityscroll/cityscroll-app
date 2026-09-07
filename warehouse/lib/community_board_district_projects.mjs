/**
 * Community district land-project projection.
 *
 * Joins the canonical Community Board to community-district registry — the
 * `covers` edges already published in `community_board_geography_lookup.json` —
 * to the district field the retained ZAP project registry publishes on each
 * project row.
 *
 * The join is geographic and exact. A project's `community_district` value is
 * split on commas and each token must match a community district identifier in
 * full; nothing is matched by substring, prefix, borough letter, name, address
 * or applicant. A project filed in more than one district appears once under
 * each matching board and never twice under one board.
 *
 * What the result supports is "this project is recorded in this district", and
 * nothing more. It is not the board's docket. It does not mean the board held a
 * hearing on the project, issued a recommendation, assigned it to a committee,
 * or has any role in it at all; `warehouse/lib/board_bp_land_bridge.mjs` remains
 * the module that decides when a retained board record actually considered a
 * project, and that decision needs an exact land identifier on that record, not
 * shared geography.
 */

export const COMMUNITY_BOARD_DISTRICT_PROJECTS_SCHEMA = "cityscroll.community_board_district_projects.v1";
export const COMMUNITY_BOARD_DISTRICT_PROJECTS_METHOD = "canonical_board_district_exact_token_join_v1";
export const COMMUNITY_BOARD_DISTRICT_PROJECTS_NEGATIVE_RULE =
  "Shared geography places a project in a district. It never establishes a board hearing, recommendation, committee assignment or ownership, and it never merges two projects that read alike.";

/** A community district identifier: borough letter plus a two-digit district. */
export const COMMUNITY_DISTRICT_TOKEN = /^[XKMQR]\d{2}$/;

const BODY_ID = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

function clean(value, max = 300) {
  return String(value ?? "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isoDay(value) {
  const day = clean(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * The exact community districts one published project row names.
 *
 * Comma separated, whitespace tolerant, order preserving, deduplicated. A token
 * that is not a whole community district identifier is dropped rather than
 * repaired, so "K0", "K011", "Brooklyn 1" and "K01A" all match nothing.
 */
export function communityDistrictTokens(value) {
  const seen = new Set();
  for (const part of String(value ?? "").split(",")) {
    const token = clean(part, 12).toUpperCase();
    if (COMMUNITY_DISTRICT_TOKEN.test(token)) seen.add(token);
  }
  return [...seen];
}

/**
 * The canonical board-to-district registry, read from the published `covers`
 * edges rather than parsed out of a board name or body id.
 */
export function boardDistrictRegistry(geography) {
  const rows = [];
  const seen = new Set();
  for (const edge of Array.isArray(geography?.public_edges) ? geography.public_edges : []) {
    if (edge?.type !== "covers") continue;
    const bodyId = clean(edge.from, 80).replace(/^community-board:/, "");
    const districtId = clean(edge.to, 40).replace(/^community-district:/, "").toUpperCase();
    if (!BODY_ID.test(bodyId) || !COMMUNITY_DISTRICT_TOKEN.test(districtId)) continue;
    if (seen.has(bodyId)) continue;
    seen.add(bodyId);
    rows.push({ body_id: bodyId, district_id: districtId });
  }
  return rows.sort((a, b) => a.body_id.localeCompare(b.body_id));
}

function projectRow(row) {
  const id = clean(row?.project_id, 40);
  if (!id) return null;
  return {
    project_id: id,
    project_name: clean(row?.project_name, 300) || null,
    primary_applicant: clean(row?.primary_applicant, 200) || null,
    public_status: clean(row?.public_status, 120) || null,
    status_recorded_on: isoDay(String(row?.current_milestone_date ?? "").slice(0, 10)),
  };
}

/**
 * Most recently recorded first, then by project identifier, so the order is a
 * property of the source rather than of the order the publisher happened to
 * return rows in. A project whose status carries no recorded date sorts after
 * the dated ones instead of being dropped or given a substitute date.
 */
function compareProjects(a, b) {
  if (a.status_recorded_on !== b.status_recorded_on) {
    if (!a.status_recorded_on) return 1;
    if (!b.status_recorded_on) return -1;
    return b.status_recorded_on.localeCompare(a.status_recorded_on);
  }
  return a.project_id.localeCompare(b.project_id);
}

/**
 * The compact per-board projection the board document and its tests read.
 *
 * One pass over the retained project registry, not one publisher read per page.
 */
export function buildCommunityBoardDistrictProjects({
  geography,
  projects,
  generatedAt = null,
} = {}) {
  const registry = boardDistrictRegistry(geography);
  const boardsByDistrict = new Map();
  for (const row of registry) {
    if (!boardsByDistrict.has(row.district_id)) boardsByDistrict.set(row.district_id, []);
    boardsByDistrict.get(row.district_id).push(row.body_id);
  }

  const byBoard = new Map(registry.map((row) => [
    row.body_id,
    { district_id: row.district_id, seen: new Set(), projects: [] },
  ]));
  const rows = Array.isArray(projects?.rows) ? projects.rows : Array.isArray(projects) ? projects : [];
  let matchedProjects = 0;
  let unmatchedDistrictTokens = 0;
  const districtsWithProjects = new Set();

  for (const raw of rows) {
    const project = projectRow(raw);
    if (!project) continue;
    let placed = false;
    for (const token of communityDistrictTokens(raw?.community_district)) {
      const boards = boardsByDistrict.get(token);
      if (!boards?.length) {
        unmatchedDistrictTokens += 1;
        continue;
      }
      districtsWithProjects.add(token);
      for (const bodyId of boards) {
        const entry = byBoard.get(bodyId);
        // One board holds a project identity once, however many district
        // tokens on the row resolve to it.
        if (entry.seen.has(project.project_id)) continue;
        entry.seen.add(project.project_id);
        entry.projects.push(project);
        placed = true;
      }
    }
    if (placed) matchedProjects += 1;
  }

  const boards = {};
  let boardProjectRows = 0;
  for (const [bodyId, entry] of [...byBoard.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!entry.projects.length) continue;
    entry.projects.sort(compareProjects);
    boardProjectRows += entry.projects.length;
    boards[bodyId] = {
      body_id: bodyId,
      district_id: entry.district_id,
      project_count: entry.projects.length,
      projects: entry.projects,
    };
  }

  const datasetId = clean(projects?.dataset_id, 40) || null;
  return {
    schema: COMMUNITY_BOARD_DISTRICT_PROJECTS_SCHEMA,
    method: COMMUNITY_BOARD_DISTRICT_PROJECTS_METHOD,
    negative_rule: COMMUNITY_BOARD_DISTRICT_PROJECTS_NEGATIVE_RULE,
    generated_at: generatedAt || null,
    source: {
      publisher: "NYC Department of City Planning, Zoning Application Portal",
      dataset_id: datasetId,
      source_url: datasetId ? `https://data.cityofnewyork.us/d/${datasetId}` : null,
      observed_on: clean(projects?.materialized_at, 40) || null,
      boundary_vintage: clean(geography?.boundary_vintage, 40) || null,
    },
    counts: {
      registry_boards: registry.length,
      boards_with_projects: Object.keys(boards).length,
      boards_without_projects: registry.length - Object.keys(boards).length,
      districts_with_projects: districtsWithProjects.size,
      retained_projects: rows.length,
      matched_projects: matchedProjects,
      board_project_rows: boardProjectRows,
      unmatched_district_tokens: unmatchedDistrictTokens,
    },
    boards,
  };
}
