import {
  renderMandateContractsBridgeSection,
} from "../mandate_contracts_bridge.mjs";

export const mandateContractsSection = Object.freeze({
  id: "mandate-contracts",
  order: 36,
  render: (view) => renderMandateContractsBridgeSection(
    view.displayView.mandates_contracts || view.view.mandates_contracts || null,
  ),
});
