import { LAND_ULURP_PHASES, mapMilestoneToPhase } from "./land_phase_spine.mjs";
import {
  DEFAULT_LAND_PROCEDURE,
  LAND_PROCEDURE_OPTIONS,
  landRowMatchesProcedure,
  normalizeLandProcedure,
} from "./land_procedure_facet.mjs";

export {
  DEFAULT_LAND_PROCEDURE,
  LAND_PROCEDURE_OPTIONS,
  landObservedDates,
  landProcedureLabelKey,
  landProcedureSodaWhere,
  landRowMatchesProcedure,
  normalizeLandProcedure,
  resolveLandProcedure,
} from "./land_procedure_facet.mjs";

const cleanLandFacetValue = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export const LAND_STAGE_OPTIONS = Object.freeze([
  { id: "any", label_key: "status_all" },
  { id: "active", label_key: "land_stage_active" },
  { id: "public_review", label_key: "land_stage_public_review" },
  { id: "pre_certification", label_key: "land_stage_pre_certification" },
  { id: "community_board", label_key: "land_phase_community_board" },
  { id: "borough_president", label_key: "land_phase_borough_president" },
  { id: "cpc", label_key: "land_phase_cpc" },
  { id: "city_council", label_key: "land_phase_city_council" },
  { id: "completed", label_key: "land_stage_completed" },
]);

export const LAND_FUTURE_ACTION_OPTIONS = Object.freeze([
  { id: "any", label_key: "status_all" },
  { id: "any_future", label_key: "land_future_any" },
  { id: "hearing", label_key: "land_future_hearing" },
  { id: "other", label_key: "land_future_other" },
  { id: "none", label_key: "land_future_none" },
]);

const LAND_STAGE_IDS = new Set(LAND_STAGE_OPTIONS.map((option) => option.id));
const LAND_FUTURE_ACTION_IDS = new Set(LAND_FUTURE_ACTION_OPTIONS.map((option) => option.id));
const PRE_CERTIFICATION_PHASES = new Set([
  "pre_application",
  "environmental",
  "pre_certification",
  "certification",
]);
const LAND_PHASE_IDS = new Set(LAND_ULURP_PHASES);

export function normalizeLandStage(value, fallback = "active") {
  const stage = cleanLandFacetValue(value).toLowerCase();
  return LAND_STAGE_IDS.has(stage) ? stage : fallback;
}

export function normalizeLandFutureAction(value, fallback = "any") {
  const action = cleanLandFacetValue(value).toLowerCase();
  return LAND_FUTURE_ACTION_IDS.has(action) ? action : fallback;
}

/** Project-stage facet over the shared normalized ULURP phase ontology. */
export function landStageForRow(row = {}) {
  const publicStatus = cleanLandFacetValue(row.public_status).toLowerCase();
  const projectStatus = cleanLandFacetValue(row.project_status).toLowerCase();
  const milestone = cleanLandFacetValue(row.current_milestone);
  if (
    /completed|approved|withdrawn|terminated/.test(publicStatus)
    || /complete|record closed|inactive/.test(projectStatus)
    || /project (?:completed|withdrawn|terminated)/i.test(milestone)
  ) return "completed";
  const explicitPhase = cleanLandFacetValue(row.phase_id);
  const phase = LAND_PHASE_IDS.has(explicitPhase) ? explicitPhase : mapMilestoneToPhase(milestone);
  return PRE_CERTIFICATION_PHASES.has(phase) ? "pre_certification" : phase;
}

export function landRowMatchesStage(row, stage = "active") {
  const selected = normalizeLandStage(stage);
  const normalized = landStageForRow(row);
  if (selected === "any") return true;
  if (selected === "completed") return normalized === "completed";
  if (selected === "public_review") {
    return normalized !== "completed" && /public review/i.test(cleanLandFacetValue(row?.public_status));
  }
  if (selected === "active") {
    return normalized !== "completed" && cleanLandFacetValue(row?.project_status).toLowerCase() === "active";
  }
  return normalized === selected;
}

function isoDay(value) {
  const matched = cleanLandFacetValue(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return matched ? matched[1] : null;
}

export function landActionKind(row = {}) {
  const eventClass = cleanLandFacetValue(row.event_class).toLowerCase();
  const title = `${cleanLandFacetValue(row.milestone_source_title)} ${cleanLandFacetValue(row.milestone_title)}`.toLowerCase();
  if (/deadline/.test(eventClass) || /comment|review deadline/.test(title)) return "deadline";
  if (/public_hearing|public hearing/.test(eventClass) || /public hearing/.test(title)) return "hearing";
  if (/vote/.test(eventClass) || /\bvote\b/.test(title)) return "meeting_vote";
  return "meeting_vote";
}

/**
 * Future actions indexed by exact project id. A row is upcoming only when its
 * publisher event/deadline day is on or after the supplied test clock.
 */
export function landFutureActionsByProject(rows = [], { today } = {}) {
  const floor = isoDay(today || new Date().toISOString());
  const evidence = landActionEvidenceByProject(rows);
  const byProject = new Map();
  for (const [projectId, actions] of evidence) {
    const future = actions.filter((action) => action.action_date && (!floor || action.action_date >= floor));
    if (future.length) byProject.set(projectId, future);
  }
  return byProject;
}

/** All retained action rows, including past dates, for normalized phase/status evidence. */
export function landActionEvidenceByProject(rows = []) {
  const byProject = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const projectId = cleanLandFacetValue(row?.project_id);
    if (!projectId) continue;
    const action = Object.freeze({
      ...row,
      action_kind: landActionKind(row),
      action_date: isoDay(row?.deadline_date || row?.event_date || row?.hearing_date || row?.hearing_at),
    });
    if (!byProject.has(projectId)) byProject.set(projectId, []);
    byProject.get(projectId).push(action);
  }
  for (const actions of byProject.values()) {
    actions.sort((left, right) => String(left.action_date || "9999-12-31").localeCompare(String(right.action_date || "9999-12-31"))
      || cleanLandFacetValue(left.event_class).localeCompare(cleanLandFacetValue(right.event_class)));
  }
  return byProject;
}

export function landActionsMatchFutureFilter(actions = [], futureAction = "any") {
  const selected = normalizeLandFutureAction(futureAction);
  if (selected === "any") return true;
  if (selected === "none") return actions.length === 0;
  if (selected === "any_future") return actions.length > 0;
  if (selected === "hearing") return actions.some((action) => action.action_kind === "hearing");
  return actions.some((action) => action.action_kind !== "hearing");
}

/** Prefer a direct ZAP action snapshot's overall status over an older Open Data row. */
export function landRowWithActionEvidence(row = {}, actions = [], { today } = {}) {
  if (landStageForRow(row) === "completed") return row;
  const ceiling = isoDay(today || new Date().toISOString());
  const directStatus = [...actions].reverse().find((action) => /public review/i.test(cleanLandFacetValue(action?.public_status)))?.public_status;
  const directPhase = [...actions].reverse().find((action) => LAND_PHASE_IDS.has(cleanLandFacetValue(action?.phase_id))
    && (!action.action_date || !ceiling || action.action_date <= ceiling))?.phase_id;
  return {
    ...row,
    ...(directStatus ? { public_status: directStatus } : {}),
    ...(directPhase ? { phase_id: directPhase } : {}),
  };
}

export function landFacetOptionCounts(projects = [], actionRows = [], {
  today,
  stage = "active",
  futureAction = "any",
  procedure = DEFAULT_LAND_PROCEDURE,
} = {}) {
  const actionsByProject = landFutureActionsByProject(actionRows, { today });
  const evidenceByProject = landActionEvidenceByProject(actionRows);
  const rows = Array.isArray(projects) ? projects : [];
  const selectedProcedure = normalizeLandProcedure(procedure);
  const stageCounts = Object.fromEntries(LAND_STAGE_OPTIONS.map(({ id }) => [id, 0]));
  const futureCounts = Object.fromEntries(LAND_FUTURE_ACTION_OPTIONS.map(({ id }) => [id, 0]));
  const procedureCounts = Object.fromEntries(LAND_PROCEDURE_OPTIONS.map(({ id }) => [id, 0]));
  for (const row of rows) {
    const actions = actionsByProject.get(cleanLandFacetValue(row?.project_id)) || [];
    const evidence = evidenceByProject.get(cleanLandFacetValue(row?.project_id)) || [];
    const effectiveRow = landRowWithActionEvidence(row, evidence, { today });
    const matchesProcedure = landRowMatchesProcedure(effectiveRow, selectedProcedure);
    const matchesStage = landRowMatchesStage(effectiveRow, stage);
    const matchesFuture = landActionsMatchFutureFilter(actions, futureAction);
    for (const option of LAND_STAGE_OPTIONS) {
      if (matchesProcedure && landRowMatchesStage(effectiveRow, option.id) && matchesFuture) {
        stageCounts[option.id] += 1;
      }
    }
    for (const option of LAND_FUTURE_ACTION_OPTIONS) {
      if (matchesProcedure && matchesStage && landActionsMatchFutureFilter(actions, option.id)) {
        futureCounts[option.id] += 1;
      }
    }
    for (const option of LAND_PROCEDURE_OPTIONS) {
      if (landRowMatchesProcedure(effectiveRow, option.id) && matchesStage && matchesFuture) {
        procedureCounts[option.id] += 1;
      }
    }
  }
  return {
    stage: stageCounts,
    future_action: futureCounts,
    procedure: procedureCounts,
    actions_by_project: actionsByProject,
  };
}

/** Build non-empty status facets from the current ZAP inventory. */
export function landStatusFacetOptions(rows = []) {
  const options = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const [field, prefix] of [["project_status", "project"], ["public_status", "public"]]) {
      const label = cleanLandFacetValue(row?.[field]);
      if (!label) continue;
      const id = `${prefix}:${label}`;
      const option = options.get(id) || { id, label, field, count: 0 };
      option.count += 1;
      options.set(id, option);
    }
  }
  return [...options.values()]
    .filter((option) => option.count > 0)
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

export function landStatusFacetWhere(status) {
  const match = String(status || "").match(/^(project|public):(.*)$/);
  if (!match || !cleanLandFacetValue(match[2])) return null;
  const value = match[2].replace(/'/g, "''");
  return `${match[1] === "project" ? "project_status" : "public_status"}='${value}'`;
}
