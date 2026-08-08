import {
  MANDATE_PREDICTION_STYLE,
  renderMandatePredictionsSection,
} from "../mandate_prediction_alerts.mjs";

export const mandatePredictionsSection = Object.freeze({
  id: "mandate-predictions",
  order: 10,
  styleOrder: 30,
  style: MANDATE_PREDICTION_STYLE,
  render: (view) => renderMandatePredictionsSection(
    view.displayView.mandates_predictions || view.view.mandates_predictions || null,
  ),
});
