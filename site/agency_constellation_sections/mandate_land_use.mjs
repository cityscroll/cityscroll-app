import { renderMandateLandUseSection } from "../mandate_land_use_bridge.mjs";

export const mandateLandUseSection = Object.freeze({
  id: "mandate-land-use",
  order: 37,
  render: (view) => renderMandateLandUseSection(
    view.displayView.mandates_land_use || view.view.mandates_land_use || null,
  ),
});
