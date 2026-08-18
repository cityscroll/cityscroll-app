/**
 * Semantic observer for the land action-ontology collapse.
 *
 * LA4 facts do not parse land presentation or clocks. This observer is the
 * first worked drift case: it fails when a bundled ZM+control project is
 * rezoning-collapsed, when Charter §197-c is applied to ELURP/Non-ULURP, or
 * when map land ids diverge from list land ids on procedure.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  landParticipationGuideHeadingKey,
  normalizeLandUseActionType,
} from "../site/land_use_action_type.mjs";
import {
  buildUlurpStatutoryClockView,
  resolveUlurpNon,
} from "../site/ulurp_statutory_clock.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const LAND_ACTION_COLLAPSE_SCHEMA = "cityscroll.architecture.land_action_collapse.v1";

export const LAND_ACTION_COLLAPSE_FINDINGS = Object.freeze({
  PRIMARY_COLLAPSE: "primary_collapse",
  WRONG_PROCEDURE_CLOCK: "wrong_procedure_clock",
  MAP_LIST_PROCEDURE_DIVERGENCE: "map_list_procedure_divergence",
});

const ZONING_CODES = new Set(["ZM", "ZR"]);
const CONTROL_CODES = new Set(["PP", "HA", "PQ", "PC", "PS"]);
const CONTROL_FAMILIES = new Set(["disposition", "acquisition", "site_selection"]);
const ULURP_STATUTE = "NYC Charter §197-c";

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function upperCodes(action) {
  return asList(action?.codes).map((code) => String(code || "").trim().toUpperCase()).filter(Boolean);
}

function hasBundledZmAndControl(action) {
  const codes = upperCodes(action);
  return codes.some((code) => ZONING_CODES.has(code)) && codes.some((code) => CONTROL_CODES.has(code));
}

function controlFamilyPresent(action) {
  return asList(action?.families).some((family) => CONTROL_FAMILIES.has(family));
}

function normalizeProcedure(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z]/g, "");
}

function isNonUlurpProcedure(value) {
  const procedure = normalizeProcedure(value);
  return procedure === "elurp" || procedure === "nonulurp";
}

function idSet(ids) {
  return new Set(asList(ids).map((id) => String(id || "").trim()).filter(Boolean));
}

export function isPrimaryCollapse(action) {
  if (!action || typeof action !== "object") return false;
  const families = asList(action.families);
  const primary = action.primary;
  const rezoningFlag = action.is_rezoning === true;
  const rezoningHeading = action.heading_key === "land_guide_heading_rezoning";
  if (hasBundledZmAndControl(action)) {
    if (primary === "rezoning" || rezoningFlag || rezoningHeading) return true;
    if (!controlFamilyPresent(action)) return true;
  }
  if (families.length > 1 && primary && primary !== "land_use" && families.includes(primary)) {
    return true;
  }
  return false;
}

export function isWrongProcedureClock(clock) {
  if (!clock || typeof clock !== "object") return false;
  if (!isNonUlurpProcedure(clock.ulurp_non)) return false;
  const status = String(clock.status || "").trim().toLowerCase();
  if (status && status !== "ineligible") return true;
  if (asList(clock.phases).length > 0) return true;
  if (asList(clock.predictions).length > 0) return true;
  if (status === "ineligible" && clock.reason && clock.reason !== "wrong_procedure") {
    return asList(clock.phases).some((phase) => phase?.statute_ref === ULURP_STATUTE);
  }
  return false;
}

export function isMapListProcedureDivergence(landIds) {
  if (!landIds || typeof landIds !== "object") return false;
  const map = idSet(landIds.map);
  const list = idSet(landIds.list);
  if (map.size === 0 && list.size === 0) return false;
  if (map.size !== list.size) return true;
  for (const id of map) {
    if (!list.has(id)) return true;
  }
  return false;
}

function finding(type, target, details = {}) {
  return { type, target, ...details };
}

export function observeLandActionCollapse(observation = {}) {
  const findings = [];
  if (isPrimaryCollapse(observation.action)) {
    findings.push(finding(
      LAND_ACTION_COLLAPSE_FINDINGS.PRIMARY_COLLAPSE,
      observation.action.project_id || "action",
      {
        primary: observation.action.primary ?? null,
        families: asList(observation.action.families),
        codes: upperCodes(observation.action),
      },
    ));
  }
  if (isWrongProcedureClock(observation.clock)) {
    findings.push(finding(
      LAND_ACTION_COLLAPSE_FINDINGS.WRONG_PROCEDURE_CLOCK,
      observation.clock.project_id || "clock",
      {
        ulurp_non: observation.clock.ulurp_non ?? null,
        status: observation.clock.status ?? null,
        reason: observation.clock.reason ?? null,
      },
    ));
  }
  if (isMapListProcedureDivergence(observation.land_ids)) {
    const map = [...idSet(observation.land_ids.map)].sort();
    const list = [...idSet(observation.land_ids.list)].sort();
    findings.push(finding(
      LAND_ACTION_COLLAPSE_FINDINGS.MAP_LIST_PROCEDURE_DIVERGENCE,
      "land_ids",
      {
        map_only: map.filter((id) => !list.includes(id)),
        list_only: list.filter((id) => !map.includes(id)),
      },
    ));
  }
  return {
    schema: LAND_ACTION_COLLAPSE_SCHEMA,
    status: findings.length ? "drift" : "healthy",
    findings,
  };
}

export function projectCurrentLandActionObservation({
  actionRecord = null,
  clockRecord = null,
  mapIds = null,
  listIds = null,
} = {}) {
  const action = actionRecord
    ? {
        project_id: actionRecord.project_id ?? null,
        ...normalizeLandUseActionType(actionRecord),
        heading_key: landParticipationGuideHeadingKey(actionRecord),
      }
    : null;
  let clock = null;
  if (clockRecord) {
    const view = buildUlurpStatutoryClockView(clockRecord);
    clock = {
      project_id: clockRecord.project_id ?? null,
      ulurp_non: resolveUlurpNon(clockRecord),
      status: view.status ?? null,
      reason: view.reason ?? null,
      phases: asList(view.phases),
      predictions: asList(clockRecord.predictions),
    };
  }
  const land_ids = mapIds != null || listIds != null
    ? { map: asList(mapIds), list: asList(listIds) }
    : null;
  return { action, clock, land_ids };
}

export function loadJsonRepoPath(repoPath, root = ROOT) {
  return JSON.parse(readFileSync(join(root, repoPath), "utf8"));
}

export {
  CONTROL_CODES,
  CONTROL_FAMILIES,
  ZONING_CODES,
};
