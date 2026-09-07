/**
 * The positions a Community Board has actually recorded on land use projects.
 *
 * The retained land materialization already carries, per project, the review
 * bodies that submitted a recommendation on it: the body identity, the position
 * the publisher recorded, the date it was voted, and the tally when one was
 * recorded. That relationship is published project-first. A reader standing on
 * a board has no way to walk it, because nothing indexes it board-first.
 *
 * This module is that index and nothing more. It reverses an existing accepted
 * relation; it does not create one.
 *
 * What decides that a board recorded a position is the canonical board identity
 * the retained recommendation already carries (`community-board:<body id>`).
 * Meeting titles, minutes text, agenda wording, project names, addresses and
 * shared geography are never inputs: a project recorded in a board's district
 * is a geographic fact and stays with
 * `warehouse/lib/community_board_district_projects.mjs`, which says so itself.
 *
 * Three deliberate boundaries, each of which the copy above the list repeats:
 *
 *  - Two applications are two applications. Rows that share a date and a tally
 *    are never merged, never deduplicated against each other, and never counted
 *    as one proceeding; this projection publishes no count of meetings or
 *    sessions at all, because the source it reads does not carry one.
 *  - A recorded tally is the vote on the board's recommendation motion. It is
 *    not a count of members who support or oppose the development, and this
 *    module never renames, re-signs or totals it.
 *  - A waiver is a waiver. Waiving a recommendation ends the board's review step
 *    without a favorable or unfavorable position, and it keeps its own published
 *    label and its absent tally instead of being folded into either side.
 *
 * A recommendation that the publisher has not marked submitted, or that carries
 * no vote date, is counted separately and left out of the recorded list rather
 * than being rendered as a dateless position or silently dropped.
 */

export const COMMUNITY_BOARD_LAND_POSITIONS_SCHEMA = "cityscroll.community_board_land_positions.v1";
export const COMMUNITY_BOARD_LAND_POSITIONS_METHOD = "retained_board_identity_reverse_index_v1";
export const COMMUNITY_BOARD_LAND_POSITIONS_NEGATIVE_RULE =
  "A recorded position is one board's advisory recommendation on one application, read back from the identity the retained record already carries. It is never a decision on the project, never a count of meetings, and a recorded tally is the vote on the recommendation motion rather than a count of support for the development.";

/** The only status the publisher marks a completed recommendation with. */
export const SUBMITTED_STATUS = "Submitted";

/** The published label of the review body this index reads back. */
export const COMMUNITY_BOARD_REPRESENTING = "Community Board";

/**
 * The reviewed position vocabulary. A published label outside this set keeps
 * its own text and is classified `unreviewed`, so an unfamiliar disposition is
 * shown as the source wrote it instead of being forced into a familiar bucket.
 */
export const REVIEWED_POSITIONS = Object.freeze({
  "Favorable": "favorable",
  "Conditional Favorable": "conditional_favorable",
  "Unfavorable": "unfavorable",
  "Conditional Unfavorable": "conditional_unfavorable",
  "Waiver of Recommendation": "waiver",
});

const BODY_ID = /^[a-z]+(?:-[a-z]+)*-cb-\d{2}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
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
  return ISO_DAY.test(day) ? day : null;
}

/** A whole number of recorded votes, or null. A missing tally is never a zero. */
function tallyNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Classify a published position label without changing it. */
export function positionClass(value) {
  return REVIEWED_POSITIONS[clean(value, 80)] || "unreviewed";
}

function recordedTally(row) {
  const votesFor = tallyNumber(row?.votes_for);
  const against = tallyNumber(row?.votes_against);
  const abstain = tallyNumber(row?.votes_abstain);
  const recorded = votesFor !== null || against !== null || abstain !== null;
  return {
    recorded,
    votes_for: votesFor,
    votes_against: against,
    votes_abstain: abstain,
  };
}

/**
 * The canonical board a retained recommendation names, or null.
 *
 * Only the `community-board:` reference the record already carries resolves. A
 * recommendation representing a Community Board with no such reference is left
 * unresolved and counted, never guessed at from a borough or a project.
 */
export function boardIdOfRecommendation(row) {
  const ref = clean(row?.body_ref, 120);
  if (!ref.startsWith("community-board:")) return null;
  const id = ref.slice("community-board:".length);
  return BODY_ID.test(id) ? id : null;
}

function companionRecommendation(row) {
  const value = clean(row?.value, 120);
  if (!value) return null;
  return {
    representing: clean(row?.representing, 80) || null,
    body_ref: clean(row?.body_ref, 120) || null,
    position: value,
    position_class: positionClass(value),
    status: clean(row?.status, 40) || null,
    // A body that submitted a position the publisher recorded no vote date for
    // keeps that absence. It is not filled in from the board's own date, the
    // project's milestone, or anything else on the record.
    recorded_on: isoDay(row?.vote_date),
    recorded_tally: recordedTally(row),
    source_record_id: clean(row?.source_id, 80) || null,
  };
}

/**
 * Most recently recorded first, then by project identifier.
 *
 * Two positions recorded on one date stay two positions in a stable order; the
 * comparison never looks at the tally, so identical tallies cannot collapse.
 */
function comparePositions(a, b) {
  if (a.recorded_on !== b.recorded_on) return b.recorded_on.localeCompare(a.recorded_on);
  return a.project_id.localeCompare(b.project_id);
}

/**
 * Build the per-board reverse index.
 *
 * `authority` is the retained land authority summary
 * (`site/data/land_authority_summary.json`), which owns the recommendation
 * semantics this index reads. `projects` is the retained land project
 * materialization (`site/data/land_default_ulurp.json`), read only for the
 * published project name, status and portal address that the summary does not
 * repeat; a project the summary knows and the project list does not keeps its
 * identifier and reports no name rather than acquiring one.
 */
export function buildCommunityBoardLandPositions({
  authority,
  projects,
  generatedAt = null,
} = {}) {
  const projectRows = Array.isArray(projects?.projects) ? projects.projects : [];
  const projectById = new Map();
  for (const row of projectRows) {
    const id = clean(row?.project_id, 40);
    if (id) projectById.set(id, row);
  }
  const outcomeById = projects?.outcomes?.by_project && typeof projects.outcomes.by_project === "object"
    ? projects.outcomes.by_project
    : {};

  const summaries = authority?.summaries && typeof authority.summaries === "object" ? authority.summaries : {};
  const byBoard = new Map();
  const counts = {
    retained_projects: Object.keys(summaries).length,
    projects_with_observed_recommendations: 0,
    board_recommendations: 0,
    board_positions: 0,
    boards_with_positions: 0,
    projects_with_board_positions: 0,
    undated_board_recommendations: 0,
    unsubmitted_board_recommendations: 0,
    unresolved_board_recommendations: 0,
    waivers: 0,
    positions_without_recorded_tally: 0,
  };
  const projectsWithPositions = new Set();

  for (const [rawProjectId, summary] of Object.entries(summaries)) {
    const projectId = clean(rawProjectId, 40);
    if (!PROJECT_ID.test(projectId)) continue;
    const recommendations = Array.isArray(summary?.observed?.recommendations)
      ? summary.observed.recommendations
      : [];
    if (!recommendations.length) continue;
    counts.projects_with_observed_recommendations += 1;

    const projectRow = projectById.get(projectId);
    const outcome = outcomeById[projectId];
    const projectName = clean(projectRow?.project_name, 300) || null;
    // One field, one meaning: the project registry's own published status. The
    // outcome read model carries a status of its own that is derived
    // differently and can disagree with it, so the two are never mixed into one
    // value a reader would have no way to tell apart.
    const publicStatus = clean(projectRow?.public_status, 120) || null;
    const portalUrl = clean(outcome?.portal_url, 400) || null;

    for (const row of recommendations) {
      if (clean(row?.representing, 80) !== COMMUNITY_BOARD_REPRESENTING) continue;
      counts.board_recommendations += 1;
      const boardId = boardIdOfRecommendation(row);
      if (!boardId) {
        counts.unresolved_board_recommendations += 1;
        continue;
      }
      const status = clean(row?.status, 40);
      if (status !== SUBMITTED_STATUS) {
        counts.unsubmitted_board_recommendations += 1;
        continue;
      }
      const recordedOn = isoDay(row?.vote_date);
      if (!recordedOn) {
        counts.undated_board_recommendations += 1;
        continue;
      }
      const position = clean(row?.value, 120);
      if (!position) {
        counts.unresolved_board_recommendations += 1;
        continue;
      }
      const klass = positionClass(position);
      if (klass === "waiver") counts.waivers += 1;
      const tally = recordedTally(row);
      if (!tally.recorded) counts.positions_without_recorded_tally += 1;

      // Every other body that recorded a position on this same application,
      // carried so the board's row can state what else the source holds
      // without inventing it — including a body whose vote date is absent.
      const others = recommendations
        .filter((other) => other !== row)
        .map(companionRecommendation)
        .filter(Boolean);

      if (!byBoard.has(boardId)) byBoard.set(boardId, []);
      byBoard.get(boardId).push({
        project_id: projectId,
        project_name: projectName,
        project_public_status: publicStatus,
        project_portal_url: portalUrl,
        position,
        position_class: klass,
        status,
        recorded_on: recordedOn,
        recorded_tally: tally,
        source_record_id: clean(row?.source_id, 80) || null,
        other_positions: others,
      });
      counts.board_positions += 1;
      projectsWithPositions.add(projectId);
    }
  }

  const boards = {};
  for (const [boardId, positions] of [...byBoard.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    positions.sort(comparePositions);
    boards[boardId] = {
      body_id: boardId,
      position_count: positions.length,
      project_count: new Set(positions.map((row) => row.project_id)).size,
      // The number of distinct dates, published so a surface can describe the
      // record without ever calling a date a meeting.
      recorded_date_count: new Set(positions.map((row) => row.recorded_on)).size,
      positions,
    };
  }
  counts.boards_with_positions = Object.keys(boards).length;
  counts.projects_with_board_positions = projectsWithPositions.size;

  const datasetId = clean(projects?.source?.dataset, 40) || null;
  return {
    schema: COMMUNITY_BOARD_LAND_POSITIONS_SCHEMA,
    method: COMMUNITY_BOARD_LAND_POSITIONS_METHOD,
    negative_rule: COMMUNITY_BOARD_LAND_POSITIONS_NEGATIVE_RULE,
    generated_at: generatedAt || null,
    source: {
      publisher: "NYC Department of City Planning, Zoning Application Portal",
      dataset_id: datasetId,
      source_url: datasetId ? `https://data.cityofnewyork.us/d/${datasetId}` : null,
      // The vintage of the retained records this index reverses, not a clock
      // read at build time.
      observed_on: clean(authority?.generated_at, 40) || null,
    },
    counts,
    boards,
  };
}
