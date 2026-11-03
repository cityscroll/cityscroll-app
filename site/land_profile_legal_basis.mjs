import { resolveLandAuthoritySourceBasis } from "./land_authority_summary.mjs";

// A bounded source citation shared by civic reads and the resident panel.
// The caller may pass a materialized payload to resolve shared defaults.
export function profileLegalBasis(summary, payload = null) {
  const profile = resolveLandAuthoritySourceBasis(summary, payload)?.profile || {};
  const basis = profile.legal_basis && typeof profile.legal_basis === "object"
    ? profile.legal_basis
    : null;
  const procedureId = profile.procedure_id || summary?.procedure_id || null;
  const stageId = profile.stage_id || summary?.current_stage?.stage_id || null;
  if (!basis && !procedureId) return null;
  return {
    citation: basis?.citation || null,
    source_url: basis?.source_url || null,
    registry_version: profile.registry_version || null,
    procedure_id: procedureId,
    stage_id: stageId,
  };
}
