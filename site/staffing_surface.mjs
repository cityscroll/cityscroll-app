import { buildBrowseView } from "./browse_view.mjs";
import { STAFFING_SURFACE } from "./browse_surface_contracts.mjs";
import { buildOwnedBrowseDocument } from "./primary_document_view.mjs";

export const STAFFING_BROWSE_VIEW = Object.freeze({
  tab: STAFFING_SURFACE.navigationFamily,
  label: STAFFING_SURFACE.label,
  route: STAFFING_SURFACE.canonicalRoute,
  countLabel: "recent appointments",
  description: STAFFING_SURFACE.description,
  sources: "City Record · DCAS · Citywide Payroll",
  container: "staffing-notice-list",
  dataPath: "/data/staffing_default_hires.json",
  rowsKey: "notices",
});

export function buildStaffingBrowseView(artifact = {}, params = new URLSearchParams()) {
  return buildBrowseView("staffing", artifact, params, {
    config: STAFFING_BROWSE_VIEW,
  });
}

export function buildStaffingDocument(shell, artifact = {}, params = new URLSearchParams()) {
  return buildOwnedBrowseDocument(shell, STAFFING_SURFACE, {
    container: STAFFING_BROWSE_VIEW.container,
    view: buildStaffingBrowseView(artifact, params),
  });
}
