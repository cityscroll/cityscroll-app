import {
  MANDATE_RULES_BRIDGE_STYLE,
  renderMandateRulesBridgeSection,
} from "../mandate_rules_bridge.mjs";

export const mandateRulesSection = Object.freeze({
  id: "mandate-rules",
  order: 30,
  styleOrder: 10,
  style: MANDATE_RULES_BRIDGE_STYLE,
  render: (view) => renderMandateRulesBridgeSection(
    view.displayView.mandates_rules || view.view.mandates_rules || null,
  ),
});
