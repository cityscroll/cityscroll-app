import { LAND_ULURP_PHASES, mapMilestoneToPhase } from "./land_phase_spine.mjs";
import {
  LAND_USE_ACTION_CODE_FAMILY,
  LAND_USE_FAMILY_LABEL_KEY,
  normalizeLandUseActionType,
} from "./land_use_action_type.mjs";
import {
  DEFAULT_LAND_PROCEDURE,
  LAND_PROCEDURE_OPTIONS,
  landRowMatchesProcedure,
  normalizeLandProcedure,
} from "./land_procedure_facet.mjs";
import {
  LAND_REGULATORY_EFFECT_OPTIONS,
  landRowMatchesRegulatoryEffect,
  normalizeLandRegulatoryEffect,
} from "./land_regulatory_effect.mjs";

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

export const DEFAULT_LAND_FAMILY = "any";

/** Closed action-family facet. Generic land_use is not offered — it is the unmapped fallback. */
export const LAND_FAMILY_OPTIONS = Object.freeze([
  { id: "any", label_key: "status_all" },
  { id: "acquisition", label_key: "land_use_family_acquisition" },
  { id: "disposition", label_key: "land_use_family_disposition" },
  { id: "certification", label_key: "land_use_family_certification" },
  { id: "renewal", label_key: "land_use_family_renewal" },
  { id: "major_concession", label_key: "land_use_family_major_concession" },
  { id: "legal_document", label_key: "land_use_family_legal_document" },
  { id: "rezoning", label_key: "land_use_family_rezoning" },
  { id: "special_permit", label_key: "land_use_family_special_permit" },
  { id: "authorization", label_key: "land_use_family_authorization" },
  { id: "site_selection", label_key: "land_use_family_site_selection" },
  { id: "mapping", label_key: "land_use_family_mapping" },
  { id: "demapping", label_key: "land_use_family_demapping" },
  { id: "urban_renewal", label_key: "land_use_family_urban_renewal" },
  { id: "landmark", label_key: "land_use_family_landmark" },
  { id: "follow_up", label_key: "land_use_family_follow_up" },
  { id: "office_space", label_key: "land_use_family_office_space" },
  { id: "bid", label_key: "land_use_family_bid" },
  { id: "franchise_consent", label_key: "land_use_family_franchise_consent" },
  { id: "housing_plan", label_key: "land_use_family_housing_plan" },
  { id: "pops", label_key: "land_use_family_pops" },
  { id: "landfill", label_key: "land_use_family_landfill" },
]);

const LAND_STAGE_IDS = new Set(LAND_STAGE_OPTIONS.map((option) => option.id));
const LAND_FUTURE_ACTION_IDS = new Set(LAND_FUTURE_ACTION_OPTIONS.map((option) => option.id));
const LAND_FAMILY_IDS = new Set(LAND_FAMILY_OPTIONS.map((option) => option.id));
const LAND_FAMILY_CODES = Object.freeze(
  Object.fromEntries(LAND_FAMILY_OPTIONS.filter((option) => option.id !== "any").map((option) => [
    option.id,
    Object.freeze(Object.entries(LAND_USE_ACTION_CODE_FAMILY)
      .filter(([, family]) => family === option.id)
      .map(([code]) => code)),
  ])),
);
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

export function normalizeLandFamily(value, fallback = DEFAULT_LAND_FAMILY) {
  const family = cleanLandFacetValue(value).toLowerCase().replace(/-/g, "_");
  return LAND_FAMILY_IDS.has(family) ? family : fallback;
}

/** Mapped families for a ZAP row, preferring a stamped families[] bag when present. */
export function landUseFamilies(row = {}) {
  if (Array.isArray(row.families) && row.families.length) {
    const seen = new Set();
    const out = [];
    for (const raw of row.families) {
      const id = normalizeLandFamily(raw, "");
      if (!id || id === "any" || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    if (out.length) return out;
  }
  return normalizeLandUseActionType(row).families;
}

export function landRowMatchesFamily(row, family = DEFAULT_LAND_FAMILY) {
  const selected = normalizeLandFamily(family);
  if (selected === "any") return true;
  return landUseFamilies(row).includes(selected);
}

export function landRecordHasFamilyEvidence(row = {}) {
  return landUseFamilies(row).length > 0
    || normalizeLandUseActionType(row).codes.length > 0
    || (Array.isArray(row.families) && row.families.length > 0)
    || Boolean(row.actions);
}

export function landFamilySodaWhere(family = DEFAULT_LAND_FAMILY) {
  const selected = normalizeLandFamily(family);
  if (selected === "any") return null;
  const codes = LAND_FAMILY_CODES[selected] || [];
  if (!codes.length) return null;
  return codes.map((code) => `upper(actions) like '%${code}%'`).join(" OR ");
}

export function landFamilyLabelKey(family) {
  const selected = normalizeLandFamily(family, "");
  if (!selected || selected === "any") return null;
  return LAND_USE_FAMILY_LABEL_KEY[selected] || null;
}

export function landFamilyChipsHTML(row = {}, { t, escape } = {}) {
  const esc = typeof escape === "function" ? escape : (value) => String(value ?? "");
  const translate = typeof t === "function" ? t : (key) => key;
  return landUseFamilies(row).map((id) => {
    const labelKey = LAND_USE_FAMILY_LABEL_KEY[id];
    if (!labelKey) return "";
    return `<span class="tag land-family" data-land-family="${esc(id)}">${esc(translate(labelKey))}</span>`;
  }).filter(Boolean).join("");
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
  family = DEFAULT_LAND_FAMILY,
  regulatoryEffect = "any",
} = {}) {
  const actionsByProject = landFutureActionsByProject(actionRows, { today });
  const evidenceByProject = landActionEvidenceByProject(actionRows);
  const rows = Array.isArray(projects) ? projects : [];
  const selectedProcedure = normalizeLandProcedure(procedure);
  const selectedFamily = normalizeLandFamily(family);
  const selectedRegulatoryEffect = normalizeLandRegulatoryEffect(regulatoryEffect);
  const stageCounts = Object.fromEntries(LAND_STAGE_OPTIONS.map(({ id }) => [id, 0]));
  const futureCounts = Object.fromEntries(LAND_FUTURE_ACTION_OPTIONS.map(({ id }) => [id, 0]));
  const procedureCounts = Object.fromEntries(LAND_PROCEDURE_OPTIONS.map(({ id }) => [id, 0]));
  const familyCounts = Object.fromEntries(LAND_FAMILY_OPTIONS.map(({ id }) => [id, 0]));
  const regulatoryEffectCounts = Object.fromEntries(LAND_REGULATORY_EFFECT_OPTIONS.map(({ id }) => [id, 0]));
  for (const row of rows) {
    const actions = actionsByProject.get(cleanLandFacetValue(row?.project_id)) || [];
    const evidence = evidenceByProject.get(cleanLandFacetValue(row?.project_id)) || [];
    const effectiveRow = landRowWithActionEvidence(row, evidence, { today });
    const matchesProcedure = landRowMatchesProcedure(effectiveRow, selectedProcedure);
    const matchesStage = landRowMatchesStage(effectiveRow, stage);
    const matchesFuture = landActionsMatchFutureFilter(actions, futureAction);
    const matchesFamily = landRowMatchesFamily(effectiveRow, selectedFamily);
    const matchesRegulatoryEffect = landRowMatchesRegulatoryEffect(effectiveRow, selectedRegulatoryEffect);
    for (const option of LAND_STAGE_OPTIONS) {
      if (matchesProcedure && matchesFamily && matchesRegulatoryEffect && landRowMatchesStage(effectiveRow, option.id) && matchesFuture) {
        stageCounts[option.id] += 1;
      }
    }
    for (const option of LAND_FUTURE_ACTION_OPTIONS) {
      if (matchesProcedure && matchesFamily && matchesRegulatoryEffect && matchesStage && landActionsMatchFutureFilter(actions, option.id)) {
        futureCounts[option.id] += 1;
      }
    }
    for (const option of LAND_PROCEDURE_OPTIONS) {
      if (landRowMatchesProcedure(effectiveRow, option.id) && matchesFamily && matchesRegulatoryEffect && matchesStage && matchesFuture) {
        procedureCounts[option.id] += 1;
      }
    }
    for (const option of LAND_FAMILY_OPTIONS) {
      if (matchesProcedure && landRowMatchesFamily(effectiveRow, option.id) && matchesRegulatoryEffect && matchesStage && matchesFuture) {
        familyCounts[option.id] += 1;
      }
    }
    for (const option of LAND_REGULATORY_EFFECT_OPTIONS) {
      if (matchesProcedure && matchesFamily && matchesStage && matchesFuture
        && landRowMatchesRegulatoryEffect(effectiveRow, option.id)) {
        regulatoryEffectCounts[option.id] += 1;
      }
    }
  }
  return {
    stage: stageCounts,
    future_action: futureCounts,
    procedure: procedureCounts,
    family: familyCounts,
    regulatory_effect: regulatoryEffectCounts,
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
