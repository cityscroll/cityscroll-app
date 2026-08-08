import { renderMandateMeetingsSection } from "../mandate_meetings_bridge.mjs";

export const mandateMeetingsSection = Object.freeze({
  id: "mandate-meetings",
  order: 35,
  render: (view) => renderMandateMeetingsSection(
    view.displayView.mandates_meetings || view.view.mandates_meetings || null,
  ),
});
