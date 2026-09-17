/**
 * Resident procedure and stage wording for Land authority surfaces.
 *
 * Shared by the detail authority panel and the map selection handoff so both
 * read the same label owners. Raw procedure and stage ids stay in diagnostic
 * attributes; this module never invents a label for an unresolved value.
 */

import { resolveLandProcedureProfile } from "./land_procedure_profiles.mjs";

function clean(value) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text || null;
}

function phaseLabel(phaseId, translate) {
  const key = `land_phase_${phaseId}`;
  const label = translate(key);
  return label === key ? phaseId : label;
}

/**
 * A parallel-group next stage (e.g. Community Board / Borough President
 * reviewed at the same time under § 197-e) is never collapsed into a single
 * label implying a first-then-second order.
 */
export function landAuthorityStageLabel(stage, translate) {
  if (stage?.group_id && Array.isArray(stage.spine_phase_ids) && stage.spine_phase_ids.length) {
    return translate("land_authority_expected_next_parallel", {
      members: stage.spine_phase_ids.map((phaseId) => phaseLabel(phaseId, translate)).join(` ${translate("land_authority_and")} `),
    });
  }
  if (!stage || stage.status === "unknown" || !stage.spine_phase_id) {
    return translate("land_authority_unknown");
  }
  return phaseLabel(stage.spine_phase_id, translate);
}

/**
 * Resident procedure wording from the reviewed procedure-profile registry.
 */
export function landAuthorityProcedureLabel(procedureId, translate) {
  const id = clean(procedureId);
  if (!id) return translate("land_authority_unknown");
  const resolved = resolveLandProcedureProfile({ procedure_id: id });
  const label = clean(resolved?.profile?.label);
  return label || translate("land_authority_unknown");
}
